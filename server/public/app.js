const video = document.getElementById("video");
const canvas = document.getElementById("compareCanvas");
const ctx = canvas.getContext("2d", { willReadFrequently: true });

const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const captureBtn = document.getElementById("captureBtn");
const clearBtn = document.getElementById("clearBtn");
const resetBtn = document.getElementById("resetBtn");
const popupCloseBtn = document.getElementById("popupCloseBtn");

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
let changed = false;
let stableCount = 0;
let startupStableCount = 0;
let lastAnalysis = 0;
let busy = false;
let previousAnalyzedSignature = null;
let apiCount = 0;
let skippedCount = 0;
let lastPopupTimer = null;

const DETECT_W = 160;
const DETECT_H = 120;

const cfg = {
  threshold: 7.0,
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

function hidePopup() {
  popup.classList.remove("show");
  if (lastPopupTimer) clearTimeout(lastPopupTimer);
  lastPopupTimer = null;
}

function showPopup(answerText) {
  const parsed = parseAnswer(answerText);
  popupAnswerEl.textContent = parsed.answer || answerText.trim() || "No answer";
  popupExplanationEl.textContent = parsed.explanation || "";
  popupExplanationEl.classList.toggle("hidden", !parsed.explanation);
  popup.classList.remove("show");
  requestAnimationFrame(() => popup.classList.add("show"));

  // Keep it visible long enough to read. It is still dismissible manually.
  if (lastPopupTimer) clearTimeout(lastPopupTimer);
  lastPopupTimer = setTimeout(() => popup.classList.remove("show"), 18000);
}

function parseAnswer(text) {
  const normalized = String(text || "").replace(/\r/g, "");
  const answerMatch = normalized.match(/(?:\*\*)?ANSWER(?:\*\*)?\s*:\s*([\s\S]*?)(?=\n\s*(?:\*\*)?EXPLANATION(?:\*\*)?\s*:|$)/i);
  const explanationMatch = normalized.match(/(?:\*\*)?EXPLANATION(?:\*\*)?\s*:\s*([\s\S]*)$/i);

  return {
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
    setStatus("Watching", "Watching for text, number, option, and blank changes automatically.");

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
        if (frameDiff < 1.8) startupStableCount++;
        else startupStableCount = 0;
      }
      previous = current;

      // Analyze the first stable screen automatically.
      if (startupStableCount >= 4 && !busy && Date.now() - lastAnalysis >= cfg.intervalMs) {
        baseline = current;
        startupStableCount = 0;
        setStatus("Question detected", "Analyzing the stable frame automatically…");
        analyzeCurrentFrame(false, visualSignature(current));
      }
    } else {
      const metrics = changeMetrics(baseline, current);
      const frameDiff = previous ? meanDifference(previous, current) : 0;

      // Trigger on either an obvious global change OR a localized text/number
      // change. This is important for one-character changes and fill-in-the-blank
      // questions where only a small part of the screen changes.
      const meaningfulChange =
        metrics.mean >= cfg.threshold ||
        metrics.changedRatio >= 0.010 ||
        metrics.changedBlocks >= 2;

      if (!changed && meaningfulChange) {
        changed = true;
        stableCount = 0;
        meterBar.style.width = "20%";
        setStatus("Change detected", "Checking for a new question, option, number, or blank…");
      }

      if (changed) {
        // A low consecutive-frame difference means the changed screen has settled.
        if (frameDiff < 1.9) stableCount++;
        else stableCount = 0;

        meterBar.style.width = `${Math.min(100, (stableCount / cfg.stableFrames) * 100)}%`;

        if (stableCount >= cfg.stableFrames) {
          const signature = visualSignature(current);

          if (!busy && Date.now() - lastAnalysis >= cfg.intervalMs) {
            changed = false;
            stableCount = 0;

            if (signature === previousAnalyzedSignature) {
              skippedCount++;
              updateStats();
              baseline = current;
              setStatus("Duplicate skipped", "Waiting for the next meaningful change…");
            } else {
              baseline = current;
              analyzeCurrentFrame(false, signature);
            }
          } else {
            setStatus("New question ready", "Waiting briefly for the AI request slot…");
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

function meanDifference(a, b) {
  let total = 0;
  let count = 0;

  for (let y = 0; y < DETECT_H; y += 2) {
    // Question/options tend to be in the upper/middle area. Still sample the
    // whole frame so scrolling and layout changes are caught.
    const weight = y < 92 ? 1.35 : 0.75;
    for (let x = 0; x < DETECT_W; x += 2) {
      const ag = grayAt(a, x, y);
      const bg = grayAt(b, x, y);
      total += Math.abs(ag - bg) * weight;
      count += weight;
    }
  }
  return total / count;
}

function changeMetrics(a, b) {
  let total = 0;
  let count = 0;
  let changedPixels = 0;
  let changedBlocks = 0;

  // Block comparison catches localized text changes that barely move the
  // frame-wide mean difference.
  for (let by = 0; by < DETECT_H; by += 8) {
    for (let bx = 0; bx < DETECT_W; bx += 8) {
      let blockDiff = 0;
      let blockCount = 0;

      for (let y = by; y < Math.min(by + 8, DETECT_H); y += 1) {
        for (let x = bx; x < Math.min(bx + 8, DETECT_W); x += 1) {
          const d = Math.abs(grayAt(a, x, y) - grayAt(b, x, y));
          blockDiff += d;
          blockCount++;
          total += d;
          count++;
          if (d >= 18) changedPixels++;
        }
      }

      if (blockDiff / blockCount >= 5.5) changedBlocks++;
    }
  }

  return {
    mean: total / count,
    changedRatio: changedPixels / count,
    changedBlocks
  };
}

function visualSignature(data) {
  let signature = "";
  for (let y = 0; y < DETECT_H; y += 5) {
    for (let x = 0; x < DETECT_W; x += 5) {
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
  setStatus("Analyzing", "Reading the changed question and finding the direct answer…");

  try {
    const capture = document.createElement("canvas");
    const maxWidth = 1024;
    const scale = Math.min(1, maxWidth / video.videoWidth);

    capture.width = Math.round(video.videoWidth * scale);
    capture.height = Math.round(video.videoHeight * scale);

    const c = capture.getContext("2d");
    c.drawImage(video, 0, 0, capture.width, capture.height);

    const dataUrl = capture.toDataURL("image/jpeg", 0.68);
    const imageBase64 = dataUrl.split(",")[1];

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 14000);
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

    answerEl.textContent = data.answer;
    answerEl.className = "answer";
    showPopup(data.answer);

    apiCount++;
    previousAnalyzedSignature = signature || visualSignature(new Uint8ClampedArray(ctx.getImageData(0, 0, DETECT_W, DETECT_H).data));
    updateStats();

    setBadge("ANSWER READY", "live");
    setStatus("Answer ready", "Popup shown. Watching for the next text/number/option change.");
    meterBar.style.width = "0%";
  } catch (err) {
    setBadge("ERROR", "busy");
    const message = err?.name === "AbortError" ? "AI took too long. Waiting for the next stable frame." : (err.message || "Try again.");
    setStatus("Analysis failed", message);
  } finally {
    busy = false;
  }
}
