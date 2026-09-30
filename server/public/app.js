const video = document.getElementById("video");
const canvas = document.getElementById("compareCanvas");
const ctx = canvas.getContext("2d", { willReadFrequently: true });

const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const captureBtn = document.getElementById("captureBtn");
const clearBtn = document.getElementById("clearBtn");
const resetBtn = document.getElementById("resetBtn");

const statusEl = document.getElementById("status");
const detailEl = document.getElementById("statusDetail");
const answerEl = document.getElementById("answer");
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

const cfg = {
  threshold: 18,
  stableFrames: 3,
  intervalMs: 3500
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

function resetSession() {
  apiCount = 0;
  skippedCount = 0;
  previousAnalyzedSignature = null;
  updateStats();
  answerEl.textContent = "No answer yet.";
  answerEl.className = "answer empty";
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
};
resetBtn.onclick = resetSession;
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

    canvas.width = 64;
    canvas.height = 64;

    previous = null;
    changed = false;
    stableCount = 0;
    lastAnalysis = 0;
    previousAnalyzedSignature = null;

    startBtn.disabled = true;
    stopBtn.disabled = false;
    captureBtn.disabled = false;
    placeholder.classList.add("hidden");
    scanLine.classList.remove("hidden");

    setBadge("WATCHING", "live");
    setStatus("Watching", "Only meaningful, stable question changes are sent to the AI.");

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

  setBadge("READY", "idle");
  setStatus("Stopped", "Camera monitoring is off.");
  meterBar.style.width = "0%";
}

function loop() {
  if (!stream) return;

  // Sample the camera continuously. We intentionally do not stop sampling
  // while Gemini is busy, so a new question that appears during an analysis
  // is not lost.
  if (video.readyState >= 2) {
    ctx.drawImage(video, 0, 0, 64, 64);
    const data = ctx.getImageData(0, 0, 64, 64).data;
    const current = new Uint8ClampedArray(data);

    if (!baseline) {
      // The question may already be visible when the camera starts.
      // Wait for a few stable samples, then analyze it automatically.
      if (previous) {
        const frameDiff = meanDifference(previous, current);
        if (frameDiff < 5) startupStableCount++;
        else startupStableCount = 0;
      }

      previous = current;
      if (startupStableCount >= 8 && !busy && Date.now() - lastAnalysis >= cfg.intervalMs) {
        baseline = current;
        startupStableCount = 0;
        setStatus("Question detected", "Analyzing the initial stable frame…");
        analyzeCurrentFrame(false, visualSignature(data));
      }
    } else {
      // Compare against the last analyzed frame, not only the immediately
      // previous camera frame. This catches gradual scrolling/transition
      // changes that would otherwise never exceed the threshold in one frame.
      const diffFromBaseline = meanDifference(baseline, current);
      const frameDiff = previous ? meanDifference(previous, current) : 0;

      if (!changed && diffFromBaseline >= cfg.threshold) {
        changed = true;
        stableCount = 0;
        meterBar.style.width = "20%";
        setStatus("New visual change", "Waiting for the new question to stabilize…");
      }

      if (changed) {
        // A low frame-to-frame difference means the new screen has settled.
        if (frameDiff < 5) stableCount++;
        else stableCount = 0;

        meterBar.style.width =
          `${Math.min(100, (stableCount / cfg.stableFrames) * 100)}%`;

        if (stableCount >= cfg.stableFrames) {
          changed = false;
          stableCount = 0;

          if (Date.now() - lastAnalysis >= cfg.intervalMs) {
            const signature = visualSignature(data);
            if (signature === previousAnalyzedSignature) {
              skippedCount++;
              updateStats();
              setStatus("Duplicate frame skipped", "No new question detected.");
            } else if (!busy) {
              // Lock this frame as the new baseline before the network call.
              // This lets the detector keep watching while Gemini responds.
              baseline = current;
              analyzeCurrentFrame(false, signature);
            }
          }
        }
      }

      // If there is no active change, keep the last analyzed frame as the
      // baseline. Do not overwrite it every frame.
    }

    previous = current;
  }

  raf = requestAnimationFrame(loop);
}
function meanDifference(a, b) {
  let total = 0;
  for (let i = 0; i < a.length; i += 4) {
    const ag = (a[i] * 299 + a[i + 1] * 587 + a[i + 2] * 114) / 1000;
    const bg = (b[i] * 299 + b[i + 1] * 587 + b[i + 2] * 114) / 1000;
    total += Math.abs(ag - bg);
  }
  return total / (a.length / 4);
}

// Small perceptual signature: helps prevent sending the same question twice.
function visualSignature(data) {
  let signature = "";
  for (let i = 0; i < data.length; i += 16) {
    const gray = (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000;
    signature += Math.floor(gray / 32).toString(16);
  }
  return signature;
}

async function analyzeCurrentFrame(manual, signature = null) {
  if (busy || !stream) return;
  if (!manual && Date.now() - lastAnalysis < cfg.intervalMs) return;

  busy = true;
  lastAnalysis = Date.now();
  setBadge("ANALYZING", "busy");
  setStatus("Analyzing", "Sending one stabilized question image to Gemini…");

  try {
    const capture = document.createElement("canvas");
    const maxWidth = 1024;
    const scale = Math.min(1, maxWidth / video.videoWidth);

    capture.width = Math.round(video.videoWidth * scale);
    capture.height = Math.round(video.videoHeight * scale);

    const c = capture.getContext("2d");
    c.drawImage(video, 0, 0, capture.width, capture.height);

    // JPEG keeps the request small while preserving normal question text.
    const dataUrl = capture.toDataURL("image/jpeg", 0.70);
    const imageBase64 = dataUrl.split(",")[1];

    const response = await fetch("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ imageBase64, mimeType: "image/jpeg" })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || `HTTP ${response.status}`);
    }

    answerEl.textContent = data.answer;
    answerEl.className = "answer";

    apiCount++;
    previousAnalyzedSignature = signature || visualSignature(ctx.getImageData(0, 0, 64, 64).data);
    updateStats();

    setBadge("ANSWER READY", "live");
    setStatus("Answer ready", "Waiting for the next meaningful question/frame.");
    meterBar.style.width = "0%";
  } catch (err) {
    setBadge("ERROR", "busy");
    setStatus("Analysis failed", err.message || "Try again.");
  } finally {
    busy = false;
  }
}
