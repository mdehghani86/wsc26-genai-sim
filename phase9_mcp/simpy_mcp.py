"""Browser-side simpy-mcp server.

Five tools that an LLM can call to construct and run a SimPy model
without writing any Python source. State is held in module-level dicts
so the JS layer can call each tool one at a time as the LLM emits them
in the recorded session.

The "tools" return JSON-serialisable dicts (or raise typed errors) so
the UI can display them verbatim.
"""

from __future__ import annotations

import math
import random
import statistics
from collections import defaultdict
from typing import Any

import simpy


# ---------- module-level model state (the "MCP server") ----------

_RESOURCES: dict[str, dict] = {}
_PROCESSES: dict[str, dict] = {}
_WIRINGS: list[tuple[str, str]] = []
_LAST_RUN: dict | None = None


def reset() -> dict:
    """Clear the model state so the demo can be replayed."""
    global _RESOURCES, _PROCESSES, _WIRINGS, _LAST_RUN
    _RESOURCES = {}
    _PROCESSES = {}
    _WIRINGS = []
    _LAST_RUN = None
    return {"ok": True, "msg": "server reset"}


def state_snapshot() -> dict:
    """Return the current server state for the UI panel."""
    return {
        "resources": [
            {"name": n, "capacity": r["capacity"]}
            for n, r in _RESOURCES.items()
        ],
        "processes": [
            {"name": n, **p} for n, p in _PROCESSES.items()
        ],
        "wirings": [{"from": a, "to": b} for a, b in _WIRINGS],
        "ran": _LAST_RUN is not None,
    }


# ---------- the five tools ----------

def define_resource(name: str, capacity: int) -> dict:
    if not isinstance(name, str) or not name:
        return {"ok": False, "error": "name must be a non-empty string"}
    if not isinstance(capacity, int) or capacity < 1:
        return {"ok": False, "error": "capacity must be a positive integer"}
    if name in _RESOURCES:
        return {"ok": False, "error": f"resource {name!r} already defined"}
    _RESOURCES[name] = {"capacity": capacity}
    return {"ok": True, "msg": f"resource {name!r} (capacity={capacity}) registered"}


def define_process(name: str, kind: str, **params) -> dict:
    """Register an arrival or service process.

    kind = "arrival": params expects inter_arrival = ("exponential", mean)
    kind = "service": params expects resource, service_time = (dist, *args)
    """
    if name in _PROCESSES:
        return {"ok": False, "error": f"process {name!r} already defined"}
    if kind not in ("arrival", "service", "router"):
        return {"ok": False, "error": f"unknown kind {kind!r}"}
    if kind == "service":
        res = params.get("resource")
        if res not in _RESOURCES:
            return {"ok": False, "error": f"unknown resource {res!r}"}
    _PROCESSES[name] = {"kind": kind, **params}
    return {"ok": True, "msg": f"process {name!r} ({kind}) registered"}


def wire(producer: str, consumer: str) -> dict:
    if producer not in _PROCESSES:
        return {"ok": False, "error": f"unknown producer {producer!r}"}
    if consumer not in _PROCESSES:
        return {"ok": False, "error": f"unknown consumer {consumer!r}"}
    _WIRINGS.append((producer, consumer))
    return {"ok": True, "msg": f"wired {producer} -> {consumer}"}


def _sample(dist: tuple, rng: random.Random) -> float:
    name, *args = dist
    if name == "exponential":
        return rng.expovariate(1.0 / args[0])
    if name == "lognormal":
        return rng.lognormvariate(args[0], args[1])
    if name == "constant":
        return float(args[0])
    raise ValueError(f"unknown distribution {name}")


def _next_consumers(producer: str) -> list[str]:
    return [b for (a, b) in _WIRINGS if a == producer]


def run(duration: int = 480, replications: int = 5, seed: int = 0) -> dict:
    """Build a SimPy model from the current state and run it."""
    if not _PROCESSES:
        return {"ok": False, "error": "no processes defined"}
    arrivals = [n for n, p in _PROCESSES.items() if p["kind"] == "arrival"]
    if not arrivals:
        return {"ok": False, "error": "no arrival process defined"}

    per_rep = []
    for r_idx in range(replications):
        rng = random.Random(seed + r_idx)
        env = simpy.Environment()
        resources = {
            n: simpy.Resource(env, capacity=v["capacity"])
            for n, v in _RESOURCES.items()
        }
        completed = []
        wait_per_resource = defaultdict(list)
        busy_time = defaultdict(float)
        n_served = defaultdict(int)

        def service_step(entity, proc_name):
            """Run one service-process step on an entity."""
            p = _PROCESSES[proc_name]
            res = resources[p["resource"]]
            t_arr = env.now
            with res.request() as req:
                yield req
                wait_per_resource[p["resource"]].append(env.now - t_arr)
                t_start = env.now
                yield env.timeout(_sample(p["service_time"], rng))
                busy_time[p["resource"]] += env.now - t_start
                n_served[p["resource"]] += 1
            # Then send to next consumer in the wire graph
            nxt = _next_consumers(proc_name)
            if not nxt:
                # terminal — entity completed
                completed.append({"id": entity, "exit_t": env.now})
            else:
                # if multiple consumers, route by round-robin (simple default)
                target = nxt[rng.randrange(len(nxt))]
                env.process(service_step(entity, target))

        def arrival_proc(name):
            p = _PROCESSES[name]
            i = 0
            while True:
                yield env.timeout(_sample(p["inter_arrival"], rng))
                if env.now >= duration:
                    return
                i += 1
                consumers = _next_consumers(name)
                if not consumers:
                    return
                target = consumers[0]
                env.process(service_step(f"e{i}", target))

        for a in arrivals:
            env.process(arrival_proc(a))
        env.run(until=duration)

        rep_kpis = {"resources": {}, "n_completed": len(completed)}
        for n in _RESOURCES:
            waits = wait_per_resource[n]
            util = busy_time[n] / (duration * _RESOURCES[n]["capacity"])
            rep_kpis["resources"][n] = {
                "utilisation": round(util, 3),
                "mean_wait": round(statistics.mean(waits), 2) if waits else 0.0,
                "p95_wait": round(sorted(waits)[int(0.95 * len(waits))], 2) if waits else 0.0,
                "n_served": n_served[n],
            }
        per_rep.append(rep_kpis)

    # aggregate
    agg = {"resources": {}}
    for n in _RESOURCES:
        utils = [r["resources"][n]["utilisation"] for r in per_rep]
        means = [r["resources"][n]["mean_wait"] for r in per_rep]
        p95s = [r["resources"][n]["p95_wait"] for r in per_rep]
        agg["resources"][n] = {
            "utilisation_mean": round(statistics.mean(utils), 3),
            "utilisation_std": round(statistics.stdev(utils), 3) if len(utils) > 1 else 0.0,
            "wait_mean": round(statistics.mean(means), 2),
            "wait_p95_mean": round(statistics.mean(p95s), 2),
        }
    agg["n_completed_mean"] = round(statistics.mean(r["n_completed"] for r in per_rep), 1)
    agg["replications"] = replications
    agg["duration"] = duration

    global _LAST_RUN
    _LAST_RUN = agg
    return {"ok": True, "kpis": agg}


def query_kpis(group_by: str = "resource") -> dict:
    if _LAST_RUN is None:
        return {"ok": False, "error": "no run has been executed yet"}
    if group_by != "resource":
        return {"ok": False, "error": f"unsupported group_by {group_by!r}"}
    return {"ok": True, "kpis": _LAST_RUN}
