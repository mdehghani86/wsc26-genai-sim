"""Run the bed-assignment experiment: 4 policies x 8 replications.

Heuristics: round-robin, severity-priority.
LLM-in-the-loop with rolling memory: GPT-5.1, Gemini-2.5-pro.
Each replication uses a fixed seed shared across all policies, so
comparisons are paired.
"""

from __future__ import annotations

import json
import statistics
import time
from pathlib import Path

from ed_model import (
    SimState,
    policy_fifo,
    policy_severity_priority,
    run_replication,
)
from llm_policy import GeminiClient, OpenAIClient, make_llm_policy


N_REPS = 8
SEEDS = list(range(N_REPS))
OUTDIR = Path(__file__).parent / "results"
OUTDIR.mkdir(exist_ok=True)


def aggregate(reps: list[dict]) -> dict:
    keys = ["mean_wait", "p95_wait", "sev_w_wait", "wait_sev1", "wait_sev3",
            "utilisation", "mean_dec_latency"]
    out = {}
    for k in keys:
        vals = [r["kpis"][k] for r in reps]
        out[k] = {
            "mean": statistics.mean(vals),
            "stdev": statistics.stdev(vals) if len(vals) > 1 else 0.0,
            "min": min(vals),
            "max": max(vals),
        }
    out["n_reps"] = len(reps)
    out["n_decisions_total"] = sum(r["kpis"]["n_decisions"] for r in reps)
    return out


def run_policy(policy_factory, name: str) -> dict:
    print(f"\n=== {name} ===", flush=True)
    rep_results = []
    rep_decision_logs = []
    t_start = time.time()
    for seed in SEEDS:
        decision_log: list = []
        try:
            # fresh policy state per replication so memory is per-rep
            pol = policy_factory()
        except Exception as e:
            print(f"  seed={seed} init FAIL: {e}")
            continue
        out = run_replication(
            pol,
            seed=seed,
            decision_log=decision_log,
        )
        kpis = out["kpis"]
        print(
            f"  seed={seed:>2}  mean={kpis['mean_wait']:6.1f}  "
            f"p95={kpis['p95_wait']:6.1f}  "
            f"sev1={kpis['wait_sev1']:6.1f} sev3={kpis['wait_sev3']:6.1f}  "
            f"util={kpis['utilisation']:.2f}  "
            f"dec_lat={kpis['mean_dec_latency']*1000:.0f} ms  "
            f"n_dec={kpis['n_decisions']}",
            flush=True,
        )
        rep_results.append(out)
        rep_decision_logs.append(decision_log)
    elapsed = time.time() - t_start
    agg = aggregate(rep_results)
    return {
        "name": name,
        "elapsed_s": elapsed,
        "agg": agg,
        "per_rep": [r["kpis"] for r in rep_results],
        "decisions": rep_decision_logs,
    }


def main():
    policies = [
        ("fifo",                lambda: policy_fifo()),
        ("severity_priority",   lambda: policy_severity_priority()),
        ("gpt-5.1",            lambda: make_llm_policy(OpenAIClient("gpt-5.1"),  name="gpt-5.1")),
        ("gemini-2.5-flash",   lambda: make_llm_policy(GeminiClient("gemini-2.5-flash"), name="gemini-2.5-flash")),
    ]

    summary = {}
    for name, factory in policies:
        try:
            summary[name] = run_policy(factory, name)
        except Exception as e:
            print(f"\n!! {name} crashed: {e}", flush=True)
            summary[name] = {"name": name, "error": str(e)}

    # Save (without raw decision logs in the human-readable summary)
    table = {
        "n_reps": N_REPS,
        "policies": {
            name: {
                "elapsed_s": v.get("elapsed_s"),
                "agg": v.get("agg"),
                "per_rep": v.get("per_rep"),
                "error": v.get("error"),
            }
            for name, v in summary.items()
        },
    }
    (OUTDIR / "summary.json").write_text(json.dumps(table, indent=2))
    # Save full traces (with decisions) separately for inspection
    full = {name: v for name, v in summary.items()}
    (OUTDIR / "full_traces.json").write_text(json.dumps(full, indent=2, default=str))

    # Pretty markdown table to stdout
    print("\n\n=== RESULTS TABLE ===")
    print(f"{'policy':<22s}  {'mean':>11s}  {'p95':>11s}  {'sev1':>10s}  {'sev3':>10s}  {'util':>11s}  {'lat_ms':>7s}")
    for name, v in summary.items():
        if v.get("error"):
            print(f"{name:<22s}  ERROR: {v['error'][:60]}")
            continue
        a = v["agg"]
        print(
            f"{name:<22s}  "
            f"{a['mean_wait']['mean']:5.1f} ± {a['mean_wait']['stdev']:4.1f}  "
            f"{a['p95_wait']['mean']:5.1f} ± {a['p95_wait']['stdev']:4.1f}  "
            f"{a['wait_sev1']['mean']:5.1f} ± {a['wait_sev1']['stdev']:4.1f}  "
            f"{a['wait_sev3']['mean']:5.1f} ± {a['wait_sev3']['stdev']:4.1f}  "
            f"{a['utilisation']['mean']:.2f} ± {a['utilisation']['stdev']:.2f}   "
            f"{a['mean_dec_latency']['mean']*1000:5.0f}"
        )


if __name__ == "__main__":
    main()
