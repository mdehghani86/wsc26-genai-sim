# GenAI + Simulation Tutorial &mdash; companion app

Live, in-browser companion application for the WSC GenAI + Simulation Tutorial paper. One full-stack page with a sidebar of phase-by-phase tabs; each phase consumes the artefact produced by the previous one.

Live: <https://mdehghani86.github.io/wsc2025-genai-simulation-tutorial/>

## Tabs

| # | Tab | Status |
|---|---|---|
| 0 | Problem formulation | live |
| 1a | Input modelling | live (Pyodide + scipy) |
| 1b | Model creation | placeholder |
| 2 | Execution | placeholder; the 2025 ER demo is preserved at `/legacy-2025/` |
| 3 | Experimentation | placeholder |
| + | Agentic AI via MCP | placeholder |
| + | Frontier-LLM comparison | placeholder |

## Architecture

* **Static site.** Everything is HTML, CSS, and vanilla JS. GitHub Pages hosts the root.
* **Pyodide** loads scipy / numpy in the browser the first time the user navigates to a tab that needs Python. No backend.
* **Chart.js** for histograms and Q-Q plots.
* **Hash routing.** `#/input-modelling`, `#/phase0`, etc.; one `<section class="page">` per route.
* **Warm-pastel palette** matches the figures in the paper (`shell.css`).

## Files

```
index.html               # shell + every page in one file
css/
  shell.css              # palette, sidebar, layout
  input-modelling.css    # tab-specific styles
js/
  shell.js               # nav + hash router
  pyodide-runtime.js     # shared Pyodide bootstrap
  input-modelling.js     # data picker, validation, fits, Q-Q, snippet
data/
  arrivals_clean.csv     # demo: stationary exponential ED arrivals
  arrivals_bursty.csv    # demo: rush-hour timestamps, non-stationary
legacy-2025/             # archived 2025 ER demo (linked from Phase 2 tab)
```

## Running locally

```bash
python -m http.server 8000
# then open http://localhost:8000
```

A static server is required because the page fetches `data/*.csv` and Pyodide's wheels.

## Citation

Dehghanimohammadi, M., Belsare, S., and Sadeghi, N. (2026). *A Tutorial on Generative AI and Simulation Modeling Integration.* Proceedings of the Winter Simulation Conference.
