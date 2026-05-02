"""
Verification harness: run the (fixed) ER simulation under several parameter
sets and compare each pool's realised metrics against multi-server queueing
theory. Used as a sanity check after any change to ``er_simulation.py``.

Theory used
-----------
- Severity ~ Uniform integer [1, 10].
  P(severity >= threshold) -> share of arrivals routed to critical care.
- Per-pool arrival rate:        lambda_pool = lambda_total * p_pool
- Per-pool mean service time:   ES_pool = (a + b + c) / 3   for triangular(a, mode, c)
- Per-pool service-time variance and coefficient of variation:
        Var = (a^2 + b^2 + c^2 - ab - ac - bc) / 18
        CV2 = Var / ES_pool^2
- Per-server utilisation:       rho = lambda_pool * ES_pool / c_servers
- Erlang-C (probability that an arriving customer waits):
        C(c, a)  where  a = lambda * ES   (offered load in Erlangs)
- Mean queue length / wait (M/M/c, the upper bound of M/G/c with low CV2):
        Lq_MMc = C(c, a) * rho / (1 - rho)
        Wq_MMc = Lq_MMc / lambda_pool
- Allen-Cunneen approximation for M/G/c:
        Wq_MGc  ~  Wq_MMc * (1 + CV2_S) / 2
        Lq_MGc  =  lambda_pool * Wq_MGc
- Mean time in system: W = Wq + ES
"""

from __future__ import annotations

import math
import statistics
import sys

from er_simulation import run_experiment, DEFAULT_SETTINGS


# ---------------------------------------------------------------------------
# Queueing-theory helpers
# ---------------------------------------------------------------------------

def triangular_mean(a: float, b: float, c: float) -> float:
    """Mean of Triangular(a, mode=b, c)."""
    return (a + b + c) / 3.0


def triangular_var(a: float, b: float, c: float) -> float:
    """Variance of Triangular(a, mode=b, c)."""
    return (a * a + b * b + c * c - a * b - a * c - b * c) / 18.0


def erlang_c(c: int, a: float) -> float:
    """Erlang-C: probability that an arriving customer must wait, given
    offered load ``a`` Erlangs and ``c`` parallel servers. Returns 1.0 if
    the system is unstable (a >= c)."""
    if c <= 0:
        return 1.0
    if a >= c:
        return 1.0
    s = 0.0
    for k in range(c):
        s += a ** k / math.factorial(k)
    last = (a ** c) / (math.factorial(c) * (1.0 - a / c))
    return last / (s + last)


def queueing_predictions(lambda_pool: float, es_pool: float, cv2_s: float,
                         c_servers: int) -> dict:
    """Closed-form predictions for one pool. Returns dict with rho, Lq, Wq, W."""
    if c_servers <= 0 or lambda_pool <= 0:
        return {"rho": 0.0, "Lq": 0.0, "Wq": 0.0, "W": es_pool, "stable": True}
    a = lambda_pool * es_pool
    rho = a / c_servers
    if rho >= 1.0:
        return {"rho": rho, "Lq": float("inf"), "Wq": float("inf"),
                "W": float("inf"), "stable": False}
    cw = erlang_c(c_servers, a)
    lq_mmc = cw * rho / (1.0 - rho)
    wq_mmc = lq_mmc / lambda_pool
    # Allen-Cunneen M/G/c correction
    wq = wq_mmc * (1.0 + cv2_s) / 2.0
    lq = lambda_pool * wq
    return {"rho": rho, "Lq": lq, "Wq": wq, "W": wq + es_pool, "stable": True}


# ---------------------------------------------------------------------------
# Test harness
# ---------------------------------------------------------------------------

