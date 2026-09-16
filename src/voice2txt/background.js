importScripts('languages.js');

const OFFSCREEN_PATH = 'offscreen.html';
const HEALTH_ALARM = 'voice2txt-healthcheck';
const HEARTBEAT_TIMEOUT_MS = 70_000;
const NOTIFICATION_ICON = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

let lifecycleQueue = Promise.resolve();
let lastOffscreenHeartbeatAt = Date.now();
let lastOffscreenHeartbeatSessionId = null;
let isRebuildingMenus = false;
let rebuildQueued = false;

function queueLifecycle(task) {
  const next = lifecycleQueue.then(task, task);
  lifecycleQueue = next.catch((error) => {
    console.error('Dictation lifecycle operation failed:', error);
  });
  return next;
}

function createSessionId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

async function getActiveState() {
  const result = await chrome.storage.local.get({
    isListening: false,
    activeTabId: null,
    sessionId: null,
    pendingStartTabId: null
  });

  return {
    isListening: Boolean(result.isListening),
    activeTabId: result.activeTabId ?? null,
    sessionId: result.sessionId ?? null,
    pendingStartTabId: result.pendingStartTabId ?? null
  };
}

async function setActiveState({
  isListening,
  activeTabId = null,
  sessionId = null,
  pendingStartTabId = null
}) {
  await chrome.storage.local.set({ isListening, activeTabId, sessionId, pendingStartTabId });
}

function notify(title, message) {
  chrome.notifications.create({
    type: 'basic',
    iconUrl: NOTIFICATION_ICON,
    title,
    message
  }).catch(() => {});
}

function updateActionUI(listening) {
  chrome.action.setBadgeText({ text: listening ? 'ON' : 'OFF' }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color: listening ? '#ff3860' : '#8e8e93' }).catch(() => {});

  try {
    const canvas = new OffscreenCanvas(128, 128);
    const context = canvas.getContext('2d');
    const gradient = context.createRadialGradient(64, 64, 10, 64, 64, 60);
    gradient.addColorStop(0, listening ? '#ff4b5c' : '#8e8e93');
    gradient.addColorStop(1, listening ? '#c70039' : '#3a3a3c');
    context.fillStyle = gradient;
    context.beginPath();
    context.arc(64, 64, 56, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = '#ffffff';
    context.beginPath();
    context.roundRect(50, 25, 28, 50, 14);
    context.fill();
    context.strokeStyle = '#ffffff';
    context.lineWidth = 6;
    context.lineCap = 'round';
    context.beginPath();
    context.arc(64, 52, 28, 0, Math.PI, false);
    context.moveTo(64, 80);
    context.lineTo(64, 102);
    context.moveTo(42, 102);
    context.lineTo(86, 102);
    context.stroke();
    chrome.action.setIcon({ imageData: context.getImageData(0, 0, 128, 128) }).catch(() => {});
  } catch (_) {
    // A badge still clearly communicates the state if an icon cannot be drawn.
  }

  chrome.contextMenus.update('toggle-dictation', {
    title: listening ? 'Stop Dictation' : 'Start Dictation'
  }).catch(() => {});
}

function isSupportedUrl(url) {
  if (!url) return false;
  const restrictedPrefixes = [
    'chrome://',
    'edge://',
    'chrome-extension://',
    'chrome-search://',
    'devtools://',
    'about:',
    'view-source:',
    'https://chrome.google.com/webstore',
    'https://chromewebstore.google.com'
  ];
  return !restrictedPrefixes.some((prefix) => url.startsWith(prefix));
}

async function getTab(tabId) {
  if (tabId === null || tabId === undefined) return null;
  try {
    return await chrome.tabs.get(tabId);
  } catch (_) {
    return null;
  }
}

async function getCurrentTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab || null;
}

async function ensureContentScriptActive(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { action: 'ping' });
    if (response?.status === 'alive') return true;
  } catch (_) {
    // The content script is normally declared in the manifest. Dynamic injection
    // also covers tabs that were already open when the extension was reloaded.
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      files: ['content.js']
    });
    return true;
  } catch (error) {
    console.warn(`Unable to inject content script into tab ${tabId}:`, error.message);
    return false;
  }
}

async function safeSendMessage(tabId, message) {
  const tab = await getTab(tabId);
  if (!tab || !isSupportedUrl(tab.url)) return null;
  if (!(await ensureContentScriptActive(tabId))) return null;

  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (error) {
    console.warn(`Unable to message tab ${tabId}:`, error.message);
    return null;
  }
}

async function checkTabSupportAndNotify(tab) {
  if (!tab?.id || !isSupportedUrl(tab.url)) {
    notify('voice2txt', 'This page is not supported for dictation. Choose a normal web page and a text field.');
    return false;
  }

  if (!(await ensureContentScriptActive(tab.id))) {
    notify('voice2txt', 'voice2txt cannot insert text on this page.');
    return false;
  }
  return true;
}

