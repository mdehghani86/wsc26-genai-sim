from er_simulation import DEFAULT_SETTINGS as S, run_single_simulation, _expected_treatment, select_next_patient, Patient

def chk(label, ok):
    print(f"  {'PASS' if ok else 'FAIL'}  {label}")

# 1. Exp(mean=6) arrivals
chk("Exp(mean=6 min) arrivals", S['arrival_mean'] == 6.0)

# 2. Severity uniform {1..10}
chk("severity uniform {1..10}", S['severity_min'] == 1 and S['severity_max'] == 10)

# 3. >=7 -> critical, c=2
chk("score>=7 -> critical, c=2", S['critical_threshold'] == 7 and S['critical_beds'] == 2)

# 4. <7 -> standard, c=4
chk("score<7 -> standard, c=4", S['standard_beds'] == 4)

# 5. Critical Tri bounds (20, ?, 45)
lo, _, hi = S['critical_tri']
chk("critical lo=20, hi=45", lo == 20 and hi == 45)

# 6. Standard Tri bounds (10, ?, 25)
lo, _, hi = S['standard_tri']
chk("standard lo=10, hi=25", lo == 10 and hi == 25)

# 7. Critical mode = 25+5*(s-7)
print("  Critical mode formula:")
all_ok = True
for s in [7, 8, 9, 10]:
    expected_mode = 25 + 5 * (s - 7)
    actual_mean = _expected_treatment(s, S)
    derived_mode = actual_mean * 3 - 20 - 45
    ok = abs(derived_mode - expected_mode) < 0.01
    if not ok:
        all_ok = False
    print(f"      score {s}: mode={derived_mode:.1f} expected={expected_mode}  {'OK' if ok else 'WRONG'}")
chk("critical mode = 25+5*(s-7)", all_ok)

# 8. Standard mode = 12+2*(s-1)
print("  Standard mode formula:")
all_ok = True
for s in [1, 2, 3, 4, 5, 6]:
    expected_mode = 12 + 2 * (s - 1)
    actual_mean = _expected_treatment(s, S)
    derived_mode = actual_mean * 3 - 10 - 25
    ok = abs(derived_mode - expected_mode) < 0.01
    if not ok:
        all_ok = False
    print(f"      score {s}: mode={derived_mode:.1f} expected={expected_mode}  {'OK' if ok else 'WRONG'}")
chk("standard mode = 12+2*(s-1)", all_ok)

# 9. Default FIFO
chk("default strategy is FIFO", S['selection_strategy'] == 'FIFO')

# 10a. SeverityFirst: highest severity served first, FIFO tie-break
try:
    wl = [
        Patient(pid=1, arrival_time=0, severity=9, bed_type='critical', expected_treatment=33),
        Patient(pid=2, arrival_time=1, severity=7, bed_type='critical', expected_treatment=30),
    ]
    chosen = select_next_patient(list(wl), 'SeverityFirst')
    chk("SeverityFirst picks highest severity first", chosen.severity == 9)
    # tie-break: equal severity, earlier arrival wins
    wl2 = [
        Patient(pid=3, arrival_time=1, severity=9, bed_type='critical', expected_treatment=33),
        Patient(pid=4, arrival_time=0, severity=9, bed_type='critical', expected_treatment=33),
    ]
    chosen2 = select_next_patient(list(wl2), 'SeverityFirst')
    chk("SeverityFirst FIFO tie-break: earlier arrival wins", chosen2.pid == 4)
except Exception as e:
    chk("SeverityFirst strategy exists", False)

# 10b. ShortestExpectedTreatment: lowest expected duration served first
try:
    wl = [
        Patient(pid=1, arrival_time=0, severity=9, bed_type='critical', expected_treatment=33),
        Patient(pid=2, arrival_time=1, severity=7, bed_type='critical', expected_treatment=30),
    ]
    chosen = select_next_patient(list(wl), 'ShortestExpectedTreatment')
    chk("ShortestExpectedTreatment picks lowest expected first", chosen.expected_treatment == 30)
except Exception as e:
    chk("ShortestExpectedTreatment strategy exists", False)

# 11. Patients depart immediately — treatment_end == treatment_start + treatment_duration
r = run_single_simulation({'duration': 2000, 'verbose': False})
completed = [p for p in r.patients if p.treatment_end is not None and p.treatment_start is not None]
extras = [p for p in completed if abs((p.treatment_end - p.treatment_start) - p.treatment_duration) > 0.01]
chk("patients depart immediately (treatment_end = treatment_start + duration)", len(extras) == 0)

# 12. Parameters configurable (settings dict accepted)
try:
    r2 = run_single_simulation({'critical_beds': 3, 'standard_beds': 5, 'duration': 100, 'verbose': False})
    chk("parameters configurable via settings dict", r2.critical_stats.capacity == 3 and r2.standard_stats.capacity == 5)
except Exception as e:
    chk("parameters configurable", False)
