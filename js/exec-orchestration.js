/* =========================================================
   exec-orchestration.js — 2b live demo.
   Runs the REAL ED model (ed_model.py) with FIFO + severity baselines
   (no key) and, when a key is set, an LLM-in-the-loop policy that decides
   each free-bed admission live. Same model, three policies, side by side.
   ========================================================= */
(function () {
  'use strict';

  // exact dispatcher system prompt from phase2_decisions/llm_policy.py
  const SYS_PROMPT =
`You are an emergency-department triage dispatcher.
A bed has just freed up. The waiting queue holds 2 or more patients.
Your job: choose ONE patient from the queue to admit next.
Severity scale: 1 = urgent, 2 = moderate, 3 = routine. Lower number is more urgent.
Trade-off: prioritising severity reduces urgent-patient wait but may starve routine patients.
You will see the queue, the current ED state, your last few decisions, and a one-line
summary of your policy so far. Decide consistently.
Reply with ONE integer: the index in the queue (0 = first in line, 1 = second, ...).
Reply with the integer only -- no words, no punctuation, no explanation.`;

  const $ = (id) => document.getElementById(id);
  let busy = false;

  function params() {
    return {
      seed: parseInt($('orch-seed').value || '0', 10),
      n: parseInt($('orch-n').value || '25', 10),
      iat: parseFloat($('orch-iat').value || '12'),
      beds: parseInt($('orch-beds').value || '4', 10),
    };
  }

  function userPrompt(state) {
    const beds = state.beds.map(b => b.busy
      ? `  bed ${b.idx}: BUSY -> sev${b.sev} patient, ~${b.rel} min until free`
      : `  bed ${b.idx}: free`).join('\n');
    const q = state.queue.map(p =>
      `  [${p.i}] sev${p.sev}, waited ${p.wait} min, est LOS ${p.los} min`).join('\n');
    return `Current state (t=${state.now} min):\nBeds:\n${beds}\nQueue (${state.queue.length} waiting):\n${q}\n\n` +
           `Choose the queue index of the patient to admit next (integer in 0..${state.queue.length - 1}):`;
  }

  function parseChoice(text, qlen) {
    const m = (text || '').match(/-?\d+/);
    let v = m ? parseInt(m[0], 10) : 0;
    if (!(v >= 0 && v < qlen)) v = 0;
    return v;
  }

  function feedLine(state, choice, ms, provider) {
    const chosen = state.queue[choice];
    const qsummary = state.queue.map(p => `sev${p.sev}/${p.wait}m`).join(', ');
    const el = document.createElement('div');
    el.className = 'orf-line';
    el.innerHTML =
      `<span class="orf-t">t=${state.now}</span> bed ${state.free_bed} freed &middot; queue [${qsummary}] ` +
      `<span class="orf-pick">&rarr; ${provider} chose [${choice}] = patient #${chosen.pid} (sev${chosen.sev}, waited ${chosen.wait}m)</span> ` +
      `<span class="orf-ms">${ms}ms</span>`;
    return el;
  }

  function kpiCols(rows) {
    // rows: {name, kpis, latMs}
    const metrics = [
      ['Mean wait', 'mean_wait', 'm'],
      ['Sev-1 (urgent) wait', 'wait_sev1', 'm'],
      ['Sev-3 (routine) wait', 'wait_sev3', 'm'],
      ['Utilisation', 'utilisation', ''],
    ];
    let html = '<table class="orf-table"><thead><tr><th>Metric</th>' +
      rows.map(r => `<th>${r.name}</th>`).join('') + '</tr></thead><tbody>';
    for (const [label, key, unit] of metrics) {
      html += `<tr><td>${label}</td>` + rows.map(r => {
        let v = r.kpis[key];
        v = key === 'utilisation' ? v.toFixed(2) : v.toFixed(1) + unit;
        return `<td>${v}</td>`;
      }).join('') + '</tr>';
    }
    html += '<tr><td>Decision latency</td>' + rows.map(r =>
      `<td>${r.latMs == null ? '0 ms' : Math.round(r.latMs) + ' ms'}</td>`).join('') + '</tr>';
    html += '</tbody></table>';
    return html;
  }

  async function runLLMPolicy(p, feedEl, onProgress) {
    const forced = [];
    const latencies = [];
    const provider = LLM.getProvider();
    const provLabel = (LLM.PROVIDERS[provider] || {}).label || provider;
    const tag = provLabel.split(' ')[0];
    let guard = 0;
    while (guard++ < 80) {
      const step = await EDRuntime.stepLLM(forced, p);
      if (step.status === 'done') {
        return { kpis: step.kpis, latMs: latencies.length ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0, tag };
      }
      // a decision is needed
      const state = step.state;
      onProgress(forced.length + 1);
      const { text, ms } = await LLM.call(SYS_PROMPT, userPrompt(state), { maxTokens: 8, temperature: 0 });
      const choice = parseChoice(text, state.queue.length);
      latencies.push(ms);
      forced.push(choice);
      feedEl.appendChild(feedLine(state, choice, ms, tag));
      feedEl.scrollTop = feedEl.scrollHeight;
    }
    throw new Error('decision loop exceeded safety cap');
  }

  async function run() {
    if (busy) return;
    busy = true;
    const btn = $('orch-run');
    const status = $('orch-status');
    const feed = $('orch-feed');
    const results = $('orch-results');
    const feedWrap = $('orch-feed-wrap');
    btn.disabled = true; feed.innerHTML = ''; results.innerHTML = '';
    const p = params();
    const hasKey = LLM.hasKey();
    feedWrap.style.display = hasKey ? '' : 'none';

    try {
      status.textContent = 'Loading the ED model in your browser…';
      const fifo = await EDRuntime.baseline('fifo', p);
      const sev = await EDRuntime.baseline('severity', p);
      const rows = [
        { name: 'FIFO', kpis: fifo.kpis, latMs: 0 },
        { name: 'Severity', kpis: sev.kpis, latMs: 0 },
      ];

      if (hasKey) {
        status.textContent = 'Running the LLM policy live on the same model…';
        const llm = await runLLMPolicy(p, feed, (n) => {
          status.textContent = `LLM deciding admission ${n}… (one call per free-bed event)`;
        });
        rows.push({ name: llm.tag + ' (live)', kpis: llm.kpis, latMs: llm.latMs });
        status.textContent = `Done. ${rows[2].name} made its admissions live; heuristics are instant.`;
      } else {
        status.innerHTML = 'Baselines ran on the real ED model. <strong>Add an API key above</strong> to run the LLM policy live on the same seed and compare.';
      }
      results.innerHTML = kpiCols(rows);
    } catch (e) {
      status.innerHTML = '<span class="orf-err">' + (e && e.message ? e.message : e) + '</span>';
    } finally {
      btn.disabled = false; busy = false;
    }
  }

  function init() {
    const host = $('orch-demo');
    if (!host) return;
    LLM.renderKeyPanel($('orch-key'));
    $('orch-run').addEventListener('click', run);
    document.addEventListener('llm:key', () => {
      const s = $('orch-status');
      if (s && !busy) s.textContent = LLM.hasKey()
        ? 'Key saved. Click Run to compare FIFO, Severity, and the live LLM policy.'
        : '';
    });
  }

  if (document.readyState !== 'loading') init();
  else document.addEventListener('DOMContentLoaded', init);
})();
