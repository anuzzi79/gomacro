// === Storage helpers ===
const STORAGE_KEYS = {
  MACROS: 'macros',
  SEQUENCES: 'sequences'
};

const RANDOM_PRESETS = {
  word: { label: 'Parola casuale' },
  sentence: { label: 'Frase (3 parole)', description: 'Genera tre parole casuali' },
  name: { label: 'Nome proprio' },
  fullName: { label: 'Nome e cognome' },
  email: { label: 'Email realistica' },
  color: { label: 'Colore' },
  uuid: { label: 'UUID v4' },
  number4: { label: 'Numero a 4 cifre' }
};

function getRandomPresetLabel(key) {
  return RANDOM_PRESETS[key]?.label || 'Testo random';
}

// === Diagnostics Logging System ===
const diagnosticsLog = [];
const MAX_LOG_ENTRIES = 1000;

function addLogEntry(level, message, data = null) {
  const timestamp = new Date().toISOString();
  const entry = {
    timestamp,
    level,
    message,
    data: data ? JSON.stringify(data, null, 2) : null
  };
  diagnosticsLog.push(entry);
  if (diagnosticsLog.length > MAX_LOG_ENTRIES) {
    diagnosticsLog.shift();
  }
  console.log(`[${level.toUpperCase()}] ${message}`, data || '');
}

function getLogsAsText() {
  return diagnosticsLog.map(entry => {
    let line = `[${entry.timestamp}] [${entry.level.toUpperCase()}] ${entry.message}`;
    if (entry.data) {
      line += '\n' + entry.data;
    }
    return line;
  }).join('\n\n');
}

const params = new URLSearchParams(location.search || '');
let targetTabId = params.has('tabId') ? Number(params.get('tabId')) : null;
let activeRun = null;
let isRunningSequence = false;
if (Number.isNaN(targetTabId)) targetTabId = null;

chrome.runtime.sendMessage({ kind: 'REQUEST_TARGET_TAB' }, (resp) => {
  if (chrome.runtime.lastError) return;
  const maybeId = Number(resp?.tabId);
  if (!Number.isNaN(maybeId) && maybeId > 0 && (!activeRun || activeRun.tabId === maybeId)) {
    targetTabId = maybeId;
  }
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.kind === 'TARGET_TAB') {
    const maybeId = Number(msg.tabId);
    if (!Number.isNaN(maybeId) && maybeId > 0 && (!activeRun || activeRun.tabId === maybeId)) {
      targetTabId = maybeId;
    }
  }
});

chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  if (activeRun && activeRun.tabId !== tabId) return;
  chrome.windows.get(windowId, (win) => {
    if (chrome.runtime.lastError) return;
    if (win?.type === 'normal') {
      updateTargetTab(tabId);
    }
  });
});

chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  try {
    const win = await chrome.windows.get(windowId);
    if (win?.type !== 'normal') return;
    const [tab] = await chrome.tabs.query({ active: true, windowId });
    if (tab?.id && (!activeRun || activeRun.tabId === tab.id)) updateTargetTab(tab.id);
  } catch (error) {
    console.warn('Focus change lookup failed', error);
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (!activeRun || tabId !== activeRun.tabId) return;
  
  addLogEntry('debug', 'Tab aggiornata', { tabId, status: changeInfo.status, hasPort: !!activeRun.port, finished: activeRun.finished, awaitingResume: activeRun.awaitingResume });
  
  if (changeInfo.status === 'loading') {
    const info = activeRun.runsTotal > 1 ? ` (${activeRun.currentRun || activeRun.runsCompleted + 1}/${activeRun.runsTotal})` : '';
    setStatus(`Pagina in caricamento${info}…`);
    activeRun.awaitingResume = true;
    addLogEntry('info', 'Pagina in caricamento, attendo completamento', { tabId });
    return;
  }
  
  if (changeInfo.status === 'complete' && activeRun.awaitingResume) {
    // Non riprendere se la porta è ancora attiva (macro già in esecuzione)
    if (activeRun.port) {
      addLogEntry('warn', 'Tentativo di RESUME ignorato: porta ancora attiva', { tabId, hasPort: true });
      activeRun.awaitingResume = false;
      return;
    }
    
    // Non riprendere se la macro è già finita
    if (activeRun.finished) {
      addLogEntry('debug', 'Tentativo di RESUME ignorato: macro già finita', { tabId, finished: true });
      activeRun.awaitingResume = false;
      return;
    }
    
    try {
      addLogEntry('info', 'Tentativo di riprendere macro dopo reload pagina', { tabId });
      await ensureContentRunner(tabId);
      if (activeRun && !activeRun.finished && !activeRun.port) {
        addLogEntry('info', 'Ripresa macro con RESUME', { tabId });
        connectToContentRunner('RESUME');
      } else {
        addLogEntry('debug', 'RESUME non eseguito', { hasActiveRun: !!activeRun, finished: activeRun?.finished, hasPort: !!activeRun?.port });
      }
    } catch (error) {
      addLogEntry('error', 'Re-injection fallita', { tabId, error: error?.message || String(error) });
      console.error('Re-injection failed', error);
      setStatus('Errore: ' + (error?.message || error));
    }
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (targetTabId === tabId) targetTabId = null;
  if (activeRun && tabId === activeRun.tabId) {
    notify('La scheda di destinazione è stata chiusa. Macro interrotta.');
    resetActiveRun();
    setStatus('Scheda chiusa');
    setProgress(0, 0);
  }
});

