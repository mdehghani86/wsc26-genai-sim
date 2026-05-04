/* MCP tab controller.
   Loads the recorded session, ensures Pyodide + simpy are ready, and steps
   through the tool calls. Each tool call invokes the real simpy_mcp module
   running in Pyodide, and the response is the actual server output. */
(function () {
  'use strict';

  const SESSION_URL = 'phase9_mcp/session.json';
  const SERVER_URL  = 'phase9_mcp/simpy_mcp.py';

  const $  = (sel, root = document) => root.querySelector(sel);
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };

  let session = null;
  let serverLoaded = false;
  let stepIdx = 0;        // index of NEXT step to execute
  let py = null;
  let ui = null;          // dom refs

  async function ensureServer() {
    if (serverLoaded) return;
    py = await window.Runtime.ensureSimpy();
    const src = await fetch(SERVER_URL).then(r => r.text());
    py.FS.writeFile('simpy_mcp.py', src);
    await py.runPythonAsync('import simpy_mcp');
    serverLoaded = true;
  }

  async function callTool(name, args) {
    await ensureServer();
    // Bridge via JSON: pass spec as a string, Python parses, calls, returns JSON.
    py.globals.set('__mcp_call', JSON.stringify({ name, args }));
    const result = await py.runPythonAsync(`
import simpy_mcp, json
spec = json.loads(__mcp_call)
fn = getattr(simpy_mcp, spec['name'])
out = fn(**spec['args'])
json.dumps(out)
`);
    return JSON.parse(result);
  }

  async function getState() {
    await ensureServer();
    const result = await py.runPythonAsync('import json, simpy_mcp; json.dumps(simpy_mcp.state_snapshot())');
    return JSON.parse(result);
  }

  async function resetServer() {
    await ensureServer();
    await py.runPythonAsync('import simpy_mcp; simpy_mcp.reset()');
  }

  // --- rendering ---

  function renderToolCall(tool, args) {
    const lines = [`${tool}(`];
    const keys = Object.keys(args);
    keys.forEach((k, i) => {
      const v = JSON.stringify(args[k]);
      lines.push(`  ${k} = ${v}${i < keys.length - 1 ? ',' : ''}`);
    });
    lines.push(')');
    return lines.join('\n');
  }

  function renderReply(reply) {
    return JSON.stringify(reply, null, 2);
  }

  function renderState(state) {
    ui.resList.innerHTML = '';
    if (state.resources.length === 0) {
      ui.resList.appendChild(el('li', 'empty', '(none defined)'));
    } else {
      state.resources.forEach(r => {
        const li = el('li');
        li.appendChild(el('span', 'res-name', r.name));
        li.append(`  capacity=${r.capacity}`);
        ui.resList.appendChild(li);
      });
    }
    ui.procList.innerHTML = '';
    if (state.processes.length === 0) {
      ui.procList.appendChild(el('li', 'empty', '(none defined)'));
    } else {
      state.processes.forEach(p => {
        const li = el('li');
        li.appendChild(el('span', 'proc-name', p.name));
        li.append(`  ${p.kind}`);
        ui.procList.appendChild(li);
      });
    }
    ui.wireList.innerHTML = '';
    if (state.wirings.length === 0) {
      ui.wireList.appendChild(el('li', 'empty', '(none yet)'));
    } else {
      state.wirings.forEach(w => {
        const li = el('li');
        li.appendChild(el('span', 'proc-name', w.from));
        li.appendChild(el('span', 'arrow', '→'));
        li.appendChild(el('span', 'proc-name', w.to));
        ui.wireList.appendChild(li);
      });
    }
  }

  function renderResultsTable(kpis) {
    if (!kpis || !kpis.resources) return '';
    const rows = Object.entries(kpis.resources).map(([name, m]) => `
      <tr>
        <td class="res-name">${name}</td>
        <td>${m.utilisation_mean.toFixed(2)} ± ${m.utilisation_std.toFixed(2)}</td>
        <td>${m.wait_mean.toFixed(1)}</td>
        <td>${m.wait_p95_mean.toFixed(1)}</td>
      </tr>
    `).join('');
    return `
      <h4>Last run · KPIs</h4>
      <div style="font-size:11px;color:var(--text-mut);margin-bottom:6px;">
        ${kpis.replications} reps · ${kpis.duration} min · ${kpis.n_completed_mean} entities/rep
      </div>
      <table class="mcp-results-table">
        <thead><tr><th>Resource</th><th>ρ (mean ± std)</th><th>W̄</th><th>W₉₅</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  }

  function buildTranscriptUI() {
    ui.transcript.innerHTML = '';
    session.steps.forEach((s, i) => {
      const step = el('div', 'mcp-step');
      step.dataset.idx = i;
      step.appendChild(el('div', 'mcp-utterance', s.utterance));
      const call = el('div', 'mcp-callbox');
      call.appendChild(el('span', 'label', 'CALL'));
      call.append(' ' + renderToolCall(s.tool, s.args));
      step.appendChild(call);
      const reply = el('div', 'mcp-replybox');
      reply.appendChild(el('span', 'label', 'REPLY'));
      reply.append(' (waiting…)');
      reply.style.display = 'none';
      step.appendChild(reply);
      ui.transcript.appendChild(step);
    });
  }

  function setProgress() {
    ui.progress.textContent = `${stepIdx} / ${session.steps.length}`;
    ui.btnNext.disabled = stepIdx >= session.steps.length;
    ui.btnAll.disabled  = stepIdx >= session.steps.length;
    ui.btnReset.disabled = stepIdx === 0;
  }

  async function runStep() {
    if (stepIdx >= session.steps.length) return;
    const s = session.steps[stepIdx];
    const stepEl = ui.transcript.querySelector(`.mcp-step[data-idx="${stepIdx}"]`);
    stepEl.classList.add('active');
    let reply;
    try {
      reply = await callTool(s.tool, s.args);
    } catch (err) {
      reply = { ok: false, error: String(err) };
    }
    const replyBox = stepEl.querySelector('.mcp-replybox');
    replyBox.style.display = '';
    replyBox.textContent = '';
    replyBox.appendChild(el('span', 'label', reply.ok === false ? 'ERROR' : 'REPLY'));
    if (reply.ok === false) replyBox.classList.add('err');
    replyBox.append(' ' + renderReply(reply));

    // refresh state panel
    const state = await getState();
    renderState(state);

    // if this was a run/query and we got KPIs, render the results table
    if (reply.kpis) {
      ui.results.innerHTML = renderResultsTable(reply.kpis);
    }

    stepEl.classList.remove('active');
    stepEl.classList.add('done');
    stepIdx++;
    setProgress();
  }

  async function runAll() {
    ui.btnAll.disabled = true;
    while (stepIdx < session.steps.length) {
      await runStep();
    }
  }

  async function reset() {
    await resetServer();
    stepIdx = 0;
    ui.transcript.querySelectorAll('.mcp-step').forEach(s => {
      s.classList.remove('done', 'active');
      const r = s.querySelector('.mcp-replybox');
      r.style.display = 'none';
      r.classList.remove('err');
      r.innerHTML = '';
      r.appendChild(el('span', 'label', 'REPLY'));
      r.append(' (waiting…)');
    });
    ui.results.innerHTML = '';
    const state = await getState();
    renderState(state);
    setProgress();
  }

  async function init() {
    const root = document.querySelector('section[data-page="mcp"] .mcp-grid');
    if (!root) return;
    if (root.dataset.initialised === '1') return;
    root.dataset.initialised = '1';

    ui = {
      catalog:   $('.mcp-catalog', root),
      controls:  $('.mcp-controls', root),
      btnNext:   $('.mcp-btn-next', root),
      btnAll:    $('.mcp-btn-all', root),
      btnReset:  $('.mcp-btn-reset', root),
      progress:  $('.mcp-progress', root),
      transcript:$('.mcp-transcript', root),
      resList:   $('.mcp-res-list', root),
      procList:  $('.mcp-proc-list', root),
      wireList:  $('.mcp-wire-list', root),
      results:   $('.mcp-results', root),
    };

    session = await fetch(SESSION_URL).then(r => r.json());
    buildTranscriptUI();
    setProgress();

    ui.btnNext.addEventListener('click', () => runStep());
    ui.btnAll.addEventListener('click',  () => runAll());
    ui.btnReset.addEventListener('click',() => reset());

    // initial state render (server not booted yet -> empty state)
    renderState({ resources: [], processes: [], wirings: [] });
  }

  // expose
  window.MCPTab = { init };

  // route hook: shell.js calls this on entering the mcp route
  document.addEventListener('route:mcp', init);
})();
