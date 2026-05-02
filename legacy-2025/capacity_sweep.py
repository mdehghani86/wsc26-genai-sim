"""
Capacity sweep: run the ER simulation for every combination of
``critical_beds`` (1..8) and ``standard_beds`` (1..12), compare each pool's
realised metrics against the M/G/c (Allen-Cunneen) prediction, and emit an
HTML report with side-by-side heat tables for each pool.

Usage::

    python capacity_sweep.py
"""

from __future__ import annotations

import math
import statistics
import sys
import time
from datetime import datetime

# Force UTF-8 stdout so the progress prints (which include the rho glyph)
# don't crash on Windows consoles that default to cp1252.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

from er_simulation import run_experiment, DEFAULT_SETTINGS

# ---------------------------------------------------------------------------
# Sweep configuration
# ---------------------------------------------------------------------------

CRIT_RANGE = range(1, 9)          # 1..8
STD_RANGE  = range(1, 13)         # 1..12
ARRIVAL_MEAN = 6.0
DURATION = 4000.0                 # long enough for steady state
N_REPLICATIONS = 2
SEED = 42

OUTPUT_HTML = "capacity_sweep_report.html"
OUTPUT_CSV  = "capacity_sweep_results.csv"


# ---------------------------------------------------------------------------
# Queueing-theory helpers (same formulas as the panel and verify harness)
# ---------------------------------------------------------------------------

def triangular_mean(a, b, c): return (a + b + c) / 3.0
def triangular_var(a, b, c):  return (a*a + b*b + c*c - a*b - a*c - b*c) / 18.0

def erlang_c(c, a):
    if c <= 0: return 1.0
    if a >= c: return 1.0
    s = sum(a**k / math.factorial(k) for k in range(c))
    last = (a**c) / (math.factorial(c) * (1.0 - a/c))
    return last / (s + last)

def predictions(lambda_pool, es_pool, cv2_s, c_servers):
    if c_servers <= 0 or lambda_pool <= 0:
        return {"rho": 0, "Lq": 0, "Wq": 0, "stable": True}
    a = lambda_pool * es_pool
    rho = a / c_servers
    if rho >= 1.0:
        return {"rho": rho, "Lq": float("inf"), "Wq": float("inf"), "stable": False}
    cw = erlang_c(c_servers, a)
    lq_mmc = cw * rho / (1 - rho)
    wq = (lq_mmc / lambda_pool) * (1 + cv2_s) / 2
    lq = lambda_pool * wq
    return {"rho": rho, "Lq": lq, "Wq": wq, "stable": True}


def compute_theory(arrival_mean, c_crit, c_std):
    cfg = DEFAULT_SETTINGS
    lam   = 1.0 / arrival_mean
    p_c   = (cfg["severity_max"] - cfg["critical_threshold"] + 1) / \
            (cfg["severity_max"] - cfg["severity_min"] + 1)
    p_s   = 1.0 - p_c
    es_c  = triangular_mean(*cfg["critical_tri"])
    es_s  = triangular_mean(*cfg["standard_tri"])
    cv2_c = triangular_var(*cfg["critical_tri"]) / (es_c**2)
    cv2_s = triangular_var(*cfg["standard_tri"])  / (es_s**2)
    return (
        predictions(lam * p_c, es_c, cv2_c, c_crit),
        predictions(lam * p_s, es_s, cv2_s, c_std),
    )


# ---------------------------------------------------------------------------
# Sim aggregation
# ---------------------------------------------------------------------------