def run_and_compare(label: str, overrides: dict, warmup_frac: float = 0.2):
    """Run the simulation once with the given overrides, then compare each
    pool's empirical mean wait/queue length against M/G/c predictions."""
    print("\n" + "=" * 78)
    print(f"Scenario: {label}")
    print("=" * 78)

    cfg = {**DEFAULT_SETTINGS, **overrides, "verbose": False}
    print(f"  arrival_mean   = {cfg['arrival_mean']} min")
    print(f"  critical_beds  = {cfg['critical_beds']}")
    print(f"  standard_beds  = {cfg['standard_beds']}")
    print(f"  duration       = {cfg['duration']} min")
    print(f"  strategy       = {cfg['selection_strategy']}")
    print(f"  replications   = {cfg['n_replications']}")

    # Theory
    lam = 1.0 / cfg["arrival_mean"]
    p_crit = (cfg["severity_max"] - cfg["critical_threshold"] + 1) / \
             (cfg["severity_max"] - cfg["severity_min"] + 1)
    p_std = 1.0 - p_crit
    es_crit = triangular_mean(*cfg["critical_tri"])
    es_std = triangular_mean(*cfg["standard_tri"])
    var_crit = triangular_var(*cfg["critical_tri"])
    var_std = triangular_var(*cfg["standard_tri"])
    cv2_crit = var_crit / (es_crit ** 2)
    cv2_std = var_std / (es_std ** 2)

    pred_crit = queueing_predictions(lam * p_crit, es_crit, cv2_crit, cfg["critical_beds"])
    pred_std = queueing_predictions(lam * p_std, es_std, cv2_std, cfg["standard_beds"])

    print(f"\n  THEORY (M/G/c, Allen-Cunneen):")
    _print_pred("    Critical", pred_crit, es_crit, cv2_crit)
    _print_pred("    Standard", pred_std, es_std, cv2_std)

    # Simulation (silently)
    saved_stdout = sys.stdout
    sys.stdout = open("nul", "w") if sys.platform == "win32" else open("/dev/null", "w")
    try:
        results = run_experiment(cfg)
    finally:
        sys.stdout.close()
        sys.stdout = saved_stdout

    # Aggregate across replications, with warm-up trimming on queue samples.
    sim_crit = _aggregate_pool(results, "critical", warmup_frac)
    sim_std = _aggregate_pool(results, "standard", warmup_frac)

    print(f"\n  SIMULATION (mean across {len(results)} replication(s), "
          f"warmup = first {int(warmup_frac*100)}% trimmed):")
    _print_sim("    Critical", sim_crit)
    _print_sim("    Standard", sim_std)

    print(f"\n  VALIDATION (sim vs theory, ratio = sim / theory):")
    _print_validation("    Critical", sim_crit, pred_crit)
    _print_validation("    Standard", sim_std, pred_std)


def _print_pred(label, pred, es, cv2):
    if not pred["stable"]:
        print(f"  {label}:  rho = {pred['rho']:.3f}  --> UNSTABLE (queue diverges)")
    else:
        print(f"  {label}:  rho = {pred['rho']:.3f}  Lq = {pred['Lq']:.2f}  "
              f"Wq = {pred['Wq']:.2f}  W = {pred['W']:.2f}  "
              f"(ES = {es:.2f}, CV^2 = {cv2:.3f})")


def _aggregate_pool(results, pool: str, warmup_frac: float) -> dict:
    capacity = getattr(results[0], f"{pool}_stats").capacity
    duration = results[0].duration
    rhos, lqs, wqs, ws = [], [], [], []
    for r in results:
        s = getattr(r, f"{pool}_stats")
        util = s.busy_time / (duration * capacity) if capacity else 0.0
        # Lq: average of queue samples, trimming warmup.
        n = len(s.queue_samples)
        cut = int(n * warmup_frac)
        tail = s.queue_samples[cut:] if cut < n else s.queue_samples
        lq = statistics.mean(tail) if tail else 0.0
        # Wq, W: average over patients of this pool whose treatment ended
        # within the duration. Trim by arrival time as a warm-up proxy.
        warmup_t = duration * warmup_frac
        pool_patients = [p for p in r.patients
                         if p.bed_type == pool and p.arrival_time >= warmup_t
                         and p.treatment_end is not None]
        wq = statistics.mean(p.wait_time for p in pool_patients) if pool_patients else 0.0
        w = statistics.mean(p.time_in_system for p in pool_patients) if pool_patients else 0.0
        rhos.append(util); lqs.append(lq); wqs.append(wq); ws.append(w)
    return {
        "rho":      statistics.mean(rhos),
        "Lq":       statistics.mean(lqs),
        "Wq":       statistics.mean(wqs),
        "W":        statistics.mean(ws),
        "served":   sum(getattr(r, f"{pool}_stats").served for r in results),
        "capacity": capacity,
    }


def _print_sim(label, sim):
    print(f"  {label}:  rho = {sim['rho']:.3f}  Lq = {sim['Lq']:.2f}  "
          f"Wq = {sim['Wq']:.2f}  W = {sim['W']:.2f}  "
          f"(c = {sim['capacity']}, served = {sim['served']})")


