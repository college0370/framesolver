const video = document.getElementById("video");
const canvas = document.getElementById("compareCanvas");
const ctx = canvas.getContext("2d", { willReadFrequently: true });

const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const captureBtn = document.getElementById("captureBtn");
const clearBtn = document.getElementById("clearBtn");
const resetBtn = document.getElementById("resetBtn");
const popupCloseBtn = document.getElementById("popupCloseBtn");
const popupCopyBtn = document.getElementById("popupCopyBtn");
const historyList = document.getElementById("historyList");
const clearHistoryBtn = document.getElementById("clearHistoryBtn");

const statusEl = document.getElementById("status");
const detailEl = document.getElementById("statusDetail");
const answerEl = document.getElementById("answer");
const popupAnswerEl = document.getElementById("popupAnswer");
const popupExplanationEl = document.getElementById("popupExplanation");
const popup = document.getElementById("answerPopup");
const badge = document.getElementById("stateBadge");
const meterBar = document.getElementById("meterBar");
const placeholder = document.getElementById("cameraPlaceholder");
const scanLine = document.getElementById("scanLine");
const apiCountEl = document.getElementById("apiCount");
const skippedCountEl = document.getElementById("skippedCount");

const thresholdInput = document.getElementById("threshold");
const stableInput = document.getElementById("stableFrames");
const intervalInput = document.getElementById("interval");
const thresholdValue = document.getElementById("thresholdValue");
const stableValue = document.getElementById("stableFramesValue");
const intervalValue = document.getElementById("intervalValue");

let stream = null;
let raf = null;
let previous = null;
let baseline = null;
let candidate = null;
let changed = false;
let stableCount = 0;
let startupStableCount = 0;
let lastAnalysis = 0;
let busy = false;
let previousAnalyzedSignature = null;
let apiCount = 0;
let skippedCount = 0;
let lastPopupTimer = null;
let currentPopupText = "";
let history = loadHistory();

const DETECT_W = 160;
const DETECT_H = 120;

const cfg = {
  threshold: 2.2,
  stableFrames: 2,
  intervalMs: 1200
};

function setStatus(text, detail = "") {
  statusEl.textContent = text;
  detailEl.textContent = detail;
}

function setBadge(text, type) {
  badge.textContent = text;
  badge.className = `badge ${type}`;
}

function updateStats() {
  apiCountEl.textContent = apiCount;
  skippedCountEl.textContent = skippedCount;
}

function loadHistory() {
  try { return JSON.parse(localStorage.getItem("framesolve_history") || "[]"); }
  catch { return []; }
}

function saveHistory() {
  localStorage.setItem("framesolve_history", JSON.stringify(history.slice(0, 50)));
}

function renderHistory() {
  if (!history.length) {
    historyList.innerHTML = '<div class="history-empty">Previous questions and answers will appear here.</div>';
    return;
  }
  historyList.innerHTML = history.map((item, index) => `
    <article class="history-item">
      <div class="history-meta"><span>${escapeHtml(item.type || "OTHER")}</span><time>${escapeHtml(item.time || "")}</time></div>
      <div class="history-question">${escapeHtml(item.question || "Detected question")}</div>
      <div class="history-answer">${escapeHtml(item.answer || "")}</div>
      <div class="history-actions"><button data-copy-index="${index}">Copy</button><button data-view-index="${index}">View</button></div>
    </article>`).join("");
}