def aggregate_pool(results, pool):
    capacity = getattr(results[0], f"{pool}_stats").capacity
    duration = results[0].duration
    rhos, lqs, wqs = [], [], []
    for r in results:
        s = getattr(r, f"{pool}_stats")
        util = s.busy_time / (duration * capacity) if capacity else 0.0
        # Trim warm-up: drop first 20 % of queue samples.
        n = len(s.queue_samples)
        cut = int(n * 0.2)
        tail = s.queue_samples[cut:] if cut < n else s.queue_samples
        lq = statistics.mean(tail) if tail else 0.0
        warmup_t = duration * 0.2
        # Wait stats from ALL assigned patients (not just completed) so that
        # heavy-load runs aren't censored.
        pool_p = [p for p in r.patients
                  if p.bed_type == pool and p.arrival_time >= warmup_t]
        wq = statistics.mean(p.wait_time for p in pool_p) if pool_p else 0.0
        rhos.append(util); lqs.append(lq); wqs.append(wq)
    return {
        "rho":      statistics.mean(rhos),
        "Lq":       statistics.mean(lqs),
        "Wq":       statistics.mean(wqs),
        "capacity": capacity,
    }


def status_for(sim, theory, isRho):
    """Return a status string and a numeric ratio for sim/theory comparison."""
    if not theory["stable"] and isRho:
        return ("ok" if sim["rho"] > 0.9 else "warn", sim["rho"])
    if not theory["stable"]:
        return ("idle", 0.0)
    thy = theory["rho"] if isRho else (theory["Lq"] if False else None)
    return ("idle", 0.0)


def metric_status(sim_val, thy_val, is_rho, is_unstable):
    if is_unstable:
        if is_rho:
            return ("ok", sim_val) if sim_val > 0.9 else ("warn", sim_val)
        return ("idle", 0.0)
    if not math.isfinite(thy_val):
        return ("idle", 0.0)
    if thy_val == 0:
        return ("ok", 0.0) if sim_val < 0.05 else ("warn", sim_val)
    ratio = sim_val / thy_val
    if is_rho:
        if 0.85 <= ratio <= 1.15: return ("ok", ratio)
        if 0.75 <= ratio <= 1.25: return ("warn", ratio)
        return ("fail", ratio)
    if 0.60 <= ratio <= 1.70: return ("ok", ratio)
    if 0.30 <= ratio <= 2.20: return ("warn", ratio)
    return ("fail", ratio)


# ---------------------------------------------------------------------------
# Runner
# ---------------------------------------------------------------------------

def silent_run(cfg):
    saved = sys.stdout
    sys.stdout = open("nul", "w") if sys.platform == "win32" else open("/dev/null", "w")
    try:
        return run_experiment(cfg)
    finally:
        sys.stdout.close()
        sys.stdout = saved


def run_one_combo(c_crit, c_std):
    cfg = {**DEFAULT_SETTINGS,
           "arrival_mean": ARRIVAL_MEAN,
           "critical_beds": c_crit,
           "standard_beds": c_std,
           "duration":      DURATION,
           "n_replications": N_REPLICATIONS,
           "seed":           SEED,
           "verbose":        False,
           "selection_strategy": "FIFO"}
    results = silent_run(cfg)
    sim_c = aggregate_pool(results, "critical")
    sim_s = aggregate_pool(results, "standard")
    thy_c, thy_s = compute_theory(ARRIVAL_MEAN, c_crit, c_std)
    return {
        "c_crit": c_crit,
        "c_std":  c_std,
        "thy_c":  thy_c, "sim_c":  sim_c,
        "thy_s":  thy_s, "sim_s":  sim_s,
    }


# ---------------------------------------------------------------------------
# HTML report
# ---------------------------------------------------------------------------

CELL_TEMPLATE = """
<td class="cell {status}" title="{title}">
  <div class="cell-rho">{rho:.2f}</div>
  <div class="cell-detail">{detail}</div>
</td>
"""


