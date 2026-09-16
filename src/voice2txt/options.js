document.addEventListener('DOMContentLoaded', () => {
  const statusDot = document.getElementById('statusDot');
  const statusLabel = document.getElementById('statusLabel');
  const grantMicBtn = document.getElementById('grantMicBtn');
  const shortcutBtn = document.getElementById('shortcutBtn');
  const dictationLangSelect = document.getElementById('dictationLang');
  const toast = document.getElementById('toast');
  const warningBanner = document.getElementById('warningBanner');
  const warningMessage = document.getElementById('warningMessage');

  // Browser Compatibility Check
  function isBrowserSupported() {
    const ua = navigator.userAgent.toLowerCase();
    
    // Check for Firefox
    if (ua.includes('firefox')) return false;
    
    // Check for Brave
    if (navigator.brave !== undefined) return false;
    
    // Check for Opera
    if (ua.includes('opr') || ua.includes('opera')) return false;
    
    // Check for Vivaldi
    if (ua.includes('vivaldi')) return false;
    
    // Check for Edge
    const isEdge = ua.includes('edg/') || ua.includes('edge/');
    
    // Check for Chrome
    const isChrome = ua.includes('chrome') && ua.includes('safari') && !ua.includes('chromium');
    
    return isEdge || isChrome;
  }

  if (!isBrowserSupported()) {
    warningBanner.style.display = 'flex';
    warningBanner.style.background = 'rgba(255, 56, 96, 0.15)';
    warningBanner.style.border = '1px solid rgba(255, 56, 96, 0.3)';
    warningBanner.style.color = '#ffb3c1';
    warningMessage.innerHTML = '<strong>Browser Not Supported:</strong> This extension requires advanced browser-native APIs and is only supported on Google Chrome and Microsoft Edge. Dictation features will not function in this browser.';
    
    if (grantMicBtn) {
      grantMicBtn.disabled = true;
      grantMicBtn.style.opacity = '0.5';
      grantMicBtn.style.cursor = 'not-allowed';
    }
    if (shortcutBtn) {
      shortcutBtn.disabled = true;
      shortcutBtn.style.opacity = '0.5';
      shortcutBtn.style.cursor = 'not-allowed';
    }
    if (dictationLangSelect) {
      dictationLangSelect.disabled = true;
      dictationLangSelect.style.opacity = '0.5';
      dictationLangSelect.style.cursor = 'not-allowed';
    }
  }

  // Populate supported languages dropdown from languages.js
  SUPPORTED_LANGUAGES.forEach(lang => {
    const opt = document.createElement('option');
    opt.value = lang.id;
    opt.textContent = lang.name;
    dictationLangSelect.appendChild(opt);
  });

  const autoPunctuationToggle = document.getElementById('autoPunctuationToggle');
  const autoCapitalizationToggle = document.getElementById('autoCapitalizationToggle');

  // Load configured settings
  chrome.storage.local.get({
    dictationLang: 'en-US',
    autoPunctuation: true,
    autoCapitalization: true
  }, (items) => {
    dictationLangSelect.value = items.dictationLang;
    if (autoPunctuationToggle) autoPunctuationToggle.checked = items.autoPunctuation !== false;
    if (autoCapitalizationToggle) autoCapitalizationToggle.checked = items.autoCapitalization !== false;
  });

  // Save language preference when changed
  dictationLangSelect.addEventListener('change', () => {
    const selectedLang = dictationLangSelect.value;
    chrome.storage.local.set({
      dictationLang: selectedLang
    }, () => {
      showToast("Language preference saved!");
    });
  });

  if (autoPunctuationToggle) {
    autoPunctuationToggle.addEventListener('change', () => {
      chrome.storage.local.set({ autoPunctuation: autoPunctuationToggle.checked }, () => {
        showToast("Formatting settings updated!");
      });
    });
  }

  if (autoCapitalizationToggle) {
    autoCapitalizationToggle.addEventListener('change', () => {
      chrome.storage.local.set({ autoCapitalization: autoCapitalizationToggle.checked }, () => {
        showToast("Formatting settings updated!");
      });
    });
  }

  // Open Chrome Shortcuts settings
  shortcutBtn.addEventListener('click', () => {
    chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
  });

  // Request Microphone Permissions
  function requestMicrophonePermission(autoCloseOnSuccess = false) {
    navigator.mediaDevices.getUserMedia({ audio: true })
      .then((stream) => {
        // Stop stream immediately to release hardware
        stream.getTracks().forEach(track => track.stop());
        updatePermissionUI('granted');
        showToast("Microphone access granted successfully!");
        
        // Notify background that permission was granted
        chrome.runtime.sendMessage({ target: 'background', type: 'permission-granted' });

        if (autoCloseOnSuccess) {
          setTimeout(() => {
            window.close();
          }, 1500);
        }
      })
      .catch((err) => {
        console.error('Microphone access denied:', err);
        updatePermissionUI('denied');
        showToast("Microphone access denied.");
      });
  }

  grantMicBtn.addEventListener('click', () => {
    requestMicrophonePermission(false);
  });

  // Check URL parameters for warnings and auto-requests
  const urlParams = new URLSearchParams(window.location.search);
  
  // Show warnings if requested
  const warningType = urlParams.get('warning');
  if (warningType === 'unsupported') {
    warningBanner.style.display = 'flex';
    warningMessage.textContent = 'Speech recognition is not available on Chrome system pages (e.g. chrome://, Web Store, settings) due to browser security restrictions. Please navigate to a standard website to use the extension.';
  } else if (warningType === 'mic_denied') {
    warningBanner.style.display = 'flex';
    warningMessage.textContent = 'Microphone permission is required to transcribe speech. Please allow access when prompted.';
  }

  // Trigger permission request automatically if requested
  if (urlParams.get('requestMic') === 'true') {
    const autoClose = urlParams.get('autoClose') === 'true';
    setTimeout(() => {
      requestMicrophonePermission(autoClose);
    }, 300);
  }

  // Query Permission state on load
  if (navigator.permissions && navigator.permissions.query) {
    navigator.permissions.query({ name: 'microphone' })
      .then((permissionStatus) => {
        updatePermissionUI(permissionStatus.state);
        permissionStatus.onchange = () => {
          updatePermissionUI(permissionStatus.state);
        };
      })
      .catch((err) => {
        checkMicStream();
      });
  } else {
    checkMicStream();
  }

  function checkMicStream() {
    navigator.mediaDevices.enumerateDevices()
      .then(devices => {
        const hasMic = devices.some(d => d.kind === 'audioinput');
        if (hasMic) {
          updatePermissionUI('prompt');
        } else {
          updatePermissionUI('denied');
        }
      });
  }

  function updatePermissionUI(state) {
    statusDot.className = 'status-dot';
    
    if (state === 'granted') {
      statusDot.classList.add('granted');
      statusLabel.textContent = 'Microphone Access: Allowed';
      grantMicBtn.textContent = 'Microphone Access Granted';
      grantMicBtn.className = 'action-btn permission-btn success';
      grantMicBtn.disabled = true;
    } else if (state === 'denied') {
      statusDot.classList.add('denied');
      statusLabel.textContent = 'Microphone Access: Denied';
      grantMicBtn.textContent = 'Enable Microphone in Site Settings';
      grantMicBtn.className = 'action-btn permission-btn';
      grantMicBtn.disabled = false;
    } else {
      statusLabel.textContent = 'Microphone Access: Required';
      grantMicBtn.textContent = 'Grant Microphone Access';
      grantMicBtn.className = 'action-btn primary permission-btn';
      grantMicBtn.disabled = false;
    }
  }

  function showToast(message) {
    if (message) {
      toast.textContent = message;
    }
    toast.style.display = 'block';
    setTimeout(() => {
      toast.style.display = 'none';
    }, 2500);
  }

  // Synchronize options selector when storage updates (e.g. from context menu)
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && changes.dictationLang) {
      dictationLangSelect.value = changes.dictationLang.newValue;
    }
  });
});
