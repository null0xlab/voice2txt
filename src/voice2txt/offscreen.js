(() => {
  // Chromium does not guarantee that a SpeechRecognition instance lives forever.
  // Keep one instance at a time and replace it before a long-running session can
  // become stale. The service worker owns the overall session; this document owns
  // only the browser recognition instance.
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const urlParams = new URLSearchParams(window.location.search);
  const language = urlParams.get('lang') || 'en-US';
  const sessionId = urlParams.get('session') || '';

  const PROACTIVE_RECYCLE_MS = 45_000;
  const MAX_RECYCLE_DEFERRAL_MS = 52_000;
  const RECYCLE_STOP_GRACE_MS = 2_500;
  const START_STALL_MS = 8_000;
  const WATCHDOG_INTERVAL_MS = 5_000;
  const RETRY_DELAYS_MS = [250, 500, 1_000, 2_000, 4_000, 8_000, 15_000, 30_000];

  let recognition = null;
  let desiredListening = true;
  let isRunning = false;
  let isStarting = false;
  let isSpeechActive = false;
  let recycleRequested = false;
  let restartTimer = null;
  let recycleTimer = null;
  let watchdogTimer = null;
  let startAttempt = 0;
  let startRequestedAt = 0;
  let sessionStartedAt = 0;
  let lastActivityAt = Date.now();
  let finalizedIndex = 0;

  const recentFinalSentBuffer = [];

  function send(type, payload = {}) {
    try {
      chrome.runtime.sendMessage({
        target: 'background',
        type,
        sessionId,
        ...payload
      }).catch(() => {});
    } catch (_) {
      // The document can be closing while an event is delivered.
    }
  }

  function isDuplicateFinalText(rawText) {
    if (!rawText) return true;

    const normalized = rawText
      .toLowerCase()
      .replace(/[^\w\s\u0980-\u09FF]/g, '')
      .trim();
    if (!normalized) return true;

    const now = Date.now();
    while (recentFinalSentBuffer.length && now - recentFinalSentBuffer[0].time > 8_000) {
      recentFinalSentBuffer.shift();
    }

    if (recentFinalSentBuffer.some((item) => item.normalized === normalized)) {
      return true;
    }

    recentFinalSentBuffer.push({ normalized, time: now });
    if (recentFinalSentBuffer.length > 15) recentFinalSentBuffer.shift();
    return false;
  }

  function clearRestartTimer() {
    if (restartTimer) {
      clearTimeout(restartTimer);
      restartTimer = null;
    }
  }

  function clearRecycleTimer() {
    if (recycleTimer) {
      clearTimeout(recycleTimer);
      recycleTimer = null;
    }
  }

  function disposeRecognition({ abort = true } = {}) {
    const instance = recognition;
    recognition = null;
    isRunning = false;
    isStarting = false;
    isSpeechActive = false;

    if (!instance) return;

    // Old callbacks must never restart or stop a newer instance.
    instance.onstart = null;
    instance.onresult = null;
    instance.onerror = null;
    instance.onend = null;
    instance.onspeechstart = null;
    instance.onspeechend = null;

    if (abort) {
      try {
        instance.abort();
      } catch (_) {}
    }
  }

  function isTerminalError(error) {
    return [
      'not-allowed',
      'service-not-allowed',
      'language-not-supported',
      'not-supported'
    ].includes(error);
  }

  function failSession(error) {
    if (!desiredListening) return;

    desiredListening = false;
    recycleRequested = false;
    clearRestartTimer();
    clearRecycleTimer();
    stopWatchdog();
    disposeRecognition();
    send('speech-fatal-error', { error });
  }

  function scheduleRestart(reason) {
    if (!desiredListening || restartTimer) return;

    startAttempt += 1;
    const delay = RETRY_DELAYS_MS[Math.min(startAttempt - 1, RETRY_DELAYS_MS.length - 1)];
    send('speech-state', {
      state: 'restarting',
      reason,
      attempt: startAttempt,
      delay
    });

    restartTimer = setTimeout(() => {
      restartTimer = null;
      startRecognition();
    }, delay);
  }

  function createRecognition() {
    if (!SpeechRecognition) {
      failSession('not-supported');
      return null;
    }

    const instance = new SpeechRecognition();
    recognition = instance;
    finalizedIndex = 0;

    instance.continuous = true;
    instance.interimResults = true;
    instance.maxAlternatives = 1;
    instance.lang = language;

    instance.onstart = () => {
      if (recognition !== instance || !desiredListening) return;

      isStarting = false;
      isRunning = true;
      recycleRequested = false;
      startAttempt = 0;
      sessionStartedAt = Date.now();
      lastActivityAt = sessionStartedAt;
      finalizedIndex = 0;
      send('speech-state', { state: 'active' });
      send('speech-restart');
    };

    instance.onspeechstart = () => {
      if (recognition !== instance) return;
      isSpeechActive = true;
      lastActivityAt = Date.now();
    };

    instance.onspeechend = () => {
      if (recognition !== instance) return;
      isSpeechActive = false;
      lastActivityAt = Date.now();
    };

    instance.onresult = (event) => {
      if (recognition !== instance || !desiredListening) return;

      lastActivityAt = Date.now();
      let finalText = '';
      let interimText = '';

      for (let index = finalizedIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        const transcript = result[0]?.transcript || '';

        if (result.isFinal) {
          if (!isDuplicateFinalText(transcript)) {
            finalText += `${finalText ? ' ' : ''}${transcript}`;
          }
          finalizedIndex = index + 1;
        } else {
          interimText += transcript;
        }
      }

      if (finalText || interimText) {
        send('speech-result', { finalText, interimText });
      }
    };

    instance.onerror = (event) => {
      if (recognition !== instance) return;

      const error = event.error || 'unknown';
      console.warn('Speech recognition error:', error);
      lastActivityAt = Date.now();
      isStarting = false;
      isRunning = false;

      if (isTerminalError(error)) {
        failSession(error);
        return;
      }

      // `aborted` is expected when the watchdog rotates a session. All other
      // recoverable errors are reported, but recovery continues automatically.
      if (!(error === 'aborted' && recycleRequested)) {
        send('speech-error', { error, attempt: startAttempt + 1 });
      }
    };

    instance.onend = () => {
      if (recognition !== instance) return;

      clearRecycleTimer();
      isStarting = false;
      isRunning = false;
      isSpeechActive = false;
      const reason = recycleRequested ? 'proactive-recycle' : 'service-ended';
      recycleRequested = false;

      if (desiredListening) {
        scheduleRestart(reason);
      } else {
        send('speech-stopped');
      }
    };

    return instance;
  }

  function startRecognition() {
    if (!desiredListening || isRunning || isStarting) return;

    clearRestartTimer();
    disposeRecognition();
    const instance = createRecognition();
    if (!instance || !desiredListening) return;

    isStarting = true;
    startRequestedAt = Date.now();
    lastActivityAt = startRequestedAt;
    send('speech-state', { state: 'starting' });

    try {
      instance.start();
    } catch (error) {
      if (recognition !== instance) return;
      console.warn('Speech recognition start failed:', error);
      isStarting = false;
      scheduleRestart('start-threw');
    }
  }

  function requestRecycle(reason) {
    if (!desiredListening || recycleRequested) return;

    const instance = recognition;
    recycleRequested = true;
    isSpeechActive = false;

    if (!instance || (!isRunning && !isStarting)) {
      recycleRequested = false;
      scheduleRestart(reason);
      return;
    }

    try {
      // stop() asks the service to flush a final result before it ends.
      instance.stop();
    } catch (_) {
      recycleRequested = false;
      disposeRecognition();
      scheduleRestart(`${reason}-stop-threw`);
      return;
    }

    clearRecycleTimer();
    recycleTimer = setTimeout(() => {
      if (recognition !== instance || !desiredListening) return;

      // A frozen implementation may ignore stop(). Replace the entire instance
      // so a silent recognizer cannot hold the microphone indefinitely.
      recycleRequested = false;
      disposeRecognition();
      scheduleRestart(`${reason}-forced`);
    }, RECYCLE_STOP_GRACE_MS);
  }

  function startWatchdog() {
    stopWatchdog();
    watchdogTimer = setInterval(() => {
      if (!desiredListening) return;

      const now = Date.now();
      send('speech-heartbeat', {
        state: isRunning ? 'active' : (isStarting ? 'starting' : 'idle'),
        lastActivityAt
      });

      if (isStarting) {
        if (now - startRequestedAt > START_STALL_MS) {
          disposeRecognition();
          scheduleRestart('start-stalled');
        }
        return;
      }

      if (!isRunning) {
        scheduleRestart('watchdog-not-running');
        return;
      }

      const sessionAge = now - sessionStartedAt;
      if (
        sessionAge >= PROACTIVE_RECYCLE_MS &&
        (!isSpeechActive || sessionAge >= MAX_RECYCLE_DEFERRAL_MS)
      ) {
        requestRecycle('scheduled-rotation');
      }
    }, WATCHDOG_INTERVAL_MS);
  }

  function stopWatchdog() {
    if (watchdogTimer) {
      clearInterval(watchdogTimer);
      watchdogTimer = null;
    }
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.target !== 'offscreen' || message?.sessionId !== sessionId) return;

    if (message.type === 'health-check') {
      sendResponse({
        ok: true,
        sessionId,
        desiredListening,
        isRunning,
        isStarting,
        lastActivityAt
      });
      return true;
    }

    if (message.type === 'stop-recognition') {
      desiredListening = false;
      clearRestartTimer();
      clearRecycleTimer();
      stopWatchdog();
      const instance = recognition;
      if (instance) {
        try {
          instance.stop();
        } catch (_) {
          disposeRecognition();
        }
      }
      sendResponse({ ok: true });
      return true;
    }
  });

  window.addEventListener('beforeunload', () => {
    desiredListening = false;
    clearRestartTimer();
    clearRecycleTimer();
    stopWatchdog();
    disposeRecognition();
  });

  if (!SpeechRecognition) {
    failSession('not-supported');
    return;
  }

  startRecognition();
  startWatchdog();
})();