async function hasOffscreenDocument() {
  try {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    return contexts.length > 0;
  } catch (error) {
    console.warn('Unable to inspect offscreen document state:', error.message);
    return false;
  }
}

async function closeOffscreenDocument() {
  if (!(await hasOffscreenDocument())) return;
  try {
    await chrome.offscreen.closeDocument();
  } catch (error) {
    console.warn('Unable to close offscreen document:', error.message);
  }
}

async function ensureHealthAlarm() {
  await chrome.alarms.create(HEALTH_ALARM, { periodInMinutes: 0.5 });
}

async function clearHealthAlarm() {
  try {
    await chrome.alarms.clear(HEALTH_ALARM);
  } catch (_) {}
}

async function startSessionInternal(tab) {
  if (!(await checkTabSupportAndNotify(tab))) return false;

  const priorState = await getActiveState();
  if (priorState.activeTabId && priorState.activeTabId !== tab.id) {
    await safeSendMessage(priorState.activeTabId, { action: 'stop-session' });
  }

  // Store the new ID before closing an existing document. Any late event from the
  // old document is ignored instead of being allowed to change the new session.
  const sessionId = createSessionId();
  await setActiveState({
    isListening: true,
    activeTabId: tab.id,
    sessionId,
    pendingStartTabId: null
  });
  updateActionUI(true);
  lastOffscreenHeartbeatAt = Date.now();
  lastOffscreenHeartbeatSessionId = sessionId;

  await safeSendMessage(tab.id, { action: 'start-session' });
  await closeOffscreenDocument();

  try {
    await chrome.offscreen.createDocument({
      url: `${OFFSCREEN_PATH}?lang=${encodeURIComponent((await chrome.storage.local.get({ dictationLang: 'en-US' })).dictationLang)}&session=${encodeURIComponent(sessionId)}`,
      reasons: [chrome.offscreen.Reason.USER_MEDIA],
      justification: 'Speech recognition requires microphone access and DOM APIs.'
    });
    await ensureHealthAlarm();
    return true;
  } catch (error) {
    console.error('Unable to start the offscreen recognition document:', error.message);
    const currentState = await getActiveState();
    if (currentState.sessionId === sessionId) {
      await setActiveState({ isListening: false });
      updateActionUI(false);
      await safeSendMessage(tab.id, { action: 'stop-session' });
      await clearHealthAlarm();
    }
    notify('voice2txt', 'Speech recognition could not be started. Check microphone access and try again.');
    return false;
  }
}

async function stopSessionInternal({ pendingStartTabId = null } = {}) {
  const state = await getActiveState();
  await setActiveState({
    isListening: false,
    activeTabId: null,
    sessionId: null,
    pendingStartTabId
  });
  updateActionUI(false);
  await clearHealthAlarm();

  if (state.activeTabId) {
    await safeSendMessage(state.activeTabId, { action: 'stop-session' });
  }
  await closeOffscreenDocument();
}

async function restartCurrentSessionInternal() {
  const state = await getActiveState();
  if (!state.isListening) return false;
  const tab = await getTab(state.activeTabId);
  if (!tab) {
    await stopSessionInternal();
    return false;
  }
  return startSessionInternal(tab);
}

async function recoverCurrentSessionInternal(reason) {
  const state = await getActiveState();
  if (!state.isListening) return;

  const tab = await getTab(state.activeTabId);
  if (!tab || !isSupportedUrl(tab.url)) {
    await stopSessionInternal();
    return;
  }

  console.warn(`Recovering dictation session: ${reason}`);
  await startSessionInternal(tab);
}

async function toggleDictation(tab) {
  return queueLifecycle(async () => {
    const state = await getActiveState();
    if (state.isListening) {
      await stopSessionInternal();
      return { isListening: false };
    }

    const targetTab = tab || await getCurrentTab();
    const started = await startSessionInternal(targetTab);
    return { isListening: started };
  });
}

async function routeSpeechResult(message) {
  const state = await getActiveState();
  if (!state.isListening || state.sessionId !== message.sessionId) return;

  lastOffscreenHeartbeatAt = Date.now();
  lastOffscreenHeartbeatSessionId = message.sessionId;
  if (state.activeTabId) {
    await safeSendMessage(state.activeTabId, {
      action: 'insert-text',
      finalText: message.finalText || '',
      interimText: message.interimText || ''
    });
  }

  chrome.runtime.sendMessage({
    target: 'voice2txt-ui',
    type: 'transcript',
    finalText: message.finalText || '',
    interimText: message.interimText || ''
  }).catch(() => {});
}

