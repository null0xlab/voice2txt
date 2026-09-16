# voice2txt

An open-source browser extension designed to provide a polished, reliable, and continuous voice-to-text input experience using browser-native Speech Recognition. Built on Manifest V3.

---

## Demo & Visuals

### Video Demo
 [![Demon & Setup Video]](https://youtu.be/D3AUQks3QQY)

### Screenshots
[![IMG-20260916-200037-293.jpg](https://i.postimg.cc/tRnKXF24/IMG-20260916-200037-293.jpg)](https://postimg.cc/t7ySkZKK)

[![IMG-20260916-200037-852.jpg](https://i.postimg.cc/zXJFdrbJ/IMG-20260916-200037-852.jpg)](https://postimg.cc/Z0MNRXxg)

[![IMG-20260916-200319.jpg](https://i.postimg.cc/SxH8pFsh/IMG-20260916-200319.jpg)](https://postimg.cc/MnbXyLVP)

---

## Why voice2txt?

Most speech-to-text extensions fail under real-world usage because they run inside the popup panel (which kills dictation when you click away) or because they freeze when the browser's speech recognition engine stalls. 

**voice2txt** decouples speech listening from the popup UI, enabling:
*   **Continuous Cross-Tab Dictation:** Keep speaking as you navigate tabs or edit documents.
*   **Dockable Side Panel:** A persistent notebook ([sidepanel.html](file:///E:/voice2txt/src/voice2txt/sidepanel.html)) that remains open as you browse.
*   **Direct In-Page Injection:** Formats and types dictated text directly at your cursor in text fields, textareas, and rich contenteditable editors ([content.js](file:///E:/voice2txt/src/voice2txt/content.js)).
*   **Zero Extension Limits:** The extension does not impose daily, word, or duration limits.

---

## Technical Problems Solved

Instead of wrapping the speech API in a basic UI, this project implements specific recovery mechanisms for the technical edge cases of browser-native speech recognition:

### 1. The 45-Second Chromium Speech API Limitation
*   **The Problem:** Chromium's native Speech Recognition API has an inherent limitation where the engine stalls or stops accepting speech after approximately 45 seconds of continuous connection or silence.
*   **Our Solution:** In [offscreen.js](file:///E:/voice2txt/src/voice2txt/offscreen.js), we implemented **Proactive Session Recycling**:
    *   **Proactive Rotation:** The active `SpeechRecognition` instance is programmatically stopped and recreated every 45 seconds (`PROACTIVE_RECYCLE_MS = 45_000`).
    *   **Smart Deferral:** If the microphone is actively capturing voice, recycling is deferred until a pause, up to a hard limit of 52 seconds (`MAX_RECYCLE_DEFERRAL_MS = 52_000`).
    *   **Service Worker Watchdog:** In [background.js](file:///E:/voice2txt/src/voice2txt/background.js), a 30-second alarm (`HEALTH_ALARM`) queries the offscreen page. If the heartbeat stalls for over 70 seconds, it automatically re-spawns the document and recovers the session.

### 2. Duplicate Text During Reconnects
*   **The Problem:** Force-stopping and restarting the SpeechRecognition engine frequently causes Chromium to fire duplicate `onresult` final events, leading to repeated words or sentences.
*   **Our Solution:** We implement a **Dual-Layer Deduplication** pipeline:
    *   **Sentence-Level:** `isDuplicateFinalText` in [offscreen.js](file:///E:/voice2txt/src/voice2txt/offscreen.js) maintains a rolling 8-second final-sentence cache to discard duplicate segments.
    *   **Word-Level:** [`dedupeIncomingText`](file:///E:/voice2txt/src/voice2txt/content.js#L243-L289) in [content.js](file:///E:/voice2txt/src/voice2txt/content.js) uses a sliding window overlap algorithm to compare trailing words of preceding text with the incoming chunk, trimming duplicate overlapping words.

### 3. Microphone & Connection Dropouts
*   **The Problem:** Hardware access errors (like `audio-capture`) or network disconnects can abort the transcription mid-sentence.
*   **Our Solution:** Recoverable errors initiate an **Exponential Backoff Reconnect** sequence in [offscreen.js](file:///E:/voice2txt/src/voice2txt/offscreen.js) (`[250ms, 500ms, 1s, 2s, 4s, 8s, 15s, 30s]`). If reconnects stall for over 4 attempts, warning toasts are injected via the content script to notify the user.

### 4. Language Drift & Bengali Locales
*   **The Problem:** Automated speech engines struggle to differentiate closely related regional dialects (such as Bengali spoken in Bangladesh `bn-BD` vs. India `bn-IN`), leading to spelling mismatches.
*   **Our Solution:** The extension avoids auto-detection in favor of manual selection from 120 locale codes listed in [languages.js](file:///E:/voice2txt/src/voice2txt/languages.js). When a user changes the language (via popup, options, or the context menu), the background script intercepts the change and executes [`restartCurrentSessionInternal`](file:///E:/voice2txt/src/voice2txt/background.js#L268-L277), hot-reloading the active recognition service with the new locale.

### 5. Terminal Error Handling
*   **The Problem:** Permissions blockages (`not-allowed`) or lack of browser API support can cause infinite crash-loops if recovery is run blindly.
*   **Our Solution:** Terminal errors are immediately isolated. The extension halts background listening and redirects the user to the options page with permission queries (`options.html?requestMic=true&warning=mic_denied`) to resolve issues.

---

## Comparison Matrix

| Feature | voice2txt | Simpler Alternatives |
| :--- | :--- | :--- |
| **Dictation Scope** | Cross-tab persistent (via offscreen context) | Stops if popup closes or user clicks away |
| **Engine Stalls (~45s)** | Proactively recycled and recovered | Freezes or stops transcribing silently |
| **Reconnection Routine** | Exponential backoff with heartbeat watchdogs | Manual extension reload required |
| **Text Deduplication** | Dual-layer (sentence cache + sliding word overlap) | None (produces repeated text on reconnects) |
| **Language Management** | 120 locales; hot-reload on context-menu change | Limited selection; requires session restart |
| **Usage Limits** | None (unrestricted open-source backend) | Often capped by page views or API keys |

---

## Browser Support & Limitations

### Supported Browsers
*   **Google Chrome (v116+):** Recommended. Native Web Speech engine.
*   **Microsoft Edge (v116+):** Full support. Identical implementation.

### Unsupported Browsers
*   **Brave:** Brave Shields block the Chromium native SpeechRecognition endpoints.
*   **Firefox & Safari:** Lack Manifest V3 `chrome.offscreen` or `chrome.sidePanel` API support.
*   **Opera & Vivaldi:** Built-in security/ad-block wrappers disable native speech processes.

### Known Limitations
*   **System Pages:** Script injection is blocked on settings pages (`chrome://*`) and the Chrome Web Store for security reasons.
*   **Internet Connectivity:** Requires an active internet connection to communicate with browser-native speech servers (unless offline speech packs are installed locally by the OS).

---

## Installation & How to Use

### Installation
1.  Clone this repository (or download it to a local folder like `E:\voice2txt`).
2.  Open your browser and navigate to `chrome://extensions` or `edge://extensions`.
3.  Enable **Developer Mode** (top-right toggle).
4.  Click **Load unpacked** (top-left) and select the project's source directory: `E:\voice2txt\src\voice2txt`.

### How to Use
1.  Click the microphone icon in your toolbar. Grant microphone access if prompted.
2.  Select your language in the popover dropdown.
3.  Click into any text field on a web page and press **Alt + L** (Mac: **Ctrl + Shift + L**) or right-click and select **Start Dictation**.
4.  Dictate your text. Speak commands like *"comma"*, *"period"*, or *"new line"* to format.
5.  Press **Alt + L** again to stop.

---

## Project Structure

```text
voice2txt/
├── README.md
└── src/
    └── voice2txt/
        ├── manifest.json       # Manifest V3 configurations & permissions
        ├── background.js       # Background service worker (state, lifecycle, alarms)
        ├── content.js          # In-page text insertion, word deduplication, and toast UI
        ├── offscreen.html      # Offscreen context page for Web Speech API
        ├── offscreen.js        # SpeechRecognition controller, watchdogs, and recycling
        ├── languages.js        # Configured list of 120 language-locale pairs
        ├── options.html/js     # Extension configuration and permission checker
        ├── popup.html/js/css   # Popover controls, live transcript previews, and UI theme
        └── sidepanel.html      # Persistent transcription notebook panel
```

---

## License

MIT License.

