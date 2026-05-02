"""
Emergency Room (ER) Discrete-Event Simulation — SimPy

Generated from the structured prompt in Figure 8 of:
    Dehghanimohammadabadi, Belsare, and Sadeghi (2025).
    "A Tutorial on Generative AI and Simulation Modeling Integration."
    Proceedings of the 2025 Winter Simulation Conference.

Scenario
--------
Patients arrive following an exponential inter-arrival distribution (mean = 6 min).
Each patient is triaged with a severity score in [1, 10]:
    severity >= 7 -> CriticalCareBeds, treatment ~ triangular(20, 30, 45)
    severity <  7 -> StandardBeds,     treatment ~ triangular(10, 15, 25)

Selection strategies
--------------------
    "FIFO"                     : earliest arrival served first
    "ShortestExpectedTreatment": severity-based proxy; lower severity (within
                                 the same bed pool) implies shorter expected
                                 treatment, served first

Run
---
    python er_simulation.py
"""

from __future__ import annotations

import random
import statistics
from dataclasses import dataclass, field
from typing import Callable

import simpy


# ---------------------------------------------------------------------------
# Defaults
# ---------------------------------------------------------------------------

DEFAULT_SETTINGS: dict = {
    "arrival_mean":          6.0,        # minutes between arrivals (exp mean)
    "critical_beds":         2,
    "standard_beds":         4,
    "selection_strategy":    "FIFO",     # or "ShortestExpectedTreatment"
    "n_replications":        1,
    "duration":              500.0,      # simulated minutes
    "severity_min":          1,
    "severity_max":          10,
    "critical_threshold":    7,          # severity >= threshold -> critical
    "critical_tri":          (20, 30, 45),
    "standard_tri":          (10, 15, 25),
    "seed":                  42,
    "verbose":               True,
}


# ---------------------------------------------------------------------------
# Data classes
# ---------------------------------------------------------------------------

@dataclass
class Patient:
    pid: int
    arrival_time: float
    severity: int
    bed_type: str                     # "critical" or "standard"
    expected_treatment: float         # severity-based proxy used for sorting
    queue_entry_time: float | None = None
    bed_assigned_time: float | None = None
    treatment_start: float | None = None
    treatment_end: float | None = None
    treatment_duration: float | None = None

    @property
    def wait_time(self) -> float:
        return (self.bed_assigned_time or 0.0) - self.arrival_time

    @property
    def time_in_system(self) -> float:
        return (self.treatment_end or 0.0) - self.arrival_time


@dataclass
class ResourceStats:
    name: str
    capacity: int
    served: int = 0
    busy_time: float = 0.0
    queue_samples: list[int] = field(default_factory=list)


@dataclass
class RunResult:
    patients: list[Patient]
    critical_stats: ResourceStats
    standard_stats: ResourceStats
    duration: float
    log: list[str]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _log(env: simpy.Environment, log: list[str], pid: int | None, msg: str,
         verbose: bool) -> None:
    line = f"[t={env.now:7.2f}]  pid={pid if pid is not None else '-':>3}  {msg}"
    log.append(line)
    if verbose:
        print(line)


def select_next_patient(waiting_list: list[Patient], strategy: str) -> Patient:
    """Pick the next patient from a waiting list according to the strategy.

    The waiting list is mutated: the chosen patient is removed and returned.
    """
    if not waiting_list:
        raise ValueError("waiting_list is empty")

    if strategy == "FIFO":
        return waiting_list.pop(0)

    if strategy == "ShortestExpectedTreatment":
        idx = min(
            range(len(waiting_list)),
            key=lambda i: waiting_list[i].expected_treatment,
        )
        return waiting_list.pop(idx)

    raise ValueError(f"Unknown selection strategy: {strategy!r}")


def _expected_treatment(severity: int, settings: dict) -> float:
    """Severity-based proxy for expected treatment time.

    Within each bed pool, lower severity implies shorter expected treatment.
    The absolute value is only used for sorting under
    'ShortestExpectedTreatment'.
    """
    lo, mode, hi = (
        settings["critical_tri"]
        if severity >= settings["critical_threshold"]
        else settings["standard_tri"]
    )
    span = hi - lo
    s_min = settings["severity_min"]
    s_max = settings["severity_max"]
    return lo + span * ((severity - s_min) / max(1, s_max - s_min))


# ---------------------------------------------------------------------------
# Process functions
# ---------------------------------------------------------------------------

