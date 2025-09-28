// Lazy Cat popup — checkpoint + 3.3A1 (Summarize)
// - Voice engine (final-only, fuzzy wake, language select, wake timeout)
// - AI router (JSON schema + cleanup)
// - Executor messaging to background (open_tab, scroll, search_web, click_ui)
// - Summarize in popup (selection/email/page) with user-gesture gated download

let listening = false;
let recognition;
let wakeActive = false;
let wakeTimer = null;

// ===== UI
const btn = document.getElementById("btnToggle");
const statusEl = document.getElementById("status");
const transcriptEl = document.getElementById("transcript");

// Optional controls (if present)
const langSel = document.getElementById("lang");
const wakeSensitivityEl = document.getElementById("wakeSensitivity");

// Debug toggle for cleaner logs
const DEBUG_SHOW_IGNORED = false;

function setStatus(msg) { statusEl && (statusEl.textContent = msg); }
function appendTranscript(text) { transcriptEl && (transcriptEl.textContent += text + "\n"); }
function clearWakeTimer() { if (wakeTimer) { clearTimeout(wakeTimer); wakeTimer = null; } }
function armWakeTimeout() {
  clearWakeTimer();
  wakeTimer = setTimeout(() => {
    wakeActive = false;
    setStatus("Wake timed out. Say 'Hey Cat' or 'Lazy Cat' again.");
  }, 5000);
}

// ===== Wake detection (fuzzy)
const BASE_WAKE_VARIANTS = [
  "hey cat", "lazy cat",
  "he got", "hey cut", "lazy cut", "hey cap", "hey cad", "hey kit", "hey kate", "hey cats"
];

function editDistanceAtMost(s, t, maxD = 2) {
  const m = s.length, n = t.length;
  if (Math.abs(m - n) > maxD) return maxD + 1;
  const dp = new Array(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    let minRow = dp[0];
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(
        dp[j] + 1,
        dp[j - 1] + 1,
        prev + (s[i - 1] === t[j - 1] ? 0 : 1)
      );
      prev = tmp;
      if (dp[j] < minRow) minRow = dp[j];
    }
    if (minRow > maxD) return maxD + 1;
  }
  return dp[n];
}

// sensitivity: 0=strict, 1=default, 2=loose
function wakeMatches(text, sensitivity = 1) {
  const lower = text.toLowerCase();
  // fast path: direct substring
  let best = null;
  for (const v of BASE_WAKE_VARIANTS) {
    const idx = lower.indexOf(v);
    if (idx !== -1 && (!best || idx < best.index)) best = { index: idx, match: v };
  }
  if (best) return best;

  // fuzzy near beginning
  const windowText = lower.slice(0, 40);
  const maxD = sensitivity === 0 ? 1 : sensitivity === 1 ? 2 : 3;
  for (const v of BASE_WAKE_VARIANTS) {
    for (let i = 0; i <= Math.max(0, windowText.length - v.length); i++) {
      const cand = windowText.slice(i, i + v.length);
      if (editDistanceAtMost(cand, v, maxD) <= maxD) return { index: i, match: v };
    }
  }
  return null;
}
function stripAfterWake(text, sensitivity = 1) {
  const info = wakeMatches(text, sensitivity);
  if (!info) return null;
  return text.slice(info.index + info.match.length).trim();
}

