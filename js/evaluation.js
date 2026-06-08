/* =========================================================
   evaluation.js — Phase 4 benchmark table.
   Renders Table 1 of the paper from the recorded benchmark
   (phase2_decisions/results/summary.json). No API key needed.
   ========================================================= */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const LABELS = {
    'fifo': 'FIFO',
    'severity_priority': 'Severity-priority',
    'gpt-5.1': 'GPT-5.1',
    'gemini-2.5-flash': 'Gemini-2.5-flash',
  };
  const ORDER = ['fifo', 'severity_priority', 'gpt-5.1', 'gemini-2.5-flash'];

  function render(data) {
    const pol = data.policies || {};
    const cols = ORDER.filter(k => pol[k]);
    const metrics = [
      ['Mean wait (min)', p => p.mean_wait.mean.toFixed(1)],
      ['P95 wait (min)', p => p.p95_wait.mean.toFixed(1)],
      ['Sev-1 (urgent) wait (min)', p => p.wait_sev1.mean.toFixed(1)],
      ['Sev-3 (routine) wait (min)', p => p.wait_sev3.mean.toFixed(1)],
      ['Utilisation', p => p.utilisation.mean.toFixed(2)],
      ['Decision latency (ms)', p => Math.round(p.mean_dec_latency.mean * 1000)],
    ];

    let html = '<table class="orf-table"><thead><tr><th>Metric</th>' +
      cols.map(k => `<th>${LABELS[k]}</th>`).join('') + '</tr></thead><tbody>';
    for (const [label, fn] of metrics) {
      html += `<tr><td>${label}</td>` +
        cols.map(k => `<td>${fn(pol[k].agg)}</td>`).join('') + '</tr>';
    }
    html += '</tbody></table>';
    $('eval-table').innerHTML = html;

    $('eval-status').innerHTML =
      `Recorded over <strong>${data.n_reps} paired seeds</strong> on the real ED model. ` +
      `Run it live yourself on the <a href="#/exec-orchestration">Orchestration</a> tab.`;

    $('eval-note').innerHTML =
      '<p class="step-note" style="margin-top:14px;">' +
      'Severity-priority halves urgent (sev-1) wait at the cost of routine (sev-3) wait. ' +
      '<strong>GPT-5.1 reproduces severity-priority almost exactly</strong>; Gemini hybridises &mdash; ' +
      'gentler on routine patients &mdash; and both LLM policies cost hundreds of milliseconds per decision ' +
      'versus zero for the heuristics.</p>';
  }

  let done = false;
  async function init() {
    if (done || !$('eval-demo')) return;
    done = true;
    try {
      const data = await fetch('phase2_decisions/results/summary.json').then(r => {
        if (!r.ok) throw new Error('summary.json ' + r.status);
        return r.json();
      });
      render(data);
    } catch (e) {
      $('eval-status').innerHTML = '<span class="orf-err">Could not load the benchmark: ' +
        (e && e.message ? e.message : e) + '</span>';
    }
  }

  document.addEventListener('route:comparison', init);
  if (location.hash.replace(/^#\/?/, '') === 'comparison') {
    if (document.readyState !== 'loading') init();
    else document.addEventListener('DOMContentLoaded', init);
  }
})();
