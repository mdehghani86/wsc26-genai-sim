/* =========================================================
   ed-runtime.js — loads the REAL ED model (phase2_decisions/ed_model.py)
   into Pyodide and exposes a driver that lets an async LLM policy decide
   on top of it, without modifying the model.

   Trick: the model's policy hook is synchronous, but LLM calls are async.
   So we re-run the (deterministic, tiny) model repeatedly: a "forced"
   policy replays the choices made so far and RAISES NeedDecision at the
   first undecided point. JS catches it, asks the LLM, appends the choice,
   and re-runs. ~15 re-runs of a 25-patient model = microseconds; the LLM
   latency dominates, exactly as in the paper.
   ========================================================= */
window.EDRuntime = (function () {
  'use strict';

  let ready = null;

  const DRIVER_PY = `
import json, random

class NeedDecision(Exception):
    def __init__(self, state):
        self.state = state

def _ser_state(s):
    return {
        "now": round(s.now, 1),
        "free_bed": s.free_bed_idx,
        "beds": [{"idx": b.idx, "busy": bool(b.busy),
                  "sev": (b.occupant.severity if b.occupant else None),
                  "rel": round(max(0.0, b.expected_release - s.now), 1)} for b in s.beds],
        "queue": [{"i": i, "pid": p.pid, "sev": p.severity,
                   "wait": round(s.now - p.arrival_time, 1),
                   "los": round(p.service_time, 0)} for i, p in enumerate(s.queue)],
        "history": [dict(h) for h in list(s.history)[-4:]],
    }

def _make_forced(forced):
    st = {"i": 0}
    def fn(s):
        i = st["i"]; st["i"] += 1
        if i < len(forced):
            return forced[i]
        raise NeedDecision(s)
    return fn

def step_llm(forced_json, seed, n_patients, inter_arr, n_beds):
    forced = json.loads(forced_json)
    log = []
    try:
        out = run_replication(_make_forced(forced), seed=int(seed),
                              n_patients=int(n_patients), inter_arr_mean=float(inter_arr),
                              n_beds=int(n_beds), decision_log=log)
        return json.dumps({"status": "done", "kpis": out["kpis"], "log": log})
    except NeedDecision as nd:
        return json.dumps({"status": "decision", "k": len(forced), "state": _ser_state(nd.state)})

def baseline(which, seed, n_patients, inter_arr, n_beds):
    pol = policy_fifo() if which == "fifo" else policy_severity_priority()
    log = []
    out = run_replication(pol, seed=int(seed), n_patients=int(n_patients),
                          inter_arr_mean=float(inter_arr), n_beds=int(n_beds), decision_log=log)
    return json.dumps({"kpis": out["kpis"], "log": log})

def event_log(seed, n_patients, inter_arr, n_beds):
    log = []
    out = run_replication(policy_fifo(), seed=int(seed), n_patients=int(n_patients),
                          inter_arr_mean=float(inter_arr), n_beds=int(n_beds), decision_log=log)
    pts = []
    for p in out["patients"]:
        pts.append({"pid": p.pid, "sev": p.severity,
                    "arr": round(p.arrival_time, 1),
                    "admit": round(p.admit_time, 1) if p.admit_time is not None else None,
                    "disc": round(p.discharge_time, 1) if p.discharge_time is not None else None,
                    "los": round(p.service_time, 1)})
    return json.dumps({"patients": pts, "end": round(out["kpis"]["end_time"], 1)})
`;

  async function init() {
    if (ready) return ready;
    ready = (async () => {
      const py = await window.Runtime.ensureSimpy();
      const src = await fetch('phase2_decisions/ed_model.py').then(r => {
        if (!r.ok) throw new Error('could not load ed_model.py (' + r.status + ')');
        return r.text();
      });
      py.runPython(src);     // defines run_replication, policy_fifo, policy_severity_priority, SimState
      py.runPython(DRIVER_PY);
      return py;
    })();
    return ready;
  }

  function call(fn, ...args) {
    const py = window.Runtime.py();
    const f = py.globals.get(fn);
    const out = f(...args);
    f.destroy();
    return JSON.parse(out);
  }

  return {
    init,
    // one re-run step; returns {status:'decision', k, state} or {status:'done', kpis, log}
    stepLLM: async (forcedArr, p) => { await init(); return call('step_llm', JSON.stringify(forcedArr), p.seed, p.n, p.iat, p.beds); },
    baseline: async (which, p) => { await init(); return call('baseline', which, p.seed, p.n, p.iat, p.beds); },
    eventLog: async (p) => { await init(); return call('event_log', p.seed, p.n, p.iat, p.beds); },
  };
})();