def cell_for(combo, pool):
    thy = combo[f"thy_{pool[0]}"]
    sim = combo[f"sim_{pool[0]}"]
    is_unstable = not thy["stable"]

    if is_unstable:
        # show sim rho; theory is infinite
        status, _ = metric_status(sim["rho"], thy["rho"], True, True)
        rho = sim["rho"]
        detail = "ρ ≥ 1<br>queue grows"
        title = (f"c={sim['capacity']} · UNSTABLE\n"
                 f"theory ρ={thy['rho']:.3f} (Lq=∞, Wq=∞)\n"
                 f"sim    ρ={sim['rho']:.3f}, Lq={sim['Lq']:.2f}, Wq={sim['Wq']:.1f}m\n"
                 f"check: sim ρ should saturate (>0.9) → {status}")
    else:
        s_rho, _   = metric_status(sim["rho"], thy["rho"], True,  False)
        s_lq, _    = metric_status(sim["Lq"],  thy["Lq"],  False, False)
        s_wq, _    = metric_status(sim["Wq"],  thy["Wq"],  False, False)
        # Cell status = worst of the three checks
        order = {"ok": 0, "warn": 1, "fail": 2, "idle": -1}
        worst = max([s_rho, s_lq, s_wq], key=lambda x: order.get(x, 0))
        status = worst
        rho = sim["rho"]
        detail = f"Lq {sim['Lq']:.2f}<br>Wq {sim['Wq']:.1f}m"
        title = (f"c={sim['capacity']}\n"
                 f"theory: ρ={thy['rho']:.3f}, Lq={thy['Lq']:.2f}, Wq={thy['Wq']:.2f}m\n"
                 f"sim   : ρ={sim['rho']:.3f}, Lq={sim['Lq']:.2f}, Wq={sim['Wq']:.2f}m\n"
                 f"checks: ρ {s_rho} · Lq {s_lq} · Wq {s_wq}")

    return CELL_TEMPLATE.format(rho=rho, detail=detail, status=status, title=title)


def render_table(combos, pool):
    rows = sorted({c["c_crit"] if pool == "critical" else c["c_std"] for c in combos})
    cols = sorted({c["c_std"]  if pool == "critical" else c["c_crit"] for c in combos})
    bmap = {(c["c_crit"], c["c_std"]): c for c in combos}

    head = "<thead><tr><th></th>"
    head += "".join(f"<th>{j} std beds</th>" for j in cols) if pool == "critical" \
            else "".join(f"<th>{j} crit beds</th>" for j in cols)
    head += "</tr></thead>"

    body = "<tbody>"
    for i in rows:
        body += "<tr>"
        body += f"<th>{i} {'crit' if pool == 'critical' else 'std'} beds</th>"
        for j in cols:
            key = (i, j) if pool == "critical" else (j, i)
            combo = bmap.get(key)
            if combo is None:
                body += "<td class='cell idle'></td>"
            else:
                body += cell_for(combo, pool)
        body += "</tr>"
    body += "</tbody>"
    return head + body