async function handleFatalRecognitionError(message) {
  const state = await getActiveState();
  if (!state.isListening || state.sessionId !== message.sessionId) return;

  const isPermissionProblem = message.error === 'not-allowed' || message.error === 'service-not-allowed';
  const targetTabId = state.activeTabId;
  await stopSessionInternal({ pendingStartTabId: isPermissionProblem ? targetTabId : null });

  let userMessage = 'Speech recognition stopped. Start dictation again after resolving the issue.';
  if (message.error === 'not-allowed') {
    userMessage = 'Microphone permission is required. Allow it in voice2txt settings, then dictation will resume.';
  } else if (message.error === 'service-not-allowed') {
    userMessage = 'Speech recognition is blocked by the browser or its service. Check browser privacy settings.';
  } else if (message.error === 'language-not-supported') {
    userMessage = 'The selected dictation language is not supported by this browser recognition service.';
  } else if (message.error === 'not-supported') {
    userMessage = 'This browser does not provide the Speech Recognition API needed by voice2txt.';
  }

  if (targetTabId) {
    await safeSendMessage(targetTabId, { action: 'show-warning', message: userMessage, type: 'warning', duration: 7_000 });
  }
  notify('voice2txt', userMessage);

  if (isPermissionProblem) {
    chrome.tabs.create({
      url: chrome.runtime.getURL('options.html?requestMic=true&autoClose=true&warning=mic_denied')
    }).catch(() => {});
  }
}

async function resumeAfterPermissionGranted() {
  return queueLifecycle(async () => {
    const state = await getActiveState();
    const preferredTab = await getTab(state.pendingStartTabId);
    const fallbackTab = preferredTab || await getCurrentTab();
    if (!fallbackTab) return false;
    return startSessionInternal(fallbackTab);
  });
}

async function rebuildContextMenus() {
  if (isRebuildingMenus) {
    rebuildQueued = true;
    return;
  }
  isRebuildingMenus = true;

  try {
    const state = await getActiveState();
    const settings = await chrome.storage.local.get({ dictationLang: 'en-US' });
    await chrome.contextMenus.removeAll();

    chrome.contextMenus.create({
      id: 'toggle-dictation',
      title: state.isListening ? 'Stop Dictation' : 'Start Dictation',
      contexts: ['editable']
    });
    chrome.contextMenus.create({
      id: 'language-selector',
      title: 'Select Language',
      contexts: ['all']
    });
    SUPPORTED_LANGUAGES.forEach((language) => {
      chrome.contextMenus.create({
        id: `lang-${language.id}`,
        parentId: 'language-selector',
        title: language.name,
        type: 'radio',
        checked: language.id === settings.dictationLang,
        contexts: ['all']
      });
    });
  } catch (error) {
    console.warn('Unable to rebuild context menus:', error.message);
  } finally {
    isRebuildingMenus = false;
    if (rebuildQueued) {
      rebuildQueued = false;
      rebuildContextMenus();
    }
  }
}

chrome.action.onClicked.addListener((tab) => {
  toggleDictation(tab).catch((error) => console.error('Unable to toggle dictation:', error));
});

chrome.commands.onCommand.addListener((command) => {
  if (command !== 'toggle-dictation') return;
  getCurrentTab().then((tab) => toggleDictation(tab));
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'toggle-dictation') {
    toggleDictation(tab);
    return;
  }

  if (!info.menuItemId.startsWith('lang-')) return;
  const dictationLang = info.menuItemId.slice(5);
  chrome.storage.local.set({ dictationLang }).then(async () => {
    const state = await getActiveState();
    if (state.isListening) queueLifecycle(restartCurrentSessionInternal);
  });
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const state = await getActiveState();
  if (!state.isListening) return;

  const tab = await getTab(tabId);
  if (!tab || !isSupportedUrl(tab.url)) return;
  await chrome.storage.local.set({ activeTabId: tabId });
  await safeSendMessage(tabId, { action: 'start-session' });
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const state = await getActiveState();
  if (!state.isListening || state.activeTabId !== tabId) return;

  const tab = await getCurrentTab();
  if (!tab || !isSupportedUrl(tab.url)) {
    queueLifecycle(stopSessionInternal);
    return;
  }
  await chrome.storage.local.set({ activeTabId: tab.id });
  await safeSendMessage(tab.id, { action: 'start-session' });
});