function escapeHtml(value) {
  return String(value || "").replace(/[&<>"]/g, ch => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[ch]));
}

function addHistory(answerText, type = "OTHER", questionText = "") {
  history.unshift({
    type,
    question: questionText || "Detected question",
    answer: answerText,
    time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
  });
  history = history.slice(0, 50);
  saveHistory();
  renderHistory();
}

function hidePopup() {
  popup.classList.remove("show");
  if (lastPopupTimer) clearTimeout(lastPopupTimer);
  lastPopupTimer = null;
}

function showPopup(answerText) {
  const parsed = parseAnswer(answerText);
  currentPopupText = parsed.answer || answerText.trim() || "No answer";
  popupAnswerEl.textContent = parsed.answer || answerText.trim() || "No answer";
  popupExplanationEl.textContent = parsed.explanation || "";
  popupExplanationEl.classList.toggle("hidden", !parsed.explanation);
  popup.classList.remove("show");
  requestAnimationFrame(() => popup.classList.add("show"));

  if (lastPopupTimer) clearTimeout(lastPopupTimer);
  lastPopupTimer = setTimeout(() => popup.classList.remove("show"), 15000);
}

function parseAnswer(text) {
  const normalized = String(text || "").replace(/\r/g, "");
  const typeMatch = normalized.match(/(?:\*\*)?TYPE(?:\*\*)?\s*:\s*([^\n]+)/i);
  const answerMatch = normalized.match(/(?:\*\*)?ANSWER(?:\*\*)?\s*:\s*([\s\S]*?)(?=\n\s*(?:\*\*)?EXPLANATION(?:\*\*)?\s*:|$)/i);
  const explanationMatch = normalized.match(/(?:\*\*)?EXPLANATION(?:\*\*)?\s*:\s*([\s\S]*)$/i);
  return {
    type: typeMatch ? typeMatch[1].trim().toUpperCase() : "OTHER",
    answer: answerMatch ? answerMatch[1].trim() : normalized.trim(),
    explanation: explanationMatch ? explanationMatch[1].trim() : ""
  };
}

function resetSession() {
  apiCount = 0;
  skippedCount = 0;
  previousAnalyzedSignature = null;
  updateStats();
  answerEl.textContent = "No answer yet.";
  answerEl.className = "answer empty";
  hidePopup();
  setStatus(stream ? "Watching" : "Ready", "Detection counters reset.");
}

function updateSettings() {
  cfg.threshold = Number(thresholdInput.value);
  cfg.stableFrames = Number(stableInput.value);
  cfg.intervalMs = Number(intervalInput.value) * 1000;
  thresholdValue.textContent = cfg.threshold;
  stableValue.textContent = cfg.stableFrames;
  intervalValue.textContent = Number(intervalInput.value);
}

thresholdInput.oninput = updateSettings;
stableInput.oninput = updateSettings;
intervalInput.oninput = updateSettings;
updateSettings();
updateStats();

clearBtn.onclick = () => {
  answerEl.textContent = "No answer yet.";
  answerEl.className = "answer empty";
  hidePopup();
};
resetBtn.onclick = resetSession;
popupCloseBtn.onclick = hidePopup;
popupCopyBtn.onclick = async () => {
  try { await navigator.clipboard.writeText(currentPopupText); popupCopyBtn.textContent = "Copied ✓"; setTimeout(() => popupCopyBtn.textContent = "Copy answer", 1200); } catch { popupCopyBtn.textContent = "Copy failed"; }
};
clearHistoryBtn.onclick = () => { history = []; saveHistory(); renderHistory(); };
historyList.addEventListener("click", async (event) => {
  const copy = event.target.closest("[data-copy-index]");
  const view = event.target.closest("[data-view-index]");
  if (copy) {
    const item = history[Number(copy.dataset.copyIndex)];
    if (item) { try { await navigator.clipboard.writeText(item.answer); copy.textContent = "Copied ✓"; setTimeout(() => copy.textContent = "Copy", 1000); } catch {} }
  }
  if (view) {
    const item = history[Number(view.dataset.viewIndex)];
    if (item) { answerEl.textContent = item.answer; answerEl.className = "answer"; showPopup(item.answer); }
  }
});
renderHistory();
startBtn.onclick = startCamera;
stopBtn.onclick = stopCamera;
captureBtn.onclick = () => analyzeCurrentFrame(true);

async function startCamera() {
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: 1280 },
        height: { ideal: 720 }
      },
      audio: false
    });

    video.srcObject = stream;
    await video.play();

    canvas.width = DETECT_W;
    canvas.height = DETECT_H;
    previous = null;
    baseline = null;
    candidate = null;
    changed = false;
    stableCount = 0;
    startupStableCount = 0;
    lastAnalysis = 0;
    previousAnalyzedSignature = null;

    startBtn.disabled = true;
    stopBtn.disabled = false;
    captureBtn.disabled = false;
    placeholder.classList.add("hidden");
    scanLine.classList.remove("hidden");
    hidePopup();

    setBadge("WATCHING", "live");
    setStatus("Watching", "Local detector is watching only the question/options area. No AI request yet.");
    loop();
  } catch (err) {
    setBadge("ERROR", "busy");
    setStatus("Camera unavailable", err.message || "Allow camera permission and try again.");
  }
}

