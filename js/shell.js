/* =========================================================
   Shell — sidebar nav + hash routing.
   Each <section class="page" data-page="..."> matches one #/route.
   ========================================================= */
(function () {
  'use strict';

  const ROUTES = [
    'home', 'phase0', 'input-modelling', 'model-creation', 'mcp',
    'exec-entity', 'exec-orchestration', 'exec-prediction', 'exec-simgpt',
    'experimentation', 'comparison', 'about'
  ];

  function readRoute() {
    const raw = (location.hash || '').replace(/^#\/?/, '').trim();
    return ROUTES.includes(raw) ? raw : 'home';
  }

  function activate(route) {
    document.querySelectorAll('.page').forEach(p => {
      p.classList.toggle('active', p.dataset.page === route);
    });
    document.querySelectorAll('.nav-item').forEach(n => {
      n.classList.toggle('active', n.dataset.route === route);
    });
    if (window.scrollTo) window.scrollTo(0, 0);

    document.dispatchEvent(new CustomEvent('route:change', { detail: { route } }));
    document.dispatchEvent(new CustomEvent('route:' + route, { detail: { route } }));
  }

  window.addEventListener('hashchange', () => activate(readRoute()));
  window.addEventListener('DOMContentLoaded', () => activate(readRoute()));
})();