async function loadMacros() {
  try {
    const result = await chrome.storage.sync.get(STORAGE_KEYS.MACROS);
    return result?.[STORAGE_KEYS.MACROS] || [];
  } catch (error) {
    console.error('Failed to load macros', error);
    setStatus('Errore lettura archivio');
    return [];
  }
}
async function saveMacros(macros) {
  try {
  await chrome.storage.sync.set({ [STORAGE_KEYS.MACROS]: macros });
  } catch (error) {
    console.error('Failed to save macros', error);
    setStatus('Errore salvataggio archivio');
    throw error;
  }
}
function updateTargetTab(tabId) {
  if (!tabId) return;
  if (activeRun && activeRun.tabId && activeRun.tabId !== tabId) return;
  targetTabId = tabId;
  chrome.runtime.sendMessage({ kind: 'UPDATE_TARGET_TAB', tabId }).catch(() => {});
}

async function getActiveTab() {
  try {
    if (targetTabId != null) {
      try {
        const tab = await chrome.tabs.get(targetTabId);
        return tab || null;
      } catch (error) {
        console.warn('Stored tab unavailable', error);
        targetTabId = null;
      }
    }
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true, windowType: 'normal' });
    if (tab?.id) {
      updateTargetTab(tab.id);
    }
    return tab || null;
  } catch (error) {
    console.error('Active tab lookup failed', error);
    return null;
  }
}

// === UI elements ===
const listEl = document.getElementById('macros-list');
const statusText = document.getElementById('status-text');
const progressFill = document.getElementById('progress-fill');

const btnCreate = document.getElementById('btn-create');
const btnExport = document.getElementById('btn-export');
const fileImport = document.getElementById('file-import');
const btnCloseApp = document.getElementById('btn-close-app');
const btnDiagnostics = document.getElementById('btn-diagnostics');

// Modal
const backdrop = document.getElementById('modal-backdrop');
const modal = document.getElementById('modal');
const modalClose = document.getElementById('modal-close');
const macroName = document.getElementById('macro-name');
const slotsEl = document.getElementById('slots');
const btnAddSlot = document.getElementById('btn-add-slot');
const btnSaveMacro = document.getElementById('btn-save-macro');
const tplSlot = document.getElementById('tpl-slot');

// Diagnostics Modal
const diagnosticsBackdrop = document.getElementById('modal-diagnostics-backdrop');
const diagnosticsModal = document.getElementById('modal-diagnostics');
const diagnosticsClose = document.getElementById('diagnostics-close');
const diagnosticsLogEl = document.getElementById('diagnostics-log');
const btnCopyLog = document.getElementById('btn-copy-log');

let macrosState = [];
let editingIndex = null; // null => create, number => edit

function openModal(title = 'Nuova macro', preset = null) {
  document.getElementById('modal-title').textContent = title;
  macroName.value = preset?.name || '';
  slotsEl.innerHTML = '';
  (preset?.steps || []).forEach(addSlotFromStep);
  if (!preset) addSlot();
  backdrop.classList.remove('hidden');
  modal.classList.remove('hidden');
}
function closeModal() {
  backdrop.classList.add('hidden');
  modal.classList.add('hidden');
}
backdrop.addEventListener('mousedown', (e) => {
  // keep modal persistent (do not close on outside click)
  e.stopPropagation();
});
modalClose.addEventListener('click', closeModal);

btnCreate.addEventListener('click', () => {
  editingIndex = null;
  openModal('Nuova macro');
});

btnCloseApp?.addEventListener('click', () => {
  window.close();
});

function openDiagnosticsModal() {
  addLogEntry('info', 'Modale diagnostica aperto', { logEntries: diagnosticsLog.length });
  updateDiagnosticsLog();
  diagnosticsBackdrop.classList.remove('hidden');
  diagnosticsModal.classList.remove('hidden');
}

function closeDiagnosticsModal() {
  diagnosticsBackdrop.classList.add('hidden');
  diagnosticsModal.classList.add('hidden');
}