def _print_validation(label, sim, pred):
    if not pred["stable"]:
        # Just check that the sim utilisation is at or above 95% (saturated).
        ok = sim["rho"] >= 0.95
        mark = "[OK]" if ok else "[FAIL]"
        print(f"  {label}:  predicted UNSTABLE; sim rho = {sim['rho']:.3f}  "
              f"({'saturated, queue grew' if ok else 'NOT saturated as expected'}) {mark}")
        return
    def ratio(a, b):
        return float("inf") if b == 0 else a / b
    rho_r = ratio(sim["rho"], pred["rho"])
    lq_r = ratio(sim["Lq"], pred["Lq"]) if pred["Lq"] > 0 else float("nan")
    wq_r = ratio(sim["Wq"], pred["Wq"]) if pred["Wq"] > 0 else float("nan")
    w_r = ratio(sim["W"], pred["W"])

    def mark(r, lo=0.85, hi=1.15):
        if math.isnan(r):
            return "[N/A]"
        return "[OK]" if (lo <= r <= hi) else "[CHECK]"

    print(f"  {label}:")
    print(f"    rho:  sim {sim['rho']:.3f}  /  thy {pred['rho']:.3f}  "
          f"= {rho_r:.2f}x  {mark(rho_r, 0.85, 1.15)}")
    if not math.isnan(lq_r):
        print(f"    Lq :  sim {sim['Lq']:.3f}   /  thy {pred['Lq']:.3f}   "
              f"= {lq_r:.2f}x  {mark(lq_r, 0.6, 1.6)}")
    if not math.isnan(wq_r):
        print(f"    Wq :  sim {sim['Wq']:.3f}   /  thy {pred['Wq']:.3f}   "
              f"= {wq_r:.2f}x  {mark(wq_r, 0.6, 1.6)}")
    print(f"    W  :  sim {sim['W']:.3f}   /  thy {pred['W']:.3f}   "
          f"= {w_r:.2f}x  {mark(w_r, 0.85, 1.20)}")


# ---------------------------------------------------------------------------
# Scenarios
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    # Scenario 1: original defaults (2 critical, 4 standard) over a long run.
    # Critical pool is borderline unstable (rho > 1); standard pool is stable.
    run_and_compare("Defaults from paper, long run (2 crit / 4 std, 6000 min)", {
        "critical_beds":   2,
        "standard_beds":   4,
        "duration":        6000.0,
        "n_replications":  3,
    })

    # Scenario 2: stable critical pool (3 critical beds) -- both pools stable.
    run_and_compare("Stable: 3 crit / 4 std, 6000 min", {
        "critical_beds":   3,
        "standard_beds":   4,
        "duration":        6000.0,
        "n_replications":  3,
    })

    # Scenario 3: higher load (faster arrivals, larger staffing)
    run_and_compare("Higher load: lambda 1/4, 4 crit / 6 std, 6000 min", {
        "arrival_mean":    4.0,
        "critical_beds":   4,
        "standard_beds":   6,
        "duration":        6000.0,
        "n_replications":  3,
    })

    # Scenario 4: low load (many beds) -- both pools very lightly loaded
    run_and_compare("Low load: 5 crit / 8 std, 4000 min", {
        "critical_beds":   5,
        "standard_beds":   8,
        "duration":        4000.0,
        "n_replications":  3,
    })

    # Scenario 5: ShortestExpectedTreatment strategy on the stable config.
    # Strategy doesn't change utilisation or Lq (work-conserving), so theory
    # values are the same as Scenario 2. Used to verify the alternate code
    # path produces the same aggregate behaviour.
    run_and_compare("Strategy = ShortestExpectedTreatment (3 crit / 4 std)", {
        "critical_beds":      3,
        "standard_beds":      4,
        "duration":           6000.0,
        "n_replications":     3,
        "selection_strategy": "ShortestExpectedTreatment",
    })

    # Scenario 6: edge case -- single bed in each pool. Tests that the
    # multi-worker design degenerates correctly to c=1 per pool.
    run_and_compare("Edge: 1 crit / 1 std, light arrivals (mean=20 min)", {
        "arrival_mean":    20.0,
        "critical_beds":   1,
        "standard_beds":   1,
        "duration":        6000.0,
        "n_replications":  3,
    })

    # Scenario 7: stress test -- very high arrival rate, both pools busy
    # but stable.
    run_and_compare("Stress: lambda 1/3, 6 crit / 8 std, 6000 min", {
        "arrival_mean":    3.0,
        "critical_beds":   6,
        "standard_beds":   8,
        "duration":        6000.0,
        "n_replications":  3,
    })