// ===== AI Router
async function aiInterpret(commandText) {
  try {
    const availability = await LanguageModel.availability();
    if (availability === "unavailable") {
      appendTranscript("⚠️ Prompt API unavailable on this device.");
      return;
    }

    const schema = {
      type: "object",
      properties: {
        command: {
          type: "string",
          enum: ["open_tab", "scroll", "search_web", "click_ui", "summarize", "rewrite_selection"] // + rewrite_selection
        },
        args: {
          type: "object",
          properties: {
            // open_tab
            url: { type: "string" },
            // scroll
            direction: { type: "string", enum: ["up", "down"] },
            // search_web
            query: { type: "string" },
            // click_ui
            text: { type: "string" },
            // summarize
            target: { type: "string", enum: ["auto", "selection", "email", "page"] },
            // rewrite_selection
            tone: { type: "string" } // ← free-form tone (e.g., "apologetic", "enthusiastic", "legal", "casual", etc.)
          },
          additionalProperties: false
        },
        confirmation: { type: "string", enum: ["none", "required"] }
      },
      required: ["command", "args", "confirmation"]
    };

    const session = await LanguageModel.create({
      // Note: some Chrome builds still warn about language; functionality OK.
      output: { type: "text", languageCode: "en" },
      responseConstraint: { type: "json_schema", schema },
      monitor(m) {
        m.addEventListener("downloadprogress", (e) => {
          setStatus(`Downloading AI model… ${Math.round((e.loaded || 0) * 100)}%`);
        });
      }
    });

    const raw = await session.prompt([
      {
        role: "system",
        content:
          "You are Lazy Cat's command router.\n" +
          "Output ONLY valid JSON per schema. Exactly one command per request.\n" +
          "For open_tab: command='open_tab' and args.url must be a full https URL.\n" +
          "For scroll: command='scroll', args.direction must be 'up' or 'down'.\n" +
          "For search_web: command='search_web', args.query is the user's search terms.\n" +
          "For click_ui: command='click_ui', args.text is the visible label to click.\n" +
          "For summarize: command='summarize', args.target is 'auto' unless user says selection/email/page.\n" +
          "For rewrite_selection: command='rewrite_selection'. args.tone is free-form (e.g., 'apologetic', 'enthusiastic', 'legal', 'casual'). If missing, assume 'natural'. Return ONLY the rewritten text (no quotes/fences/commentary), preserve meaning and key details.\n" +
          "Never invent other fields. Never output any text outside the JSON."
      },
      { role: "user", content: commandText }
    ]);

    session.destroy?.();

    console.log("DEBUG raw result:", raw);

    // Cleanup code fences if any
    let cleaned = String(raw).replace(/```json/gi, "").replace(/```/g, "").trim();

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      parsed = { command: "noop", args: {}, confirmation: "none", error: "Could not parse AI output" };
    }

    // Intercept rewrite_selection (must run in a page, not the background worker)
    if (parsed.command === "rewrite_selection") {
      const tone = (parsed.args?.tone || "natural").trim();
      await handleRewriteSelectionFromPopup(tone);
      return;
    }

    appendTranscript("🤖 " + JSON.stringify(parsed, null, 2));

    // 🔹 Intercept summarize (runs in popup, not background worker)
    if (parsed.command === "summarize") {
      const target = parsed.args?.target || "auto";
      await handleSummarizeFromPopup(target);
      return;
    }

    // Send the rest to executor (background)
    chrome.runtime.sendMessage(
      { type: "executeCommand", data: parsed },
      (response) => {
        console.log("Executor response:", response);
        if (response?.status === "ok") {
          appendTranscript(`✅ Executed: ${JSON.stringify(response)}`);
        } else if (response?.status === "noop") {
          appendTranscript(`⚠️ Unsupported command`);
        } else {
          appendTranscript(`⚠️ ${response?.message || "Execution failed"}`);
        }
      }
    );
  } catch (err) {
    appendTranscript("❌ AI error: " + err.message);
  }
}

// ===== Summarizer helpers (3.3A1)

// Cached instance (after first enable)
let __lazycatSummarizer = null;

function showSummarizerInstallUI(onReady) {
  const panel = document.getElementById("aiSetup");
  const btn = document.getElementById("btnEnableSummarizer");
  if (!panel || !btn) {
    appendTranscript("⚠️ Summarizer setup UI not found in popup.html.");
    return;
  }
  panel.style.display = "block";
  setStatus("Summarizer model required — click to install.");

  btn.onclick = async () => {
    try {
      setStatus("Preparing summarizer…");
      const summarizer = await Summarizer.create({
        type: "tldr",
        format: "markdown",
        length: "medium",
        monitor(m) {
          m.addEventListener("downloadprogress", (e) => {
            setStatus(`Downloading AI model… ${Math.round((e.loaded || 0) * 100)}%`);
          });
        }
      });
      __lazycatSummarizer = summarizer;
      panel.style.display = "none";
      setStatus("Summarizer ready.");
      onReady && onReady(summarizer);
    } catch (e) {
      appendTranscript("❌ Summarizer setup failed: " + e.message);
    }
  };
}

