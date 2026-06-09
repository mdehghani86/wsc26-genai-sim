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

    // accordion: open ONLY the stage that owns the active sub-route; any other
    // route (a single-item phase, home, about) collapses every stage group.
    const activeSub = document.querySelector('.nav-sub.active');
    const activeStage = activeSub ? activeSub.closest('.nav-stage') : null;
    document.querySelectorAll('.nav-stage').forEach(s => s.classList.toggle('open', s === activeStage));

    if (window.scrollTo) window.scrollTo(0, 0);

    document.dispatchEvent(new CustomEvent('route:change', { detail: { route } }));
    document.dispatchEvent(new CustomEvent('route:' + route, { detail: { route } }));
  }

  function initStageToggles() {
    document.querySelectorAll('.nav-stage-head').forEach(h => {
      h.addEventListener('click', () => {
        const stage = h.closest('.nav-stage');
        const willOpen = !stage.classList.contains('open');
        document.querySelectorAll('.nav-stage').forEach(s => s.classList.remove('open'));
        if (willOpen) stage.classList.add('open');
      });
    });
  }

  window.addEventListener('hashchange', () => activate(readRoute()));
  window.addEventListener('DOMContentLoaded', () => { initStageToggles(); activate(readRoute()); });
})();