function stopCamera() {
  if (raf) cancelAnimationFrame(raf);
  raf = null;
  if (stream) {
    stream.getTracks().forEach(track => track.stop());
    stream = null;
  }
  video.srcObject = null;
  startBtn.disabled = false;
  stopBtn.disabled = true;
  captureBtn.disabled = true;
  placeholder.classList.remove("hidden");
  scanLine.classList.add("hidden");
  previous = null;
  baseline = null;
  candidate = null;
  changed = false;
  stableCount = 0;
  startupStableCount = 0;
  hidePopup();
  setBadge("READY", "idle");
  setStatus("Stopped", "Camera monitoring is off.");
  meterBar.style.width = "0%";
}

function loop() {
  if (!stream) return;

  if (video.readyState >= 2) {
    ctx.drawImage(video, 0, 0, DETECT_W, DETECT_H);
    const current = new Uint8ClampedArray(ctx.getImageData(0, 0, DETECT_W, DETECT_H).data);

    if (!baseline) {
      if (previous) {
        const frameDiff = meanDifference(previous, current);
        if (frameDiff < 1.35) startupStableCount++;
        else startupStableCount = 0;
      }
      previous = current;

      if (startupStableCount >= 6 && !busy && Date.now() - lastAnalysis >= cfg.intervalMs) {
        baseline = current;
        startupStableCount = 0;
        setStatus("Question detected", "Analyzing the first stable question automatically…");
        analyzeCurrentFrame(false, visualSignature(current));
      }
    } else {
      const metrics = changeMetrics(baseline, current);
      const frameDiff = previous ? meanDifference(previous, current) : 0;

      // Localized text/number changes are the primary trigger. Broad changes
      // across most blocks are treated as camera shake and ignored.
      // Very small localized edits (a digit, character, punctuation mark,
      // or one word) can be only a few dozen pixels at detection resolution.
      // We therefore use an aligned residual metric rather than requiring a
      // large percentage of the whole screen to change.
      const aligned = alignedChangeMetrics(baseline, current);
      const tinyTextChange =
        aligned.residualMean >= cfg.threshold &&
        aligned.changedRatio >= 0.00055 &&
        aligned.changedBlocks >= 1 &&
        aligned.changedBlocks <= 45;

      const normalQuestionChange =
        aligned.residualMean >= Math.max(1.4, cfg.threshold * 0.72) &&
        aligned.changedRatio >= 0.0012 &&
        aligned.changedBlocks >= 2 &&
        aligned.changedBlocks <= 90;

      const meaningfulChange = tinyTextChange || normalQuestionChange;

      if (!changed && meaningfulChange) {
        changed = true;
        candidate = current;
        stableCount = 0;
        meterBar.style.width = "20%";
        setStatus("Question changed", "Waiting for the changed text/number/options to become stable…");
      }

      if (changed) {
        // Compare candidate and current: the new frame must stop moving before
        // we send it. This prevents camera shake from producing requests.
        const candidateDiff = candidate ? meanDifference(candidate, current) : 999;
        if (candidateDiff < 1.55 && frameDiff < 1.7) stableCount++;
        else stableCount = 0;

        candidate = current;
        meterBar.style.width = `${Math.min(100, (stableCount / cfg.stableFrames) * 100)}%`;

        if (stableCount >= cfg.stableFrames) {
          const signature = visualSignature(current);
          changed = false;
          stableCount = 0;
          candidate = null;
          baseline = current;
          meterBar.style.width = "0%";

          if (signature === previousAnalyzedSignature) {
            skippedCount++;
            updateStats();
            setStatus("Same question skipped", "No AI request — waiting for the next meaningful text change.");
          } else if (!busy && Date.now() - lastAnalysis >= cfg.intervalMs) {
            analyzeCurrentFrame(false, signature);
          } else {
            setStatus("New question ready", "AI request is already in progress; no duplicate request will be sent.");
          }
        }
      }

      previous = current;
    }
  }

  raf = requestAnimationFrame(loop);
}

