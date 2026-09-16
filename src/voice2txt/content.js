(function() {
  if (window.__voice2txt_content_script_injected) {
    return;
  }
  window.__voice2txt_content_script_injected = true;

  let currentInputState = {
    element: null,
    interimStart: -1,
    interimEnd: -1,
    startContainer: null,
    startOffset: -1,
    supportsSelection: true,
    initialValue: undefined,
    accumulatedFinalText: ""
  };

  let userSettings = {
    autoPunctuation: true,
    autoCapitalization: true
  };

  function loadSettings() {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      chrome.storage.local.get({
        autoPunctuation: true,
        autoCapitalization: true
      }, (items) => {
        userSettings.autoPunctuation = items.autoPunctuation !== false;
        userSettings.autoCapitalization = items.autoCapitalization !== false;
      });
    }
  }

  loadSettings();

  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local') {
        if (changes.autoPunctuation !== undefined) userSettings.autoPunctuation = changes.autoPunctuation.newValue;
        if (changes.autoCapitalization !== undefined) userSettings.autoCapitalization = changes.autoCapitalization.newValue;
      }
    });
  }

  // Listen for messages
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "ping") {
      sendResponse({ status: "alive" });
      return true;
    }

    if (request.action === "start-session") {
      resetTracking();
      const el = getDeepActiveElement();
      if (el && isEditable(el)) {
        currentInputState.element = el;
        const hasSelection = supportsSelection(el);
        currentInputState.supportsSelection = hasSelection;
        if (el.tagName && ['input', 'textarea'].includes(el.tagName.toLowerCase())) {
          if (hasSelection) {
            currentInputState.interimStart = el.selectionStart;
            currentInputState.interimEnd = el.selectionStart;
          } else {
            currentInputState.initialValue = el.value || "";
            currentInputState.accumulatedFinalText = "";
          }
        } else {
          syncContentEditableSelection();
        }
        showToast("Listening...", "info", 1500);
        sendResponse({ status: "started" });
      } else {
        showToast("No text input or textarea is selected. Please click inside a text box to dictate.", "warning", 4500);
        sendResponse({ status: "not-editable" });
      }
      return true;
    }

    if (request.action === "reset-interim") {
      removeInterimSpan();
      syncCurrentSelection();
      sendResponse({ status: "synced" });
      return true;
    }

    if (request.action === "stop-session") {
      finalizeInterimSpan();
      resetTracking();
      showToast("Stopped listening", "info", 1500);
      sendResponse({ status: "stopped" });
      return true;
    }

    if (request.action === "insert-text") {
      handleInsert(request.finalText, request.interimText);
      sendResponse({ status: "inserted" });
      return true;
    }

    if (request.action === "insertText") {
      handleInsert(request.text, "");
      sendResponse({ status: "inserted" });
      return true;
    }

    if (request.action === "show-warning") {
      showToast(request.message, request.type || "warning", request.duration || 4500);
      sendResponse({ status: "warning-shown" });
      return true;
    }
  });

  // Track user cursor movement/clicks to reset interim tracking if they move the cursor
  document.addEventListener('mousedown', (e) => {
    const activeEl = getDeepActiveElement();
    if (activeEl !== currentInputState.element) {
      finalizeInterimSpan();
      resetTracking();
    }
  }, true);

  document.addEventListener('keydown', (e) => {
    if (e.isTrusted) {
      finalizeInterimSpan();
      resetTracking();
    }
  }, true);

  function resetTracking() {
    currentInputState = {
      element: null,
      interimStart: -1,
      interimEnd: -1,
      startContainer: null,
      startOffset: -1,
      supportsSelection: true,
      initialValue: undefined,
      accumulatedFinalText: ""
    };
  }

  function syncCurrentSelection() {
    const el = getDeepActiveElement();
    if (el && isEditable(el)) {
      currentInputState.element = el;
      if (el.tagName && ['input', 'textarea'].includes(el.tagName.toLowerCase())) {
        if (supportsSelection(el)) {
          currentInputState.interimStart = el.selectionStart;
          currentInputState.interimEnd = el.selectionStart;
        }
      } else {
        syncContentEditableSelection();
      }
    }
  }

  function syncContentEditableSelection() {
    const sel = window.getSelection();
    if (sel && sel.rangeCount) {
      const range = sel.getRangeAt(0);
      currentInputState.startContainer = range.startContainer;
      currentInputState.startOffset = range.startOffset;
    }
  }

  function supportsSelection(el) {
    if (!el) return false;
    const tagName = el.tagName ? el.tagName.toLowerCase() : '';
    if (tagName === 'input' || tagName === 'textarea') {
      try {
        const _ = el.selectionStart;
        return true;
      } catch (e) {
        return false;
      }
    }
    return false;
  }

  function getDeepActiveElement() {
    let activeEl = document.activeElement;
    while (activeEl && activeEl.shadowRoot && activeEl.shadowRoot.activeElement) {
      activeEl = activeEl.shadowRoot.activeElement;
    }
    return activeEl;
  }

  function isEditable(el) {
    if (!el) return false;
    const tagName = el.tagName ? el.tagName.toLowerCase() : '';
    if (tagName === 'input' || tagName === 'textarea') {
      const type = el.getAttribute('type');
      if (type && ['radio', 'checkbox', 'submit', 'button', 'image', 'file', 'hidden'].includes(type.toLowerCase())) {
        return false;
      }
      return !el.readOnly && !el.disabled;
    }
    if (el.isContentEditable) {
      return true;
    }
    if (el.getAttribute('contenteditable') === 'true' || el.getAttribute('role') === 'textbox') {
      return true;
    }
    return false;
  }

  function setElementValueReact(el, value) {
    const prototype = el instanceof HTMLInputElement ? window.HTMLInputElement.prototype : window.HTMLTextAreaElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
    if (descriptor && descriptor.set) {
      descriptor.set.call(el, value);
    } else {
      el.value = value;
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // Preceding text extraction
  function getPrecedingText(el, rangeStart) {
    if (!el) return "";
    const isInput = el.tagName && ['input', 'textarea'].includes(el.tagName.toLowerCase());
    if (isInput) {
      const val = el.value || "";
      const pos = (rangeStart !== undefined && rangeStart !== -1) ? rangeStart : (el.selectionStart || val.length);
      return val.slice(0, pos);
    } else {
      const sel = window.getSelection();
      if (!sel || !sel.rangeCount) return "";
      try {
        const range = sel.getRangeAt(0);
        const preRange = range.cloneRange();
        preRange.selectNodeContents(el);
        preRange.setEnd(range.startContainer, range.startOffset);
        return preRange.toString();
      } catch (e) {
        return el.textContent || "";
      }
    }
  }

  // Duplicate Word Prevention Algorithm
  function dedupeIncomingText(preceding, incoming) {
    if (!preceding || !incoming) return incoming;

    const normalize = s => s.toLowerCase().replace(/[^\w\s\u0980-\u09FF]/g, '').trim();
    
    const precedingWords = preceding.trim().split(/\s+/).map(normalize).filter(Boolean);
    const incomingWords = incoming.trim().split(/\s+/).map(normalize).filter(Boolean);

    if (precedingWords.length === 0 || incomingWords.length === 0) return incoming;

    const maxOverlap = Math.min(precedingWords.length, incomingWords.length);
    let overlapCount = 0;

    for (let len = maxOverlap; len >= 1; len--) {
      let match = true;
      for (let i = 0; i < len; i++) {
        const precWord = precedingWords[precedingWords.length - len + i];
        const incWord = incomingWords[i];
        if (precWord !== incWord) {
          match = false;
          break;
        }
      }
      if (match) {
        overlapCount = len;
        break;
      }
    }

    if (overlapCount > 0) {
      let wordIdx = 0;
      let cutCharIdx = 0;
      const incomingMatchRegex = /\S+/g;
      let match;
      while ((match = incomingMatchRegex.exec(incoming)) !== null) {
        wordIdx++;
        if (wordIdx === overlapCount) {
          cutCharIdx = match.index + match[0].length;
          break;
        }
      }
      return incoming.slice(cutCharIdx);
    }

    return incoming;
  }

  // Voice Formatting & Spacing Optimization
  function processTextForInsertion(rawText, precedingText) {
    if (!rawText) return "";

    let processed = rawText;

    if (userSettings.autoPunctuation || userSettings.autoCapitalization) {
      processed = applyVoiceFormatting(processed, precedingText, userSettings.autoPunctuation, userSettings.autoCapitalization);
    }

    processed = dedupeIncomingText(precedingText, processed);

    if (!processed || processed.trim().length === 0) return "";

    if (precedingText && precedingText.length > 0) {
      const firstChar = processed.charAt(0);
      const isPunctuation = /^[.,!?:;)]/.test(firstChar);
      if (!/\s$/.test(precedingText) && !isPunctuation && !processed.startsWith(' ')) {
        processed = ' ' + processed;
      }
    }

    return processed;
  }

  function applyVoiceFormatting(text, precedingText, enablePunctuation, enableCap) {
    let result = text;
    if (enablePunctuation) {
      result = result
        .replace(/\bperiod\b/gi, '.')
        .replace(/\bfull stop\b/gi, '.')
        .replace(/\bcomma\b/gi, ',')
        .replace(/\bquestion mark\b/gi, '?')
        .replace(/\bexclamation mark\b/gi, '!')
        .replace(/\bexclamation point\b/gi, '!')
        .replace(/\bnew line\b/gi, '\n')
        .replace(/\bnewline\b/gi, '\n')
        .replace(/\bcolon\b/gi, ':')
        .replace(/\bsemicolon\b/gi, ';');
    }

    if (enableCap && result.length > 0) {
      const isStartOfSentence = !precedingText || precedingText.trim().length === 0 || /[.!?\n]\s*$/.test(precedingText);
      if (isStartOfSentence) {
        result = result.replace(/^(\s*)([a-z])/, (match, p1, p2) => p1 + p2.toUpperCase());
      }
    }
    return result;
  }

  // Safe Insertion for input / textarea
  function safeInsertText(el, text, rangeStart, rangeEnd) {
    el.focus();
    const isInput = el.tagName && ['input', 'textarea'].includes(el.tagName.toLowerCase());
    const hasSelection = isInput && supportsSelection(el);
    
    if (isInput && hasSelection && rangeStart !== undefined && rangeStart !== -1) {
      try {
        el.setSelectionRange(rangeStart, rangeEnd);
      } catch (e) {}
    }

    let success = false;
    try {
      const beforeInputEvent = new InputEvent('beforeinput', {
        inputType: 'insertText',
        data: text,
        bubbles: true,
        cancelable: true
      });
      el.dispatchEvent(beforeInputEvent);
      success = document.execCommand('insertText', false, text);
    } catch (e) {}

    if (!success) {
      if (isInput) {
        const val = el.value || "";
        let start = val.length;
        let end = val.length;
        if (hasSelection) {
          try {
            start = (rangeStart !== undefined && rangeStart !== -1) ? rangeStart : el.selectionStart;
            end = (rangeEnd !== undefined && rangeEnd !== -1) ? rangeEnd : el.selectionEnd;
          } catch (e) {}
        }
        const newVal = val.slice(0, start) + text + val.slice(end);
        setElementValueReact(el, newVal);
        if (hasSelection) {
          try {
            el.setSelectionRange(start + text.length, start + text.length);
          } catch (e) {}
        }
      }
    }

    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // ContentEditable Span Management
  function getInterimSpan(el) {
    return (el || document).querySelector('span[data-voice2txt-interim="true"]');
  }

  function removeInterimSpan() {
    const span = getInterimSpan(currentInputState.element);
    if (span) span.remove();
  }

  function finalizeInterimSpan() {
    const span = getInterimSpan(currentInputState.element);
    if (span) {
      const textNode = document.createTextNode(span.textContent);
      if (span.parentNode) {
        span.parentNode.replaceChild(textNode, span);
      }
    }
  }

  function updateContentEditableInterim(el, interimText) {
    if (!interimText) {
      removeInterimSpan();
      return;
    }

    let span = getInterimSpan(el);
    if (!span) {
      span = document.createElement('span');
      span.setAttribute('data-voice2txt-interim', 'true');
      span.style.opacity = '0.7';
      span.style.borderBottom = '1.5px dotted #00d2ff';
      span.style.color = 'inherit';

      const sel = window.getSelection();
      if (sel && sel.rangeCount) {
        const range = sel.getRangeAt(0);
        range.deleteContents();
        range.insertNode(span);
      } else {
        el.appendChild(span);
      }
    }
    span.textContent = interimText;
  }

  function insertContentEditableFinal(el, finalText) {
    const span = getInterimSpan(el);
    const sel = window.getSelection();

    if (span) {
      const textNode = document.createTextNode(finalText);
      if (span.parentNode) {
        span.parentNode.replaceChild(textNode, span);
      }
      if (sel) {
        const range = document.createRange();
        range.setStartAfter(textNode);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
      }
    } else {
      if (sel && sel.rangeCount) {
        const range = sel.getRangeAt(0);
        range.deleteContents();
        const textNode = document.createTextNode(finalText);
        range.insertNode(textNode);
        range.setStartAfter(textNode);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
      } else {
        const textNode = document.createTextNode(finalText);
        el.appendChild(textNode);
      }
    }

    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // Handle insertion of interim and finalized text blocks
  function handleInsert(finalText, interimText) {
    try {
      let el = getDeepActiveElement();
      if (!el || !isEditable(el)) {
        if (currentInputState.element && isEditable(currentInputState.element)) {
          el = currentInputState.element;
          el.focus();
        } else {
          showToast("Please click inside a text box to dictate.", "warning");
          return;
        }
      }

      const isInput = el.tagName && ['input', 'textarea'].includes(el.tagName.toLowerCase());

      if (isInput) {
        const hasSelection = supportsSelection(el);

        if (!hasSelection) {
          if (currentInputState.initialValue === undefined) {
            currentInputState.initialValue = el.value || "";
            currentInputState.accumulatedFinalText = "";
          }

          if (finalText) {
            const preceding = currentInputState.initialValue + currentInputState.accumulatedFinalText;
            const processedFinal = processTextForInsertion(finalText, preceding);
            if (processedFinal) {
              currentInputState.accumulatedFinalText += processedFinal;
            }
          }

          const newVal = currentInputState.initialValue + currentInputState.accumulatedFinalText + (interimText ? (" " + interimText) : "");
          setElementValueReact(el, newVal);
          return;
        }

        if (currentInputState.interimStart === -1) {
          currentInputState.interimStart = el.selectionStart;
          currentInputState.interimEnd = el.selectionStart;
        }

        if (finalText) {
          const preceding = getPrecedingText(el, currentInputState.interimStart);
          const processedFinal = processTextForInsertion(finalText, preceding);

          if (processedFinal) {
            safeInsertText(el, processedFinal, currentInputState.interimStart, currentInputState.interimEnd);
            currentInputState.interimStart = el.selectionStart;
            currentInputState.interimEnd = el.selectionStart;
          } else {
            safeInsertText(el, "", currentInputState.interimStart, currentInputState.interimEnd);
            currentInputState.interimEnd = currentInputState.interimStart;
          }
        }

        if (interimText) {
          const start = currentInputState.interimStart;
          const end = currentInputState.interimEnd;
          const preceding = getPrecedingText(el, start);
          const formattedInterim = processTextForInsertion(interimText, preceding);

          safeInsertText(el, formattedInterim, start, end);
          currentInputState.interimEnd = start + formattedInterim.length;
        } else if (!finalText) {
          safeInsertText(el, "", currentInputState.interimStart, currentInputState.interimEnd);
          currentInputState.interimEnd = currentInputState.interimStart;
        }
      } else {
        // CONTENTEDITABLE
        if (finalText) {
          const preceding = getPrecedingText(el);
          const processedFinal = processTextForInsertion(finalText, preceding);
          if (processedFinal) {
            insertContentEditableFinal(el, processedFinal);
          } else {
            removeInterimSpan();
          }
        } else if (interimText) {
          updateContentEditableInterim(el, interimText);
        } else {
          removeInterimSpan();
        }
      }
    } catch (e) {
      console.error("Error in voice2txt handleInsert:", e);
    }
  }

  // Toast System
  function showToast(message, type = "info", duration = 4000) {
    const existingToasts = document.querySelectorAll('.voice2txt-toast');
    existingToasts.forEach(t => t.remove());

    const container = document.createElement('div');
    container.className = 'voice2txt-toast';
    
    let accentColor = '#00d2ff';
    let iconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="${accentColor}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink: 0;"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path><path d="M19 10v1a7 7 0 0 1-14 0v-1"></path><line x1="12" y1="19" x2="12" y2="23"></line><line x1="8" y1="23" x2="16" y2="23"></line></svg>`;

    if (type === 'warning') {
      accentColor = '#ff3860';
      iconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="${accentColor}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink: 0;"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>`;
    } else if (type === 'success') {
      accentColor = '#39ff14';
      iconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="${accentColor}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink: 0;"><polyline points="20 6 9 17 4 12"></polyline></svg>`;
    }

    container.innerHTML = `
      <div style="display: flex; align-items: center; gap: 10px;">
        ${iconSvg}
        <span style="font-size: 13px; font-weight: 600; letter-spacing: 0.3px;">${message}</span>
      </div>
    `;

    Object.assign(container.style, {
      position: 'fixed',
      bottom: '30px',
      right: '30px',
      background: 'rgba(15, 12, 30, 0.88)',
      border: `1px solid ${accentColor}4D`,
      color: '#f5f3f7',
      padding: '12px 18px',
      borderRadius: '12px',
      boxShadow: '0 8px 32px 0 rgba(0, 0, 0, 0.5)',
      backdropFilter: 'blur(10px)',
      webkitBackdropFilter: 'blur(10px)',
      fontFamily: "'Outfit', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
      zIndex: '999999',
      transition: 'opacity 0.3s ease, transform 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
      opacity: '0',
      transform: 'translateY(15px) scale(0.95)',
      pointerEvents: 'none'
    });

    document.body.appendChild(container);
    
    requestAnimationFrame(() => {
      container.style.opacity = '1';
      container.style.transform = 'translateY(0) scale(1)';
    });

    setTimeout(() => {
      container.style.opacity = '0';
      container.style.transform = 'translateY(10px) scale(0.95)';
      setTimeout(() => {
        container.remove();
      }, 300);
    }, duration);
  }
})();