async function getSummarizerOrPrompt() {
  if (__lazycatSummarizer) return __lazycatSummarizer;

  if (!("Summarizer" in self)) {
    appendTranscript("⚠️ Summarizer API not available in this browser.");
    return null;
  }

  const availability = await Summarizer.availability();
  if (availability === "unavailable") {
    appendTranscript("⚠️ Summarizer unavailable on this device.");
    return null;
  }

  if (availability === "available") {
    try {
      __lazycatSummarizer = await Summarizer.create({
        type: "tldr",
        format: "markdown",
        length: "medium"
      });
      return __lazycatSummarizer;
    } catch {
      // Some builds still require explicit gesture; fall back to UI.
      showSummarizerInstallUI();
      return null;
    }
  }

  // 'downloadable' or 'downloading' require a user gesture
  showSummarizerInstallUI();
  return null;
}

async function handleSummarizeFromPopup(target = "auto") {
  try {
    // 1) Extract text from the active tab
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) { appendTranscript("⚠️ No active tab to summarize"); return; }

    const [{ result: extraction }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      args: [target],
      func: (tgt) => {
        const clamp = (s, max = 60000) => (s || "").slice(0, max);
        const getSel = () => (window.getSelection()?.toString() || "").trim();
        const getMainish = () => {
          const picks = [
            document.querySelector("[role='main']"),
            document.querySelector("main"),
            document.querySelector("article")
          ].filter(Boolean);
          const texts = picks
            .map(el => (el.innerText || "").trim())
            .filter(s => s.length > 200)
            .sort((a, b) => b.length - a.length);
          return texts[0] || "";
        };

        let text = "", source = "auto";
        if (tgt === "selection" || tgt === "auto") {
          text = getSel(); if (text) source = "selection";
        }
        if (!text && (tgt === "email" || tgt === "auto")) {
          const m = getMainish(); if (m) { text = m; source = "email/main"; }
        }
        if (!text && (tgt === "page" || tgt === "auto")) {
          const body = (document.body?.innerText || "").trim();
          if (body) { text = body; source = "page"; }
        }

        return { source, text: clamp(text) };
      }
    });

    if (!extraction?.text) {
      appendTranscript("⚠️ Nothing to summarize (no selection/page text)");
      return;
    }

    // 2) Ensure summarizer (may prompt for one-time user gesture)
    const summarizer = await getSummarizerOrPrompt();
    if (!summarizer) {
      // UI shown; user will click to download, then you can run the command again.
      return;
    }

    // 3) Summarize
    setStatus("Summarizing…");
    const summary = await summarizer.summarize(extraction.text, {
      context: "Produce a concise, helpful summary for a busy reader."
    });

    appendTranscript(`📝 Summary (${extraction.source}):\n${summary}`);
    setStatus("Idle");
  } catch (err) {
    appendTranscript("❌ Summarize error: " + err.message);
    setStatus("Idle");
  }
}