function grayAt(data, x, y) {
  const i = (y * DETECT_W + x) * 4;
  return (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000;
}

function inQuestionRegion(x, y) {
  // Ignore the extreme camera edges and the bottom button/toolbar area.
  return x >= 8 && x <= 152 && y >= 10 && y <= 92;
}

function meanDifference(a, b) {
  let total = 0;
  let count = 0;
  for (let y = 10; y <= 92; y += 2) {
    for (let x = 8; x <= 152; x += 2) {
      const ag = grayAt(a, x, y);
      const bg = grayAt(b, x, y);
      total += Math.abs(ag - bg);
      count++;
    }
  }
  return total / count;
}

function changeMetrics(a, b) {
  let total = 0;
  let count = 0;
  let changedPixels = 0;
  let changedBlocks = 0;

  for (let by = 10; by < 92; by += 6) {
    for (let bx = 8; bx < 152; bx += 6) {
      let blockDiff = 0;
      let blockCount = 0;
      for (let y = by; y < Math.min(by + 6, 93); y++) {
        for (let x = bx; x < Math.min(bx + 6, 153); x++) {
          if (!inQuestionRegion(x, y)) continue;
          const d = Math.abs(grayAt(a, x, y) - grayAt(b, x, y));
          blockDiff += d;
          blockCount++;
          total += d;
          count++;
          if (d >= 15) changedPixels++;
        }
      }
      if (blockCount && blockDiff / blockCount >= 4.0) changedBlocks++;
    }
  }

  return {
    mean: count ? total / count : 0,
    changedRatio: count ? changedPixels / count : 0,
    changedBlocks
  };
}

function alignedChangeMetrics(a, b) {
  // Find the tiny camera translation that best aligns the current frame to
  // the last analyzed frame. This suppresses hand/table shake while preserving
  // local changes such as one digit or one character changing.
  let best = { score: Infinity, dx: 0, dy: 0 };
  for (let dy = -3; dy <= 3; dy++) {
    for (let dx = -3; dx <= 3; dx++) {
      let total = 0;
      let count = 0;
      for (let y = 14; y <= 88; y += 3) {
        for (let x = 12; x <= 148; x += 3) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 8 || xx > 152 || yy < 10 || yy > 92) continue;
          total += Math.abs(grayAt(a, x, y) - grayAt(b, xx, yy));
          count++;
        }
      }
      const score = count ? total / count : Infinity;
      if (score < best.score) best = { score, dx, dy };
    }
  }

  let residualTotal = 0;
  let residualCount = 0;
  let changedPixels = 0;
  let changedBlocks = 0;

  for (let by = 10; by < 92; by += 5) {
    for (let bx = 8; bx < 153; bx += 5) {
      let block = 0;
      let blockCount = 0;
      for (let y = by; y < Math.min(by + 5, 93); y++) {
        for (let x = bx; x < Math.min(bx + 5, 153); x++) {
          if (!inQuestionRegion(x, y)) continue;
          const xx = x + best.dx;
          const yy = y + best.dy;
          if (xx < 8 || xx > 152 || yy < 10 || yy > 92) continue;
          const d = Math.abs(grayAt(a, x, y) - grayAt(b, xx, yy));
          residualTotal += d;
          residualCount++;
          block += d;
          blockCount++;
          if (d >= 12) changedPixels++;
        }
      }
      if (blockCount && block / blockCount >= 3.0) changedBlocks++;
    }
  }

  return {
    residualMean: residualCount ? residualTotal / residualCount : 0,
    changedRatio: residualCount ? changedPixels / residualCount : 0,
    changedBlocks,
    dx: best.dx,
    dy: best.dy
  };
}

