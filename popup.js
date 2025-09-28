// Voice engine: accuracy upgrades only (no new commands)
// - process FINAL results only (reduces duplicates/garble)
// - n-best alternative selection (pick best hypothesis)
// - robust wake detection with fuzzy matching & tolerance control
// - 5s wake window, auto-timeout
// - optional hide (ignored) lines unless debugging

let listening = false;
let recognition;
let wakeActive = false;
let wakeTimer = null;

// ===== UI
const btn = document.getElementById("btnToggle");
const statusEl = document.getElementById("status");
const transcriptEl = document.getElementById("transcript");

// New: simple controls to help ASR
const langSel = document.getElementById("lang");
const wakeSensitivityEl = document.getElementById("wakeSensitivity");

// Show ignored lines? Set true to debug
const DEBUG_SHOW_IGNORED = false;

function setStatus(msg) { statusEl.textContent = msg; }
function appendTranscript(text) { transcriptEl.textContent += text + "\n"; }

function clearWakeTimer() {
  if (wakeTimer) { clearTimeout(wakeTimer); wakeTimer = null; }
}
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
  // common mis-hears we saw
  "he got", "hey cut", "lazy cut", "hey cap", "hey cad", "hey kit", "hey kate", "hey cats"
];

// very small edit-distance helper (Levenshtein, capped early)
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
    if (minRow > maxD) return maxD + 1; // early stop
  }
  return dp[n];
}

// sensitivity: 0=strict (exact/near exact), 1=default, 2=loose (allow more distance)
function wakeMatches(text, sensitivity = 1) {
  const lower = text.toLowerCase();
  const variants = BASE_WAKE_VARIANTS;
  let bestIdx = -1, bestLen = Infinity, bestMatch = null;

  // direct substring hit (fast path)
  for (const v of variants) {
    const idx = lower.indexOf(v);
    if (idx !== -1) {
      if (idx < bestIdx || bestIdx === -1) {
        bestIdx = idx; bestLen = v.length; bestMatch = v;
      }
    }
  }
  if (bestMatch) return { index: bestIdx, match: bestMatch };

  // fuzzy: look at first ~20 chars to catch wake near start
  const windowText = lower.slice(0, 40);
  const maxD = sensitivity === 0 ? 1 : sensitivity === 1 ? 2 : 3;
  for (const v of variants) {
    for (let i = 0; i <= Math.max(0, windowText.length - v.length); i++) {
      const cand = windowText.slice(i, i + v.length);
      if (editDistanceAtMost(cand, v, maxD) <= maxD) {
        return { index: i, match: v };
      }
    }
  }
  return null;
}

function stripAfterWake(text, sensitivity = 1) {
  const info = wakeMatches(text, sensitivity);
  if (!info) return null;
  return text.slice(info.index + info.match.length).trim();
}

// ===== AI Router (same behavior as your checkpoint)
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
        command: { type: "string", enum: ["open_tab", "scroll", "search_web", "click_ui"] },
        args: {
          type: "object",
          properties: {
            url: { type: "string" },                         // open_tab
            direction: { type: "string", enum: ["up", "down"] }, // scroll
            query: { type: "string" },                       // search_web
            text: { type: "string" }                         // click_ui
          },
          additionalProperties: false
        },
        confirmation: { type: "string", enum: ["none", "required"] }
      },
      required: ["command", "args", "confirmation"]
    };

    const session = await LanguageModel.create({
      output: { type: "text", languageCode: "en" }, // note: Chrome may still warn; functionality OK
      responseConstraint: { type: "json_schema", schema },
      monitor(m) {
        m.addEventListener("downloadprogress", (e) => {
          setStatus(`Downloading AI model… ${Math.round((e.loaded || 0) * 100)}%`);
        });
      }
    });

    const raw = await session.prompt([
      { role: "system",
        content:
          "You are Lazy Cat's command router.\n" +
          "Output ONLY valid JSON per schema. Exactly one command per request.\n" +
          "For open_tab: command='open_tab' and args.url must be a full https URL.\n" +
          "For scroll: command='scroll', args.direction must be 'up' or 'down'.\n" +
          "For search_web: command='search_web', args.query is the user's search terms.\n" +
          "For click_ui: command='click_ui', args.text is the visible label to click.\n" +
          "Never invent other fields. Never output any text outside the JSON."
      },
      { role: "user", content: commandText }
    ]);

    session.destroy?.();

    console.log("DEBUG raw result:", raw);
    let cleaned = String(raw).replace(/```json/gi, "").replace(/```/g, "").trim();

    let parsed;
    try { parsed = JSON.parse(cleaned); }
    catch { parsed = { command: "noop", args: {}, confirmation: "none", error: "Could not parse AI output" }; }

    appendTranscript("🤖 " + JSON.stringify(parsed, null, 2));

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

// ===== Speech Recognition (accuracy-focused)
function initRecognition() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    setStatus("SpeechRecognition not supported in this browser.");
    btn.disabled = true;
    return;
  }

  recognition = new SpeechRecognition();
  recognition.lang = (localStorage.getItem("lc_lang") || "en-US");
  recognition.continuous = true;
  recognition.interimResults = true;     // allow interim; we’ll use only finals
  recognition.maxAlternatives = 5;       // get n-best to choose from

  recognition.onstart = () => setStatus("Listening… say 'Hey Cat' or 'Lazy Cat'.");
  recognition.onerror = (e) => setStatus("Error: " + e.error);
  recognition.onend = () => {
    if (listening) recognition.start();
    else setStatus("Stopped.");
  };

  recognition.onresult = (event) => {
    // use the latest result block only
    const res = event.results[event.results.length - 1];
    if (!res) return;

    // Only act on final results to reduce noise/duplication
    if (!res.isFinal) return;

    // Pull alternatives (n-best) and pick best by wake-awareness / length
    const alts = [];
    for (let i = 0; i < res.length; i++) {
      const t = (res[i].transcript || "").trim();
      if (t) alts.push(t);
    }
    if (alts.length === 0) return;

    const sens = Number(localStorage.getItem("lc_wake_sens") ?? "1");

    // choose the first alt that contains a wake (strict → loose), else longest alt
    let chosen = null;
    for (const t of alts) {
      if (wakeMatches(t.toLowerCase(), sens)) { chosen = t; break; }
    }
    if (!chosen) {
      // pick the alt with the most characters (heuristic)
      chosen = alts.slice().sort((a, b) => b.length - a.length)[0];
    }

    const lower = chosen.toLowerCase();

    // Case A: this final contains a wake phrase → extract trailing command
    const afterWake = stripAfterWake(lower, sens);
    if (afterWake !== null) {
      if (afterWake) {
        appendTranscript("🐱 " + afterWake);
        aiInterpret(afterWake);
        wakeActive = false;
        clearWakeTimer();
        recognition.stop(); // one-shot cycle
      } else {
        setStatus("Wake word detected — waiting for your command…");
        wakeActive = true;
        armWakeTimeout();
      }
      return;
    }

    // Case B: no wake phrase here, but we are in wake window → treat as command
    if (wakeActive) {
      appendTranscript("🐱 " + chosen);
      aiInterpret(chosen);
      wakeActive = false;
      clearWakeTimer();
      recognition.stop(); // one-shot cycle
      return;
    }

    // Case C: ignore (unless debugging)
    if (DEBUG_SHOW_IGNORED) appendTranscript("(ignored) " + chosen);
    recognition.stop(); // reset session to avoid cumulative transcripts
  };
}

// UI wiring
btn.addEventListener("click", () => {
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

// persist language & sensitivity
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