function updateDiagnosticsLog() {
  if (!diagnosticsLogEl) return;
  diagnosticsLogEl.innerHTML = diagnosticsLog.map(entry => {
    const time = new Date(entry.timestamp).toLocaleTimeString('it-IT');
    let html = `<div class="log-entry">`;
    html += `<span class="log-time">[${time}]</span> `;
    html += `<span class="log-level-${entry.level}">[${entry.level.toUpperCase()}]</span> `;
    html += `<span>${escapeHtml(entry.message)}</span>`;
    if (entry.data) {
      html += `<pre style="margin: 4px 0 0 20px; color: #858585;">${escapeHtml(entry.data)}</pre>`;
    }
    html += `</div>`;
    return html;
  }).join('');
  diagnosticsLogEl.scrollTop = diagnosticsLogEl.scrollHeight;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

btnDiagnostics?.addEventListener('click', openDiagnosticsModal);
diagnosticsClose?.addEventListener('click', closeDiagnosticsModal);
diagnosticsBackdrop?.addEventListener('mousedown', (e) => {
  e.stopPropagation();
});

btnCopyLog?.addEventListener('click', async () => {
  const logText = getLogsAsText();
  try {
    await navigator.clipboard.writeText(logText);
    btnCopyLog.textContent = '✓ Copiato!';
    setTimeout(() => {
      btnCopyLog.textContent = '📋 Copia log';
    }, 2000);
  } catch (error) {
    addLogEntry('error', 'Impossibile copiare il log', { error: error.message });
    alert('Impossibile copiare il log. Controlla la console per i dettagli.');
  }
});

btnExport.addEventListener('click', async () => {
  const macros = await loadMacros();
  const blob = new Blob([JSON.stringify({ macros }, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'macro-automator-export.json';
  a.click();
  URL.revokeObjectURL(url);
});

fileImport.addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    const txt = await file.text();
    const parsed = JSON.parse(txt);
    if (!parsed || !Array.isArray(parsed.macros)) throw new Error('File non valido');
    await saveMacros(parsed.macros);
    macrosState = parsed.macros;
    renderList();
    notify('Importazione completata');
  } catch (err) {
    alert('Importazione fallita: ' + err.message);
  } finally {
    fileImport.value = '';
  }
});

async function testSingleStep(step) {
  try {
    addLogEntry('info', 'Test singolo step avviato', { stepType: step.type });
    const tab = await getActiveTab();
    if (!tab?.id) {
      alert('Nessuna scheda attiva disponibile per il test.');
      return;
    }
    
    setStatus('Test in corso...');
    await ensureContentRunner(tab.id);
    
    const port = chrome.tabs.connect(tab.id, { name: 'macro-automator-test' });
    
    const testPromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        port.disconnect();
        reject(new Error('Timeout durante il test'));
      }, 30000);
      
      port.onMessage.addListener((msg) => {
        clearTimeout(timeout);
        port.disconnect();
        if (msg.kind === 'TEST_SUCCESS') {
          resolve(msg);
        } else if (msg.kind === 'TEST_ERROR') {
          reject(new Error(msg.error));
        }
      });
      
      port.onDisconnect.addListener(() => {
        clearTimeout(timeout);
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        }
      });
      
      port.postMessage({ kind: 'TEST_STEP', step });
    });
    
    const result = await testPromise;
    setStatus('Test completato con successo');
    notify('Test completato');
    addLogEntry('info', 'Test singolo step completato', { stepType: step.type, success: true });
  } catch (error) {
    setStatus('Test fallito: ' + error.message);
    notify('Test fallito');
    addLogEntry('error', 'Test singolo step fallito', { stepType: step.type, error: error.message });
    alert('Test fallito: ' + error.message);
  }
}

btnAddSlot.addEventListener('click', () => addSlot());
btnSaveMacro.addEventListener('click', async () => {
  const macro = readMacroFromUI();
  if (!macro.name.trim()) return alert('Imposta un nome per la macro');
  if (!macro.steps.length) return alert('Aggiungi almeno un\'azione');

  if (editingIndex === null) {
    macrosState.push(macro);
    editingIndex = macrosState.length - 1;
    document.getElementById('modal-title').textContent = 'Modifica macro';
  } else {
    macrosState[editingIndex] = macro;
  }
  await saveMacros(macrosState);
  renderList();
  setStatus('Macro salvata');
  notify('Macro salvata');
});

function addSlot() {
  const node = tplSlot.content.firstElementChild.cloneNode(true);
  node.draggable = true;
  const typeSel = node.querySelector('.slot-type');
  const fields = node.querySelector('.slot-fields');
  const preview = node.querySelector('.slot-preview');
  const btnTest = node.querySelector('.slot-test');
  const btnDel = node.querySelector('.slot-del');
  
  btnDel.addEventListener('click', () => node.remove());
  
  btnTest.addEventListener('click', async () => {
    const step = readStepFromFields(typeSel.value, fields);
    if (!step.type) return;
    
    // Disabilita il pulsante durante il test
    btnTest.disabled = true;
    btnTest.textContent = '⏳ test...';
    
    try {
      await testSingleStep(step);
    } finally {
      btnTest.disabled = false;
      btnTest.textContent = '🔴 test';
    }
  });

  typeSel.addEventListener('change', () => {
    buildFields(typeSel.value, fields);
    updatePreview();
  });
  buildFields(typeSel.value, fields);

  function updatePreview() {
    const step = readStepFromFields(typeSel.value, fields);
    preview.textContent = prettyStep(step);
  }
  fields.addEventListener('input', updatePreview);

  slotsEl.appendChild(node);
  // init preview
  setTimeout(() => {
    const fieldsEl = node.querySelector('.slot-fields');
    const step = readStepFromFields(typeSel.value, fieldsEl);
    preview.textContent = prettyStep(step);
  });
}

