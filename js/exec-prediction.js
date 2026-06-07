/* =========================================================
   exec-prediction.js — 2c live demo.
   Runs the REAL ED model (ed_model.py) to produce a genuine event log,
   shows the log up to a cut point, asks the LLM to forecast the next
   window, then reveals the actual outcome from the same run.
   ========================================================= */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const WIN = 60;          // forecast window, minutes
  let busy = false;

  const SYS =
`You are an operations forecaster for an emergency department running as a discrete-event simulation.
From the recent event log you predict the next time window. Arrivals are roughly Poisson; severity split is about 20% urgent (sev1), 45% moderate (sev2), 35% routine (sev3). Reply with ONLY a JSON object, no prose.`;

  function params() {
    return {
      seed: parseInt($('pred-seed').value || '3', 10),
      n: parseInt($('pred-n').value || '25', 10),
      iat: parseFloat($('pred-iat').value || '12'),
      beds: parseInt($('pred-beds').value || '4', 10),
    };
  }

  function buildEvents(pts) {
    const ev = [];
    for (const p of pts) {
      ev.push({ t: p.arr, kind: 'arrival', sev: p.sev, pid: p.pid });
      if (p.admit != null) ev.push({ t: p.admit, kind: 'admit', sev: p.sev, pid: p.pid });
      if (p.disc != null) ev.push({ t: p.disc, kind: 'discharge', sev: p.sev, pid: p.pid });
    }
    ev.sort((a, b) => a.t - b.t || (a.kind === 'arrival' ? -1 : 1));
    return ev;
  }

  function censusAt(pts, t) {
    let c = 0;
    for (const p of pts) if (p.admit != null && p.admit <= t && (p.disc == null || p.disc > t)) c++;
    return c;
  }

  function actuals(pts, cut, nbeds) {
    let sev1 = 0, total = 0;
    for (const p of pts) if (p.arr > cut && p.arr <= cut + WIN) { total++; if (p.sev === 1) sev1++; }
    let peak = 0;
    for (let t = cut; t <= cut + WIN; t += 2) peak = Math.max(peak, censusAt(pts, t));
    return { sev1, total, peak, breach: peak >= nbeds };
  }

  function logText(ev, cut) {
    const recent = ev.filter(e => e.t <= cut).slice(-14);
    return recent.map(e => `t=${e.t.toFixed(0).padStart(3)}  ${e.kind.padEnd(9)} sev${e.sev} (pt#${e.pid})`).join('\n');
  }

  function renderLog(ev, cut) {
    const recent = ev.filter(e => e.t <= cut).slice(-14);
    return recent.map(e => {
      const cls = e.kind === 'arrival' ? 'pe-arr' : e.kind === 'admit' ? 'pe-adm' : 'pe-dis';
      return `<div class="pe-line"><span class="pe-t">t=${e.t.toFixed(0)}</span> <span class="${cls}">${e.kind}</span> sev${e.sev} <span class="pe-pid">#${e.pid}</span></div>`;
    }).join('');
  }

  function cmpCard(label, fc, ac) {
    return `<div class="pc-card"><div class="pc-h">${label}</div>` +
      `<div class="pc-row"><span class="pc-k">Forecast</span><span class="pc-fc">${fc}</span></div>` +
      `<div class="pc-row"><span class="pc-k">Actual</span><span class="pc-ac">${ac}</span></div></div>`;
  }

  async function run() {
    if (busy) return;
    busy = true;
    const btn = $('pred-run'), status = $('pred-status'), logEl = $('pred-log'), out = $('pred-out');
    btn.disabled = true; out.innerHTML = '';
    const p = params();
    try {
      status.textContent = 'Running the ED model in your browser…';
      const data = await EDRuntime.eventLog(p);
      const pts = data.patients;
      const lastArr = Math.max(...pts.map(x => x.arr));
      const cut = Math.round(lastArr * 0.55);
      const ev = buildEvents(pts);
      const census = censusAt(pts, cut);
      logEl.innerHTML = `<div class="pe-cut">log up to t=${cut} min &middot; census ${census}/${p.beds} beds occupied</div>` + renderLog(ev, cut);

      const ac = actuals(pts, cut, p.beds);

      if (!LLM.hasKey()) {
        status.innerHTML = 'Real event log generated. <strong>Add an API key above</strong> to have the LLM forecast the next ' + WIN + ' minutes — then compare against the actual outcome.';
        out.innerHTML = `<div class="pc-grid">` +
          cmpCard('Sev-1 arrivals (next ' + WIN + 'm)', '—', ac.sev1) +
          cmpCard('Total arrivals', '—', ac.total) +
          cmpCard('Peak census', '—', ac.peak + '/' + p.beds) +
          cmpCard('All beds full?', '—', ac.breach ? 'yes' : 'no') + `</div>`;
        return;
      }

      status.textContent = 'LLM forecasting the next window…';
      const user =
        `Beds: ${p.beds}. Time now: t=${cut} min. Current census: ${census}/${p.beds} beds occupied.\n` +
        `Recent events (oldest first):\n${logText(ev, cut)}\n\n` +
        `Forecast the next ${WIN} minutes. Reply ONLY with this JSON:\n` +
        `{"expected_sev1_arrivals": <int>, "expected_total_arrivals": <int>, "peak_census": <int 0..${p.beds}>, "breach_probability": <float 0..1>, "note": "<one short sentence>"}`;
      const { text, ms } = await LLM.call(SYS, user, { maxTokens: 200, temperature: 0 });
      const fc = LLM.parseJSON(text) || {};
      const bp = (typeof fc.breach_probability === 'number') ? Math.round(fc.breach_probability * 100) + '%' : '—';

      out.innerHTML =
        `<div class="pc-grid">` +
        cmpCard('Sev-1 arrivals (next ' + WIN + 'm)', fc.expected_sev1_arrivals ?? '—', ac.sev1) +
        cmpCard('Total arrivals', fc.expected_total_arrivals ?? '—', ac.total) +
        cmpCard('Peak census', (fc.peak_census ?? '—') + '/' + p.beds, ac.peak + '/' + p.beds) +
        cmpCard('All beds full? (P / actual)', bp, ac.breach ? 'yes' : 'no') +
        `</div>` +
        (fc.note ? `<div class="pc-note">LLM: &ldquo;${fc.note}&rdquo; &middot; ${ms}ms</div>` : `<div class="pc-note">${ms}ms</div>`);
      status.textContent = 'Done. Forecast (from the log only) vs the actual outcome of the same run.';
    } catch (e) {
      status.innerHTML = '<span class="orf-err">' + (e && e.message ? e.message : e) + '</span>';
    } finally {
      btn.disabled = false; busy = false;
    }
  }

  function init() {
    if (!$('pred-demo')) return;
    LLM.renderKeyPanel($('pred-key'));
    $('pred-run').addEventListener('click', run);
  }
  if (document.readyState !== 'loading') init();
  else document.addEventListener('DOMContentLoaded', init);
})();
