// Prompt popover — copy-to-clipboard LLM prompts with parameterised form.
// Used by Phase 1a (input modelling) and Phase 1b (model creation).
// Templates live in this file; the modal HTML is a single shared shell.
(function () {
  'use strict';

  // ---------- templates ----------
  const TEMPLATES = {
    'input-modelling': {
      eyebrow: 'Phase 1a',
      title: 'Input-modelling prompt',
      footer: 'Paste this into Claude, ChatGPT, or your IDE-integrated LLM. The model proposes candidates; scipy decides the winner.',
      fields: [
        { section: 'Mode' },
        { type: 'mode-toggle', key: 'mode', options: [
            { value: 'auto',   label: 'Auto · ED demo' },
            { value: 'custom', label: 'Custom' }
        ], defaultValue: 'auto' },

        { section: 'Data' },
        { type: 'text',  key: 'variable',     label: 'Variable name',        hint: 'What the numbers represent.', defaultValue: 'inter-arrival time (minutes)' },
        { type: 'text',  key: 'data_kind',    label: 'Data kind',            hint: 'positive continuous, counts, durations, etc.', defaultValue: 'positive continuous, durations' },
        { type: 'number',key: 'n_samples',    label: 'Number of samples',    defaultValue: 1000 },
        { type: 'number',key: 'mean',         label: 'Sample mean',          step: 0.01, defaultValue: 10.2 },
        { type: 'number',key: 'std',          label: 'Sample std',           step: 0.01, defaultValue: 9.8 },
        { type: 'number',key: 'min',          label: 'Sample min',           step: 0.01, defaultValue: 0.05 },
        { type: 'number',key: 'max',          label: 'Sample max',           step: 0.01, defaultValue: 78.4 },

        { section: 'Candidate distributions' },
        { type: 'checks', key: 'candidates', columns: 2, options: [
            { value: 'Exponential', defaultChecked: true },
            { value: 'Gamma',       defaultChecked: true },
            { value: 'Lognormal',   defaultChecked: true },
            { value: 'Weibull',     defaultChecked: true },
            { value: 'Triangular',  defaultChecked: false },
            { value: 'Normal',      defaultChecked: false },
            { value: 'Beta',        defaultChecked: false },
            { value: 'Uniform',     defaultChecked: false }
        ] }
      ],
      render: (v) => {
        const cands = (v.candidates || []).join(', ') || 'Exponential, Gamma, Lognormal, Weibull';
        return [
`You are a simulation engineer helping me fit a probability distribution to ${v.variable}.`,
``,
`I have ${v.n_samples} observations.`,
`Summary statistics:`,
`  - Mean: ${v.mean}`,
`  - Std:  ${v.std}`,
`  - Min:  ${v.min}`,
`  - Max:  ${v.max}`,
``,
`Data kind: ${v.data_kind}.`,
``,
`Propose at most 3 candidate distributions from this set: { ${cands} },`,
`ranked by likelihood of fit. For each candidate, give:`,
`  1. Distribution name and one-sentence rationale.`,
`  2. Parametrisation form (e.g. Exponential(lambda), Gamma(alpha, beta)).`,
`  3. A single SimPy-ready Python expression I can paste into a model`,
`     (e.g. random.expovariate(1/${v.mean}) or numpy.random.gamma(a, b)).`,
``,
`Return the answer as a markdown table with columns:`,
`  Rank | Distribution | Rationale | SimPy expression`,
``,
`Do NOT run a goodness-of-fit test. That is my job. You only propose.`
].join('\n');
      }
    },

    'simpy-model': {
      eyebrow: 'Phase 1b',
      title: 'SimPy model-generation prompt',
      footer: 'Paste this into your LLM. The output should be a single Python file. Run it under Pyodide or your local Python and validate against the five-check gate.',
      fields: [
        { section: 'Mode' },
        { type: 'mode-toggle', key: 'mode', options: [
            { value: 'auto',   label: 'Auto · ED demo' },
            { value: 'custom', label: 'Custom' }
        ], defaultValue: 'auto' },

        { section: 'Scenario' },
        { type: 'textarea', key: 'scenario', label: 'Scenario',
          hint: 'Plain-English description of the system.',
          defaultValue:
'Emergency department with two triage tiers (urgent, non-urgent), a shared imaging pool, and fixed bed pools. Walk-in arrival to admit-or-discharge. Ambulance routing, no-shows, and inpatient bed flow are out of scope.' },
        { type: 'text', key: 'resource_name', label: 'Resource term (singular)',
          hint: 'How to label one server (bed, cashier, machine).', defaultValue: 'bed' },

        { section: 'Capacity & timing' },
        { type: 'number', key: 'n_servers',  label: 'Number of servers', defaultValue: 6 },
        { type: 'text',   key: 'arrival',    label: 'Arrival distribution', hint: 'A Python expression.', defaultValue: 'random.expovariate(1/10.0)' },
        { type: 'text',   key: 'service',    label: 'Service distribution', hint: 'A Python expression.', defaultValue: 'random.triangular(8, 15, 30)' },
        { type: 'number', key: 'duration',   label: 'Run duration (min)',   defaultValue: 4800 },
        { type: 'number', key: 'warmup_pct', label: 'Warm-up cut (% of run)', defaultValue: 20 },
        { type: 'number', key: 'seed',       label: 'Random seed',          defaultValue: 42 },

        { section: 'Output' },
        { type: 'checks', key: 'metrics', columns: 1, options: [
            { value: 'per-patient timestamps (arrival, treatment_start, treatment_end)', defaultChecked: true },
            { value: 'per-pool rho, Lq, Wq',                                              defaultChecked: true },
            { value: 'event log',                                                         defaultChecked: true },
            { value: 'theory comparison vs Erlang-C / Allen-Cunneen',                     defaultChecked: false }
        ] }
      ],
      render: (v) => {
        const m = (v.metrics || []).map(x => `  - ${x}`).join('\n');
        return [
`You are a simulation engineer. Generate a runnable SimPy file for the problem below.`,
``,
`[Role]     Simulation engineer.`,
`[Goal]     One Python file, no dependencies beyond simpy and the standard library.`,
``,
`[Scenario]`,
`${v.scenario}`,
``,
`[Inputs]`,
`  - Number of ${v.resource_name} servers: ${v.n_servers}`,
`  - Arrival distribution: ${v.arrival}`,
`  - Service distribution: ${v.service}`,
`  - Simulation duration (minutes): ${v.duration}`,
`  - Warm-up cut: drop first ${v.warmup_pct}% of observations`,
`  - Random seed: ${v.seed}`,
``,
`[Output requirements]`,
`  - ONE simpy.Resource per pool.`,
`  - ONE worker process per server slot (NOT one process per pool).`,
`  - Append patients to the served list at server-assignment time, not at completion.`,
`  - Filter incomplete patients out before computing time-in-system metrics.`,
`  - Reconcile in-flight busy_time after env.run() (credit partial service intervals at horizon).`,
`  - Use the random seed above for reproducibility.`,
`  - Print the following at the end of the run:`,
m || '  - per-patient timestamps, per-pool rho/Lq/Wq, event log',
``,
`Return ONLY the Python file. No commentary, no markdown fences.`
].join('\n');
      }
    }
  };

  // ---------- modal shell (created lazily, once) ----------
  let modal = null;

  function buildModal() {
    if (modal) return modal;
    modal = document.createElement('div');
    modal.className = 'prompt-modal';
    modal.hidden = true;
    modal.innerHTML = `
      <div class="prompt-modal-backdrop" data-close></div>
      <div class="prompt-modal-dialog" role="dialog" aria-modal="true" aria-labelledby="pm-title">
        <header class="pm-head">
          <div>
            <span class="pm-eyebrow" id="pm-eyebrow"></span>
            <div class="pm-title" id="pm-title"></div>
          </div>
          <button class="pm-close" type="button" data-close aria-label="Close">&times;</button>
        </header>
        <div class="pm-body">
          <div class="pm-form" id="pm-form"></div>
          <div class="pm-preview">
            <div class="pm-preview-head">
              <span class="pm-preview-title">Prompt preview &middot; copy this</span>
              <button class="pm-copy" id="pm-copy" type="button">copy to clipboard</button>
            </div>
            <pre class="pm-preview-body" id="pm-preview-body"></pre>
          </div>
        </div>
        <div class="pm-foot" id="pm-foot"></div>
      </div>
    `;
    document.body.appendChild(modal);

    modal.addEventListener('click', (e) => {
      if (e.target.matches('[data-close]')) close();
    });
    document.addEventListener('keydown', (e) => {
      if (!modal.hidden && e.key === 'Escape') close();
    });

    const copyBtn = modal.querySelector('#pm-copy');
    copyBtn.addEventListener('click', () => {
      const text = modal.querySelector('#pm-preview-body').textContent;
      navigator.clipboard.writeText(text).then(() => {
        copyBtn.classList.add('is-done');
        copyBtn.textContent = 'copied!';
        setTimeout(() => {
          copyBtn.classList.remove('is-done');
          copyBtn.textContent = 'copy to clipboard';
        }, 1600);
      });
    });

    return modal;
  }

  let currentTemplate = null;
  let currentValues = {};

  function renderForm(tpl) {
    const form = modal.querySelector('#pm-form');
    form.innerHTML = '';
    tpl.fields.forEach((f, idx) => {
      if (f.section) {
        const h = document.createElement('div');
        h.className = 'pm-form-section';
        h.textContent = f.section;
        form.appendChild(h);
        return;
      }
      const wrap = document.createElement('label');
      wrap.className = 'pm-field';

      if (f.type === 'mode-toggle') {
        const toggle = document.createElement('div');
        toggle.className = 'pm-mode-toggle';
        f.options.forEach(opt => {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'pm-mode-btn';
          b.textContent = opt.label;
          b.dataset.value = opt.value;
          if ((currentValues[f.key] || f.defaultValue) === opt.value) b.classList.add('is-active');
          b.addEventListener('click', () => {
            toggle.querySelectorAll('.pm-mode-btn').forEach(x => x.classList.remove('is-active'));
            b.classList.add('is-active');
            currentValues[f.key] = opt.value;
            renderForm(tpl);
            updatePreview();
          });
          toggle.appendChild(b);
        });
        wrap.appendChild(toggle);
        form.appendChild(wrap);
        return;
      }

      if (f.type === 'checks') {
        if (f.label) {
          const lab = document.createElement('span'); lab.className = 'pm-field-label'; lab.textContent = f.label; wrap.appendChild(lab);
        }
        if (f.hint) {
          const h = document.createElement('span'); h.className = 'pm-field-hint'; h.textContent = f.hint; wrap.appendChild(h);
        }
        const grid = document.createElement('div');
        grid.className = 'pm-checks';
        grid.style.gridTemplateColumns = (f.columns === 1) ? '1fr' : '1fr 1fr';
        f.options.forEach(opt => {
          const lab = document.createElement('label');
          lab.className = 'pm-check';
          const cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.value = opt.value;
          const initVals = currentValues[f.key];
          if (Array.isArray(initVals)) cb.checked = initVals.includes(opt.value);
          else cb.checked = !!opt.defaultChecked;
          cb.addEventListener('change', () => {
            const all = Array.from(grid.querySelectorAll('input:checked')).map(x => x.value);
            currentValues[f.key] = all;
            updatePreview();
          });
          lab.appendChild(cb);
          lab.appendChild(document.createTextNode(opt.value));
          grid.appendChild(lab);
        });
        // initialise from defaults if not set
        if (currentValues[f.key] === undefined) {
          currentValues[f.key] = f.options.filter(o => o.defaultChecked).map(o => o.value);
        }
        wrap.appendChild(grid);
        form.appendChild(wrap);
        return;
      }

      const lab = document.createElement('span');
      lab.className = 'pm-field-label';
      lab.textContent = f.label;
      wrap.appendChild(lab);
      if (f.hint) {
        const h = document.createElement('span'); h.className = 'pm-field-hint'; h.textContent = f.hint; wrap.appendChild(h);
      }
      let input;
      if (f.type === 'textarea') {
        input = document.createElement('textarea');
        input.rows = 3;
      } else {
        input = document.createElement('input');
        input.type = f.type === 'number' ? 'number' : 'text';
        if (f.step) input.step = f.step;
      }
      const initVal = (currentValues[f.key] !== undefined) ? currentValues[f.key] : f.defaultValue;
      input.value = (initVal === undefined || initVal === null) ? '' : initVal;
      if (currentValues[f.key] === undefined) currentValues[f.key] = f.defaultValue;
      input.addEventListener('input', () => {
        currentValues[f.key] = (f.type === 'number') ? Number(input.value) : input.value;
        updatePreview();
      });
      wrap.appendChild(input);
      form.appendChild(wrap);
    });
  }

  function updatePreview() {
    if (!currentTemplate) return;
    const txt = currentTemplate.render(currentValues);
    modal.querySelector('#pm-preview-body').textContent = txt;
  }

  function open(templateKey) {
    buildModal();
    const tpl = TEMPLATES[templateKey];
    if (!tpl) { console.warn('Unknown prompt template:', templateKey); return; }
    currentTemplate = tpl;
    currentValues = {};
    modal.querySelector('#pm-eyebrow').textContent = tpl.eyebrow;
    modal.querySelector('#pm-title').textContent = tpl.title;
    modal.querySelector('#pm-foot').textContent = tpl.footer || '';
    renderForm(tpl);
    updatePreview();
    modal.hidden = false;
    document.body.style.overflow = 'hidden';
  }
  function close() {
    if (!modal) return;
    modal.hidden = true;
    document.body.style.overflow = '';
  }

  // ---------- wire up triggers ----------
  document.addEventListener('click', (e) => {
    const trig = e.target.closest('.prompt-popover-trigger');
    if (!trig) return;
    e.preventDefault();
    open(trig.dataset.prompt);
  });

  // expose for debugging
  window.__promptPopover = { open, close, TEMPLATES };
})();