function addSlotFromStep(step) {
  addSlot();
  // fill last slot fields
  const last = slotsEl.lastElementChild;
  const typeSel = last.querySelector('.slot-type');
  typeSel.value = step.type;
  buildFields(typeSel.value, last.querySelector('.slot-fields'), step);
  last.querySelector('.slot-fields').dispatchEvent(new Event('input'));
}

let draggingSlot = null;
slotsEl.addEventListener('dragstart', (e) => {
  const slot = e.target.closest('.slot');
  if (!slot) return;
  draggingSlot = slot;
  slot.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', '');
});

slotsEl.addEventListener('dragend', () => {
  if (draggingSlot) draggingSlot.classList.remove('dragging');
  draggingSlot = null;
});

slotsEl.addEventListener('dragover', (e) => {
  if (!draggingSlot) return;
  e.preventDefault();
  const slot = e.target.closest('.slot');
  if (!slot || slot === draggingSlot) return;
  const rect = slot.getBoundingClientRect();
  const before = e.clientY < rect.top + rect.height / 2;
  if (before) {
    slotsEl.insertBefore(draggingSlot, slot);
  } else {
    slotsEl.insertBefore(draggingSlot, slot.nextSibling);
  }
});

function buildFields(type, container, preset = null) {
  container.innerHTML = '';
  const add = (label, init = '') => {
    const wrap = document.createElement('div');
    wrap.className = 'field';
    const l = document.createElement('label'); l.textContent = label;
    const i = document.createElement('input'); i.type = 'text'; i.value = init;
    wrap.appendChild(l); wrap.appendChild(i);
    container.appendChild(wrap);
    return i;
  };
  if (type === 'click') {
    add('Selettore (CSS o XPath)', preset?.selector || '');
  } else if (type === 'wait') {
    add('Ritardo (ms)', String(preset?.ms ?? 1000));
  } else if (type === 'waitFor') {
    add('Selettore (CSS o XPath)', preset?.selector || '');
    add('Timeout (ms)', String(preset?.timeout ?? 5000));
  } else if (type === 'type') {
    add('Selettore (CSS o XPath)', preset?.selector || '');

    const randomPreset = preset?.randomPreset || '';
    container.dataset.randomPreset = randomPreset;

    const wrap = document.createElement('div');
    wrap.className = 'field field-random-text';
    const label = document.createElement('label');
    label.textContent = 'Testo (supporta placeholder)';

    const row = document.createElement('div');
    row.className = 'random-row';

    const textInput = document.createElement('input');
    textInput.type = 'text';
    textInput.value = preset?.text || '';
    textInput.dataset.manualValue = preset?.text || '';
    textInput.placeholder = 'Inserisci il testo da digitare';

    const randomBtn = document.createElement('button');
    randomBtn.type = 'button';
    randomBtn.className = 'secondary random-toggle';
    randomBtn.textContent = randomPreset ? getRandomPresetLabel(randomPreset) : 'Testo random…';

    const menu = document.createElement('div');
    menu.className = 'random-menu hidden';

    const select = document.createElement('select');
    const defaultOption = document.createElement('option');
    defaultOption.value = '';
    defaultOption.textContent = 'Nessuno (usa testo fisso)';
    select.appendChild(defaultOption);
    Object.entries(RANDOM_PRESETS).forEach(([key, meta]) => {
      const opt = document.createElement('option');
      opt.value = key;
      opt.textContent = meta.label;
      select.appendChild(opt);
    });
    select.value = randomPreset;

    const helper = document.createElement('div');
    helper.className = 'random-helper muted';
    menu.append(select, helper);

    function syncRandomUI() {
      const key = container.dataset.randomPreset || '';
      if (key) {
        randomBtn.classList.add('active');
        randomBtn.textContent = getRandomPresetLabel(key);
        textInput.disabled = true;
        if (textInput.value) {
          textInput.dataset.manualValue = textInput.value;
        }
        textInput.value = '';
        helper.textContent = `Genera automaticamente: ${getRandomPresetLabel(key)}`;
      } else {
        randomBtn.classList.remove('active');
        randomBtn.textContent = 'Testo random…';
        textInput.disabled = false;
        if (!textInput.value && textInput.dataset.manualValue) {
          textInput.value = textInput.dataset.manualValue;
        }
        helper.textContent = 'Scrivi un testo fisso oppure scegli una modalità casuale.';
      }
    }

    let outsideListener = null;
    function attachOutsideCloser() {
      if (outsideListener) return;
      outsideListener = (event) => {
        if (!menu.contains(event.target) && event.target !== randomBtn) {
          menu.classList.add('hidden');
          detachOutsideCloser();
        }
      };
      document.addEventListener('click', outsideListener);
    }
    function detachOutsideCloser() {
      if (!outsideListener) return;
      document.removeEventListener('click', outsideListener);
      outsideListener = null;
    }

    randomBtn.addEventListener('click', () => {
      const willOpen = menu.classList.contains('hidden');
      menu.classList.toggle('hidden');
      if (!menu.classList.contains('hidden')) {
        select.focus();
        attachOutsideCloser();
      } else {
        detachOutsideCloser();
      }
    });

    select.addEventListener('change', () => {
      container.dataset.randomPreset = select.value || '';
      if (select.value) {
        textInput.dataset.manualValue = textInput.value;
        textInput.value = '';
      }
      if (!select.value && textInput.dataset.manualValue !== undefined) {
        textInput.value = textInput.dataset.manualValue || '';
      }
      syncRandomUI();
      container.dispatchEvent(new Event('input', { bubbles: true }));
      menu.classList.add('hidden');
    });

    menu.addEventListener('click', (e) => e.stopPropagation());

    syncRandomUI();

    row.append(textInput, randomBtn);
    wrap.append(label, row, menu);
    container.appendChild(wrap);
  } else if (type === 'selectOption') {
    add('Selettore (CSS o XPath)', preset?.selector || '');
    add('Valore opzione (attributo value)', preset?.value || '');
    add('Testo opzione (fallback)', preset?.text || '');
  } else if (type === 'pressKey') {
    add('Tasto (es. Enter, Tab, Escape)', preset?.key || 'Enter');
  } else if (type === 'navigate') {
    add('URL', preset?.url || 'https://');
  }
}

