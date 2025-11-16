(function(){
  if (window.__macroAutomatorInjected) return;
  window.__macroAutomatorInjected = true;

  const HIGHLIGHT_MS_DEFAULT = 800;
  const STATE_KEY = '__macroAutomatorState';
  const hasSessionStorageApi = !!(chrome.storage && chrome.storage.session);

  const RANDOM_WORDS = ['alpha','bravo','charlie','delta','echo','foxtrot','golf','hotel','india','juliet','kilo','lima','mike','november','oscar','papa','quebec','romeo','sierra','tango','uniform','victor','whiskey','xray','yankee','zulu'];
  const RANDOM_FIRST_NAMES = ['Luca','Giulia','Marco','Francesca','Paolo','Chiara','Alessio','Marta','Davide','Sara','Giorgio','Elisa','Nicola','Anna','Matteo','Laura','Riccardo','Noemi','Stefano','Beatrice'];
  const RANDOM_LAST_NAMES = ['Rossi','Bianchi','Ferrari','Esposito','Romano','Galli','Costa','Fontana','Greco','Lombardi','Moretti','Marino','Giordano','Mancini','De Luca','Ricci','Testa','Rinaldi','Caruso','Ferri'];
  const RANDOM_COLORS = ['rosso','verde','blu','giallo','arancione','viola','indaco','ciano','magenta','oliva','marrone','avorio','crema','teal','salvia','corallo','lavanda','perla','zafferano','rubino'];
  const RANDOM_EMAIL_DOMAINS = ['example.com', 'mail.test', 'company.dev', 'demo.io', 'sample.net'];
  const RANDOM_PRESET_LABELS = {
    word: 'Parola casuale',
    sentence: 'Frase casuale',
    name: 'Nome proprio',
    fullName: 'Nome e cognome',
    email: 'Email realistica',
    color: 'Colore casuale',
    uuid: 'UUID',
    number4: 'Numero a 4 cifre'
  };

  function randomChoice(list) {
    if (!Array.isArray(list) || !list.length) return '';
    return list[Math.floor(Math.random() * list.length)];
  }

  function uuidv4(){
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random()*16|0, v = c==='x'? r : (r&0x3|0x8);
      return v.toString(16);
    });
  }

  function randInt(a,b){ a=Number(a); b=Number(b); return Math.floor(a + Math.random()*(b-a+1)); }
  function randFloat(a,b,d){ a=Number(a); b=Number(b); d=Number(d||0); return (a + Math.random()*(b-a)).toFixed(d); }

  async function loadRunState() {
    if (hasSessionStorageApi) {
      try {
        const data = await chrome.storage.session.get(STATE_KEY);
        if (data && data[STATE_KEY]) return data[STATE_KEY];
      } catch (error) {
        console.warn('storage.session get error', error);
      }
    }
    try {
      const raw = sessionStorage.getItem(STATE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (error) {
      console.warn('sessionStorage get error', error);
      return null;
    }
  }

  async function saveRunState(state) {
    if (!state) return clearRunState();
    if (hasSessionStorageApi) {
      try {
        await chrome.storage.session.set({ [STATE_KEY]: state });
        return;
      } catch (error) {
        console.warn('storage.session set error', error);
      }
    }
    try {
      sessionStorage.setItem(STATE_KEY, JSON.stringify(state));
    } catch (error) {
      console.warn('sessionStorage set error', error);
    }
  }

  async function clearRunState() {
    if (hasSessionStorageApi) {
      try {
        await chrome.storage.session.remove(STATE_KEY);
        return;
      } catch (error) {
        console.warn('storage.session remove error', error);
      }
    }
    try {
      sessionStorage.removeItem(STATE_KEY);
    } catch (error) {
      console.warn('sessionStorage remove error', error);
    }
  }

  let isRunning = false;
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg) return;
    if (msg.kind === 'STOP_RUNNER') {
      isRunning = false;
      Promise.all([flushSequenceCache(), clearRunState()]).then(()=> {
        sendResponse?.({ ok: true });
      }).catch(err => {
        console.warn('STOP_RUNNER cleanup failed', err);
        sendResponse?.({ ok: false });
      });
      return true;
    }
    return undefined;
  });


  const sequenceState = {
    cache: null,
    loading: null,
    flushTimer: null
  };

  function storageGet(defaults) {
    return new Promise((resolve) => {
      chrome.storage.sync.get(defaults, data => {
        if (chrome.runtime.lastError) {
          console.warn('storage.get error', chrome.runtime.lastError);
          resolve(defaults || {});
        } else {
          resolve(data || defaults || {});
        }
      });
    });
  }

  function storageSet(payload) {
    return new Promise((resolve) => {
      chrome.storage.sync.set(payload, () => {
        if (chrome.runtime.lastError) {
          console.warn('storage.set error', chrome.runtime.lastError);
        }
        resolve();
      });
    });
  }

  async function ensureSequenceCache() {
    if (sequenceState.cache) return sequenceState.cache;
    if (!sequenceState.loading) {
      sequenceState.loading = storageGet({ sequences: {} })
        .then(data => data.sequences || {})
        .catch(err => {
          console.warn('Failed to load sequences', err);
          return {};
        })
        .finally(() => {
          sequenceState.loading = null;
        });
    }
    sequenceState.cache = await sequenceState.loading;
    return sequenceState.cache;
  }

  function scheduleSequenceFlush() {
    if (!sequenceState.cache) return;
    if (sequenceState.flushTimer) return;
    sequenceState.flushTimer = setTimeout(async () => {
      sequenceState.flushTimer = null;
      await storageSet({ sequences: sequenceState.cache });
    }, 50);
  }

  async function flushSequenceCache() {
    if (!sequenceState.cache) return;
    if (sequenceState.flushTimer) {
      clearTimeout(sequenceState.flushTimer);
      sequenceState.flushTimer = null;
    }
    await storageSet({ sequences: sequenceState.cache });
  }

  window.addEventListener('beforeunload', () => {
    flushSequenceCache();
  });

  function isXPath(sel){
    if (!sel) return false;
    const s = sel.trim();
    return s.startsWith('//') || s.startsWith('(/') || s.startsWith('(//') || s.startsWith('.//');
  }

  function q(sel) {
    if (isXPath(sel)) {
      const r = document.evaluate(sel, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
      return r.singleNodeValue || null;
    }
    try { return document.querySelector(sel); } catch { return null; }
  }

  function sleep(ms){ return new Promise(res => setTimeout(res, ms)); }

  async function waitForSelector(selector, timeoutMs=5000){
    const start = performance.now();
    while (performance.now() - start < timeoutMs) {
      const el = q(selector);
      if (el) return el;
      await sleep(100);
    }
    throw new Error(`Timeout in attesa del selettore: ${selector}`);
  }

  function highlight(el, ok=true, ms=HIGHLIGHT_MS_DEFAULT){
    if (!el || !el.style) return;
    const prevOutline = el.style.outline;
    el.style.outline = `2px solid ${ok? '#22c55e': '#ef4444'}`;
    setTimeout(()=>{ el.style.outline = prevOutline || ''; }, ms);
  }

  function dispatchRichClick(el){
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const clientX = rect.left + (rect.width || 0) / 2;
    const clientY = rect.top + (rect.height || 0) / 2;
    const eventInit = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX,
      clientY,
      buttons: 1
    };
    ['pointerdown','mousedown','pointerup','mouseup','click'].forEach(type => {
      const evt = new MouseEvent(type, eventInit);
      el.dispatchEvent(evt);
    });
  }

  // Placeholder engine
  async function resolvePlaceholders(text){
    if (typeof text !== 'string') return text;
    if (!/\{\{[^}]+\}\}/.test(text) && !/\[[^\]]+\|[^\]]+\]/.test(text)) return text;

    async function nextSeq(name){
      const cache = await ensureSequenceCache();
      const key = String(name || 'default');
      const curr = Number(cache[key] || 0) + 1;
      cache[key] = curr;
      scheduleSequenceFlush();
      return curr;
    }

    // alternatives: [a|b|c]
    text = text.replace(/\[(?:[^\]|\\]|\\\]|\\\|)+\]/g, (m)=>{
      const inner = m.slice(1,-1);
      const parts = inner.split('|').map(s=>s.trim()).filter(Boolean);
      if (!parts.length) return '';
      return parts[Math.floor(Math.random()*parts.length)];
    });

    async function asyncReplace(str, regex, replacer){
      const tokens = [];
      str.replace(regex, (match, ...args)=>{ tokens.push({ match, args }); return match; });
      for (const t of tokens){
        const rep = await replacer(t.match, ...t.args);
        str = str.replace(t.match, rep);
      }
      return str;
    }

    text = await asyncReplace(text, /\{\{UUID\}\}/g, ()=> uuidv4());
    text = await asyncReplace(text, /\{\{TIMESTAMP\}\}\s*/g, ()=> String(Date.now()));
    text = await asyncReplace(text, /\{\{RANDOM_INT:(\-?\d+):(\-?\d+)\}\}/g, (_m,a,b)=> String(randInt(a,b)));
    text = await asyncReplace(text, /\{\{RANDOM_FLOAT:(\-?\d+\.?\d*):(\-?\d+\.?\d*):(\d+)\}\}/g, (_m,a,b,d)=> String(randFloat(a,b,d)));
    text = await asyncReplace(text, /\{\{RANDOM_WORD\}\}/g, ()=> randomChoice(RANDOM_WORDS));
    text = await asyncReplace(text, /\{\{RANDOM_SENTENCE\}\}/g, ()=> `${randomChoice(RANDOM_WORDS)} ${randomChoice(RANDOM_WORDS)} ${randomChoice(RANDOM_WORDS)}`);
    text = await asyncReplace(text, /\{\{RANDOM_EMAIL\}\}/g, ()=> `user${randInt(1000,9999)}@${randomChoice(RANDOM_EMAIL_DOMAINS)}`);
    text = await asyncReplace(text, /\{\{SEQ:([a-zA-Z0-9_\-]+)\}\}/g, async (_m,name)=> String(await nextSeq(name)) );

    return text;
  }

  function generateRandomText(preset){
    switch (preset) {
      case 'word':
        return randomChoice(RANDOM_WORDS);
      case 'sentence':
        return `${randomChoice(RANDOM_WORDS)} ${randomChoice(RANDOM_WORDS)} ${randomChoice(RANDOM_WORDS)}`;
      case 'name':
        return randomChoice(RANDOM_FIRST_NAMES);
      case 'fullName':
        return `${randomChoice(RANDOM_FIRST_NAMES)} ${randomChoice(RANDOM_LAST_NAMES)}`;
      case 'email': {
        const local = `${randomChoice(RANDOM_FIRST_NAMES)}${randInt(1,9999)}`.toLowerCase();
        return `${local.replace(/\s+/g,'')}.${randInt(10,99)}@${randomChoice(RANDOM_EMAIL_DOMAINS)}`;
      }
      case 'color':
        return randomChoice(RANDOM_COLORS);
      case 'uuid':
        return uuidv4();
      case 'number4':
        return String(randInt(1000, 9999));
      default:
        return '';
    }
  }

  async function performStep(step, options){
    const timeout = Number(step.timeout ?? options.defaultTimeout ?? 5000);

    if (step.type === 'wait') {
      await sleep(Number(step.ms||0));
      return { label: `Attesa ${step.ms} ms` };
    }
    if (step.type === 'waitFor') {
      const el = await waitForSelector(step.selector, timeout);
      highlight(el, true, options.highlightMs);
      return { label: `Attesa elemento ${step.selector}` };
    }
    if (step.type === 'click') {
      const el = await waitForSelector(step.selector, timeout);
      highlight(el, true, options.highlightMs);
      if (el.matches?.('select')) {
        el.focus();
        if (typeof el.showPicker === 'function') {
          try {
            el.showPicker();
          } catch (err) {
            dispatchRichClick(el);
          }
        } else {
          dispatchRichClick(el);
        }
      } else {
        el.click();
      }
      return { label: `Clic ${step.selector}` };
    }
    if (step.type === 'type') {
      const el = await waitForSelector(step.selector, timeout);
      let rawText = '';
      if (step.randomPreset) {
        rawText = generateRandomText(step.randomPreset) || '';
      } else {
        rawText = step.text || '';
      }
      const textResolved = await resolvePlaceholders(rawText);
      const text = typeof textResolved === 'string' ? textResolved : String(textResolved ?? rawText ?? '');
      el.focus();
      if ('value' in el) el.value = text;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      highlight(el, true, options.highlightMs);
      const label = step.randomPreset
        ? `Scrivi ${RANDOM_PRESET_LABELS[step.randomPreset] || 'testo random'} → ${step.selector}`
        : `Scrivi → ${step.selector}`;
      return { label };
    }
    if (step.type === 'selectOption') {
      const el = await waitForSelector(step.selector, timeout);
      const optionsList = Array.from(el?.options || []);
      let chosen = null;
      if (step.value) {
        chosen = optionsList.find(opt => opt.value == step.value);
      }
      if (!chosen && step.text) {
        const targetText = String(step.text).trim().toLowerCase();
        chosen = optionsList.find(opt => opt.text.trim().toLowerCase() === targetText);
      }
      if (!chosen) {
        throw new Error(`Opzione non trovata (${step.value || step.text || 'n.d.'})`);
      }
      el.value = chosen.value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      highlight(el, true, options.highlightMs);
      return { label: `Seleziona ${chosen.text || chosen.value} → ${step.selector}` };
    }
    if (step.type === 'pressKey') {
      const key = step.key || 'Enter';
      document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles:true }));
      document.activeElement?.dispatchEvent(new KeyboardEvent('keypress', { key, bubbles:true }));
      document.activeElement?.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles:true }));
      return { label: `Premi ${key}` };
    }
    if (step.type === 'navigate') {
      const url = await resolvePlaceholders(step.url || '');
      window.location.href = url;
      return { label: `Apri URL ${url}` };
    }
    throw new Error('Tipo di azione sconosciuto: ' + step.type);
  }

  async function executeFromState(port, providedState = null) {
    if (isRunning) {
      port.postMessage({ kind: 'ERROR', error: 'Macro già in esecuzione' });
      return;
    }
    isRunning = true;
    try {
      let state = providedState || await loadRunState();
      if (!state || !state.macro) {
        port.postMessage({ kind: 'ERROR', error: 'Nessuna macro da eseguire' });
        return;
      }

      const macro = JSON.parse(JSON.stringify(state.macro || {}));
      const steps = Array.isArray(macro.steps) ? macro.steps : [];
      const options = { defaultTimeout: 5000, highlightMs: 800, failFast: true, ...(macro.options || {}) };
      let index = Number(state.stepIndex || 0);
      if (!Number.isFinite(index) || index < 0) index = 0;
      if (index > steps.length) index = steps.length;
      const total = steps.length;

      await saveRunState({ macro, stepIndex: index });
      port.postMessage({ kind: 'STATE', step: index, total });

      if (!total || index >= total) {
        await flushSequenceCache();
        await clearRunState();
        port.postMessage({ kind: 'DONE', total });
        return;
      }

      let aborted = false;

      for (let i = index; i < steps.length; i++) {
        const step = steps[i];
        await saveRunState({ macro, stepIndex: i });
        try {
          if (step.type === 'navigate') {
            await saveRunState({ macro, stepIndex: i + 1 });
          }
          const res = await performStep(step, options);
          if (step.type !== 'navigate') {
            await saveRunState({ macro, stepIndex: i + 1 });
          }
          port.postMessage({ kind: 'PROGRESS', step: i + 1, total, label: res?.label || step.type });
        } catch (err) {
          port.postMessage({ kind: 'ERROR', error: err.message || String(err) });
          if (options.failFast !== false) {
            await saveRunState({ macro, stepIndex: i });
            aborted = true;
            break;
          } else {
            await saveRunState({ macro, stepIndex: i + 1 });
          }
        }
      }

      await flushSequenceCache();

      if (!aborted) {
        await clearRunState();
        port.postMessage({ kind: 'DONE', total });
      }
    } finally {
      isRunning = false;
    }
  }

  chrome.runtime.onConnect.addListener((port) => {
    if (port.name === 'macro-automator-test') {
      port.onMessage.addListener(async (msg) => {
        if (msg.kind !== 'TEST_STEP') return;
        const step = msg.step;
        const options = { defaultTimeout: 5000, highlightMs: 800, failFast: true };
        
        try {
          const res = await performStep(step, options);
          port.postMessage({ kind: 'TEST_SUCCESS', label: res?.label || step.type });
        } catch (err) {
          port.postMessage({ kind: 'TEST_ERROR', error: err.message || String(err) });
        }
      });
      return;
    }
    
    if (port.name !== 'macro-automator') return;
    port.onDisconnect.addListener(() => {
      flushSequenceCache();
    });
    port.onMessage.addListener(async (msg) => {
      if (msg.kind === 'RUN') {
        const macro = msg.macro ? JSON.parse(JSON.stringify(msg.macro)) : null;
        if (!macro) {
          port.postMessage({ kind: 'ERROR', error: 'Macro non valida' });
          return;
        }
        await saveRunState({ macro, stepIndex: 0 });
        await executeFromState(port, { macro, stepIndex: 0 });
      } else if (msg.kind === 'RESUME') {
        const stored = await loadRunState();
        if (!stored || !stored.macro) {
          port.postMessage({ kind: 'ERROR', error: 'Nessuna macro da riprendere' });
          return;
        }
        const macro = JSON.parse(JSON.stringify(stored.macro));
        await saveRunState({ macro, stepIndex: stored.stepIndex || 0 });
        await executeFromState(port, { macro, stepIndex: stored.stepIndex || 0 });
      }
    });
  });
})();