def treat_patient(env: simpy.Environment, patient: Patient, settings: dict,
                  log: list[str]):
    """Sample the treatment duration and time-out for it."""
    rng = settings["_rng"]
    if patient.bed_type == "critical":
        lo, mode, hi = settings["critical_tri"]
    else:
        lo, mode, hi = settings["standard_tri"]
    duration = rng.triangular(lo, mode, hi)
    patient.treatment_duration = duration
    patient.treatment_start = env.now
    _log(env, log, patient.pid,
         f"treatment START ({patient.bed_type}, dur={duration:.2f})",
         settings["verbose"])
    yield env.timeout(duration)
    patient.treatment_end = env.now
    _log(env, log, patient.pid, "treatment END", settings["verbose"])


def patient_process(env: simpy.Environment, patient: Patient,
                  waiting_lists: dict[str, list[Patient]],
                  new_arrival_events: dict[str, simpy.Event],
                  settings: dict, log: list[str]) -> None:
    """Patient arrives, is triaged, and is placed on the waiting list.
    Treatment is driven by the per-bed worker processes."""
    _log(env, log, patient.pid,
         f"ARRIVAL  severity={patient.severity}  -> {patient.bed_type}",
         settings["verbose"])

    patient.queue_entry_time = env.now
    waiting_lists[patient.bed_type].append(patient)
    _log(env, log, patient.pid, f"queued ({patient.bed_type})",
         settings["verbose"])

    # Wake every worker currently parked on the arrival event for this
    # bed type, then install a fresh event so subsequent arrivals can
    # wake workers that re-park after losing the race for this patient.
    ev = new_arrival_events[patient.bed_type]
    new_arrival_events[patient.bed_type] = env.event()
    if not ev.triggered:
        ev.succeed()


def bed_worker(env: simpy.Environment, bed_id: int, bed_type: str,
               stats: ResourceStats,
               waiting_lists: dict[str, list[Patient]],
               new_arrival_events: dict[str, simpy.Event],
               served_patients: list[Patient],
               settings: dict, log: list[str]):
    """One worker per bed slot. The worker IS a bed: it pulls one patient
    at a time off the shared waiting list using the configured selection
    strategy, runs that patient's treatment, then loops.

    Spawning ``c`` workers per pool gives the pool true ``c``-server
    parallelism. With this design the realised utilisation and queue
    length track classical multi-server queueing theory (Erlang-C for
    M/M/c, Allen-Cunneen for M/G/c). A single per-pool controller would
    serialise treatments and force effective capacity = 1 regardless of
    the configured bed count.
    """
    strategy = settings["selection_strategy"]

    while True:
        # Wait for a patient of this type. Multiple workers may share the
        # same arrival event; the first one to run grabs the patient via
        # ``select_next_patient``, the rest find the list empty and
        # re-park on the freshly installed event.
        while not waiting_lists[bed_type]:
            yield new_arrival_events[bed_type]

        if not waiting_lists[bed_type]:
            continue

        patient = select_next_patient(waiting_lists[bed_type], strategy)
        patient.bed_assigned_time = env.now
        stats.served += 1
        _log(env, log, patient.pid,
             f"bed assigned ({bed_type}/bed{bed_id})  wait={patient.wait_time:.2f}",
             settings["verbose"])

        # Append at ASSIGNMENT time, not at completion. This way wait_time
        # statistics include patients whose treatment is still in progress
        # when the simulation horizon is reached, which would otherwise be
        # silently censored under heavy load and bias the realised Wq low.
        served_patients.append(patient)

        t0 = env.now
        yield env.process(treat_patient(env, patient, settings, log))
        stats.busy_time += env.now - t0


def arrivals(env: simpy.Environment, waiting_lists, new_arrival_events,
             settings: dict, log: list[str]):
    """Poisson arrivals: exponential inter-arrival times."""
    rng = settings["_rng"]
    pid = 0
    while True:
        yield env.timeout(rng.expovariate(1.0 / settings["arrival_mean"]))
        pid += 1
        severity = rng.randint(settings["severity_min"], settings["severity_max"])
        bed_type = (
            "critical"
            if severity >= settings["critical_threshold"]
            else "standard"
        )
        patient = Patient(
            pid=pid,
            arrival_time=env.now,
            severity=severity,
            bed_type=bed_type,
            expected_treatment=_expected_treatment(severity, settings),
        )
        patient_process(env, patient, waiting_lists,
                      new_arrival_events, settings, log)


def queue_sampler(env: simpy.Environment,
                  waiting_lists: dict[str, list[Patient]],
                  critical_stats: ResourceStats,
                  standard_stats: ResourceStats,
                  step: float = 1.0):
    while True:
        critical_stats.queue_samples.append(len(waiting_lists["critical"]))
        standard_stats.queue_samples.append(len(waiting_lists["standard"]))
        yield env.timeout(step)


# ---------------------------------------------------------------------------
# Run controllers
# ---------------------------------------------------------------------------