function readStepFromFields(type, container) {
  const inputs = [...container.querySelectorAll('input')].map(i => i.value);
  switch (type) {
    case 'click': return { type, selector: inputs[0] || '' };
    case 'wait': return { type, ms: Number(inputs[0] || 0) };
    case 'waitFor': return { type, selector: inputs[0] || '', timeout: Number(inputs[1] || 0) };
    case 'type': {
      const randomPreset = container.dataset.randomPreset || '';
      return {
        type,
        selector: inputs[0] || '',
        text: inputs[1] || '',
        randomPreset: randomPreset || undefined
      };
    }
    case 'selectOption': {
      return {
        type,
        selector: inputs[0] || '',
        value: inputs[1] || '',
        text: inputs[2] || ''
      };
    }
    case 'pressKey': return { type, key: inputs[0] || 'Enter' };
    case 'navigate': return { type, url: inputs[0] || '' };
    default: return { type };
  }
}

function prettyStep(step) {
  switch (step.type) {
    case 'click': return `Clic → ${step.selector || '(selettore mancante)'}`;
    case 'wait': return `Attendi ${step.ms ?? 0} ms`;
    case 'waitFor': return `Attendi elemento → ${step.selector} (timeout ${step.timeout} ms)`;
    case 'type': {
      if (step.randomPreset) {
        return `Scrivi ${getRandomPresetLabel(step.randomPreset)} → ${step.selector}`;
      }
      return `Scrivi "${step.text ?? ''}" → ${step.selector}`;
    }
    case 'selectOption': {
      const label = step.value
        ? `value="${step.value}"`
        : (step.text ? `"${step.text}"` : 'opzione');
      return `Seleziona ${label} → ${step.selector}`;
    }
    case 'pressKey': return `Premi ${step.key}`;
    case 'navigate': return `Apri URL → ${step.url}`;
    default: return JSON.stringify(step);
  }
}

function readMacroFromUI() {
  const steps = [...slotsEl.children].map(slot => {
    const type = slot.querySelector('.slot-type').value;
    const fields = slot.querySelector('.slot-fields');
    return readStepFromFields(type, fields);
  });
  const previousOptions = (editingIndex != null && macrosState[editingIndex]?.options) || {};
  return {
    name: macroName.value.trim(),
    steps,
    options: {
      defaultTimeout: previousOptions.defaultTimeout ?? 5000,
      highlightMs: previousOptions.highlightMs ?? 800,
      failFast: previousOptions.failFast ?? true,
      repeat: previousOptions.repeat ?? 1
    }
  };
}

function sanitizeMacro(macro) {
  return JSON.parse(JSON.stringify(macro));
}