// ===== Speech Recognition (accuracy-focused)
function initRecognition() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    setStatus("SpeechRecognition not supported in this browser.");
    btn && (btn.disabled = true);
    return;
  }

  recognition = new SpeechRecognition();
  recognition.lang = (localStorage.getItem("lc_lang") || "en-US");
  recognition.continuous = true;
  recognition.interimResults = true;     // we only act on finals
  recognition.maxAlternatives = 5;

  recognition.onstart = () => setStatus("Listening… say 'Hey Cat' or 'Lazy Cat'.");
  recognition.onerror = (e) => setStatus("Error: " + e.error);
  recognition.onend = () => {
    if (listening) recognition.start();
    else setStatus("Stopped.");
  };

  recognition.onresult = (event) => {
    const res = event.results[event.results.length - 1];
    if (!res || !res.isFinal) return;

    // Collect n-best and choose the best heuristic
    const alts = [];
    for (let i = 0; i < res.length; i++) {
      const t = (res[i].transcript || "").trim();
      if (t) alts.push(t);
    }
    if (!alts.length) return;

    const sens = Number(localStorage.getItem("lc_wake_sens") ?? "1");
    let chosen = null;
    for (const t of alts) {
      if (wakeMatches(t.toLowerCase(), sens)) { chosen = t; break; }
    }
    if (!chosen) chosen = alts.slice().sort((a, b) => b.length - a.length)[0];

    const lower = chosen.toLowerCase();

    // A) wake phrase present → extract trailing command
    const afterWake = stripAfterWake(lower, sens);
    if (afterWake !== null) {
      if (afterWake) {
        appendTranscript("🐱 " + afterWake);
        aiInterpret(afterWake);
        wakeActive = false;
        clearWakeTimer();
        recognition.stop();
      } else {
        setStatus("Wake word detected — waiting for your command…");
        wakeActive = true;
        armWakeTimeout();
      }
      return;
    }

    // B) already in wake window → treat as command
    if (wakeActive) {
      appendTranscript("🐱 " + chosen);
      aiInterpret(chosen);
      wakeActive = false;
      clearWakeTimer();
      recognition.stop();
      return;
    }

    // C) ignore
    if (DEBUG_SHOW_IGNORED) appendTranscript("(ignored) " + chosen);
    recognition.stop();
  };
}

// UI wiring
btn && btn.addEventListener("click", () => {
  if (!recognition) initRecognition();

  if (!listening) {
    listening = true;
    recognition.start();
    btn.textContent = "🛑 Stop Listening";
  } else {
    listening = false;
    recognition.stop();
    btn.textContent = "🎤 Start Listening";
  }
});

// Persist language & sensitivity
if (langSel) {
  const savedLang = localStorage.getItem("lc_lang");
  if (savedLang) langSel.value = savedLang;
  langSel.addEventListener("change", () => {
    localStorage.setItem("lc_lang", langSel.value);
    if (recognition) recognition.lang = langSel.value;
    setStatus(`Language set to ${langSel.value}`);
  });
}
if (wakeSensitivityEl) {
  const savedSens = localStorage.getItem("lc_wake_sens");
  if (savedSens !== null) wakeSensitivityEl.value = savedSens;
  wakeSensitivityEl.addEventListener("input", () => {
    localStorage.setItem("lc_wake_sens", wakeSensitivityEl.value);
    setStatus(`Wake sensitivity: ${wakeSensitivityEl.value}`);
  });
}

