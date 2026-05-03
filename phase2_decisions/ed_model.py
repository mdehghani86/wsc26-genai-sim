"""ED admission simulation with pluggable triage policies.

Stage 2 (Execution) artefact for the WSC 2026 tutorial. The simulation
is intentionally small (B=4 beds, ~25 patients/rep) so it fits the
in-tutorial token budget for LLM-driven policies.

The decision point is at admission: whenever a bed is free AND the queue
holds more than one waiting patient, which patient do we admit next?
This is the substantive triage decision -- the bed itself is fungible.

Policies are pure functions of the current system state:
  policy(state) -> queue index in [0, len(queue))
"""

from __future__ import annotations

import random
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Callable, Optional

import simpy


@dataclass
class Patient:
    pid: int
    severity: int           # 1 = urgent, 2 = moderate, 3 = routine
    arrival_time: float
    service_time: float     # length of stay once in a bed (minutes)
    bed_idx: Optional[int] = None
    admit_time: Optional[float] = None
    discharge_time: Optional[float] = None

    @property
    def wait(self) -> float:
        return (self.admit_time or 0) - self.arrival_time


@dataclass
class BedState:
    idx: int
    busy: bool = False
    occupant: Optional[Patient] = None
    expected_release: float = 0.0
    served: int = 0


@dataclass
class SimState:
    """Snapshot passed to a policy at each admission decision.

    The policy must return an index into `queue`.
    """
    now: float
    beds: list[BedState]
    queue: list[Patient]
    free_bed_idx: int            # bed that just became free (or any free bed)
    history: list[dict] = field(default_factory=list)


# Type alias: returns queue index of the patient to admit next
Policy = Callable[[SimState], int]


def gen_patient(pid: int, t: float, rng: random.Random) -> Patient:
    """Severity-stratified service time, in minutes."""
    sev_probs = [0.20, 0.45, 0.35]
    r = rng.random()
    if r < sev_probs[0]:
        sev = 1
        mu, sigma = 4.44, 0.32      # mean ~ 90 min
    elif r < sev_probs[0] + sev_probs[1]:
        sev = 2
        mu, sigma = 4.05, 0.28      # mean ~ 60 min
    else:
        sev = 3
        mu, sigma = 3.50, 0.25      # mean ~ 35 min
    s = rng.lognormvariate(mu, sigma)
    return Patient(pid=pid, severity=sev, arrival_time=t, service_time=s)


