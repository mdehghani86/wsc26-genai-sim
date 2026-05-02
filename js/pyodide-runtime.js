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

  window.Runtime = {
    boot,
    py: () => pyodide,
    setStatus,
  };
})();