function renderList() {
  if (!macrosState.length) {
    const empty = document.createElement('div');
    empty.className = 'muted';
    empty.textContent = 'Nessuna macro salvata — clicca "Crea macro" per iniziare.';
    listEl.replaceChildren(empty);
    return;
  }

  const fragment = document.createDocumentFragment();
  macrosState.forEach((m, idx) => {
    const card = document.createElement('div');
    card.className = 'card';

    const h = document.createElement('h3');
    h.textContent = m.name || `Macro #${idx + 1}`;
    const preview = document.createElement('div');
    preview.className = 'muted';
    const stepsCount = m?.steps?.length || 0;
    preview.textContent = stepsCount === 1 ? '1 azione' : `${stepsCount} azioni`;

    const row = document.createElement('div');
    row.className = 'row';
    const left = document.createElement('div');
    left.append(h, preview);

    const btns = document.createElement('div');
    btns.className = 'btns';

    const runGroup = document.createElement('div');
    runGroup.className = 'run-group';

    const repeatInput = document.createElement('input');
    repeatInput.type = 'number';
    repeatInput.min = '1';
    repeatInput.step = '1';
    repeatInput.className = 'repeat-input';
    const storedRepeat = Number(m?.options?.repeat ?? 1);
    repeatInput.value = storedRepeat && storedRepeat > 0 ? String(storedRepeat) : '1';
    repeatInput.title = 'Numero di esecuzioni consecutive';

    const repeatMult = document.createElement('span');
    repeatMult.className = 'repeat-mult';
    repeatMult.textContent = '×';

    const bRun = document.createElement('button'); bRun.className='primary'; bRun.textContent='Esegui';
    if (isRunningSequence) bRun.disabled = true;
    const bDup = document.createElement('button'); bDup.textContent='Duplica';
    const bDel = document.createElement('button'); bDel.textContent='Elimina';
    const bEdt = document.createElement('button'); bEdt.textContent='Modifica';

    async function persistRepeatValue(value) {
      let repeatVal = Math.floor(Number(value) || 1);
      if (!Number.isFinite(repeatVal) || repeatVal < 1) repeatVal = 1;
      const existingOptions = m.options || {};
      const updatedOptions = { ...existingOptions, repeat: repeatVal };
      m.options = updatedOptions;
      macrosState[idx] = { ...m, options: updatedOptions };
      repeatInput.value = String(repeatVal);
      try {
        await saveMacros(macrosState);
      } catch (error) {
        console.error('Impossibile salvare il numero di ripetizioni', error);
      }
      return repeatVal;
    }

    repeatInput.addEventListener('change', () => {
      persistRepeatValue(repeatInput.value);
    });

    runGroup.append(repeatInput, repeatMult, bRun);

    bRun.addEventListener('click', async () => {
      if (isRunningSequence) return;
      const repeatVal = await persistRepeatValue(repeatInput.value);
      runMacro(m, repeatVal);
    });
    bDup.addEventListener('click', async () => {
      const copy = JSON.parse(JSON.stringify(m));
      copy.name = (m.name || 'Macro') + ' (copia)';
      macrosState.splice(idx + 1, 0, copy);
      await saveMacros(macrosState);
      renderList();
    });
    bDel.addEventListener('click', async () => {
      if (!confirm('Eliminare questa macro?')) return;
      macrosState.splice(idx, 1);
      await saveMacros(macrosState);
      renderList();
    });
    bEdt.addEventListener('click', () => {
      editingIndex = idx;
      openModal('Modifica macro', m);
    });

    btns.append(runGroup, bEdt, bDup, bDel);
    row.append(left, btns);
    card.append(row);
    fragment.append(card);
  });
  listEl.replaceChildren(fragment);
}

function setStatus(text) {
  statusText.textContent = text;
}
function setProgress(step, total) {
  const pct = total ? Math.round((step/total)*100) : 0;
  progressFill.style.width = pct + '%';
}

function notify(message) {
  try {
    chrome.notifications.create('', { type: 'basic', iconUrl: 'icon48.png', title: 'Macro Automator', message });
  } catch (e) {
    setStatus(message);
  }
}

async function ensureContentRunner(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content-runner.js'] });
  } catch (error) {
    console.warn('Failed to inject content script', error);
    const message = /cannot access/i.test(String(error?.message || error))
      ? 'Non è possibile eseguire macro su questa pagina.'
      : 'Impossibile iniettare lo script nella scheda attiva.';
    throw new Error(message);
  }
}

function signalRunnerStop(tabId) {
  if (!tabId) return Promise.resolve(false);
  return new Promise((resolve) => {
    try {
      chrome.tabs.sendMessage(tabId, { kind: 'STOP_RUNNER' }, () => {
        if (chrome.runtime.lastError) {
          resolve(false);
        } else {
          resolve(true);
        }
      });
    } catch (error) {
      console.warn('signalRunnerStop failed', error);
      resolve(false);
    }
  });
}

