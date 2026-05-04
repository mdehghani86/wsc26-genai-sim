/* =========================================================
   Shared Pyodide runtime.
   Loads pyodide + scipy on first demand, exposes window.Runtime.
   Status surfaced in the sidebar footer (#pyodide-status).
   ========================================================= */
(function () {
  'use strict';

  const statusEl = () => document.getElementById('pyodide-status');
  const setStatus = (s, cls = '') => {
    const el = statusEl(); if (!el) return;
    el.textContent = s;
    el.className = 'foot-val ' + cls;
  };

  let pyodide = null;
  let bootPromise = null;
  let simpyLoaded = false;

  async function boot() {
    if (pyodide) return pyodide;
    if (bootPromise) return bootPromise;
    bootPromise = (async () => {
      setStatus('loading...');
      pyodide = await loadPyodide({ indexURL: 'https://cdn.jsdelivr.net/pyodide/v0.26.4/full/' });
      setStatus('loading scipy...');
      await pyodide.loadPackage(['numpy', 'scipy']);
      setStatus('ready', 'mono');
      return pyodide;
    })();
    return bootPromise;
  }

  async function ensureSimpy() {
    const py = await boot();
    if (simpyLoaded) return py;
    setStatus('loading simpy...');
    await py.loadPackage('micropip');
    await py.runPythonAsync(`
import micropip
await micropip.install('simpy')
`);
    simpyLoaded = true;
    setStatus('ready', 'mono');
    return py;
  }

  window.Runtime = {
    boot,
    ensureSimpy,
    py: () => pyodide,
    setStatus,
  };
})();