def run_single_simulation(settings: dict | None = None) -> RunResult:
    cfg = {**DEFAULT_SETTINGS, **(settings or {})}
    cfg["_rng"] = random.Random(cfg["seed"])

    env = simpy.Environment()

    waiting_lists: dict[str, list[Patient]] = {"critical": [], "standard": []}
    new_arrival_events = {
        "critical": env.event(),
        "standard": env.event(),
    }

    critical_stats = ResourceStats("CriticalCareBeds", cfg["critical_beds"])
    standard_stats = ResourceStats("StandardBeds", cfg["standard_beds"])
    served: list[Patient] = []
    log: list[str] = []

    env.process(arrivals(env, waiting_lists, new_arrival_events, cfg, log))

    # Spawn one bed_worker per bed slot. With ``c`` workers per pool the
    # pool delivers true ``c``-server parallelism, so realised utilisation
    # and queue length match multi-server queueing theory.
    for bed_id in range(cfg["critical_beds"]):
        env.process(bed_worker(env, bed_id, "critical", critical_stats,
                               waiting_lists, new_arrival_events,
                               served, cfg, log))
    for bed_id in range(cfg["standard_beds"]):
        env.process(bed_worker(env, bed_id, "standard", standard_stats,
                               waiting_lists, new_arrival_events,
                               served, cfg, log))

    env.process(queue_sampler(env, waiting_lists, critical_stats, standard_stats))

    env.run(until=cfg["duration"])

    # Credit busy_time for any worker still mid-treatment at the run horizon.
    # Without this, occupancy is only booked when ``treat_patient`` returns,
    # so partial service intervals at termination are dropped and realised
    # rho is biased low (most visible in short or heavily loaded runs).
    for pt in served:
        if pt.treatment_start is not None and pt.treatment_end is None:
            partial = max(0.0, cfg["duration"] - pt.treatment_start)
            if pt.bed_type == "critical":
                critical_stats.busy_time += partial
            else:
                standard_stats.busy_time += partial

    return RunResult(
        patients=served,
        critical_stats=critical_stats,
        standard_stats=standard_stats,
        duration=cfg["duration"],
        log=log,
    )


def _summary_block(label: str, values: list[float]) -> str:
    if not values:
        return f"  {label}: (no observations)"
    return (
        f"  {label}: n={len(values):3d}  "
        f"mean={statistics.mean(values):7.2f}  "
        f"min={min(values):6.2f}  "
        f"max={max(values):6.2f}  "
        f"stdev={(statistics.pstdev(values)):6.2f}"
    )


def summarize(result: RunResult) -> str:
    p = result.patients
    completed = [pt for pt in p if pt.treatment_end is not None]
    lines = []
    lines.append("=" * 72)
    lines.append(f"Simulation summary  (duration = {result.duration:.0f} min, "
                 f"assigned = {len(p)}, completed = {len(completed)})")
    lines.append("=" * 72)
    lines.append(_summary_block("time in system  ",
                                [pt.time_in_system for pt in completed]))
    lines.append(_summary_block("wait time       ",
                                [pt.wait_time for pt in p]))
    lines.append(_summary_block("treatment time  ",
                                [pt.treatment_duration for pt in completed
                                 if pt.treatment_duration is not None]))
    for stats in (result.critical_stats, result.standard_stats):
        util = (stats.busy_time / (result.duration * stats.capacity)
                if stats.capacity else 0.0)
        avg_q = (statistics.mean(stats.queue_samples)
                 if stats.queue_samples else 0.0)
        lines.append(
            f"  {stats.name:18s}  capacity={stats.capacity}  "
            f"served={stats.served}  utilization={util*100:5.1f}%  "
            f"avg_queue_len={avg_q:.2f}"
        )
    return "\n".join(lines)


def run_experiment(settings: dict | None = None) -> list[RunResult]:
    cfg = {**DEFAULT_SETTINGS, **(settings or {})}
    base_seed = cfg["seed"]
    results: list[RunResult] = []
    for r in range(cfg["n_replications"]):
        rep_cfg = {**cfg, "seed": base_seed + r}
        if cfg["n_replications"] > 1:
            rep_cfg["verbose"] = False
        result = run_single_simulation(rep_cfg)
        results.append(result)
        print(summarize(result))
        print()
    return results


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    print("ER Simulation — default settings (FIFO, 1 replication, 500 min)")
    run_experiment()

    print("\n" + "#" * 72)
    print("# Comparison run: ShortestExpectedTreatment, 3 replications")
    print("#" * 72 + "\n")
    run_experiment({
        "selection_strategy": "ShortestExpectedTreatment",
        "n_replications":     3,
        "duration":           500.0,
        "verbose":            False,
    })
