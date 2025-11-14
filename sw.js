let popupWindowId = null;
let lastInvokerTabId = null;

async function focusPopupWindow() {
  if (!popupWindowId) return false;
  try {
    await chrome.windows.update(popupWindowId, { focused: true });
    return true;
  } catch (err) {
    console.warn('Unable to focus existing window', err);
    popupWindowId = null;
    return false;
  }
}

function notifyPopupTargetTab(tabId) {
  if (!popupWindowId || tabId == null) return;
  chrome.runtime.sendMessage({ kind: 'TARGET_TAB', tabId }).catch(() => {});
}

async function openPopupWindow() {
  if (await focusPopupWindow()) {
    if (lastInvokerTabId != null) notifyPopupTargetTab(lastInvokerTabId);
    return;
  }

  const url = lastInvokerTabId != null ? `popup.html?tabId=${lastInvokerTabId}` : 'popup.html';

  const win = await chrome.windows.create({
    url,
    type: 'popup',
    width: 460,
    height: 680,
    focused: true
  });
  popupWindowId = win?.id ?? null;
  if (popupWindowId) {
    const handleRemoved = (id) => {
      if (id === popupWindowId) {
        popupWindowId = null;
        chrome.windows.onRemoved.removeListener(handleRemoved);
      }
    };
    chrome.windows.onRemoved.addListener(handleRemoved);
    if (lastInvokerTabId != null) {
      setTimeout(() => notifyPopupTargetTab(lastInvokerTabId), 300);
    }
  }
}

chrome.runtime.onInstalled.addListener(() => {
  // no-op
});

chrome.action.onClicked.addListener((tab) => {
  lastInvokerTabId = tab?.id ?? null;
  openPopupWindow();
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.kind === 'NOTIFY' && msg?.message) {
    chrome.notifications.create('', { type: 'basic', iconUrl: 'icon48.png', title: 'Macro Automator', message: msg.message });
    sendResponse({ ok: true });
    return;
  }
  if (msg?.kind === 'REQUEST_TARGET_TAB') {
    sendResponse({ tabId: lastInvokerTabId });
    return;
  }
  if (msg?.kind === 'UPDATE_TARGET_TAB') {
    lastInvokerTabId = msg?.tabId ?? lastInvokerTabId;
    return;
  }
});