async function resetActiveRun() {
  const tabId = activeRun?.tabId;
  const runInfo = activeRun ? { runsTotal: activeRun.runsTotal, runsCompleted: activeRun.runsCompleted } : null;
  addLogEntry('debug', 'resetActiveRun chiamato', { tabId, runInfo });
  
  if (tabId) {
    try {
      addLogEntry('debug', 'Invio STOP_RUNNER al content script', { tabId });
      await signalRunnerStop(tabId);
      addLogEntry('debug', 'STOP_RUNNER completato', { tabId });
    } catch (error) {
      addLogEntry('error', 'Errore nello stop del runner', { tabId, error: error?.message || String(error) });
      console.warn('Errore nello stop del runner', error);
    }
  }
  if (activeRun?.port) {
    try {
      activeRun.expectingDisconnect = true;
      activeRun.port.disconnect();
      addLogEntry('debug', 'Porta disconnessa', { tabId });
    } catch (_) {}
  }
  activeRun = null;
  const statusSnapshot = statusText?.textContent;
  addLogEntry('debug', 'Attesa 300ms prima di impostare Pronto', { statusSnapshot });
  await new Promise(resolve => setTimeout(resolve, 300));
  if (!activeRun && statusText?.textContent === statusSnapshot) {
    setStatus('Pronto');
    setProgress(0, 0);
    addLogEntry('info', 'Status impostato a Pronto', { previousStatus: statusSnapshot });
  } else {
    addLogEntry('debug', 'Status non cambiato a Pronto', { activeRun: !!activeRun, currentStatus: statusText?.textContent, statusSnapshot });
  }
}

function connectToContentRunner(mode = 'RUN') {
  if (!activeRun) {
    addLogEntry('warn', 'connectToContentRunner chiamato senza activeRun');
    return;
  }
  try {
    const isResume = mode === 'RESUME';
    const currentRunIndex = (activeRun.runsCompleted || 0) + 1;
    const runInfo = activeRun.runsTotal > 1 ? ` (${currentRunIndex}/${activeRun.runsTotal})` : '';
    const statusPrefix = isResume ? 'Ripresa macro' : 'Preparazione macro';
    if (!isResume) setProgress(0, activeRun.total);
    setStatus(`${statusPrefix}${runInfo}…`);

    addLogEntry('info', 'Connessione alla tab', { tabId: activeRun.tabId, mode, currentRunIndex, runsTotal: activeRun.runsTotal });
    const port = chrome.tabs.connect(activeRun.tabId, { name: 'macro-automator' });
    activeRun.port = port;
    activeRun.awaitingResume = false;
    activeRun.expectingDisconnect = false;

    const payload = { kind: isResume ? 'RESUME' : 'RUN', macro: activeRun.macro };
    try {
      addLogEntry('debug', 'Invio messaggio al content runner', { kind: payload.kind, steps: activeRun.macro.steps?.length || 0 });
      port.postMessage(payload);
      addLogEntry('debug', 'Messaggio inviato con successo');
    } catch (error) {
      addLogEntry('error', 'Errore nell\'invio del messaggio', { error: error?.message || String(error) });
      console.error('Failed to post message to runner', error);
      throw error;
    }

    port.onDisconnect.addListener(() => {
      if (!activeRun) return;
      activeRun.port = null;
      if (activeRun.expectingDisconnect) {
        activeRun.expectingDisconnect = false;
        return;
      }
      if (activeRun.finished) return;
      activeRun.awaitingResume = true;
      const currentRunIndex = (activeRun.runsCompleted || 0) + 1;
      const info = activeRun.runsTotal > 1 ? ` (${currentRunIndex}/${activeRun.runsTotal})` : '';
      setStatus(`Esecuzione in attesa${info}: caricamento pagina…`);
    });

    port.onMessage.addListener(async msg => {
      if (!activeRun) return;
      const total = msg.total ?? activeRun.total ?? activeRun.macro.steps.length;
      const plannedRuns = activeRun.runsTotal || 1;
      const projectedIndex = Math.min((activeRun.runsCompleted || 0) + (msg.kind === 'DONE' ? 1 : 0), plannedRuns);
      const runInfoLabel = plannedRuns > 1 ? ` [${projectedIndex}/${plannedRuns}]` : '';

      if (msg.kind === 'STATE') {
        const completed = Math.min(Number(msg.step ?? 0), total);
        setStatus(total ? `Ripresa programmata${runInfoLabel}: ${completed}/${total} passi completati` : `Ripresa macro${runInfoLabel}`);
        setProgress(completed, total);
        return;
      }

      if (msg.kind === 'PROGRESS') {
        setStatus(`Passo ${msg.step}/${total}${runInfoLabel} – ${msg.label}`);
        setProgress(msg.step, total);
        return;
      }

      if (msg.kind === 'DONE') {
        addLogEntry('info', 'Messaggio DONE ricevuto dal content runner', { total, runsCompleted: activeRun.runsCompleted, runsTotal: activeRun.runsTotal });
        setProgress(total, total);
        activeRun.finished = true;
        activeRun.awaitingResume = false;
        activeRun.expectingDisconnect = true;
        try { port.disconnect(); } catch (_) {}
        const runRef = activeRun;
        await resetActiveRun();
        addLogEntry('debug', 'Chiamata onComplete callback', { runsCompleted: runRef?.runsCompleted, runsTotal: runRef?.runsTotal });
        runRef?.onComplete?.();
        return;
      }

      if (msg.kind === 'ERROR') {
        addLogEntry('error', 'Messaggio ERROR ricevuto dal content runner', { error: msg.error, runsCompleted: activeRun.runsCompleted, runsTotal: activeRun.runsTotal });
        setStatus('Errore: ' + msg.error);
        notify('Macro fallita');
        activeRun.finished = true;
        activeRun.awaitingResume = false;
        activeRun.expectingDisconnect = true;
        try { port.disconnect(); } catch (_) {}
        const runRef = activeRun;
        await resetActiveRun();
        addLogEntry('debug', 'Chiamata onError callback', { error: msg.error });
        runRef?.onError?.(new Error(msg.error));
      }
    });
  } catch (error) {
    console.error('Connection to runner failed', error);
    setStatus('Errore: ' + (error?.message || error));
    const runRef = activeRun;
    resetActiveRun();
    runRef?.onError?.(error);
  }
}

