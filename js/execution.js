/* =========================================================
   Phase 2 — Execution
   Runs the Phase 1b SimPy ER model in browser via Pyodide,
   compares per-pool ρ / Lq / Wq against M/G/c theory.
   ========================================================= */
(function () {
  'use strict';

  // ---------- DOM ----------
  function el(id) { return document.getElementById(id); }
  function $(sel, root) { return (root || document).querySelector(sel); }

  function ready(fn) {
    if (document.readyState !== 'loading') fn();
    else document.addEventListener('DOMContentLoaded', fn);
  }

  ready(function () {
    const runBtn = el('ex-run-btn');
    if (!runBtn) return; // page not present
    runBtn.addEventListener('click', runSim);
  });

  // ---------- M/G/c theory ----------
  // Allen-Cunneen approximation for M/G/c.
  // Triangular(a, m, b): mean = (a+m+b)/3, var = (a^2+m^2+b^2-am-ab-mb)/18.
  function triStats(a, m, b) {
    const mean = (a + m + b) / 3;
    const variance = (a*a + m*m + b*b - a*m - a*b - m*b) / 18;
    const cs2 = variance / (mean*mean);
    return { mean, cs2 };
  }

  function erlangC(c, rho) {
    // Probability of waiting in M/M/c.
    const a = c * rho;
    let sum = 0, term = 1;
    for (let k = 0; k < c; k++) {
      sum += term;
      term *= a / (k + 1);
    }
    const last = Math.pow(a, c) / factorial(c) * (1 / (1 - rho));
    return last / (sum + last);
  }
  function factorial(n) { let r = 1; for (let i = 2; i <= n; i++) r *= i; return r; }

  function mGcTheory(lambda, c, sMean, sCs2) {
    const rho = lambda * sMean / c;
    if (rho >= 1) return { rho, Lq: Infinity, Wq: Infinity, stable: false };
    const pwait = erlangC(c, rho);
    const Wq_MMc = pwait / (c * (1/sMean) * (1 - rho));
    const Wq    = Wq_MMc * (1 + sCs2) / 2; // Allen-Cunneen correction (Ca^2=1 for Poisson)
    const Lq    = lambda * Wq;
    return { rho, Lq, Wq, stable: true };
  }

  // ---------- Simulation code (mirrors phase1b/er_simulation.py) ----------
  const SIM_PY = String.raw`
import random, statistics, json, simpy
from dataclasses import dataclass, field
from typing import Optional

DEFAULTS = dict(
    arrival_mean=6.0, critical_beds=2, standard_beds=4,
    selection_strategy="FIFO", n_replications=1, duration=5000.0,
    severity_min=1, severity_max=10, critical_threshold=7,
    critical_tri=(20, 30, 45), standard_tri=(10, 15, 25),
    seed=42, verbose=False,
)

@dataclass
class Patient:
    pid: int
    arrival_time: float
    severity: int
    bed_type: str
    expected_treatment: float
    bed_assigned_time: Optional[float] = None
    treatment_start: Optional[float] = None
    treatment_end: Optional[float] = None
    treatment_duration: Optional[float] = None
    @property
    def wait_time(self):     return (self.bed_assigned_time or 0.0) - self.arrival_time
    @property
    def time_in_system(self):return (self.treatment_end or 0.0) - self.arrival_time

@dataclass
class ResourceStats:
    name: str
    bed_type: str
    capacity: int
    served: int = 0
    busy_time: float = 0.0
    queue_sum: float = 0.0
    queue_count: int = 0

def _expected_treatment(severity, s):
    lo, mode, hi = s["critical_tri"] if severity >= s["critical_threshold"] else s["standard_tri"]
    return lo + (hi - lo) * ((severity - s["severity_min"]) / max(1, s["severity_max"] - s["severity_min"]))

def select_next(wl, strategy):
    if strategy == "FIFO": return wl.pop(0)
    idx = min(range(len(wl)), key=lambda i: wl[i].expected_treatment)
    return wl.pop(idx)

def treat(env, p, s, log):
    rng = s["_rng"]
    lo, mode, hi = s["critical_tri"] if p.bed_type == "critical" else s["standard_tri"]
    d = rng.triangular(lo, hi, mode)  # fix: Python signature is (low, high, mode)
    p.treatment_duration = d
    p.treatment_start = env.now
    yield env.timeout(d)
    p.treatment_end = env.now

def patient(env, p, wl, ev, s, log):
    wl[p.bed_type].append(p)
    e = ev[p.bed_type]
    ev[p.bed_type] = env.event()
    if not e.triggered: e.succeed()

def worker(env, bid, btype, stats, wl, ev, served, s, log):
    strat = s["selection_strategy"]
    while True:
        while not wl[btype]:
            yield ev[btype]
        if not wl[btype]: continue
        p = select_next(wl[btype], strat)
        p.bed_assigned_time = env.now
        stats.served += 1
        served.append(p)
        t0 = env.now
        yield env.process(treat(env, p, s, log))
        stats.busy_time += env.now - t0

def arrivals(env, wl, ev, s, log):
    rng = s["_rng"]; pid = 0
    while True:
        yield env.timeout(rng.expovariate(1.0 / s["arrival_mean"]))
        pid += 1
        sev = rng.randint(s["severity_min"], s["severity_max"])
        bt = "critical" if sev >= s["critical_threshold"] else "standard"
        p = Patient(pid=pid, arrival_time=env.now, severity=sev, bed_type=bt,
                    expected_treatment=_expected_treatment(sev, s))
        patient(env, p, wl, ev, s, log)

def queue_sampler(env, wl, cs, ss, duration, step=1.0, cap=10000):
    if duration and duration > cap * step:
        step = duration / cap
    while True:
        cs.queue_sum += len(wl["critical"]); cs.queue_count += 1
        ss.queue_sum += len(wl["standard"]); ss.queue_count += 1
        yield env.timeout(step)

def run_once(cfg):
    cfg["_rng"] = random.Random(cfg["seed"])
    env = simpy.Environment()
    wl = {"critical": [], "standard": []}
    ev = {"critical": env.event(), "standard": env.event()}
    cs = ResourceStats("CriticalCare", "critical", cfg["critical_beds"])
    ss = ResourceStats("Standard",     "standard", cfg["standard_beds"])
    served = []; log = []
    env.process(arrivals(env, wl, ev, cfg, log))
    for i in range(cfg["critical_beds"]):
        env.process(worker(env, i, "critical", cs, wl, ev, served, cfg, log))
    for i in range(cfg["standard_beds"]):
        env.process(worker(env, i, "standard", ss, wl, ev, served, cfg, log))
    env.process(queue_sampler(env, wl, cs, ss, cfg["duration"]))
    env.run(until=cfg["duration"])
    # credit busy_time for any worker still in-treatment at horizon
    for p in served:
        if p.treatment_start is not None and p.treatment_end is None:
            partial = max(0.0, cfg["duration"] - p.treatment_start)
            (cs if p.bed_type == "critical" else ss).busy_time += partial
    completed = [p for p in served if p.treatment_end is not None]
    tis = [p.time_in_system for p in completed]
    wait = [p.wait_time for p in served]
    treat_d = [p.treatment_duration for p in completed if p.treatment_duration is not None]
    def pool(st):
        util = st.busy_time / (cfg["duration"] * st.capacity) if st.capacity else 0.0
        qmean = st.queue_sum / st.queue_count if st.queue_count else 0.0
        pool_waits = [p.wait_time for p in served if p.bed_type == st.bed_type]
        pool_tis   = [p.time_in_system for p in completed if p.bed_type == st.bed_type]
        wq = statistics.mean(pool_waits) if pool_waits else 0.0
        return dict(name=st.name, bed_type=st.bed_type, capacity=st.capacity,
                    served=st.served, rho=util, Lq=qmean, Wq=wq,
                    wait_samples=pool_waits[:5000], tis_samples=pool_tis[:5000])
    return dict(
        duration=cfg["duration"], assigned=len(served), completed=len(completed),
        tis_mean=statistics.mean(tis) if tis else 0.0,
        wait_mean=statistics.mean(wait) if wait else 0.0,
        treat_mean=statistics.mean(treat_d) if treat_d else 0.0,
        critical=pool(cs), standard=pool(ss),
        log=log[:500],
    )

def run_rep(**overrides):
    """Run a single replication and return its JSON-serialisable dict."""
    cfg = {**DEFAULTS, **overrides}
    return json.dumps(run_once(cfg))

def aggregate(reps_json):
    """JS hands us a list of JSON strings; aggregate to mean + 95% CI."""
    reps = [json.loads(s) for s in reps_json]
    def agg_scalar(key):
        vals = [r[key] for r in reps]
        m = statistics.mean(vals)
        sd = statistics.stdev(vals) if len(vals) > 1 else 0.0
        half = 1.96 * sd / (len(vals) ** 0.5) if len(vals) > 1 else 0.0
        return {"mean": m, "half": half}
    def agg_pool(side):
        out = {}
        for key in ("rho", "Lq", "Wq", "served"):
            vals = [r[side][key] for r in reps]
            m = statistics.mean(vals)
            sd = statistics.stdev(vals) if len(vals) > 1 else 0.0
            half = 1.96 * sd / (len(vals) ** 0.5) if len(vals) > 1 else 0.0
            out[key] = {"mean": m, "half": half}
        out["capacity"] = reps[0][side]["capacity"]
        out["bed_type"] = reps[0][side]["bed_type"]
        out["wait_samples"] = []
        out["tis_samples"] = []
        for r in reps:
            out["wait_samples"].extend(r[side]["wait_samples"])
            out["tis_samples"].extend(r[side]["tis_samples"])
        out["wait_samples"] = out["wait_samples"][:8000]
        out["tis_samples"]  = out["tis_samples"][:8000]
        return out
    log_lines = []
    for r in reps:
        if r.get("log"):
            log_lines.extend(r["log"])
            if len(log_lines) >= 5000: break
    return json.dumps({
        "n_replications": len(reps),
        "duration":  reps[0]["duration"],
        "assigned":  agg_scalar("assigned"),
        "completed": agg_scalar("completed"),
        "tis_mean":  agg_scalar("tis_mean"),
        "wait_mean": agg_scalar("wait_mean"),
        "treat_mean":agg_scalar("treat_mean"),
        "critical":  agg_pool("critical"),
        "standard":  agg_pool("standard"),
        "log":       log_lines[:5000],
    })
`;

  // ---------- Run ----------
  let pyReady = false;

  async function runSim() {
    const status = el('ex-status');
    const btn    = el('ex-run-btn');
    btn.disabled = true;
    status.className = 'ex-status';

    const arrival  = parseFloat(el('ex-arrival').value);
    const critBeds = parseInt(el('ex-critical').value, 10);
    const stdBeds  = parseInt(el('ex-standard').value, 10);
    const duration = parseFloat(el('ex-duration').value);
    const strategy = el('ex-strategy').value;
    const nReps    = Math.max(1, parseInt(el('ex-reps').value, 10) || 1);
    const verbose  = el('ex-verbose').checked;

    if (!isFinite(arrival) || !isFinite(duration) || !critBeds || !stdBeds) {
      status.textContent = 'Bad input — please check the form.';
      status.className = 'ex-status is-error';
      btn.disabled = false;
      return;
    }

    const prog     = el('ex-progress');
    const progFill = el('ex-progress-fill');
    const progLbl  = el('ex-progress-label');
    function setProgress(done, total, msg) {
      const pct = Math.round((done / total) * 100);
      progFill.style.width = pct + '%';
      progLbl.textContent = msg || `${done} / ${total} reps · ${pct}%`;
    }

    try {
      prog.hidden = false;
      setProgress(0, nReps, pyReady ? `0 / ${nReps} reps · 0%` : 'Booting Pyodide…');
      status.textContent = pyReady ? `Running ${nReps} replication${nReps>1?'s':''}…` : 'Booting Pyodide + SimPy (first run only, ~10s)…';
      const py = await window.Runtime.ensureSimpy();
      if (!pyReady) {
        await py.runPythonAsync(SIM_PY);
        pyReady = true;
      }
      const t0 = performance.now();
      const repJsons = [];
      for (let r = 0; r < nReps; r++) {
        status.textContent = `Rep ${r + 1} of ${nReps} · simulating ${Math.round(duration).toLocaleString()} minutes…`;
        setProgress(r, nReps);
        py.globals.set('_args', py.toPy({
          arrival_mean: arrival,
          critical_beds: critBeds,
          standard_beds: stdBeds,
          selection_strategy: strategy,
          duration: duration,
          seed: 42 + r,
          verbose: verbose,
        }));
        const repStr = await py.runPythonAsync(`run_rep(**_args)`);
        repJsons.push(repStr);
        setProgress(r + 1, nReps);
        // yield to the UI so the bar updates between reps
        await new Promise(res => setTimeout(res, 0));
      }
      status.textContent = `Aggregating ${nReps} reps…`;
      py.globals.set('_reps', py.toPy(repJsons));
      const jsonStr = await py.runPythonAsync(`aggregate(list(_reps))`);
      const elapsed = ((performance.now() - t0) / 1000).toFixed(2);
      const result = JSON.parse(jsonStr);

      // theory predictions
      const lambdaTotal  = 1 / arrival;
      const pCrit = (10 - 7 + 1) / 10; // severity >= 7
      const pStd  = 1 - pCrit;
      const sCrit = triStats(20, 30, 45);
      const sStd  = triStats(10, 15, 25);
      const thCrit = mGcTheory(lambdaTotal * pCrit, critBeds, sCrit.mean, sCrit.cs2);
      const thStd  = mGcTheory(lambdaTotal * pStd,  stdBeds,  sStd.mean,  sStd.cs2);

      renderResults(result, thCrit, thStd, elapsed);
      const assigned = Math.round(result.assigned.mean);
      const completed = Math.round(result.completed.mean);
      const repNote = result.n_replications > 1 ? ` averaged over ${result.n_replications} reps` : '';
      status.textContent = `Done in ${elapsed}s${repNote} · ${assigned.toLocaleString()} patients assigned, ${completed.toLocaleString()} completed.`;
      status.className = 'ex-status is-ok';
      setProgress(nReps, nReps, 'Done');
      setTimeout(() => { prog.hidden = true; }, 800);
    } catch (e) {
      console.error(e);
      status.textContent = 'Error during run — ' + (e.message || e);
      status.className = 'ex-status is-error';
      prog.hidden = true;
    } finally {
      btn.disabled = false;
    }
  }

  function renderResults(r, thCrit, thStd, elapsed) {
    el('ex-results').hidden = false;
    const nrep = r.n_replications;
    const ciTag = (a) => nrep > 1 ? `<div class="sub">±${a.half.toFixed(2)} (95% CI)</div>` : '';
    el('ex-kpi-grid').innerHTML = `
      <div class="ex-kpi"><div class="lbl">Patients served</div><div class="val">${Math.round(r.completed.mean).toLocaleString()}</div><div class="sub">of ${Math.round(r.assigned.mean).toLocaleString()} assigned${nrep > 1 ? ` · mean over ${nrep} reps` : ''}</div></div>
      <div class="ex-kpi"><div class="lbl">Mean TIS</div><div class="val">${r.tis_mean.mean.toFixed(2)}</div>${ciTag(r.tis_mean) || '<div class="sub">minutes per patient</div>'}</div>
      <div class="ex-kpi"><div class="lbl">Mean wait</div><div class="val">${r.wait_mean.mean.toFixed(2)}</div>${ciTag(r.wait_mean) || '<div class="sub">minutes in queue</div>'}</div>
      <div class="ex-kpi"><div class="lbl">Mean treatment</div><div class="val">${r.treat_mean.mean.toFixed(2)}</div>${ciTag(r.treat_mean) || '<div class="sub">minutes per patient</div>'}</div>
      <div class="ex-kpi"><div class="lbl">Wall clock</div><div class="val">${elapsed}s</div><div class="sub">${nrep > 1 ? nrep + ' reps · ' : ''}browser-side Pyodide</div></div>
    `;

    el('ex-pool-grid').innerHTML = renderPool('critical', r.critical, thCrit, nrep) + renderPool('standard', r.standard, thStd, nrep);
    renderHistograms(r.critical, r.standard);
    wireLogButton(r.log || []);
  }

  function donutSVG(rho, kind) {
    const pct = Math.min(1, Math.max(0, rho));
    const C   = 2 * Math.PI * 40;
    const off = C * (1 - pct);
    const color = kind === 'critical' ? '#997A22' : '#1F6B73';
    const bg    = kind === 'critical' ? '#E8DDB8' : '#C7E1E2';
    return `
      <svg class="ex-donut" viewBox="0 0 100 100" aria-label="utilisation ${(pct*100).toFixed(1)}%">
        <circle cx="50" cy="50" r="40" fill="none" stroke="${bg}" stroke-width="12"/>
        <circle cx="50" cy="50" r="40" fill="none" stroke="${color}" stroke-width="12"
                stroke-dasharray="${C}" stroke-dashoffset="${off}"
                stroke-linecap="round" transform="rotate(-90 50 50)"/>
        <text x="50" y="50" text-anchor="middle" dy="2"
              font-family="JetBrains Mono, monospace" font-size="18" font-weight="700"
              fill="#2A2A2A">${(pct*100).toFixed(1)}%</text>
        <text x="50" y="68" text-anchor="middle"
              font-family="Source Sans Pro, sans-serif" font-size="8" font-weight="700"
              letter-spacing="1" fill="#8B8772">UTIL</text>
      </svg>
    `;
  }

  // Looser bands for Lq / Wq because Allen-Cunneen for M/G/c with c>1
  // is itself approximate (Tijms 1986). ρ stays tight — it's a direct
  // count and should match.
  function markFor(delta, metric) {
    const a = Math.abs(delta);
    const bands = (metric === 'rho')
      ? [5, 15]
      : [10, 25];
    if (a <= bands[0]) return { sym: '✓', cls: 'is-ok',  tip: `within ${bands[0]}%` };
    if (a <= bands[1]) return { sym: '~', cls: '',         tip: `within ${bands[1]}%` };
    return                { sym: '✗', cls: 'is-bad', tip: `over ${bands[1]}%` };
  }

  function renderPool(kind, sim, theory, nrep) {
    const cls   = kind === 'critical' ? 'is-critical' : 'is-standard';
    const title = kind === 'critical' ? 'Critical Care' : 'Standard Care';
    const stable = sim.rho.mean < 1 && theory.stable;
    const stabBadge = stable
      ? `<span class="ex-stability is-stable">ρ &lt; 1 stable</span>`
      : `<span class="ex-stability is-unstable">ρ ≥ 1 unstable</span>`;
    const row = (lbl, th, smObj, metric) => {
      const sm = smObj.mean;
      const half = smObj.half;
      const delta = isFinite(th) && th !== 0 ? ((sm - th) / th) * 100 : 0;
      const m = isFinite(th) ? markFor(delta, metric) : { sym: '—', cls: '', tip: '' };
      const dTxt = isFinite(th) ? `${delta >= 0 ? '+' : ''}${delta.toFixed(1)}%` : '—';
      const thTxt = isFinite(th) ? th.toFixed(3) : '—';
      const simTxt = nrep > 1 ? `${sm.toFixed(3)} <span class="ci">±${half.toFixed(3)}</span>` : sm.toFixed(3);
      return `<tr>
        <td>${lbl}</td>
        <td>${thTxt}</td>
        <td class="sim">${simTxt}</td>
        <td class="delta ${m.cls}">${dTxt} <span class="mark ${m.cls}" title="${m.tip}">${m.sym}</span></td>
      </tr>`;
    };
    return `
      <div class="ex-pool ${cls}">
        <h3>${title} <span class="badge">c = ${sim.capacity}</span> ${stabBadge}</h3>
        <div class="ex-pool-body">
          <div class="ex-pool-donut">${donutSVG(sim.rho.mean, kind)}</div>
          <table>
            <thead><tr><th>Metric</th><th>Theory</th><th>Simulation${nrep > 1 ? ' (mean ± 95% CI)' : ''}</th><th>Δ vs theory</th></tr></thead>
            <tbody>
              ${row('ρ (utilisation)', theory.rho, sim.rho, 'rho')}
              ${row('Lq', theory.Lq, sim.Lq, 'Lq')}
              ${row('Wq', theory.Wq, sim.Wq, 'Wq')}
            </tbody>
          </table>
        </div>
      </div>
    `;
  }

  function histogramSVG(samples, color, bg, bins) {
    bins = bins || 22;
    if (!samples || samples.length < 2) {
      return `<div class="ex-hist-empty">No samples (no waits or empty pool)</div>`;
    }
    const min = Math.min(...samples), max = Math.max(...samples);
    if (min === max) {
      return `<div class="ex-hist-empty">All values = ${min.toFixed(2)} (no spread)</div>`;
    }
    const w = (max - min) / bins;
    const counts = new Array(bins).fill(0);
    for (const s of samples) {
      let i = Math.min(bins - 1, Math.floor((s - min) / w));
      counts[i]++;
    }
    const maxCount = Math.max(...counts);
    // pick a "nice" y-axis upper limit (round up maxCount to a clean number)
    const yMax = niceCeil(maxCount);
    const W = 380, H = 130, padL = 40, padB = 22, padR = 8, padT = 10;
    const innerW = W - padL - padR, innerH = H - padB - padT;
    const barW = innerW / bins;
    let bars = '';
    counts.forEach((c, i) => {
      const h = (c / yMax) * innerH;
      bars += `<rect x="${padL + i*barW + 1}" y="${padT + innerH - h}" width="${barW - 2}" height="${h}" fill="${color}" opacity="0.88"/>`;
    });
    // y-axis: 0, yMax/2, yMax
    const yTicks = [0, yMax / 2, yMax];
    let yAxis = '';
    yTicks.forEach(v => {
      const y = padT + innerH - (v / yMax) * innerH;
      yAxis += `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="#D0D0D0" stroke-width="0.5" stroke-dasharray="2,3"/>`;
      yAxis += `<text x="${padL - 4}" y="${y + 3}" text-anchor="end" font-family="JetBrains Mono, monospace" font-size="9" fill="#8B8772">${Math.round(v)}</text>`;
    });
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
    const meanX = padL + ((mean - min) / (max - min)) * innerW;
    // mean label position: above plot area to avoid overlap with bars
    return `
      <svg class="ex-hist" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">
        ${yAxis}
        ${bars}
        <line x1="${padL}" y1="${padT + innerH}" x2="${W - padR}" y2="${padT + innerH}" stroke="#8B8772" stroke-width="0.8"/>
        <line x1="${padL}" y1="${padT}" x2="${padL}" y2="${padT + innerH}" stroke="#8B8772" stroke-width="0.8"/>
        <line x1="${meanX}" y1="${padT + 2}" x2="${meanX}" y2="${padT + innerH}" stroke="#2A2A2A" stroke-width="1.2" stroke-dasharray="3,2"/>
        <rect x="${meanX - 22}" y="${padT - 9}" width="44" height="11" rx="2" fill="#2A2A2A"/>
        <text x="${meanX}" y="${padT - 1}" text-anchor="middle" font-family="JetBrains Mono, monospace" font-size="9" font-weight="700" fill="#fff">μ ${mean.toFixed(1)}</text>
        <text x="${padL}" y="${H - 6}" font-family="JetBrains Mono, monospace" font-size="9" fill="#8B8772">${min.toFixed(1)}</text>
        <text x="${(padL + W - padR)/2}" y="${H - 6}" text-anchor="middle" font-family="JetBrains Mono, monospace" font-size="9" fill="#8B8772">n=${samples.length.toLocaleString()}</text>
        <text x="${W - padR}" y="${H - 6}" text-anchor="end" font-family="JetBrains Mono, monospace" font-size="9" fill="#8B8772">${max.toFixed(1)}</text>
      </svg>
    `;
  }

  function niceCeil(x) {
    if (x <= 0) return 1;
    const exp = Math.pow(10, Math.floor(Math.log10(x)));
    const f = x / exp;
    let nf;
    if (f <= 1) nf = 1;
    else if (f <= 2) nf = 2;
    else if (f <= 5) nf = 5;
    else nf = 10;
    return nf * exp;
  }

  function renderHistograms(crit, std) {
    const host = el('ex-hist-grid');
    if (!host) return;
    host.innerHTML = `
      <div class="ex-hist-card">
        <h4>Wait time · Critical <span class="ex-hist-unit">minutes</span></h4>
        ${histogramSVG(crit.wait_samples, '#997A22', '#E8DDB8')}
      </div>
      <div class="ex-hist-card">
        <h4>Wait time · Standard <span class="ex-hist-unit">minutes</span></h4>
        ${histogramSVG(std.wait_samples, '#1F6B73', '#C7E1E2')}
      </div>
      <div class="ex-hist-card">
        <h4>Time in system · Critical <span class="ex-hist-unit">minutes</span></h4>
        ${histogramSVG(crit.tis_samples, '#762A4F', '#EFD9E2')}
      </div>
      <div class="ex-hist-card">
        <h4>Time in system · Standard <span class="ex-hist-unit">minutes</span></h4>
        ${histogramSVG(std.tis_samples, '#4A7C2E', '#DDE8C8')}
      </div>
    `;
  }

  function wireLogButton(lines) {
    const btn = el('ex-log-popout');
    if (!btn) return;
    btn.disabled = !lines.length;
    btn.onclick = function () {
      if (!lines.length) return;
      const body = lines.join('\n');
      const html = `<!doctype html><html><head><meta charset="utf-8"><title>Event log — Phase 2</title>
<style>body{margin:0;padding:18px;background:#1a1a1a;color:#e8e2d3;font-family:JetBrains Mono,monospace;font-size:12px;line-height:1.5;white-space:pre}</style>
</head><body>${body.replace(/&/g,'&amp;').replace(/</g,'&lt;')}</body></html>`;
      const blob = new Blob([html], { type: 'text/html' });
      window.open(URL.createObjectURL(blob), '_blank');
    };
  }
})();
