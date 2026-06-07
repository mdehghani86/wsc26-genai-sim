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
    },

    'problem-brief': {
      eyebrow: 'Phase 0',
      title: 'Problem-formulation prompt',
      footer: 'Paste this into your LLM. The response is forced into a fixed three-row schema (problem, scope, KPIs) so outputs stay comparable across projects and models. Review every cell before building against it.',
      fields: [
        { section: 'Study' },
        { type: 'textarea', key: 'facility', label: 'Facility & context',
          hint: 'One or two sentences on the real system.',
          defaultValue: 'A small community-hospital emergency department with two triage tiers (urgent, non-urgent). The team wants to evaluate staffing and routing-rule changes under fluctuating arrival rates.' },
        { type: 'textarea', key: 'question', label: 'Study question',
          hint: 'What decision the simulation must inform.',
          defaultValue: 'Whether triage-rule changes or staffing changes deliver the larger reduction in length of stay.' },
        { section: 'KPI grounding' },
        { type: 'text', key: 'years', label: 'Literature window', defaultValue: '2023-2025' },
        { type: 'checks', key: 'searchopts', columns: 1, options: [
            { value: 'Search recent peer-reviewed simulation studies and adopt community-standard KPIs', defaultChecked: true }
        ] }
      ],
      render: (v) => {
        const search = (v.searchopts && v.searchopts.length)
          ? `Search recent literature (${v.years}) on emergency-department simulation studies and pull the KPIs the community reports most often.`
          : `Use standard discrete-event simulation KPIs for this kind of system.`;
        return [
`I am planning a discrete-event simulation study. Help me formulate it as a structured problem statement.`,
``,
`[Context]`,
`${v.facility}`,
``,
`[Study question]`,
`${v.question}`,
``,
`[Grounding]`,
`${search}`,
``,
`[Return] a single table with exactly three rows:`,
`  1. Problem definition  -- the decision the simulation must inform.`,
`  2. Scope & boundaries  -- what is in and explicitly out of the model.`,
`  3. KPIs                -- the measures the study will be judged against.`,
`Keep each cell to two or three short sentences. Flag any row you cannot fill confidently.`
].join('\n');
      }
    },

    'bed-dispatch': {
      eyebrow: 'Phase 2 · Orchestration',
      title: 'In-loop bed-assignment prompt',
      footer: 'This is the exact prompt the running model fires at each free-bed event (see phase2_decisions/llm_policy.py). The LLM answers with ONE integer; that integer IS the admission decision. Temperature is pinned to 0 for reproducibility.',
      fields: [
        { section: 'Severity scale' },
        { type: 'text', key: 'scale', label: 'Severity coding',
          hint: 'Lower number = more urgent.',
          defaultValue: '1 = urgent, 2 = moderate, 3 = routine' },
        { section: 'Live state (example)' },
        { type: 'textarea', key: 'state', label: 'Current state block',
          hint: 'What _state_to_text() injects at run time.',
          defaultValue:
'bed 0: BUSY -> sev1 pt, ~22 min until free\nbed 1: BUSY -> sev3 pt, ~8 min until free\nQueue (3 waiting): [0] sev2, waited 14 min  [1] sev1, waited 3 min  [2] sev3, waited 31 min' },
        { type: 'text', key: 'policy', label: 'Policy-so-far summary',
          hint: 'One-line rolling memory of past decisions.',
          defaultValue: 'Admitting the most urgent waiting patient, breaking ties by longest wait.' }
      ],
      render: (v) => {
        const qmax = 2;
        return [
`[System]`,
`You are an emergency-department triage dispatcher.`,
`A bed has just freed up. The waiting queue holds 2 or more patients.`,
`Your job: choose ONE patient from the queue to admit next.`,
`Severity scale: ${v.scale}. Lower number is more urgent.`,
`Trade-off: prioritising severity reduces urgent-patient wait but may starve routine patients.`,
`You will see the queue, the current ED state, your last few decisions, and a one-line`,
`summary of your policy so far. Decide consistently.`,
`Reply with ONE integer: the index in the queue (0 = first in line, 1 = second, ...).`,
`Reply with the integer only -- no words, no punctuation, no explanation.`,
``,
`[User]`,
`Recent decisions (memory): ...`,
``,
`Policy so far: ${v.policy}`,
``,
`Current state:`,
`${v.state}`,
``,
`Choose the queue index of the patient to admit next (integer in 0..${qmax}):`
].join('\n');
      }
    },

    'scenario-ideation': {
      eyebrow: 'Phase 3 · Experimentation',
      title: 'Scenario-ideation prompt',
      footer: 'The LLM proposes a starting design from the Phase 0 brief; you accept or trim the factors and levels, and the rest of the experiment runs mechanically. The LLM designs the sweep -- it does not run it.',
      fields: [
        { section: 'From the brief' },
        { type: 'textarea', key: 'kpis', label: 'KPIs (the comparison target)',
          defaultValue: 'Mean and 95th-percentile length of stay; bed utilisation; daily throughput.' },
        { type: 'textarea', key: 'factors', label: 'Movable factors (the scope row)',
          defaultValue: 'Bed count; triage staffing level; hour-of-day arrival pattern.' },
        { section: 'Design' },
        { type: 'number', key: 'reps', label: 'Replications per cell', defaultValue: 20 }
      ],
      render: (v) => [
`I am designing the experiment for a discrete-event simulation study.`,
`Propose a scenario set I can run, drawn directly from the brief below.`,
``,
`[KPIs -- what the comparison must measure]`,
`${v.kpis}`,
``,
`[Movable factors -- what I can change]`,
`${v.factors}`,
``,
`[Return]`,
`  1. A small full- or fractional-factorial design over the movable factors,`,
`     with explicit levels for each (no more than is needed to answer the KPIs).`,
`  2. ${v.reps} replications per cell, or justify a different number for the precision the KPIs demand.`,
`  3. A one-line rationale per factor tying it back to a KPI.`,
`Do not run anything. Output only the design table and rationale so I can review before execution.`
].join('\n')
    },

    'mcp-construction': {
      eyebrow: 'Stage 1.3 · Agentic construction',
      title: 'MCP tool-construction prompt',
      footer: 'The LLM never writes Python and never sees the source. It assembles the model by emitting typed calls to the simpy-mcp server (define_resource, define_process, wire, run, query_kpis); a typed error on any single step is fed back so the model repairs that step alone.',
      fields: [
        { section: 'Target model' },
        { type: 'textarea', key: 'model', label: 'System to assemble',
          defaultValue: 'An emergency department: triage, imaging, laboratory, and bed pools; walk-in arrivals; admit-or-discharge flow.' },
        { type: 'text', key: 'goal', label: 'KPI to report', defaultValue: 'per-pool utilisation, Lq, and Wq' }
      ],
      render: (v) => [
`You are constructing a discrete-event simulation by calling tools on a simulation MCP server.`,
`You do NOT write Python and you do NOT see the source. You build the model one typed call at a time.`,
``,
`[Available tools]`,
`  - define_resource(name, capacity)      -- declare a server pool`,
`  - define_process(name, steps)          -- declare an entity flow`,
`  - wire(producer, consumer)             -- connect one step to the next`,
`  - run(duration, seed, replications)    -- execute the assembled model`,
`  - query_kpis(metric)                   -- read results back`,
``,
`[Model to assemble]`,
`${v.model}`,
``,
`[Procedure]`,
`  1. Emit tool calls one at a time; wait for each server reply before the next.`,
`  2. If a call returns a typed error, repair only that step and retry -- do not restart.`,
`  3. After wiring, run the model, then query ${v.goal}.`,
`  4. If a theory check disagrees on utilisation, query the parameter at fault and fix that call alone.`,
`Report the final KPIs and the sequence of calls you made.`
].join('\n')
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
