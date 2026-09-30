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
const copyHistoryBtn = document.getElementById("copyHistoryBtn");
const clearHistoryBtn = document.getElementById("clearHistoryBtn");

const statusEl = document.getElementById("status");
const detailEl = document.getElementById("statusDetail");
const answerEl = document.getElementById("answer");
const popupAnswerEl = document.getElementById("popupAnswer");
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
let pendingCapture = null;
let pendingSignature = null;
let pendingQuestionVersion = 0;
let autoRetryUsedForVersion = -1;
let analysisVersion = 0;
let latestQuestionVersion = 0;
let motionReacquire = false;
let motionStableCount = 0;
let settleStartedAt = 0;
let settleLastChangeAt = 0;
let history = loadHistory();

const DETECT_W = 192;
const DETECT_H = 144;
const CAPTURE_MAX_W = 1600;
const CAPTURE_JPEG_QUALITY = 0.92;

const cfg = {
  threshold: 1.8,
  stableFrames: 3,
  intervalMs: 900
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
  if (copyHistoryBtn) copyHistoryBtn.disabled = !history.length;
}

function buildAllHistoryCopyText() {
  return history.slice().reverse().map((item, index) => {
    const number = item.number || index + 1;
    return buildHistoryCopyText({ ...item, number });
  }).join("\n\n--------------------------------\n\n");
}

function buildHistoryCopyText(item) {
  const options = Array.isArray(item.options) ? item.options : [];
  return [
    `Q${item.number || ""}`.trim(),
    `Question: ${item.question || ""}`,
    options.length ? `Options:\n${options.map((o,i)=>`${String.fromCharCode(65+i)}. ${o}`).join("\n")}` : "",
    `Solution: ${item.answer || ""}`,
    item.explanation ? `Explanation: ${item.explanation}` : ""
  ].filter(Boolean).join("\n\n");
}

function escapeHtml(value) {
  return String(value || "").replace(/[&<>"]/g, ch => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[ch]));
}

function normalizeQuestion(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^a-z0-9%().,+\-*/=<>? ]/g, "")
    .trim();
}

function addHistory(answerText, type = "OTHER", questionText = "", options = [], explanation = "") {
  const question = questionText || "Detected question";
  const key = normalizeQuestion(question);
  const existingIndex = key && key !== "detected question"
    ? history.findIndex(item => normalizeQuestion(item.question) === key)
    : -1;
  const item = {
    type,
    question,
    options: Array.isArray(options) ? options : [],
    answer: answerText,
    explanation: explanation || "",
    time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
  };
  if (existingIndex >= 0) {
    history.splice(existingIndex, 1);
  }
  history.unshift(item);
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
  popup.classList.remove("show");
  requestAnimationFrame(() => popup.classList.add("show"));

  if (lastPopupTimer) clearTimeout(lastPopupTimer);
  lastPopupTimer = setTimeout(() => popup.classList.remove("show"), 15000);
}

function parseAnswer(text) {
  const normalized = String(text || "").replace(/\r/g, "");
  const typeMatch = normalized.match(/(?:\*\*)?TYPE(?:\*\*)?\s*:\s*([^\n]+)/i);
  const questionMatch = normalized.match(/(?:\*\*)?QUESTION(?:\*\*)?\s*:\s*([\s\S]*?)(?=\n\s*(?:\*\*)?ANSWER(?:\*\*)?\s*:|$)/i);
  const optionsMatch = normalized.match(/(?:\*\*)?OPTIONS(?:\*\*)?\s*:\s*([\s\S]*?)(?=\n\s*(?:\*\*)?ANSWER(?:\*\*)?\s*:|$)/i);
  const answerMatch = normalized.match(/(?:\*\*)?ANSWER(?:\*\*)?\s*:\s*([\s\S]*?)(?=\n\s*(?:\*\*)?EXPLANATION(?:\*\*)?\s*:|$)/i);
  const explanationMatch = normalized.match(/(?:\*\*)?EXPLANATION(?:\*\*)?\s*:\s*([\s\S]*)$/i);
  const optionsRaw = optionsMatch ? optionsMatch[1].trim() : "";
  const options = optionsRaw && !/^NONE$/i.test(optionsRaw)
    ? optionsRaw.split(/\n+/).map(x => x.replace(/^\s*(?:[A-D][.)]|[-•])\s*/, "").trim()).filter(Boolean)
    : [];
  return {
    type: typeMatch ? typeMatch[1].trim().toUpperCase() : "OTHER",
    question: questionMatch ? questionMatch[1].trim() : "",
    options,
    answer: answerMatch ? answerMatch[1].trim() : normalized.trim(),
    explanation: explanationMatch ? explanationMatch[1].trim() : ""
  };
}