async function runMacro(macro, repeat = 1) {
  if (activeRun || isRunningSequence) {
    addLogEntry('warn', 'Tentativo di avviare macro mentre un\'altra è in esecuzione', { activeRun: !!activeRun, isRunningSequence });
    alert('È già in esecuzione una macro. Attendi il completamento o interrompi prima di avviarne un\'altra.');
    return;
  }
  
  let repeatTotal = Math.floor(Number(repeat) || Number(macro?.options?.repeat) || 1);
  if (!Number.isFinite(repeatTotal) || repeatTotal < 1) repeatTotal = 1;
  
  addLogEntry('info', `Avvio sequenza macro`, { macroName: macro.name, repeatTotal, steps: macro.steps?.length || 0 });
  
  isRunningSequence = true;
  renderList();
  
  try {
    const cleanMacro = sanitizeMacro(macro);
    const totalSteps = cleanMacro?.steps?.length || 0;
    const tab = await getActiveTab();
    if (!tab?.id) throw new Error('Nessuna scheda attiva disponibile.');
    updateTargetTab(tab.id);
    
    addLogEntry('info', 'Tab di destinazione ottenuta', { tabId: tab.id, url: tab.url });
    
    for (let i = 0; i < repeatTotal; i++) {
      const currentRun = i + 1;
      const runInfo = repeatTotal > 1 ? ` (${currentRun}/${repeatTotal})` : '';
      
      addLogEntry('info', `Inizio esecuzione ${currentRun} di ${repeatTotal}`, { currentRun, repeatTotal, tabId: tab.id });
      
      await ensureContentRunner(tab.id);
      
      const runPromise = new Promise((resolve, reject) => {
        activeRun = {
          macro: cleanMacro,
          tabId: tab.id,
          total: totalSteps,
          awaitingResume: false,
          finished: false,
          port: null,
          runsTotal: repeatTotal,
          runsCompleted: i,
          expectingDisconnect: false,
          onComplete: () => {
            addLogEntry('debug', 'onComplete chiamato, attendo status Pronto', { currentRun, status: statusText?.textContent });
            const checkReady = () => {
              const currentStatus = statusText?.textContent;
              if (currentStatus === 'Pronto') {
                addLogEntry('info', `Esecuzione ${currentRun} completata, status Pronto raggiunto`, { currentRun });
                resolve();
              } else {
                addLogEntry('debug', 'Status non ancora Pronto, riprovo', { currentStatus, currentRun });
                setTimeout(checkReady, 100);
              }
            };
            setTimeout(checkReady, 400);
          },
          onError: (error) => {
            addLogEntry('error', `Errore durante esecuzione ${currentRun}`, { currentRun, error: error?.message || String(error) });
            reject(error);
          }
        };
        
        addLogEntry('debug', 'Connessione al content runner', { currentRun, tabId: tab.id });
        connectToContentRunner('RUN');
      });
      
      try {
        await runPromise;
        addLogEntry('info', `Esecuzione ${currentRun} terminata con successo`, { currentRun });
      } catch (error) {
        addLogEntry('error', `Esecuzione ${currentRun} fallita`, { currentRun, error: error?.message || String(error) });
        console.error('Run failed', error);
        break;
      }
      
      if (i < repeatTotal - 1) {
        addLogEntry('debug', `Attesa prima della prossima esecuzione`, { nextRun: i + 2, repeatTotal });
        await new Promise(resolve => setTimeout(resolve, 300));
      }
    }
    
    addLogEntry('info', 'Sequenza macro completata', { macroName: macro.name, repeatTotal, completed: true });
    notify('Macro completata');
  } catch (error) {
    addLogEntry('error', 'Errore critico durante sequenza macro', { error: error?.message || String(error), stack: error?.stack });
    console.error('Macro run failed', error);
    setStatus('Errore: ' + (error?.message || error));
    alert(error?.message || 'Impossibile avviare la macro');
  } finally {
    isRunningSequence = false;
    addLogEntry('info', 'Sequenza macro terminata, isRunningSequence resettato', { isRunningSequence: false });
    renderList();
  }
}

// init
(async function init(){
  macrosState = await loadMacros();
  renderList();
  setStatus('Pronto');
})();
