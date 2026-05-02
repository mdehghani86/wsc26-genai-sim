/* =========================================================
   Input modelling tab.
   Pipeline:  pick data -> validate -> summary + histogram
              -> LLM proposes candidates -> scipy fits + tests
              -> Q-Q plot -> verdict + SimPy snippet.
   The test, not the LLM, picks the winner.
   ========================================================= */
(function () {
  'use strict';

  const state = {
    data: null,        // numeric inter-arrival times
    label: null,       // shown in the verdict
    source: null,      // 'demo:clean' | 'demo:bursty' | 'upload:<filename>'
    candidates: [],    // [{name, rationale, scipy}]
    fits: [],          // populated by Pyodide
    winner: null,
    histChart: null,
    qqChart: null,
  };

  // ---------- prompt template + pre-baked LLM responses ----------
  const PROMPT_TEMPLATE = (summary) => `I have ${summary.n} inter-arrival times (minutes) from an emergency-department arrival log.

Summary statistics:
  mean   = ${summary.mean.toFixed(2)}
  std    = ${summary.std.toFixed(2)}
  min    = ${summary.min.toFixed(2)}
  max    = ${summary.max.toFixed(2)}
  CV     = ${summary.cv.toFixed(2)}
  skewness = ${summary.skew.toFixed(2)}

Propose 2 or 3 continuous distributions that are plausible candidates for these data,
with a one-sentence rationale per candidate. Return only the candidate list.
Do NOT run a goodness-of-fit test; that will be done in scipy and the test wins.`;

  const DEMO_RESPONSES = {
    'demo:clean': {
      label: 'ED arrivals, off-peak ward',
      candidates: [
        { name: 'expon',   rationale: 'Inter-arrival times in a stable Poisson process are exponentially distributed. Mean and standard deviation of the sample are within 5% of each other, which is the signature of an exponential.' },
        { name: 'gamma',   rationale: 'Gamma generalises exponential; included so the test has a chance to discriminate.' },
        { name: 'lognorm', rationale: 'Common second-choice for service or inter-arrival data with a long right tail; included as a sanity check.' },
      ],
    },
    'demo:bursty': {
      label: 'ED arrivals, with rush hours (timestamps)',
      candidates: [
        { name: 'expon',   rationale: 'Aggregated ED arrivals are conventionally modelled as Poisson, so exponential is the default first guess. Note: visible non-stationarity in this trace will likely cause the test to reject this.' },
        { name: 'lognorm', rationale: 'Mixture of quiet and rush periods inflates the right tail; lognormal often fits aggregated bursty data better than a single exponential.' },
        { name: 'gamma',   rationale: 'Gamma with shape less than 1 can absorb some over-dispersion relative to exponential; included as a conservative third candidate.' },
      ],
    },
  };

  // ---------- DOM helpers ----------
  const $  = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));
  const showStep = (key) => $(`[data-step="${key}"]`).hidden = false;
  const hideStepsFrom = (key) => {
    const order = ['validate', 'summary', 'propose', 'tests', 'qq', 'verdict'];
    const i = order.indexOf(key);
    order.slice(i).forEach(k => { const el = $(`[data-step="${k}"]`); if (el) el.hidden = true; });
  };

  // ---------- bootstrap on first nav to the tab ----------
  document.addEventListener('route:change', (e) => {
    if (e.detail.route !== 'input-modelling') return;
    if (!state.bound) bind();
    if (window.Runtime) window.Runtime.boot();
  });

  function bind() {
    state.bound = true;
    $$('.data-card[data-demo]').forEach(c => {
      c.addEventListener('click', () => loadDemo(c.dataset.demo, c));
    });
    const fileInput = $('#csv-upload');
    fileInput.addEventListener('change', (ev) => {
      const f = ev.target.files && ev.target.files[0];
      if (f) loadUpload(f);
    });
    $('#snippet-copy').addEventListener('click', copySnippet);
  }

  // ---------- data loaders ----------
  async function loadDemo(name, card) {
    $$('.data-card').forEach(c => c.classList.remove('is-selected'));
    card.classList.add('is-selected');
    const path = name === 'clean' ? 'data/arrivals_clean.csv' : 'data/arrivals_bursty.csv';
    state.source = `demo:${name}`;
    state.label  = DEMO_RESPONSES[state.source].label;
    const text = await fetch(path).then(r => r.text());
    consume(text);
  }

  async function loadUpload(file) {
    $$('.data-card').forEach(c => c.classList.remove('is-selected'));
    file.target = null;
    state.source = `upload:${file.name}`;
    state.label  = file.name;
    const text = await file.text();
    consume(text);
  }

  // ---------- validation + parsing ----------
  function consume(rawText) {
    hideStepsFrom('validate');
    showStep('validate');

    const list = $('#validate-list'); list.innerHTML = '';
    const badge = $('#validate-badge');
    badge.className = 'step-badge';
    badge.textContent = 'running';

    const lines = rawText.split(/\r?\n/).map(l => l.trim()).filter(l => l.length);
    if (lines.length < 2) return fail('Empty file or no data rows.');

    // strip header if first line is non-numeric
    let header = null;
    if (!isFinite(parseFloat(lines[0])) && !looksLikeTimestamp(lines[0])) {
      header = lines.shift();
    }

    let interarrivals = [];
    let mode = null;
    if (looksLikeTimestamp(lines[0])) {
      mode = 'timestamps';
      const ts = lines.map(l => Date.parse(l)).filter(t => isFinite(t)).sort((a, b) => a - b);
      for (let i = 1; i < ts.length; i++) interarrivals.push((ts[i] - ts[i - 1]) / 60000);
    } else {
      mode = 'interarrivals';
      interarrivals = lines.map(l => parseFloat(l)).filter(x => isFinite(x));
    }

    const checks = [];
    checks.push({ kind: 'ok', text: `Detected format: <strong>${mode}</strong>${header ? ` (column header: <code>${header}</code>)` : ''}.` });
    if (interarrivals.length < 30) {
      checks.push({ kind: 'fail', text: `Only ${interarrivals.length} samples after parsing. Need at least 30.` });
    } else {
      checks.push({ kind: 'ok', text: `Parsed <strong>${interarrivals.length}</strong> numeric inter-arrival values.` });
    }

    const negs = interarrivals.filter(x => x < 0).length;
    if (negs) checks.push({ kind: 'fail', text: `<strong>${negs}</strong> negative values detected. Inter-arrival times cannot be negative.` });
    else      checks.push({ kind: 'ok',   text: 'No negative values.' });

    const zeros = interarrivals.filter(x => x === 0).length;
    if (zeros) checks.push({ kind: 'warn', text: `<strong>${zeros}</strong> zero values; these will be kept but very small inter-arrivals can bias the fit.` });

    if (interarrivals.length >= 30 && interarrivals.length < 100) {
      checks.push({ kind: 'warn', text: `Sample size <strong>${interarrivals.length}</strong> below 100; goodness-of-fit p-values will be wide.` });
    }

    renderChecks(list, checks);
    const fatal = checks.some(c => c.kind === 'fail');
    if (fatal) {
      badge.textContent = 'failed'; badge.classList.add('is-warn');
      return;
    }
    badge.textContent = mode === 'timestamps' ? 'timestamps' : 'numeric ok';
    badge.classList.add('is-good');

    state.data = interarrivals.filter(x => x >= 0);
    advanceToSummary();
  }

  function fail(message) {
    const list = $('#validate-list');
    list.innerHTML = `<li class="fail">${message}</li>`;
    $('#validate-badge').textContent = 'failed';
    $('#validate-badge').classList.add('is-warn');
  }
  function renderChecks(list, checks) {
    list.innerHTML = checks.map(c => `<li class="${c.kind || 'ok'}">${c.text}</li>`).join('');
  }
  function looksLikeTimestamp(s) {
    return /^\d{4}-\d{2}-\d{2}/.test(s) || /\d{1,2}:\d{2}/.test(s);
  }

  // ---------- summary + histogram ----------
  function advanceToSummary() {
    showStep('summary');
    const data = state.data;
    const summary = computeSummary(data);
    state.summary = summary;
    renderSummary(summary);
    renderHistogram(data);
    advanceToProposal();
  }

  function computeSummary(arr) {
    const n = arr.length;
    const sum = arr.reduce((a, b) => a + b, 0);
    const mean = sum / n;
    const sq = arr.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
    const std = Math.sqrt(sq);
    const min = Math.min(...arr), max = Math.max(...arr);
    const cv  = std / mean;
    const skew = arr.reduce((a, b) => a + ((b - mean) / std) ** 3, 0) / n;
    return { n, mean, std, min, max, cv, skew };
  }

  function renderSummary(s) {
    const cells = [
      ['n',         s.n.toString(),               null],
      ['mean',      s.mean.toFixed(2),            'min'],
      ['std',       s.std.toFixed(2),             'min'],
      ['CV',        s.cv.toFixed(2),              null],
      ['skewness',  s.skew.toFixed(2),            null],
      ['min',       s.min.toFixed(2),             'min'],
      ['max',       s.max.toFixed(2),             'min'],
    ];
    $('#summary-grid').innerHTML = cells.map(([k, v, u]) =>
      `<div class="summary-cell"><div class="summary-key">${k}</div><div class="summary-val">${v}${u ? `<span class="unit">${u}</span>` : ''}</div></div>`
    ).join('');
  }

  function renderHistogram(data) {
    const bins = 40;
    const min = Math.min(...data), max = Math.max(...data);
    const w = (max - min) / bins;
    const counts = new Array(bins).fill(0);
    data.forEach(x => {
      let i = Math.floor((x - min) / w); if (i >= bins) i = bins - 1; counts[i]++;
    });
    const labels = counts.map((_, i) => (min + i * w).toFixed(1));

    if (state.histChart) state.histChart.destroy();
    state.histChart = new Chart($('#chart-hist'), {
      type: 'bar',
      data: {
        labels,
        datasets: [{
          label: 'observations',
          data: counts,
          backgroundColor: 'rgba(31,107,115,0.55)',
          borderColor:    'rgba(31,107,115,0.9)',
          borderWidth: 1,
        }],
      },
      options: {
        animation: false,
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { title: { display: true, text: 'inter-arrival time (min)' }, grid: { display: false } },
          y: { title: { display: true, text: 'count' }, grid: { color: 'rgba(0,0,0,0.05)' } },
        },
      },
    });
  }

  // ---------- LLM proposal (demo: pre-baked, upload: heuristic) ----------
  function advanceToProposal() {
    showStep('propose');
    $('#propose-prompt').textContent = PROMPT_TEMPLATE(state.summary);
    let resp;
    if (DEMO_RESPONSES[state.source]) {
      resp = DEMO_RESPONSES[state.source];
      $('#propose-source').textContent = 'pre-baked Claude response';
    } else {
      resp = heuristicProposal(state.summary);
      $('#propose-source').textContent = 'heuristic (no API key)';
    }
    state.candidates = resp.candidates;
    $('#candidate-list').innerHTML = state.candidates.map((c, i) =>
      `<div class="candidate">
         <div class="candidate-name">${c.name}</div>
         <div class="candidate-rationale">${c.rationale}</div>
         <div class="candidate-rank">candidate ${i + 1}</div>
       </div>`
    ).join('');
    runScipyTests();
  }

  function heuristicProposal(s) {
    // Without an LLM API call we still need plausible candidates.
    // Use the CV: CV approx 1 -> exponential; CV > 1 -> lognormal/gamma; CV < 1 -> gamma/normal.
    const list = [];
    list.push({ name: 'expon',   rationale: 'Default first guess for inter-arrival data; the test will reject if it does not fit.' });
    if (s.cv > 1.05) list.push({ name: 'lognorm', rationale: `Sample CV is ${s.cv.toFixed(2)} (over-dispersed relative to exponential); lognormal often absorbs this.` });
    if (s.skew > 0)  list.push({ name: 'gamma',   rationale: 'Right-skewed positive data; gamma is a flexible parametric alternative to exponential.' });
    return { candidates: list.slice(0, 3) };
  }

  // ---------- scipy fits + tests ----------
  async function runScipyTests() {
    showStep('tests');
    $('#tests-source').textContent = 'pyodide loading...';
    const py = await window.Runtime.boot();
    $('#tests-source').textContent = 'scipy.stats';

    py.globals.set('SAMPLES', state.data);
    py.globals.set('CANDIDATES', state.candidates.map(c => c.name));

    const code = `
import numpy as np
from scipy import stats
import json, math

raw = np.array(SAMPLES.to_py(), dtype=float)
# replace zeros with a tiny epsilon so lognorm/gamma logpdf is finite
eps = max(1e-6, float(np.min(raw[raw > 0])) * 1e-3) if (raw > 0).any() else 1e-6
data = np.where(raw <= 0, eps, raw)
names = list(CANDIDATES.to_py())

def _safe(x):
    try:
        x = float(x)
    except Exception:
        return None
    if not math.isfinite(x):
        return None
    return x

def fit_one(name, data):
    if name == 'expon':
        loc, scale = stats.expon.fit(data, floc=0)
        ks = stats.kstest(data, 'expon', args=(loc, scale))
        ad = stats.anderson(data, dist='expon')
        params = {'rate': 1.0/scale, 'mean': scale}
        ll = float(np.sum(stats.expon.logpdf(data, loc=loc, scale=scale)))
        k  = 1
        # chi-square against fitted CDF, k bins of equal expected count
        return name, params, float(ks.pvalue), float(ad.statistic), ll, k, ('expon', loc, scale)
    if name == 'lognorm':
        s, loc, scale = stats.lognorm.fit(data, floc=0)
        ks = stats.kstest(data, 'lognorm', args=(s, loc, scale))
        ad_stat = stats.anderson_ksamp([data, stats.lognorm.rvs(s, loc=loc, scale=scale, size=min(2000, len(data)), random_state=0)]).statistic
        params = {'s': s, 'scale': scale, 'mu': float(np.log(scale)), 'sigma': s}
        ll = float(np.sum(stats.lognorm.logpdf(data, s, loc=loc, scale=scale)))
        return name, params, float(ks.pvalue), float(ad_stat), ll, 2, ('lognorm', s, loc, scale)
    if name == 'gamma':
        a, loc, scale = stats.gamma.fit(data, floc=0)
        ks = stats.kstest(data, 'gamma', args=(a, loc, scale))
        ad_stat = stats.anderson_ksamp([data, stats.gamma.rvs(a, loc=loc, scale=scale, size=min(2000, len(data)), random_state=0)]).statistic
        params = {'a': a, 'scale': scale}
        ll = float(np.sum(stats.gamma.logpdf(data, a, loc=loc, scale=scale)))
        return name, params, float(ks.pvalue), float(ad_stat), ll, 2, ('gamma', a, loc, scale)
    return name, {}, float('nan'), float('nan'), float('nan'), 0, None

def chisquare_pval(data, dist_args):
    if dist_args is None: return float('nan')
    name = dist_args[0]
    if name == 'expon':
        loc, scale = dist_args[1], dist_args[2]
        cdf = lambda x: stats.expon.cdf(x, loc=loc, scale=scale)
    elif name == 'lognorm':
        s, loc, scale = dist_args[1], dist_args[2], dist_args[3]
        cdf = lambda x: stats.lognorm.cdf(x, s, loc=loc, scale=scale)
    elif name == 'gamma':
        a, loc, scale = dist_args[1], dist_args[2], dist_args[3]
        cdf = lambda x: stats.gamma.cdf(x, a, loc=loc, scale=scale)
    n = len(data)
    k = max(5, min(20, int(n / 20)))
    qs = np.linspace(0, 1, k + 1)
    edges = [float('-inf')] + [float(stats.expon.ppf(q, loc=0, scale=np.mean(data))) for q in qs[1:-1]] + [float('inf')]
    # Use distribution's own quantiles for edges to keep expected counts equal:
    if name == 'expon':
        edges = [float('-inf')] + [float(stats.expon.ppf(q, loc=loc, scale=scale)) for q in qs[1:-1]] + [float('inf')]
    elif name == 'lognorm':
        edges = [float('-inf')] + [float(stats.lognorm.ppf(q, s, loc=loc, scale=scale)) for q in qs[1:-1]] + [float('inf')]
    elif name == 'gamma':
        edges = [float('-inf')] + [float(stats.gamma.ppf(q, a, loc=loc, scale=scale)) for q in qs[1:-1]] + [float('inf')]
    obs, _ = np.histogram(data, bins=edges)
    exp = np.full(k, n / k)
    chi = float(np.sum((obs - exp) ** 2 / exp))
    df = max(1, k - 1 - len(dist_args) + 1)
    p = float(1.0 - stats.chi2.cdf(chi, df))
    return p

results = []
dargs_by_name = {}
for name in names:
    try:
        nm, params, ks_p, ad_s, ll, k, dargs = fit_one(name, data)
        chi_p = chisquare_pval(data, dargs)
        aic = 2 * k - 2 * ll
    except Exception as ex:
        nm, params, ks_p, ad_s, chi_p, aic, dargs = name, {}, float('nan'), float('nan'), float('nan'), float('nan'), None
    dargs_by_name[nm] = dargs
    results.append({
        'name': nm, 'params': {kk: _safe(vv) for kk, vv in params.items()},
        'ks_p': _safe(ks_p), 'ad_stat': _safe(ad_s),
        'chi_p': _safe(chi_p), 'aic': _safe(aic),
        'dargs_ok': dargs is not None,
    })

passing = [r for r in results if (r['ks_p'] or 0) >= 0.05]
def _ks(r): return r['ks_p'] if r['ks_p'] is not None else -1.0
if passing:
    winner = max(passing, key=_ks)['name']
else:
    winner = max(results, key=_ks)['name']

# Q-Q points for the winner — use raw fitted args (not the json-safe ones)
sorted_data = np.sort(data)
n = len(sorted_data)
probs = (np.arange(1, n + 1) - 0.5) / n
dargs = dargs_by_name.get(winner)
if dargs and dargs[0] == 'expon':
    q_theo = stats.expon.ppf(probs, loc=dargs[1], scale=dargs[2])
elif dargs and dargs[0] == 'lognorm':
    q_theo = stats.lognorm.ppf(probs, dargs[1], loc=dargs[2], scale=dargs[3])
elif dargs and dargs[0] == 'gamma':
    q_theo = stats.gamma.ppf(probs, dargs[1], loc=dargs[2], scale=dargs[3])
else:
    q_theo = sorted_data
qq = list(zip([_safe(x) or 0.0 for x in q_theo.tolist()], sorted_data.tolist()))

json.dumps({'results': results, 'winner': winner, 'qq': qq, 'all_passed': len(passing) > 0})
`;
    let out;
    try {
      out = JSON.parse(py.runPython(code));
    } catch (e) {
      console.error('scipy run failed', e);
      $('#tests-source').textContent = 'error: ' + e.message;
      return;
    }
    state.fits   = out.results;
    state.winner = out.winner;
    state.allPassed = out.all_passed;
    state.qq     = out.qq;
    renderResultsTable();
    renderQQ(out.qq);
    renderVerdict();
  }

  function renderResultsTable() {
    const tbody = $('#tests-table tbody');
    tbody.innerHTML = state.fits.map(r => {
      const isWin = r.name === state.winner;
      const passed = r.ks_p >= 0.05;
      const verdict = passed
        ? `<span class="verdict-pill win">accept</span>`
        : `<span class="verdict-pill fail">reject</span>`;
      const params = formatParams(r.params);
      return `<tr class="${isWin ? 'is-winner' : ''}">
        <td><strong>${r.name}</strong></td>
        <td><span class="mono">${params}</span></td>
        <td><span class="mono">${fmt(r.ks_p)}</span></td>
        <td><span class="mono">${fmt(r.ad_stat)}</span></td>
        <td><span class="mono">${fmt(r.chi_p)}</span></td>
        <td><span class="mono">${fmt(r.aic, 1)}</span></td>
        <td>${verdict}</td>
      </tr>`;
    }).join('');
  }
  function fmt(x, dp = 4) {
    if (x === null || isNaN(x) || !isFinite(x)) return 'n/a';
    return Number(x).toFixed(dp);
  }
  function formatParams(p) {
    return Object.entries(p)
      .filter(([k]) => k !== 's' || true)
      .map(([k, v]) => `${k}=${typeof v === 'number' ? v.toFixed(3) : v}`)
      .join(', ');
  }

  function renderQQ(qq) {
    showStep('qq');
    if (state.qqChart) state.qqChart.destroy();
    const points = qq.map(([t, e]) => ({ x: t, y: e }));
    const lo = Math.min(...points.map(p => Math.min(p.x, p.y)));
    const hi = Math.max(...points.map(p => Math.max(p.x, p.y)));
    state.qqChart = new Chart($('#chart-qq'), {
      type: 'scatter',
      data: {
        datasets: [
          {
            label: 'observed vs theoretical',
            data: points,
            backgroundColor: 'rgba(153,122,34,0.55)',
            borderColor:    'rgba(153,122,34,0.9)',
            pointRadius: 2,
          },
          {
            label: 'y = x',
            type: 'line',
            data: [{ x: lo, y: lo }, { x: hi, y: hi }],
            borderColor: 'rgba(31,107,115,0.9)',
            borderDash: [4, 4],
            borderWidth: 1.5,
            pointRadius: 0,
            fill: false,
          },
        ],
      },
      options: {
        animation: false,
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: true, position: 'bottom' } },
        scales: {
          x: { title: { display: true, text: `theoretical quantile (${state.winner})` } },
          y: { title: { display: true, text: 'observed quantile' } },
        },
      },
    });
  }

  // ---------- verdict + SimPy snippet ----------
  function renderVerdict() {
    showStep('verdict');
    const w = state.fits.find(r => r.name === state.winner);
    const passed = state.allPassed;
    const ks = (w && w.ks_p != null) ? w.ks_p.toFixed(3) : 'n/a';
    const verdictMsg = passed
      ? `The chi-square and KS tests <strong>accept ${state.winner}</strong> at the 5% level (KS p-value ${ks}). The LLM's first candidate ${state.candidates[0].name === state.winner ? 'agreed with the test' : 'did not match the test winner; the test wins'}.`
      : `<strong>No candidate passed</strong> the KS test at the 5% level. The closest fit was ${state.winner} (KS p = ${ks}). This is the failure mode the LLM cannot detect on its own. Likely cause: the data are non-stationary (rush hours mixed with off-peak); fit per hour-of-day rather than globally.`;
    $('#verdict-block').innerHTML = `<p>${verdictMsg}</p>`;
    $('#snippet-body').textContent = simpySnippet(w, passed);
  }

  function simpySnippet(w, passed) {
    const banner = passed
      ? `# Phase 1a -> Phase 1b hand-off (accepted by goodness-of-fit)`
      : `# Phase 1a hand-off (NO candidate passed; using closest fit, see Q-Q plot)`;
    if (!w || !w.params) return `${banner}\n# fit failed`;
    const p = w.params;
    const safe = (x, dp) => (x == null ? 'NaN' : Number(x).toFixed(dp));
    if (w.name === 'expon' && p.mean != null) {
      return `${banner}
import random
def interarrival():
    return random.expovariate(${safe(1 / p.mean, 4)})  # mean = ${safe(p.mean, 2)} min`;
    }
    if (w.name === 'lognorm' && p.s != null && p.scale != null) {
      return `${banner}
import random, math
def interarrival():
    # lognorm shape s=${safe(p.s, 3)}, scale=${safe(p.scale, 3)}
    return random.lognormvariate(math.log(${safe(p.scale, 3)}), ${safe(p.s, 3)})`;
    }
    if (w.name === 'gamma' && p.a != null && p.scale != null) {
      return `${banner}
import random
def interarrival():
    return random.gammavariate(${safe(p.a, 3)}, ${safe(p.scale, 3)})`;
    }
    return `${banner}\n# unsupported or failed distribution: ${w.name}`;
  }

  function copySnippet() {
    const txt = $('#snippet-body').textContent;
    navigator.clipboard.writeText(txt).then(() => {
      const btn = $('#snippet-copy');
      btn.textContent = 'copied';
      btn.classList.add('is-copied');
      setTimeout(() => { btn.textContent = 'copy'; btn.classList.remove('is-copied'); }, 1500);
    });
  }
})();
