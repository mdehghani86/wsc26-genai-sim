/* =========================================================
   llm-client.js — shared, browser-side LLM client for the
   Execution live demos (2b Orchestration, 2c Prediction).

   - Key kept in sessionStorage only (cleared when tab closes).
   - Direct browser -> provider calls (user's own key).
   - Providers: Anthropic (Claude), OpenAI, Google (Gemini).
   - Never logged, never sent anywhere but the chosen provider.
   ========================================================= */
window.LLM = (function () {
  'use strict';

  const KEY_STORE = 'wsc_llm_key';
  const PROV_STORE = 'wsc_llm_provider';

  const PROVIDERS = {
    anthropic: { label: 'Claude (Anthropic)', model: 'claude-haiku-4-5-20251001' },
    openai:    { label: 'OpenAI',             model: 'gpt-4o-mini' },
    gemini:    { label: 'Gemini (Google)',    model: 'gemini-2.5-flash' }
  };

  function getProvider() { return sessionStorage.getItem(PROV_STORE) || 'anthropic'; }
  function getKey()      { return sessionStorage.getItem(KEY_STORE) || ''; }
  function setProvider(p){ sessionStorage.setItem(PROV_STORE, p); }
  function setKey(k)     { if (k) sessionStorage.setItem(KEY_STORE, k); else sessionStorage.removeItem(KEY_STORE); }
  function hasKey()      { return !!getKey(); }

  // ---- provider call adapters -------------------------------------------
  async function callAnthropic(key, model, system, user, opts) {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model,
        max_tokens: opts.maxTokens || 256,
        temperature: opts.temperature ?? 0,
        system,
        messages: [{ role: 'user', content: user }]
      })
    });
    if (!r.ok) throw new Error('Anthropic ' + r.status + ': ' + (await r.text()).slice(0, 240));
    const d = await r.json();
    return (d.content || []).map(b => b.text || '').join('').trim();
  }

  async function callOpenAI(key, model, system, user, opts) {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'authorization': 'Bearer ' + key },
      body: JSON.stringify({
        model,
        temperature: opts.temperature ?? 0,
        max_tokens: opts.maxTokens || 256,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }]
      })
    });
    if (!r.ok) throw new Error('OpenAI ' + r.status + ': ' + (await r.text()).slice(0, 240));
    const d = await r.json();
    return (d.choices?.[0]?.message?.content || '').trim();
  }

  async function callGemini(key, model, system, user, opts) {
    const url = 'https://generativelanguage.googleapis.com/v1beta/models/' +
                model + ':generateContent?key=' + encodeURIComponent(key);
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: user }] }],
        generationConfig: { temperature: opts.temperature ?? 0, maxOutputTokens: opts.maxTokens || 256 }
      })
    });
    if (!r.ok) throw new Error('Gemini ' + r.status + ': ' + (await r.text()).slice(0, 240));
    const d = await r.json();
    return (d.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('').trim();
  }

  // ---- public: one call, returns {text, ms} -----------------------------
  async function call(system, user, opts) {
    opts = opts || {};
    const provider = getProvider();
    const key = getKey();
    if (!key) throw new Error('No API key set.');
    const model = opts.model || PROVIDERS[provider].model;
    const t0 = performance.now();
    let text;
    if (provider === 'anthropic') text = await callAnthropic(key, model, system, user, opts);
    else if (provider === 'openai') text = await callOpenAI(key, model, system, user, opts);
    else if (provider === 'gemini') text = await callGemini(key, model, system, user, opts);
    else throw new Error('Unknown provider: ' + provider);
    return { text, ms: Math.round(performance.now() - t0), provider, model };
  }

  // ---- key panel UI (reused by both demos) ------------------------------
  function renderKeyPanel(host) {
    host.innerHTML =
      '<div class="lk-row">' +
        '<div class="lk-field"><label>Provider</label>' +
          '<select class="lk-prov">' +
            Object.entries(PROVIDERS).map(([k, v]) =>
              `<option value="${k}">${v.label}</option>`).join('') +
          '</select></div>' +
        '<div class="lk-field lk-grow"><label>API key <span class="lk-sub">(stays in this tab; direct calls to the provider only)</span></label>' +
          '<input type="password" class="lk-key" placeholder="paste your key" autocomplete="off" /></div>' +
        '<button class="lk-save" type="button">Save</button>' +
        '<span class="lk-status" aria-live="polite"></span>' +
      '</div>';

    const prov = host.querySelector('.lk-prov');
    const inp = host.querySelector('.lk-key');
    const status = host.querySelector('.lk-status');
    prov.value = getProvider();
    if (hasKey()) { inp.value = '••••••••••••'; status.textContent = 'key saved'; status.className = 'lk-status ok'; }

    prov.addEventListener('change', () => setProvider(prov.value));
    host.querySelector('.lk-save').addEventListener('click', () => {
      setProvider(prov.value);
      const v = inp.value.trim();
      if (v && v !== '••••••••••••') { setKey(v); inp.value = '••••••••••••'; }
      status.textContent = hasKey() ? 'key saved' : 'no key';
      status.className = 'lk-status ' + (hasKey() ? 'ok' : 'warn');
      document.dispatchEvent(new CustomEvent('llm:key'));
    });
  }

  // best-effort JSON extraction from a model reply
  function parseJSON(text) {
    if (!text) return null;
    const m = text.match(/\{[\s\S]*\}/);
    try { return JSON.parse(m ? m[0] : text); } catch (e) { return null; }
  }

  return { call, hasKey, getProvider, renderKeyPanel, parseJSON, PROVIDERS };
})();