// ===== Rewrite selection helper (3.3A1)
async function handleRewriteSelectionFromPopup(tone = "professional") {
  try {
    // 1) Get selected/focused text from the active tab
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) { appendTranscript("⚠️ No active tab for rewrite"); return; }

    const [{ result: extract }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      args: [],
      func: () => {
        const sel = window.getSelection();
        const hasSelection = sel && sel.rangeCount && sel.toString().trim().length > 0;

        // Focused element (input/textarea/contenteditable)
        const ae = document.activeElement;
        const isTextInput =
          ae && ((ae.tagName === "TEXTAREA") ||
          (ae.tagName === "INPUT" && /^(text|search|email|tel|url|password)$/i.test(ae.type)) ||
          ae.isContentEditable);

        let mode = "none";
        let text = "";

        if (hasSelection) {
          mode = "selection";
          text = sel.toString();
        } else if (isTextInput) {
          mode = ae.isContentEditable ? "contenteditable" :
                 (ae.tagName === "TEXTAREA" ? "textarea" : "input");
          text = ae.value ?? ae.innerText ?? "";
          // If no explicit selection in input, rewrite whole field
          if ((mode === "input" || mode === "textarea") && typeof ae.selectionStart === "number" && ae.selectionStart !== ae.selectionEnd) {
            mode = mode + "_range"; // input_range / textarea_range
            text = (ae.value || "").substring(ae.selectionStart, ae.selectionEnd);
          } else if (mode === "contenteditable" && hasSelection) {
            mode = "contenteditable_range";
            text = sel.toString();
          }
        }

        // Clamp to keep latency sane
        const clamp = (s, max = 20000) => (s || "").slice(0, max);
        return { mode, text: clamp(text) };
      }
    });

    if (!extract || !extract.text) {
      appendTranscript("⚠️ No selection or editable text to rewrite");
      return;
    }

    // 2) Rewrite using on-device Prompt API
    const lmAvail = await LanguageModel.availability();
    if (lmAvail === "unavailable") {
      appendTranscript("⚠️ Prompt API unavailable on this device.");
      return;
    }

    const session = await LanguageModel.create({
      output: { type: "text", languageCode: "en" } // expect plain text back
    });

    // Keep prompt simple and deterministic: model should return ONLY the rewritten text
    const styleHint =
      tone === "friendly" ? "friendly and warm"
      : tone === "concise" ? "more concise and clear"
      : tone === "neutral" ? "neutral and clear"
      : "professional and polite";

    const prompt = [
      { role: "system", content: "Rewrite the user's text. Return ONLY the rewritten text, no quotes, no code fences, no commentary." },
      { role: "user", content: `Tone/style: ${styleHint}\n\nText:\n${extract.text}` }
    ];

    const raw = await session.prompt(prompt);
    session.destroy?.();

    // Sanitize: strip accidental fences/quotes/whitespace
    const rewritten = String(raw).replace(/```[\s\S]*?```/g, "").trim();
    if (!rewritten) {
      appendTranscript("⚠️ Rewrite produced empty output");
      return;
    }

    // 3) Try to replace text in page
    const [{ result: replaced }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      args: [extract.mode, rewritten],
      func: (mode, newText) => {
        const fire = (el) => {
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
        };

        const sel = window.getSelection();

        // Inputs/Textareas (with or without range)
        if (mode === "input" || mode === "textarea") {
          const ae = document.activeElement;
          if (!ae) return { success: false, reason: "no_active_element" };
          const desc = mode;
          const setter = Object.getOwnPropertyDescriptor(ae.__proto__, "value") ||
                         Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value") ||
                         Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value");
          setter?.set?.call(ae, newText);
          fire(ae);
          return { success: true, where: desc };
        }
        if (mode === "input_range" || mode === "textarea_range") {
          const ae = document.activeElement;
          if (!ae || typeof ae.selectionStart !== "number") return { success: false, reason: "no_range" };
          const start = ae.selectionStart, end = ae.selectionEnd;
          ae.setRangeText(newText, start, end, "end");
          fire(ae);
          return { success: true, where: mode };
        }

        // Contenteditable
        if (mode === "contenteditable") {
          const ae = document.activeElement;
          if (!ae || !ae.isContentEditable) return { success: false, reason: "no_contenteditable" };
          ae.innerText = newText;
          fire(ae);
          return { success: true, where: "contenteditable" };
        }
        if (mode === "contenteditable_range" || mode === "selection") {
          if (!sel || !sel.rangeCount) return { success: false, reason: "no_selection_range" };
          const range = sel.getRangeAt(0);
          range.deleteContents();
          range.insertNode(document.createTextNode(newText));
          // move caret to end
          range.collapse(false);
          sel.removeAllRanges();
          sel.addRange(range);
          return { success: true, where: mode };
        }

        return { success: false, reason: "unsupported_mode" };
      }
    });

    // 4) Show result in popup regardless of replacement success
    appendTranscript(`✍️ Rewritten (${tone}):\n${rewritten}`);
    if (!replaced?.success) {
      appendTranscript(`ℹ️ Could not auto-insert (${replaced?.reason || "unknown"}). You can copy from above.`);
    } else {
      appendTranscript(`✅ Inserted into ${replaced.where}.`);
    }
  } catch (err) {
    appendTranscript("❌ Rewrite error: " + err.message);
  }
}