chrome.webNavigation.onCompleted.addListener(async (details) => {
  if (details.frameId !== 0) return;
  const state = await getActiveState();
  if (!state.isListening || state.activeTabId !== details.tabId) return;

  const tab = await getTab(details.tabId);
  if (tab && isSupportedUrl(tab.url)) {
    await safeSendMessage(tab.id, { action: 'start-session' });
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== HEALTH_ALARM) return;
  queueLifecycle(async () => {
    const state = await getActiveState();
    if (!state.isListening) return;

    const hasDocument = await hasOffscreenDocument();
    const heartbeatIsCurrent = lastOffscreenHeartbeatSessionId === state.sessionId;
    const heartbeatIsStale = heartbeatIsCurrent && Date.now() - lastOffscreenHeartbeatAt > HEARTBEAT_TIMEOUT_MS;
    if (!hasDocument || heartbeatIsStale) {
      await recoverCurrentSessionInternal(!hasDocument ? 'offscreen document missing' : 'recognition heartbeat stalled');
    }
  });
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;
  if (changes.dictationLang) rebuildContextMenus();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.action === 'openSidePanel') {
    getCurrentTab()
      .then((tab) => {
        if (!tab?.id) throw new Error('No active tab');
        return chrome.sidePanel.open({ tabId: tab.id });
      })
      .then(() => sendResponse({ success: true }))
      .catch((error) => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (message?.target !== 'background') return;

  if (message.type === 'toggle-dictation') {
    getCurrentTab()
      .then((tab) => toggleDictation(tab))
      .then(sendResponse)
      .catch((error) => sendResponse({ isListening: false, error: error.message }));
    return true;
  }

  if (message.type === 'restart-dictation') {
    queueLifecycle(restartCurrentSessionInternal)
      .then((started) => sendResponse({ isListening: Boolean(started) }))
      .catch((error) => sendResponse({ isListening: false, error: error.message }));
    return true;
  }

  if (message.type === 'get-dictation-state') {
    getActiveState().then(sendResponse).catch(() => sendResponse({ isListening: false }));
    return true;
  }

  if (message.type === 'insert-manual') {
    getCurrentTab()
      .then((tab) => tab?.id ? safeSendMessage(tab.id, { action: 'insert-text', finalText: message.text || '', interimText: '' }) : null)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === 'permission-granted') {
    resumeAfterPermissionGranted()
      .then((started) => sendResponse({ isListening: Boolean(started) }))
      .catch((error) => sendResponse({ isListening: false, error: error.message }));
    return true;
  }

  if (!message.sessionId) return;

  if (message.type === 'speech-heartbeat') {
    getActiveState().then((state) => {
      if (state.isListening && state.sessionId === message.sessionId) {
        lastOffscreenHeartbeatAt = Date.now();
        lastOffscreenHeartbeatSessionId = message.sessionId;
      }
    });
  } else if (message.type === 'speech-state') {
    getActiveState().then(async (state) => {
      if (!state.isListening || state.sessionId !== message.sessionId) return;
      lastOffscreenHeartbeatAt = Date.now();
      lastOffscreenHeartbeatSessionId = message.sessionId;
      if (message.state === 'active' && state.activeTabId) {
        await safeSendMessage(state.activeTabId, { action: 'reset-interim' });
      }
      if (message.state === 'restarting' && message.attempt === 4 && state.activeTabId) {
        await safeSendMessage(state.activeTabId, {
          action: 'show-warning',
          message: 'Speech recognition is reconnecting automatically. Keep the extension enabled.',
          type: 'warning',
          duration: 4_500
        });
      }
    });
  } else if (message.type === 'speech-restart') {
    getActiveState().then((state) => {
      if (state.isListening && state.sessionId === message.sessionId && state.activeTabId) {
        safeSendMessage(state.activeTabId, { action: 'reset-interim' });
      }
    });
  } else if (message.type === 'speech-result') {
    routeSpeechResult(message);
  } else if (message.type === 'speech-error') {
    if (message.error === 'audio-capture' && message.attempt >= 4) {
      getActiveState().then((state) => {
        if (state.isListening && state.sessionId === message.sessionId && state.activeTabId) {
          safeSendMessage(state.activeTabId, {
            action: 'show-warning',
            message: 'No microphone is currently available. voice2txt will keep retrying automatically.',
            type: 'warning',
            duration: 6_000
          });
        }
      });
    }
  } else if (message.type === 'speech-fatal-error') {
    queueLifecycle(() => handleFatalRecognitionError(message));
  } else if (message.type === 'speech-stopped') {
    queueLifecycle(async () => {
      const state = await getActiveState();
      if (state.isListening && state.sessionId === message.sessionId) {
        await recoverCurrentSessionInternal('offscreen document stopped unexpectedly');
      }
    });
  }

  return true;
});

chrome.runtime.onInstalled.addListener(async () => {
  await setActiveState({ isListening: false });
  await clearHealthAlarm();
  await rebuildContextMenus();
  updateActionUI(false);
});

chrome.runtime.onStartup.addListener(async () => {
  await setActiveState({ isListening: false });
  await clearHealthAlarm();
  await rebuildContextMenus();
  updateActionUI(false);
});

getActiveState().then(async (state) => {
  updateActionUI(state.isListening);
  if (state.isListening) {
    await ensureHealthAlarm();
    queueLifecycle(() => recoverCurrentSessionInternal('service worker restarted'));
  }
  rebuildContextMenus();
});