function resetSession() {
  apiCount = 0;
  skippedCount = 0;
  previousAnalyzedSignature = null;
  pendingCapture = null;
  pendingSignature = null;
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
copyHistoryBtn.onclick = async () => {
  if (!history.length) return;
  try {
    await navigator.clipboard.writeText(buildAllHistoryCopyText());
    copyHistoryBtn.textContent = "Copied ✓";
    setTimeout(() => copyHistoryBtn.textContent = "Copy all history", 1200);
  } catch {
    copyHistoryBtn.textContent = "Copy failed";
    setTimeout(() => copyHistoryBtn.textContent = "Copy all history", 1200);
  }
};
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
    pendingCapture = null;
    pendingSignature = null;
    latestQuestionVersion = 0;
    motionReacquire = false;
    motionStableCount = 0;

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
    if (questionVersionAtStart !== latestQuestionVersion && !manual) {
      setStatus("New question ready", "Previous request ended late; the newer question remains queued.");
      return;
    }
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
  pendingCapture = null;
  pendingSignature = null;
  latestQuestionVersion++;
  motionReacquire = false;
  motionStableCount = 0;
  settleStartedAt = 0;
  settleLastChangeAt = 0;
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
        analyzeCapturedFrame(captureCurrentFrame(), false, visualSignature(current));
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
        aligned.changedRatio >= 0.00022 &&
        aligned.changedBlocks >= 1 &&
        aligned.changedBlocks <= 70;

      const normalQuestionChange =
        aligned.residualMean >= Math.max(1.15, cfg.threshold * 0.65) &&
        aligned.changedRatio >= 0.00065 &&
        aligned.changedBlocks >= 1 &&
        aligned.changedBlocks <= 130;

      const meaningfulChange = tinyTextChange || normalQuestionChange;

      // If the phone was moved, the whole frame can change and the normal
      // localized detector intentionally ignores that broad motion. After the
      // camera settles, compare the new stable frame with the last analyzed
      // frame. If the scene/question is actually different, treat it as a
      // new question. This prevents the old answer from surviving a phone move.
      const broadMotion = frameDiff >= 5.5 || aligned.residualMean >= 5.5;
      if (broadMotion && !changed) {
        motionReacquire = true;
        motionStableCount = 0;
      }
      if (motionReacquire && !changed) {
        if (frameDiff < 1.55 && aligned.residualMean < 2.2) motionStableCount++;
        else motionStableCount = 0;
        if (motionStableCount >= 6) {
          const settledDifference = aligned.residualMean;
          const settledSignature = visualSignature(current);
          motionReacquire = false;
          motionStableCount = 0;
          if (settledDifference >= 2.0 && settledSignature !== previousAnalyzedSignature) {
            changed = true;
            latestQuestionVersion++;
            hidePopup();
            answerEl.textContent = "New question detected…";
            answerEl.className = "answer empty";
            candidate = current;
            stableCount = 0;
            meterBar.style.width = "20%";
            setStatus("Question changed", "Phone moved and settled — checking the new question before sending it.");
          }
        }
      }

      if (!changed && meaningfulChange) {
        latestQuestionVersion++;
        changed = true;
        // A genuinely new question has appeared. Never leave the previous
        // answer visible while the new question is being analyzed.
        hidePopup();
        answerEl.textContent = "Waiting for the new question…";
        answerEl.className = "answer empty";
        candidate = current;
        stableCount = 0;
        meterBar.style.width = "20%";
        setStatus("Question changed", "Waiting for the changed text/number/options to become stable…");
      }

      if (changed) {
        // IMPORTANT: once a meaningful question change is detected, do not
        // require perfectly identical frames. Phone-camera screens naturally
        // have tiny brightness/pixel fluctuations, which previously caused
        // the automatic pipeline to remain stuck on "waiting for stability".
        // We now use a short settle window with a hard maximum.
        if (!settleStartedAt) {
          settleStartedAt = Date.now();
          settleLastChangeAt = Date.now();
        }

        const candidateDiff = candidate ? meanDifference(candidate, current) : 999;
        if (candidateDiff >= 1.7 || frameDiff >= 2.0) {
          settleLastChangeAt = Date.now();
          stableCount = 0;
        } else {
          stableCount++;
        }
        candidate = current;

        const quietFor = Date.now() - settleLastChangeAt;
        const totalSettle = Date.now() - settleStartedAt;
        const enoughQuiet = quietFor >= 450;
        const hardSettle = totalSettle >= 1400;
        const enoughFrames = stableCount >= 2;
        meterBar.style.width = `${Math.min(100, Math.max(5, (quietFor / 700) * 100))}%`;

        // Capture automatically as soon as the frame is reasonably settled,
        // or at 1.4s latest. This removes the gap where the UI detected the
        // question but never dispatched an automatic request.
        if ((enoughQuiet && enoughFrames) || hardSettle) {
          const signature = visualSignature(current);
          const capture = captureCurrentFrame();
          changed = false;
          stableCount = 0;
          candidate = null;
          settleStartedAt = 0;
          settleLastChangeAt = 0;
          baseline = current;
          meterBar.style.width = "0%";

          if (signature === previousAnalyzedSignature) {
            skippedCount++;
            updateStats();
            setStatus("Same question skipped", "No AI request — waiting for the next meaningful text change.");
          } else {
            // Always queue a detected question if another request is busy.
            // The newest stable frame is preserved and dispatched when the
            // current request finishes.
            pendingCapture = capture;
            pendingSignature = signature;
            if (!busy && Date.now() - lastAnalysis >= cfg.intervalMs) {
              const nextCapture = pendingCapture;
              const nextSignature = pendingSignature;
              pendingCapture = null;
              pendingSignature = null;
              analyzeCapturedFrame(nextCapture, false, nextSignature);
            } else {
              setStatus("Question queued", "New question captured automatically; it will be analyzed as soon as the current request finishes.");
            }
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
  return x >= 10 && x <= 182 && y >= 12 && y <= 112;
}

function meanDifference(a, b) {
  let total = 0;
  let count = 0;
  for (let y = 12; y <= 112; y += 2) {
    for (let x = 10; x <= 182; x += 2) {
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

  for (let by = 12; by < 112; by += 6) {
    for (let bx = 10; bx < 182; bx += 6) {
      let blockDiff = 0;
      let blockCount = 0;
      for (let y = by; y < Math.min(by + 6, 113); y++) {
        for (let x = bx; x < Math.min(bx + 6, 183); x++) {
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
      for (let y = 16; y <= 108; y += 3) {
        for (let x = 14; x <= 178; x += 3) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 10 || xx > 182 || yy < 12 || yy > 112) continue;
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

  for (let by = 12; by < 112; by += 5) {
    for (let bx = 10; bx < 183; bx += 5) {
      let block = 0;
      let blockCount = 0;
      for (let y = by; y < Math.min(by + 5, 113); y++) {
        for (let x = bx; x < Math.min(bx + 5, 183); x++) {
          if (!inQuestionRegion(x, y)) continue;
          const xx = x + best.dx;
          const yy = y + best.dy;
          if (xx < 10 || xx > 182 || yy < 12 || yy > 112) continue;
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
  for (let y = 12; y <= 112; y += 5) {
    for (let x = 10; x <= 182; x += 5) {
      signature += Math.floor(grayAt(data, x, y) / 32).toString(16);
    }
  }
  return signature;
}

function captureCurrentFrame() {
  const sourceW = video.videoWidth || 1280;
  const sourceH = video.videoHeight || 720;
  const maxWidth = CAPTURE_MAX_W;
  const scale = Math.min(1, maxWidth / sourceW);
  const outW = Math.max(1, Math.round(sourceW * scale));
  const outH = Math.max(1, Math.round(sourceH * scale));

  // Keep the full question/options area but remove only the extreme bottom
  // browser/camera controls that cannot contain the question. This gives the
  // vision model more pixels per character without losing LTI-style layouts.
  const cropTop = Math.round(outH * 0.01);
  const cropBottom = Math.round(outH * 0.94);
  const cropH = Math.max(1, cropBottom - cropTop);

  const capture = document.createElement("canvas");
  capture.width = outW;
  capture.height = cropH;
  const c = capture.getContext("2d", { alpha: false });
  c.imageSmoothingEnabled = true;
  c.imageSmoothingQuality = "high";
  c.drawImage(video, 0, cropTop / scale, sourceW, cropH / scale, 0, 0, outW, cropH);

  // Screen text benefits from mild contrast/sharpening. Do not destroy the
  // original colors; the model still receives a natural-looking image.
  try {
    const image = c.getImageData(0, 0, capture.width, capture.height);
    const px = image.data;
    for (let i = 0; i < px.length; i += 4) {
      const r = px[i], g = px[i + 1], b = px[i + 2];
      const gray = 0.299 * r + 0.587 * g + 0.114 * b;
      const contrast = 1.18;
      const offset = 128 * (1 - contrast);
      px[i] = Math.max(0, Math.min(255, r * contrast + offset));
      px[i + 1] = Math.max(0, Math.min(255, g * contrast + offset));
      px[i + 2] = Math.max(0, Math.min(255, b * contrast + offset));
      // Suppress faint blue/green cast from screen glare while preserving text.
      if (gray > 180 && b > r * 1.12 && g > r * 1.04) {
        const neutral = Math.round((r + g + b) / 3);
        px[i] = neutral; px[i + 1] = neutral; px[i + 2] = neutral;
      }
    }
    c.putImageData(image, 0, 0);
  } catch {}

  const dataUrl = capture.toDataURL("image/jpeg", CAPTURE_JPEG_QUALITY);
  return { dataUrl, imageBase64: dataUrl.split(",")[1] };
}

async function analyzeCurrentFrame(manual, signature = null) {
  if (!stream || busy) return;
  if (!manual && Date.now() - lastAnalysis < cfg.intervalMs) return;
  analyzeCapturedFrame(captureCurrentFrame(), manual, signature);
}

async function analyzeCapturedFrame(capture, manual, signature = null) {
  const questionVersionAtStart = latestQuestionVersion;
  if (!stream) return;
  if (!manual && busy) {
    pendingCapture = capture;
    pendingSignature = signature;
    return;
  }
  if (!manual && Date.now() - lastAnalysis < cfg.intervalMs) {
    pendingCapture = capture;
    pendingSignature = signature;
    return;
  }

  busy = true;
  const thisAnalysisVersion = ++analysisVersion;
  lastAnalysis = Date.now();
  setBadge("ANALYZING", "busy");
  setStatus("Analyzing", "Reading the captured question carefully…");

  try {
    const imageBase64 = capture.imageBase64;
    const controller = new AbortController();
    // Normal questions get up to 32 seconds because correctness is now the
    // priority. Coding can use the longer 95-second window.
    const clientTimeoutMs = 42000;
    const timeout = setTimeout(() => controller.abort(), clientTimeoutMs);
    let response;
    try {
      response = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imageBase64, mimeType: "image/jpeg", mode: "AUTO" }),
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeout);
    }

    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);

    // Never let a late response for an older question overwrite a newer one.
    if (!manual && questionVersionAtStart !== latestQuestionVersion) {
      setStatus("New question ready", "Discarded the older response; the newest captured question remains queued.");
      return;
    }

    const answerText = String(data.answer || "");
    const parsed = parseAnswer(answerText);
    const answerForDisplay = parsed.answer || answerText;

    answerEl.textContent = answerForDisplay;
    answerEl.className = "answer";
    showPopup(answerForDisplay);
    addHistory(answerForDisplay, parsed.type, parsed.question || "Detected question", parsed.options, parsed.explanation);

    apiCount++;
    previousAnalyzedSignature = signature || null;
    updateStats();

    setBadge("ANSWER READY", "live");
    setStatus("Answer ready", `Verified through ${data.provider || "AI"}. Watching for the next meaningful question/text change.`);
    meterBar.style.width = "0%";
  } catch (err) {
    // A new question may have appeared while the previous one was processing.
    // Do not surface a stale error over the new question; queue processing is
    // handled in finally below.
    if (!manual && questionVersionAtStart !== latestQuestionVersion) {
      setStatus("New question ready", "The previous request ended late; the newer question is being processed.");
      return;
    }

    hidePopup();
    setBadge("ERROR", "busy");
    const message = err?.name === "AbortError"
      ? "AI request reached the response limit without a reliable answer."
      : (err.message || "Try again.");
    setStatus("Analysis failed", message);
  } finally {
    busy = false;

    // Immediately process the newest stable question. Do not leave the UI
    // waiting for a manual Analyze Now click.
    if (pendingCapture && pendingSignature && pendingSignature !== previousAnalyzedSignature && stream) {
      const nextCapture = pendingCapture;
      const nextSignature = pendingSignature;
      pendingCapture = null;
      pendingSignature = null;
      hidePopup();
      answerEl.textContent = "Analyzing the latest question…";
      answerEl.className = "answer empty";
      setTimeout(() => {
        if (stream && !busy) analyzeCapturedFrame(nextCapture, false, nextSignature);
      }, 50);
    }
  }
}
