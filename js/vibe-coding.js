/* =========================================================
   Vibe-coding recipes.
   Floating launcher button + slide-in panel with seven
   copy-paste prompts that walk a user from a vague problem
   to a validated SimPy model using any LLM.
   No dependencies. Persists open/closed state in localStorage
   only for the "first-time pulse" hint.
   ========================================================= */
(function () {
  'use strict';

  // -------------------------------------------------------
  // Recipes. Generic placeholders so they work for any
  // simulation problem, not just the ED example in the paper.
  // -------------------------------------------------------
  const RECIPES = [
    {
      n: 1,
      title: 'Frame the problem',
      sub: 'Lock down problem, scope, KPIs before any code.',
      prompt:
`I am planning a discrete-event simulation study. Help me formulate it as a structured problem statement.

Notes about the system:
<<paste 2-4 sentences about the real system you want to study>>

Reference KPIs (paste 1-3 abstracts of similar studies if you have them; otherwise leave blank and rely on standard textbook KPIs for this domain):
<<optional: paste excerpts from similar studies, or leave empty>>

Return ONE table with three rows and two columns:
| Element              | Statement |
| Problem definition   | (one paragraph)  |
| Scope and boundaries | (what is in vs out of scope) |
| KPIs                 | (3-6 measurable outputs) |

Keep each cell to 2-3 short sentences. No code yet. If the reference block is empty, do not invent literature citations — pull only from textbook-standard KPIs for this kind of system.`,
      tip: 'Save the table. Every later prompt re-uses the Scope row and the KPIs row verbatim. Only the browsing-enabled models (e.g., ChatGPT with web on) can do real literature search — so if you want it, paste the abstracts in yourself.'
    },

    {
      n: 2,
      title: 'Fit the input data',
      sub: 'Have the LLM propose distributions, then verify with a test.',
      prompt:
`I have a sample of <<inter-arrival times | service times | other>> in <<units>>. Summary statistics:

  n      = <<count>>
  mean   = <<value>>
  stdev  = <<value>>
  min    = <<value>>
  max    = <<value>>
  shape  = <<right-skewed | symmetric | bimodal | bursty>>

Propose 3 candidate continuous distributions that could fit this data. For each candidate return:
- name (e.g., Exponential, Lognormal, Gamma, Weibull, Triangular)
- the parameters you would fit
- a one-sentence rationale tied to the shape and support
- the EXACT scipy.stats line to fit it (e.g., scipy.stats.expon.fit(data))

Do NOT pick a winner. I will run KS, Anderson-Darling, and chi-square tests in scipy and let the test decide.`,
      tip: 'Run the proposed scipy.stats fits in a notebook (or in this companion app on the Phase 1a tab). Trust the test, not the LLM.'
    },

    {
      n: 3,
      title: 'Generate the SimPy model',
      sub: 'Five-part structured prompt: role, goal, scenario, inputs, output.',
      prompt:
`ROLE
You are a simulation engineer.

GOAL
Produce a runnable SimPy file that simulates the system described below.

SCENARIO
<<paste the Scope-and-boundaries row from Step 1 verbatim>>

INPUTS
- Arrival generator: <<paste the winning fit from Step 2, e.g., random.expovariate(1/10.0)>>
- Service-time distributions:
  <<resource A>>: <<distribution + params>>
  <<resource B>>: <<distribution + params>>
- Resource pools and capacities:
  <<resource A>>: capacity = <<int>>
  <<resource B>>: capacity = <<int>>
- Run length: <<minutes>>; warm-up: <<minutes>>; replications: <<int>>; seed: <<int>>

OUTPUT
ONE Python file. No dependencies beyond simpy and the standard library.
Hard requirements:
1. Exactly one simpy.Resource per pool. ONE worker process per server slot
   (NOT one process per pool). A pool of capacity c serves c entities in parallel.
2. Append per-entity records (arrival, start, finish, wait) at the moment of
   assignment, not at end-of-run.
3. Track per-pool busy_time. At end of run, RECONCILE in-flight busy_time
   for any entity still being served when the clock stops.
4. Print: utilisation rho per pool, mean and 95th-percentile waiting time,
   and throughput. Save an event log to a CSV.
5. Use a single random.Random(seed) instance threaded through the model.

Return only the file. No prose.`,
      tip: 'These five hard requirements come from real SimPy bugs surfaced in WSC 2025 reviews. Keep them in every prompt — they are the validation gate in disguise.'
    },

    {
      n: 4,
      title: 'Static code audit (pre-run)',
      sub: 'Three checks the LLM can do by reading the source — no execution yet.',
      prompt:
`Audit the SimPy file you just produced. Answer each check with PASS or FAIL plus a one-line justification quoting the relevant lines. These are STATIC checks — answer them by reading the source, NOT by simulating output.

1. Process logic. Does the entity flow match the SCENARIO end to end? Any missing or extra step?
2. Connectivity. Does every producer wire into a declared consumer? Any orphan resources or dead-end queues?
3. Parallel vs sequential. For every pool with capacity c, do c entities get served in parallel? Specifically: is there ONE worker process per server slot (NOT one process per pool that serves entities one at a time)? Quote the worker-process loop.

Do NOT report rho, Lq, Wq, or distribution-fit numbers in this step — those are run-time checks and require observed output. They live in Step 6.

If ANY check fails, do NOT rewrite the whole file. List the failing checks and propose the smallest patch that fixes only those. Return the patch as a unified diff.`,
      tip: 'These three checks live in the source. They catch the most common LLM failure mode: a manager process that serves a multi-server pool sequentially.'
    },

    {
      n: 5,
      title: 'Fix-it loop',
      sub: 'When a check fails, re-prompt with ONLY the failing check.',
      prompt:
`Validation check <<N>> failed:

  Check: <<paste the exact text of the failing check>>
  Observed: <<paste the actual symptom: numbers, error, or mismatch>>
  Expected: <<what should have been true>>

Regenerate ONLY the section of the file responsible for this check. Do not touch the other sections.

Return:
1. The minimal unified diff against the previous version of the file.
2. A 2-sentence explanation of WHY the original code violated the invariant.

After the patch, re-run the same check and show the updated number. If the patch passes, stop. If not, repeat with the next-smallest patch.`,
      tip: 'Bound this loop. Three rounds max. If the same check keeps failing, switch to the multi-agent or MCP path — the model is fighting you, not learning.'
    },

    {
      n: 6,
      title: 'Post-run numeric validation',
      sub: 'After the run, check observed numbers against theory. Requires real output.',
      prompt:
`I ran the simulation. Here is the observed output (REQUIRED — do not answer if any of these are missing):

Per-pool observed metrics:
  <<pool A>>: arrivals = <<n>>, mean_service = <<value>>, capacity = <<c>>,
              busy_time = <<minutes>>, observed_rho = <<value>>,
              mean_wait = <<value>>, Lq = <<value>>
  <<pool B>>: ... (repeat)

Run length: <<minutes>>; warm-up trimmed: <<minutes>>; replications: <<int>>

INPUTS (recap from Step 3):
  <<paste arrival generator and service-time distributions verbatim>>

For each pool:

A. Theoretical rho = arrival_rate * mean_service / capacity. Compute it from the inputs above. Does observed_rho match within 5%? PASS / FAIL.

B. If a single-class M/M/c is plausible (Poisson arrivals, exponential service), compute Lq from the Erlang-C formula and compare to observed Lq within 10%. PASS / FAIL. If the model is NOT M/M/c, say so and skip this check — do NOT fabricate a number.

C. Sampled service times: do the observed mean and variance match the INPUTS distribution within 5% and 10% respectively? PASS / FAIL.

For each FAIL, propose the smallest patch (unified diff) and explain in 2 sentences which SimPy invariant was violated. The most common ones:
- per-pool busy_time was not reconciled for in-flight entities at end of run
- per-entity wait was appended at end-of-service instead of at assignment
- a single worker process was serving a multi-slot pool sequentially.

If a number you need is missing from my paste, ask for it and stop. Do NOT estimate.`,
      tip: 'This step is the teeth of the validation gate. Refuse to accept any answer that is not grounded in the observed numbers you just provided.'
    },

    {
      n: 7,
      title: 'Narrate the trace',
      sub: 'Turn raw event logs into a Phase-0-anchored summary.',
      prompt:
`I ran the simulation. Here is the event log (truncated to ~200 rows) and the KPI summary:

<<paste a representative slice of the event log>>

<<paste the KPI table: rho per pool, mean and 95th-pct wait, throughput, etc.>>

Phase 0 problem statement:
<<paste the Problem-definition row from Step 1>>

Phase 0 KPIs:
<<paste the KPIs row from Step 1>>

Write a 4-paragraph summary aimed at the original stakeholder (not at me). Anchor it on the Phase 0 problem and KPIs. For each KPI:
- state the value
- state whether it meets the target
- name ONE event in the trace that explains it (cite the row)

Do NOT recommend changes yet. Just describe what happened.`,
      tip: 'The trace summary is for stakeholders, not for you. Keep it concrete — every claim must point back to a specific row in the log or a specific KPI.'
    },

    {
      n: 8,
      title: 'Design a scenario sweep',
      sub: 'Turn a question into a small DOE the simulation can answer.',
      prompt:
`I want to use this validated simulation to answer: <<state your what-if question, e.g., "Will adding one more server cut 95th-percentile wait by 30%?">>

Phase 0 KPIs that the answer must move:
<<paste the KPIs row from Step 1>>

Design a small experiment:
1. Identify 1-3 decision variables (factor levels). Justify each choice in one line.
2. Identify 1-2 nuisance factors that should be controlled by common random numbers.
3. Propose a full or fractional factorial table with at most 12 runs total.
4. State the number of replications per run needed to detect a <<X>>% effect at 95% confidence (use a paired t-test heuristic).
5. List the columns of the results table I should produce after running.

Return the experiment design as a table. No code.`,
      tip: 'Cap the runs at what you are actually willing to wait for. A clean 8-run design beats a sloppy 64-run one. CRN (common random numbers) is non-negotiable for paired comparisons.'
    },
  ];

  // -------------------------------------------------------
  // DOM
  // -------------------------------------------------------
  function el(tag, attrs, children) {
    const e = document.createElement(tag);
    if (attrs) for (const k in attrs) {
      if (k === 'class') e.className = attrs[k];
      else if (k === 'html') e.innerHTML = attrs[k];
      else if (k === 'text') e.textContent = attrs[k];
      else if (k.startsWith('on') && typeof attrs[k] === 'function') e.addEventListener(k.slice(2), attrs[k]);
      else e.setAttribute(k, attrs[k]);
    }
    if (children) {
      for (const c of [].concat(children)) {
        if (c == null) continue;
        e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
      }
    }
    return e;
  }

  function buildFab() {
    // SVG wand sparkle icon (currentColor so it follows hover state)
    const iconSvg =
      '<svg class="vc-fab-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<path d="M5 19 L15 9"/>' +
        '<path d="M14 8 L16 10"/>' +
        '<path d="M18 4 v3 M16.5 5.5 h3"/>' +
        '<path d="M20 14 v2 M19 15 h2"/>' +
        '<path d="M6 6 v2 M5 7 h2"/>' +
      '</svg>';

    const btn = el('button', {
      class: 'vc-fab is-pulse',
      type: 'button',
      'aria-label': 'Open vibe-coding recipes',
      'aria-haspopup': 'dialog',
      'aria-expanded': 'false',
      html: iconSvg + '<span>Vibe coding</span><span class="vc-fab-tag">prompts</span>'
    });
    return btn;
  }

  function buildRecipe(r) {
    const head = el('summary', { class: 'vc-recipe-head' }, [
      el('span', { class: 'vc-recipe-num', text: String(r.n) }),
      el('span', { class: 'vc-recipe-title' }, [
        document.createTextNode(r.title),
        el('span', { class: 'vc-recipe-sub', text: r.sub })
      ]),
      el('span', { class: 'vc-recipe-chev', text: 'open' })
    ]);

    const pre = el('pre', { class: 'vc-recipe-pre' });
    pre.textContent = r.prompt;
    const copyBtn = el('button', {
      class: 'vc-copy',
      type: 'button',
      text: 'Copy prompt',
      onclick: function () { copyText(r.prompt, copyBtn); }
    });
    const preHeader = el('div', { class: 'vc-pre-header' }, [
      el('span', { class: 'vc-pre-label', text: 'Prompt — paste into Claude, ChatGPT, or Gemini' }),
      copyBtn
    ]);
    const preWrap = el('div', { class: 'vc-pre-wrap' }, [preHeader, pre]);

    const tip = el('div', { class: 'vc-recipe-tip' }, [
      el('strong', { text: 'Tip' }),
      document.createTextNode(r.tip)
    ]);

    const body = el('div', { class: 'vc-recipe-body' }, [preWrap, tip]);

    const recipe = el('details', {
      class: 'vc-recipe',
      'data-n': String(r.n)
    }, [head, body]);

    if (r.n === 1) recipe.setAttribute('open', '');

    // Update the chev label based on open/closed
    recipe.addEventListener('toggle', function () {
      head.querySelector('.vc-recipe-chev').textContent = recipe.open ? 'close' : 'open';
    });

    return recipe;
  }

  function buildPanel() {
    const closeBtn = el('button', {
      class: 'vc-close',
      type: 'button',
      'aria-label': 'Close',
      text: '✕'
    });

    const head = el('div', { class: 'vc-head' }, [
      el('div', { class: 'vc-head-text' }, [
        el('div', { class: 'vc-eyebrow', text: 'Vibe coding · 8 steps' }),
        el('div', { class: 'vc-title', text: 'Build a SimPy model with any LLM' }),
        el('div', { class: 'vc-sub', text: 'Copy each prompt into ChatGPT, Claude, or Gemini in order. Each step’s output feeds the next. Replace anything in <<double angle brackets>> before you send it.' })
      ]),
      closeBtn
    ]);

    const body = el('div', { class: 'vc-body' });
    RECIPES.forEach(function (r) { body.appendChild(buildRecipe(r)); });

    const foot = el('div', { class: 'vc-foot' }, [
      el('span', { text: 'Mirrors the four-phase workflow in the paper.' }),
      el('a', {
        href: 'https://github.com/mdehghani86/wsc26-genai-sim',
        target: '_blank',
        rel: 'noopener',
        text: 'Repo →'
      })
    ]);

    const panel = el('aside', {
      class: 'vc-panel',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-labelledby': 'vc-panel-title',
      tabindex: '-1'
    }, [head, body, foot]);

    head.querySelector('.vc-title').id = 'vc-panel-title';

    return { panel: panel, closeBtn: closeBtn };
  }

  // -------------------------------------------------------
  // Clipboard
  // -------------------------------------------------------
  function copyText(text, btn) {
    const original = btn.textContent;
    const flash = function (label, klass) {
      btn.textContent = label;
      btn.classList.remove('is-copied', 'is-failed');
      btn.classList.add(klass);
      setTimeout(function () {
        btn.textContent = original;
        btn.classList.remove(klass);
      }, 1600);
    };
    const onSuccess = function () { flash('copied', 'is-copied'); };
    const onFailure = function () { flash('select & copy', 'is-failed'); };

    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(onSuccess, function () {
        if (!fallback()) onFailure();
      });
    } else {
      if (!fallback()) onFailure();
    }

    function fallback() {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'absolute';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (_) { ok = false; }
      document.body.removeChild(ta);
      if (ok) onSuccess();
      return ok;
    }
  }

  // -------------------------------------------------------
  // Mount and wire up
  // -------------------------------------------------------
  function mount() {
    if (document.querySelector('.vc-fab')) return;

    const fab = buildFab();
    const backdrop = el('div', { class: 'vc-backdrop' });
    const built = buildPanel();
    const panel = built.panel;
    const closeBtn = built.closeBtn;

    document.body.appendChild(fab);
    document.body.appendChild(backdrop);
    document.body.appendChild(panel);

    let lastFocus = null;
    let openFocusTimer = null;

    const FOCUSABLE = [
      'button:not([disabled])',
      '[href]',
      'input:not([disabled])',
      'select:not([disabled])',
      'textarea:not([disabled])',
      'summary',
      '[tabindex]:not([tabindex="-1"])'
    ].join(',');

    function focusables() {
      return Array.prototype.filter.call(
        panel.querySelectorAll(FOCUSABLE),
        function (el) {
          return !el.hasAttribute('disabled') &&
                 el.offsetParent !== null;
        }
      );
    }

    function isOpen() { return panel.classList.contains('is-open'); }

    function open() {
      lastFocus = document.activeElement;
      backdrop.classList.add('is-open');
      panel.classList.add('is-open');
      fab.setAttribute('aria-expanded', 'true');
      fab.classList.remove('is-pulse');
      try { localStorage.setItem('vc-seen', '1'); } catch (_) {}
      if (openFocusTimer) { clearTimeout(openFocusTimer); }
      openFocusTimer = setTimeout(function () {
        openFocusTimer = null;
        if (isOpen()) closeBtn.focus();
      }, 50);
    }
    function close() {
      if (openFocusTimer) { clearTimeout(openFocusTimer); openFocusTimer = null; }
      backdrop.classList.remove('is-open');
      panel.classList.remove('is-open');
      fab.setAttribute('aria-expanded', 'false');
      if (lastFocus && typeof lastFocus.focus === 'function') {
        lastFocus.focus();
      }
    }

    fab.addEventListener('click', open);
    backdrop.addEventListener('click', close);
    closeBtn.addEventListener('click', close);

    // Single keydown handler: Escape closes, Tab is trapped inside the panel
    // while it is open so focus cannot escape into the obscured page.
    document.addEventListener('keydown', function (ev) {
      if (!isOpen()) return;
      if (ev.key === 'Escape') {
        ev.preventDefault();
        close();
        return;
      }
      if (ev.key !== 'Tab') return;
      const list = focusables();
      if (list.length === 0) {
        ev.preventDefault();
        closeBtn.focus();
        return;
      }
      const first = list[0];
      const last = list[list.length - 1];
      const active = document.activeElement;
      if (!panel.contains(active)) {
        ev.preventDefault();
        (ev.shiftKey ? last : first).focus();
        return;
      }
      if (ev.shiftKey && active === first) {
        ev.preventDefault();
        last.focus();
      } else if (!ev.shiftKey && active === last) {
        ev.preventDefault();
        first.focus();
      }
    });

    // suppress the pulse on repeat visits
    try {
      if (localStorage.getItem('vc-seen') === '1') fab.classList.remove('is-pulse');
    } catch (_) {}
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
})();