def run_replication(
    policy: Policy,
    *,
    n_beds: int = 4,
    n_patients: int = 25,
    inter_arr_mean: float = 12.0,   # tighter to create real queueing
    seed: int = 0,
    decision_log: Optional[list] = None,
) -> dict:
    rng = random.Random(seed)
    env = simpy.Environment()
    beds = [BedState(idx=i) for i in range(n_beds)]
    queue: list[Patient] = []
    completed: list[Patient] = []
    history: deque[dict] = deque(maxlen=8)
    decision_latency: list[float] = []
    n_real_decisions = 0   # decisions where queue had >1 candidate

    def admit_to(patient: Patient, bed: BedState):
        bed.busy = True
        bed.occupant = patient
        bed.expected_release = env.now + patient.service_time
        bed.served += 1
        patient.bed_idx = bed.idx
        patient.admit_time = env.now
        env.process(discharge_after_los(patient))

    def discharge_after_los(patient: Patient):
        yield env.timeout(patient.service_time)
        patient.discharge_time = env.now
        bed = beds[patient.bed_idx]
        bed.busy = False
        bed.occupant = None
        bed.expected_release = env.now
        completed.append(patient)
        env.process(try_admit())

    def try_admit():
        nonlocal n_real_decisions
        if False:
            yield  # generator marker
        free = [b for b in beds if not b.busy]
        if not free or not queue:
            return
        # take the lowest-index free bed; the bed itself is fungible
        bed = sorted(free, key=lambda b: b.idx)[0]
        if len(queue) == 1:
            chosen_idx = 0
        else:
            n_real_decisions += 1
            state = SimState(
                now=env.now,
                beds=beds,
                queue=list(queue),     # snapshot
                free_bed_idx=bed.idx,
                history=list(history),
            )
            t0 = time.time()
            chosen_idx = policy(state)
            decision_latency.append(time.time() - t0)
            if not (0 <= chosen_idx < len(queue)):
                chosen_idx = 0
        chosen = queue.pop(chosen_idx)
        rec = {
            "t": round(env.now, 1),
            "pid": chosen.pid,
            "sev": chosen.severity,
            "wait_so_far": round(env.now - chosen.arrival_time, 1),
            "queue_len_before": len(queue) + 1,
            "queue_idx_chosen": chosen_idx,
            "bed_used": bed.idx,
        }
        history.append(rec)
        if decision_log is not None:
            decision_log.append(rec)
        admit_to(chosen, bed)

    def arrival_proc():
        for pid in range(n_patients):
            iat = rng.expovariate(1.0 / inter_arr_mean)
            yield env.timeout(iat)
            patient = gen_patient(pid, env.now, rng)
            queue.append(patient)
            env.process(try_admit())

    env.process(arrival_proc())
    env.run()

    end_t = env.now
    # patients still queued at end -> pin admit/discharge to end_t
    for p in queue:
        p.admit_time = end_t
        p.discharge_time = end_t
        completed.append(p)

    waits = [p.wait for p in completed]
    sev_w_waits = [p.wait * (4 - p.severity) for p in completed]
    waits_by_sev = {1: [], 2: [], 3: []}
    for p in completed:
        waits_by_sev[p.severity].append(p.wait)
    busy_time = sum(
        min(p.discharge_time, end_t) - p.admit_time
        for p in completed if p.bed_idx is not None
    )
    util = busy_time / (n_beds * end_t) if end_t > 0 else 0.0

    kpis = {
        "n_completed": len(completed),
        "mean_wait": sum(waits) / len(waits) if waits else 0,
        "p95_wait": sorted(waits)[int(0.95 * len(waits))] if waits else 0,
        "sev_w_wait": sum(sev_w_waits) / len(sev_w_waits) if sev_w_waits else 0,
        "wait_sev1": sum(waits_by_sev[1]) / max(1, len(waits_by_sev[1])),
        "wait_sev3": sum(waits_by_sev[3]) / max(1, len(waits_by_sev[3])),
        "utilisation": util,
        "n_decisions": n_real_decisions,
        "mean_dec_latency": sum(decision_latency) / len(decision_latency) if decision_latency else 0,
        "end_time": end_t,
    }
    return {"kpis": kpis, "patients": completed}


# --- baseline heuristics --------------------------------------------------

def policy_fifo() -> Policy:
    """First-in, first-out: oldest queued patient goes first."""
    def fn(s: SimState) -> int:
        # queue is already arrival-ordered (we append on arrival),
        # so index 0 is the oldest
        return 0
    return fn


def policy_severity_priority() -> Policy:
    """Severity first (sev 1 = most urgent), tie-break by arrival time."""
    def fn(s: SimState) -> int:
        # min over (severity, arrival_time) -> highest-priority patient
        best_i, best_key = 0, (s.queue[0].severity, s.queue[0].arrival_time)
        for i, p in enumerate(s.queue[1:], start=1):
            key = (p.severity, p.arrival_time)
            if key < best_key:
                best_i, best_key = i, key
        return best_i
    return fn


if __name__ == "__main__":
    # smoke test
    print(">>> FIFO")
    out = run_replication(policy_fifo(), seed=0)
    for k, v in out["kpis"].items():
        print(f"  {k:>20s}: {v}")
    print()
    print(">>> SEVERITY-PRIORITY")
    out = run_replication(policy_severity_priority(), seed=0)
    for k, v in out["kpis"].items():
        print(f"  {k:>20s}: {v}")
