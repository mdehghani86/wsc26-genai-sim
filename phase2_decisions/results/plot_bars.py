"""Render the §10 results as a grouped bar chart, straight from summary.json.

Every value plotted is read from summary.json — no hand-edits, so the figure
cannot drift from the experiment.

Output: ../../../2_Figures/fig06_results_bars.png
"""
from __future__ import annotations
import json, os
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

HERE = Path(__file__).parent
SUMMARY = HERE / "summary.json"
OUT_DIR = HERE.parents[3] / "GenAI_Tutorial_Paper" / "2_Figures"
OUT_PNG = OUT_DIR / "fig06_results_bars.png"

# warm-pastel palette (consistent with the rest of the paper)
COL_MEAN = "#997A22"   # gold
COL_SEV1 = "#1F6B73"   # teal
COL_SEV3 = "#762A4F"   # plum
COL_LATENCY = "#6B5C2A"

POLICY_ORDER = ["fifo", "severity_priority", "gpt-5.1", "gemini-2.5-flash"]
POLICY_LABEL = {
    "fifo":              "FIFO",
    "severity_priority": "Severity-priority",
    "gpt-5.1":           "GPT-5.1\n+ memory",
    "gemini-2.5-flash":  "Gemini-2.5-flash\n+ memory",
}


def main():
    data = json.loads(SUMMARY.read_text())
    policies = data["policies"]

    means = [policies[p]["agg"]["mean_wait"]["mean"] for p in POLICY_ORDER]
    means_std = [policies[p]["agg"]["mean_wait"]["stdev"] for p in POLICY_ORDER]
    sev1 = [policies[p]["agg"]["wait_sev1"]["mean"] for p in POLICY_ORDER]
    sev1_std = [policies[p]["agg"]["wait_sev1"]["stdev"] for p in POLICY_ORDER]
    sev3 = [policies[p]["agg"]["wait_sev3"]["mean"] for p in POLICY_ORDER]
    sev3_std = [policies[p]["agg"]["wait_sev3"]["stdev"] for p in POLICY_ORDER]
    latency = [policies[p]["agg"]["mean_dec_latency"]["mean"] * 1000 for p in POLICY_ORDER]  # to ms
    labels = [POLICY_LABEL[p] for p in POLICY_ORDER]

    fig, (axL, axR) = plt.subplots(
        1, 2, figsize=(12.5, 4.4),
        gridspec_kw={"width_ratios": [3.2, 1.0]},
        constrained_layout=True,
    )

    # --- LEFT PANEL: wait times ---
    x = np.arange(len(POLICY_ORDER))
    w = 0.27
    axL.bar(x - w, means, w, yerr=means_std,
            color=COL_MEAN, label="Mean wait", alpha=0.92,
            error_kw=dict(ecolor="#444", capsize=3, lw=0.9))
    axL.bar(x,     sev1,  w, yerr=sev1_std,
            color=COL_SEV1, label="Severity-1 wait", alpha=0.92,
            error_kw=dict(ecolor="#444", capsize=3, lw=0.9))
    axL.bar(x + w, sev3,  w, yerr=sev3_std,
            color=COL_SEV3, label="Severity-3 wait", alpha=0.92,
            error_kw=dict(ecolor="#444", capsize=3, lw=0.9))

    # value labels above the bars
    def annotate(xs, ys, dy=2):
        for xi, yi in zip(xs, ys):
            axL.text(xi, yi + dy, f"{yi:.1f}", ha="center", va="bottom",
                     fontsize=8.5, color="#2A2A2A")
    annotate(x - w, means)
    annotate(x,     sev1)
    annotate(x + w, sev3)

    axL.set_xticks(x)
    axL.set_xticklabels(labels, fontsize=10)
    axL.set_ylabel("Wait time (minutes)", fontsize=11)
    axL.set_title("Per-policy wait times across $N{=}8$ paired replications",
                  fontsize=11, pad=8, loc="left")
    axL.legend(fontsize=9, frameon=False, loc="upper left")
    axL.grid(axis="y", alpha=0.25, linestyle="--", linewidth=0.6)
    axL.set_axisbelow(True)
    for spine in ("top", "right"):
        axL.spines[spine].set_visible(False)
    axL.set_ylim(0, max(sev3) + max(sev3_std) + 30)

    # --- RIGHT PANEL: decision latency ---
    bars = axR.bar(np.arange(len(POLICY_ORDER)), latency,
                   color=COL_LATENCY, alpha=0.85, width=0.55)
    for xi, yi in enumerate(latency):
        if yi < 1:
            txt = "≈ 0"
        else:
            txt = f"{yi:.0f}"
        axR.text(xi, yi + max(latency) * 0.02, txt,
                 ha="center", va="bottom", fontsize=9, color="#2A2A2A")
    short_labels = ["FIFO", "Sev-pri", "GPT-5.1", "Gemini-flash"]
    axR.set_xticks(np.arange(len(POLICY_ORDER)))
    axR.set_xticklabels(short_labels, fontsize=9, rotation=20, ha="right")
    axR.set_ylabel("Per-decision latency (ms)", fontsize=10)
    axR.set_title("Wall-time cost per decision", fontsize=10, pad=8, loc="left")
    axR.grid(axis="y", alpha=0.25, linestyle="--", linewidth=0.6)
    axR.set_axisbelow(True)
    for spine in ("top", "right"):
        axR.spines[spine].set_visible(False)
    axR.set_ylim(0, max(latency) * 1.18)

    fig.savefig(OUT_PNG, dpi=200, bbox_inches="tight",
                facecolor="white", edgecolor="none")
    print(f"wrote {OUT_PNG}")


if __name__ == "__main__":
    main()