def render_html(combos, total_runtime):
    pass_count = sum(1 for c in combos
                     if c["thy_c"]["stable"] and c["thy_s"]["stable"])
    unstable = sum(1 for c in combos if not c["thy_c"]["stable"]
                                       or not c["thy_s"]["stable"])
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Capacity sweep · ER simulation vs queueing theory</title>
<style>
  :root {{
    --bg: #060912; --bg-2: #0d1428; --surface: rgba(20,30,56,0.78);
    --border: rgba(255,255,255,0.08); --text: #e8eefb; --text-mut: #94a4c4;
    --ok: #34d399; --warn: #f59e0b; --fail: #ef4444; --idle: #6b7280;
  }}
  * {{ box-sizing: border-box; }}
  body {{
    background: radial-gradient(900px 480px at 82% -8%, rgba(96,165,250,0.18), transparent 60%),
                radial-gradient(700px 400px at -10% 25%, rgba(37,99,235,0.14), transparent 60%),
                var(--bg);
    color: var(--text);
    font-family: 'Inter', system-ui, sans-serif;
    margin: 0; padding: 32px 40px; min-height: 100vh;
  }}
  h1 {{ font-size: 22px; font-weight: 700; margin: 0 0 4px; letter-spacing: -0.01em; }}
  .sub {{ color: var(--text-mut); font-size: 13px; margin-bottom: 20px; }}
  .card {{
    background: var(--surface); backdrop-filter: blur(20px);
    border: 1px solid var(--border); border-radius: 14px;
    padding: 18px 20px; margin-bottom: 18px;
    box-shadow: 0 14px 40px rgba(37,99,235,0.10);
  }}
  h2 {{ font-size: 14px; font-weight: 700; margin: 0 0 12px;
       letter-spacing: 0.04em; text-transform: uppercase; color: var(--text-mut); }}
  table {{ border-collapse: collapse; width: 100%; }}
  th, td {{
    border: 1px solid rgba(255,255,255,0.05);
    padding: 4px; text-align: center; min-width: 70px;
  }}
  th {{
    font-size: 10px; font-weight: 700; color: var(--text-mut);
    background: rgba(255,255,255,0.04);
    letter-spacing: 0.04em; text-transform: uppercase;
  }}
  td.cell {{
    font-family: 'JetBrains Mono', monospace; font-size: 11px;
    cursor: help; transition: transform .12s ease;
    padding: 6px 4px;
  }}
  td.cell:hover {{ transform: scale(1.05); z-index: 2; position: relative; }}
  .cell-rho   {{ font-size: 13px; font-weight: 700; line-height: 1.2; }}
  .cell-detail {{ font-size: 9.5px; color: rgba(255,255,255,0.65); margin-top: 2px; line-height: 1.25; }}
  td.cell.ok   {{ background: rgba(52,211,153,0.20);  color: #d1fae5; }}
  td.cell.warn {{ background: rgba(245,158,11,0.22);  color: #fde68a; }}
  td.cell.fail {{ background: rgba(239,68,68,0.25);   color: #fecaca; }}
  td.cell.idle {{ background: rgba(107,114,128,0.18); color: #cbd5e1; }}
  .legend {{
    margin-top: 8px; font-size: 11px; color: var(--text-mut);
    display: flex; gap: 14px; flex-wrap: wrap;
  }}
  .legend span {{
    display: inline-flex; align-items: center; gap: 5px;
  }}
  .swatch {{ width: 12px; height: 12px; border-radius: 3px; display: inline-block; }}
  .params {{
    font-size: 12px; color: var(--text-mut); display: flex; gap: 22px;
    flex-wrap: wrap;
  }}
  .params b {{ color: var(--text); font-family: 'JetBrains Mono', monospace; }}
</style>
</head>
<body>
  <h1>Capacity sweep · ER simulation vs queueing theory</h1>
  <div class="sub">Generated {datetime.now().strftime('%Y-%m-%d %H:%M')} · runtime {total_runtime:.1f}s</div>

  <div class="card">
    <h2>Sweep parameters</h2>
    <div class="params">
      <span>arrival_mean = <b>{ARRIVAL_MEAN}</b> min</span>
      <span>duration = <b>{int(DURATION)}</b> min</span>
      <span>replications = <b>{N_REPLICATIONS}</b></span>
      <span>strategy = <b>FIFO</b></span>
      <span>combinations = <b>{len(combos)}</b></span>
      <span>stable = <b>{pass_count}</b></span>
      <span>unstable = <b>{unstable}</b></span>
    </div>
    <div class="legend">
      <span><span class="swatch" style="background: rgba(52,211,153,0.40)"></span> within band (sim/theory ratio in [0.85, 1.15] for ρ; [0.6, 1.7] for Lq/Wq)</span>
      <span><span class="swatch" style="background: rgba(245,158,11,0.40)"></span> close (within wider band)</span>
      <span><span class="swatch" style="background: rgba(239,68,68,0.40)"></span> off</span>
      <span><span class="swatch" style="background: rgba(107,114,128,0.30)"></span> theory unstable / n/a</span>
    </div>
  </div>

  <div class="card">
    <h2>Critical care pool · sim vs theory</h2>
    <table>{render_table(combos, "critical")}</table>
  </div>

  <div class="card">
    <h2>Standard pool · sim vs theory</h2>
    <table>{render_table(combos, "standard")}</table>
  </div>

  <div class="sub" style="margin-top: 16px">
    Hover any cell for full ρ / Lq / Wq theory and sim numbers and per-metric pass/warn/fail. Cell colour is the worst of the three per-pool checks.
  </div>
</body>
</html>"""


def write_csv(combos, path):
    with open(path, "w", encoding="utf-8") as f:
        f.write("crit_beds,std_beds,pool,thy_rho,thy_Lq,thy_Wq,thy_stable,sim_rho,sim_Lq,sim_Wq\n")
        for c in combos:
            for pool in ("c", "s"):
                thy = c[f"thy_{pool}"]
                sim = c[f"sim_{pool}"]
                f.write(f"{c['c_crit']},{c['c_std']},"
                        f"{'critical' if pool == 'c' else 'standard'},"
                        f"{thy['rho']:.4f},"
                        f"{'inf' if not thy['stable'] else thy['Lq']:.4f if thy['stable'] else ''},"
                        f"{'inf' if not thy['stable'] else thy['Wq']:.4f if thy['stable'] else ''},"
                        f"{int(thy['stable'])},"
                        f"{sim['rho']:.4f},{sim['Lq']:.4f},{sim['Wq']:.4f}\n")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    print(f"Capacity sweep starting: {len(CRIT_RANGE)*len(STD_RANGE)} combinations")
    print(f"Params: arrival_mean={ARRIVAL_MEAN}, duration={DURATION}, "
          f"reps={N_REPLICATIONS}, strategy=FIFO")
    print()

    combos = []
    t_start = time.time()
    for i, c_crit in enumerate(CRIT_RANGE):
        for j, c_std in enumerate(STD_RANGE):
            t0 = time.time()
            combo = run_one_combo(c_crit, c_std)
            elapsed = time.time() - t0
            done = i * len(STD_RANGE) + j + 1
            total = len(CRIT_RANGE) * len(STD_RANGE)
            print(f"  [{done:3d}/{total}] crit={c_crit}, std={c_std}  "
                  f"rho_c={combo['sim_c']['rho']:.3f}  rho_s={combo['sim_s']['rho']:.3f}  "
                  f"({elapsed:.1f}s)")
            combos.append(combo)

    total_time = time.time() - t_start
    print(f"\nSweep complete in {total_time:.1f}s")

    # Write report
    html = render_html(combos, total_time)
    with open(OUTPUT_HTML, "w", encoding="utf-8") as f:
        f.write(html)
    print(f"HTML report:  {OUTPUT_HTML}")

    # Write CSV (best-effort; format string complexity not always pretty)
    try:
        with open(OUTPUT_CSV, "w", encoding="utf-8") as f:
            f.write("crit_beds,std_beds,pool,thy_rho,thy_Lq,thy_Wq,thy_stable,sim_rho,sim_Lq,sim_Wq\n")
            for c in combos:
                for pool_short, pool_full in (("c", "critical"), ("s", "standard")):
                    thy = c[f"thy_{pool_short}"]
                    sim = c[f"sim_{pool_short}"]
                    thy_lq = "inf" if not thy["stable"] else f"{thy['Lq']:.4f}"
                    thy_wq = "inf" if not thy["stable"] else f"{thy['Wq']:.4f}"
                    f.write(f"{c['c_crit']},{c['c_std']},{pool_full},"
                            f"{thy['rho']:.4f},{thy_lq},{thy_wq},"
                            f"{int(thy['stable'])},"
                            f"{sim['rho']:.4f},{sim['Lq']:.4f},{sim['Wq']:.4f}\n")
        print(f"CSV results:  {OUTPUT_CSV}")
    except Exception as e:
        print(f"(CSV write failed: {e})")