function visualSignature(data) {
  let signature = "";
  for (let y = 10; y <= 92; y += 5) {
    for (let x = 8; x <= 152; x += 5) {
      signature += Math.floor(grayAt(data, x, y) / 32).toString(16);
    }
  }
  return signature;
}

async function analyzeCurrentFrame(manual, signature = null) {
  if (busy || !stream) return;
  if (!manual && Date.now() - lastAnalysis < cfg.intervalMs) return;

  busy = true;
  lastAnalysis = Date.now();
  setBadge("ANALYZING", "busy");
  setStatus("Analyzing", "One AI request — reading the changed question…");

  try {
    const capture = document.createElement("canvas");
    // 960px is enough for typical phone-camera question text while keeping
    // upload size and vision latency down.
    const maxWidth = 1280;
    const scale = Math.min(1, maxWidth / video.videoWidth);
    capture.width = Math.round(video.videoWidth * scale);
    capture.height = Math.round(video.videoHeight * scale);

    const c = capture.getContext("2d");
    c.drawImage(video, 0, 0, capture.width, capture.height);
    const dataUrl = capture.toDataURL("image/jpeg", 0.82);
    const imageBase64 = dataUrl.split(",")[1];

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 22000);
    let response;
    try {
      response = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imageBase64, mimeType: "image/jpeg" }),
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeout);
    }

    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);

    const answerText = String(data.answer || "");
    const unreadable = /unable to read|cannot read|can't read|unreadable|not readable/i.test(answerText);
    if (unreadable && data.provider === "Groq") {
      setStatus("Reading again", "Groq could not confidently read the code; requesting the higher-quality fallback image analysis…");
      const retryController = new AbortController();
      const retryTimeout = setTimeout(() => retryController.abort(), 12000);
      let retryResponse;
      try {
        retryResponse = await fetch("/api/analyze", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ imageBase64, mimeType: "image/jpeg", forceFallback: true }),
          signal: retryController.signal
        });
      } finally {
        clearTimeout(retryTimeout);
      }
      const retryData = await retryResponse.json();
      if (retryResponse.ok && retryData.answer) {
        data.answer = retryData.answer;
        data.provider = retryData.provider || "Gemini fallback";
      }
    }

    const parsed = parseAnswer(data.answer);
    const answerForDisplay = parsed.answer || data.answer;
    answerEl.textContent = answerForDisplay;
    answerEl.className = "answer";
    showPopup(data.answer);
    addHistory(answerForDisplay, parsed.type, "Detected question — open the camera capture for the original text.");

    apiCount++;
    previousAnalyzedSignature = signature || visualSignature(new Uint8ClampedArray(ctx.getImageData(0, 0, DETECT_W, DETECT_H).data));
    updateStats();

    setBadge("ANSWER READY", "live");
    setStatus("Answer ready", "Popup shown. Local detector is watching for the next real question/text change.");
    meterBar.style.width = "0%";
  } catch (err) {
    setBadge("ERROR", "busy");
    const message = err?.name === "AbortError"
      ? "AI timed out. No repeated request was sent; waiting for the next question."
      : (err.message || "Try again.");
    setStatus("Analysis failed", message);
  } finally {
    busy = false;
  }
}
