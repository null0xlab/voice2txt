document.addEventListener('DOMContentLoaded', () => {
  const dictationLangSelect = document.getElementById('dictationLang');
  const recordBtn = document.getElementById('recordBtn');
  const micContainer = document.querySelector('.mic-container');
  const statusText = document.getElementById('statusText');
  const transcriptionOutput = document.getElementById('transcriptionOutput');
  const copyBtn = document.getElementById('copyBtn');
  const insertBtn = document.getElementById('insertBtn');
  const settingsBtn = document.getElementById('settingsBtn');
  const sidePanelBtn = document.getElementById('sidePanelBtn');

  let isListening = false;
  let finalTranscript = '';

  function setListeningState(listening) {
    isListening = Boolean(listening);
    micContainer?.classList.toggle('listening', isListening);
    recordBtn?.setAttribute('aria-pressed', String(isListening));
    if (statusText) statusText.textContent = isListening ? 'Listening...' : 'Idle';
  }

  function showError(message) {
    if (statusText) statusText.textContent = message;
    micContainer?.classList.remove('listening');
  }

  function appendFinalTranscript(text) {
    const cleaned = (text || '').trim();
    if (!cleaned) return;
    finalTranscript += `${finalTranscript && !/\s$/.test(finalTranscript) ? ' ' : ''}${cleaned}`;
    if (transcriptionOutput) transcriptionOutput.value = finalTranscript;
  }

  function showInterimTranscript(text) {
    if (!transcriptionOutput || !text) return;
    const separator = finalTranscript && !/\s$/.test(finalTranscript) ? ' ' : '';
    transcriptionOutput.value = `${finalTranscript}${separator}${text}`;
  }

  function populateLanguages() {
    if (!dictationLangSelect || typeof SUPPORTED_LANGUAGES === 'undefined') return;
    dictationLangSelect.replaceChildren();
    SUPPORTED_LANGUAGES.forEach((language) => {
      const option = document.createElement('option');
      option.value = language.id;
      option.textContent = language.name;
      dictationLangSelect.appendChild(option);
    });
  }

  async function sendToBackground(type, payload = {}) {
    return chrome.runtime.sendMessage({ target: 'background', type, ...payload });
  }

  populateLanguages();

  chrome.storage.local.get({ dictationLang: 'en-US' }).then((settings) => {
    if (dictationLangSelect) dictationLangSelect.value = settings.dictationLang;
  });

  sendToBackground('get-dictation-state')
    .then((state) => setListeningState(state.isListening))
    .catch(() => setListeningState(false));

  recordBtn?.addEventListener('click', async () => {
    recordBtn.disabled = true;
    try {
      const state = await sendToBackground('toggle-dictation');
      setListeningState(state.isListening);
      if (state.error) showError('Unable to start');
    } catch (error) {
      console.error('Unable to toggle dictation:', error);
      showError('Connection error');
    } finally {
      recordBtn.disabled = false;
    }
  });

  dictationLangSelect?.addEventListener('change', async () => {
    await chrome.storage.local.set({ dictationLang: dictationLangSelect.value });
    if (!isListening) return;

    try {
      const state = await sendToBackground('restart-dictation');
      setListeningState(state.isListening);
    } catch (error) {
      console.error('Unable to apply language change:', error);
      showError('Language update failed');
    }
  });

  settingsBtn?.addEventListener('click', () => chrome.runtime.openOptionsPage());

  sidePanelBtn?.addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'openSidePanel' })
      .then((response) => {
        if (response?.success) window.close();
      })
      .catch((error) => console.error('Unable to open side panel:', error));
  });

  copyBtn?.addEventListener('click', async () => {
    const text = transcriptionOutput?.value || '';
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      const oldText = copyBtn.textContent;
      copyBtn.textContent = 'Copied!';
      setTimeout(() => { copyBtn.textContent = oldText; }, 1_500);
    } catch (error) {
      console.error('Unable to copy transcript:', error);
      showError('Copy failed');
    }
  });

  insertBtn?.addEventListener('click', async () => {
    const text = transcriptionOutput?.value || '';
    if (!text) return;
    try {
      const result = await sendToBackground('insert-manual', { text });
      if (!result?.ok) showError('Insert failed');
    } catch (error) {
      console.error('Unable to insert transcript:', error);
      showError('Insert failed');
    }
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    if (changes.dictationLang && dictationLangSelect) {
      dictationLangSelect.value = changes.dictationLang.newValue;
    }
    if (changes.isListening) {
      setListeningState(changes.isListening.newValue);
    }
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.target !== 'voice2txt-ui' || message.type !== 'transcript') return;
    if (message.finalText) appendFinalTranscript(message.finalText);
    if (message.interimText) showInterimTranscript(message.interimText);
    if (message.finalText && !message.interimText && transcriptionOutput) {
      transcriptionOutput.value = finalTranscript;
    }
  });
});
