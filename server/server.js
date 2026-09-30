import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = Number(process.env.PORT || 8080);
const groqModel = process.env.GROQ_MODEL || "qwen/qwen3.8-27b";
const geminiModel = process.env.GEMINI_MODEL || "gemini-3.8-flash";

app.use(cors());
app.use(express.json({ limit: "8mb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "FrameSolve Web",
    version: "7.0-diagnostic",
    primary: { provider: "Groq", model: groqModel },
    fallback: { provider: "Gemini", model: geminiModel }
  });
});

const prompt = `
You are a fast visual question-answering assistant for the user's own non-proctored practice/mock material.

IMPORTANT: This image may contain a PROGRAMMING QUESTION or CODE shown on a phone/laptop screen.
Read ONLY the question shown in this exact captured frame. Do not rely on any previous question, previous answer, or outside conversation context. Before answering, make sure the answer corresponds to the question actually visible in this image.

For programming questions:
1. First mentally transcribe the visible question, constraints, input/output format, and code/text.
2. Preserve symbols such as (), {}, [], :, ;, <, >, =, ==, <=, >=, quotes, underscores, and indentation.
3. Then solve the problem.
4. If code is requested, return complete runnable Python 3 code, not pseudocode.
5. If the question asks for the output of code, return the exact output.

Return exactly:
TYPE: <MCQ | ENGLISH | NUMERICAL | CODING | OTHER>
QUESTION: <short transcription of the question>
OPTIONS: <for MCQ, list every visible option on separate lines; otherwise write NONE>
ANSWER: <direct answer or complete code>
EXPLANATION: <one short useful sentence>

Rules:
- MCQ: transcribe ALL visible options under OPTIONS, then give the correct option text and, if useful, its letter.
- English/fill-in-the-blank: give the exact word or phrase.
- Numerical/aptitude: give the final result with the essential calculation only.
- Python/programming: give the complete Python 3 solution when code is requested.
- SQL/CS theory: give the direct correct answer.
- This is a camera photo of a screen. Use the full visible question area, not just the center.
- The screen may contain watermarks, logos, timestamps, UI labels, or an email address. IGNORE those unrelated elements. They are not the question and must not cause a refusal or an error.
- For LTI-style aptitude/reasoning questions, read the problem statement, every statement/condition, and every answer option before solving.
- For coding questions, read the complete problem statement, constraints, input/output examples, and code text before solving.
- Do NOT say the image is unreadable merely because the text is small. Inspect the enhanced screen image carefully first.
- If a small portion genuinely cannot be read, state the specific missing portion and solve using all readable information.
- Only use 'Unable to read the question' when the main question itself truly cannot be recovered from the image.
`;


function dataUrl(imageBase64, mimeType) {
  return `data:${mimeType};base64,${imageBase64}`;
}

async function fetchWithTimeout(url, options, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function callGroq(imageBase64, mimeType) {
  if (!process.env.GROQ_API_KEY) throw Object.assign(new Error("GROQ_API_KEY is not configured"), { provider: "Groq", code: 0 });
  const started = Date.now();
  const response = await fetchWithTimeout(
    "https://api.groq.com/openai/v1/chat/completions",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.GROQ_API_KEY}`
      },
      body: JSON.stringify({
        model: groqModel,
        messages: [{
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: dataUrl(imageBase64, mimeType) } }
          ]
        }],
        temperature: 0,
        max_completion_tokens: 1100,
        reasoning_effort: "none",
        stream: false
      })
    },
    16000
  );
  const rawText = await response.text();
  let data = {};
  try { data = rawText ? JSON.parse(rawText) : {}; } catch {}
  const meta = {
    provider: "Groq",
    model: groqModel,
    httpStatus: response.status,
    ok: response.ok,
    elapsedMs: Date.now() - started,
    retryAfter: response.headers.get("retry-after"),
    remainingRequests: response.headers.get("x-ratelimit-remaining-requests"),
    remainingTokens: response.headers.get("x-ratelimit-remaining-tokens"),
    resetRequests: response.headers.get("x-ratelimit-reset-requests"),
    resetTokens: response.headers.get("x-ratelimit-reset-tokens"),
    errorType: data?.error?.type || null,
    errorMessage: data?.error?.message || null
  };
  if (!response.ok) {
    const error = new Error(data?.error?.message || `Groq HTTP ${response.status}`);
    Object.assign(error, meta);
    throw error;
  }
  const answer = data?.choices?.[0]?.message?.content?.trim();
  if (!answer) {
    const error = new Error("Groq returned HTTP 200 but no answer content");
    Object.assign(error, meta);
    throw error;
  }
  return { answer, meta };
}

async function callGemini(imageBase64, mimeType, mode = "NORMAL") {
  if (!process.env.GEMINI_API_KEY) throw Object.assign(new Error("GEMINI_API_KEY is not configured"), { provider: "Gemini", code: 0 });
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(geminiModel)}:generateContent?key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`;
  const started = Date.now();
  const response = await fetchWithTimeout(
    endpoint,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{
          role: "user",
          parts: [
            { text: prompt },
            { inline_data: { mime_type: mimeType, data: imageBase64 } }
          ]
        }],
        generationConfig: {
          temperature: 0,
          maxOutputTokens: 1200,
          thinkingConfig: { thinkingLevel: "low" }
        }
      })
    },
    mode === "CODING" ? 60000 : 9000
  );
  const rawText = await response.text();
  let data = {};
  try { data = rawText ? JSON.parse(rawText) : {}; } catch {}
  const meta = {
    provider: "Gemini",
    model: geminiModel,
    httpStatus: response.status,
    ok: response.ok,
    elapsedMs: Date.now() - started,
    errorStatus: data?.error?.status || null,
    errorCode: data?.error?.code || null,
    errorMessage: data?.error?.message || null,
    blockReason: data?.promptFeedback?.blockReason || null
  };
  if (!response.ok) {
    const error = new Error(data?.error?.message || `Gemini HTTP ${response.status}`);
    Object.assign(error, meta);
    throw error;
  }
  const answer = (data?.candidates?.[0]?.content?.parts || [])
    .map(part => part?.text || "")
    .join("")
    .trim();
  if (!answer) {
    const error = new Error(data?.promptFeedback?.blockReason ? `Gemini blocked the prompt: ${data.promptFeedback.blockReason}` : "Gemini returned HTTP 200 but no answer content");
    Object.assign(error, meta);
    throw error;
  }
  return { answer, meta };
}

function errorMeta(error, provider) {
  return {
    provider: error?.provider || provider,
    model: error?.model || (provider === "Groq" ? groqModel : geminiModel),
    httpStatus: error?.httpStatus || (error?.name === "AbortError" ? "TIMEOUT" : null),
    elapsedMs: error?.elapsedMs || null,
    retryAfter: error?.retryAfter || null,
    remainingRequests: error?.remainingRequests || null,
    remainingTokens: error?.remainingTokens || null,
    resetRequests: error?.resetRequests || null,
    resetTokens: error?.resetTokens || null,
    errorType: error?.errorType || null,
    errorStatus: error?.errorStatus || null,
    errorCode: error?.errorCode || null,
    errorMessage: error?.message || "Unknown error"
  };
}

function diagnosticSummary(meta) {
  return `${meta.provider}: HTTP ${meta.httpStatus ?? "?"} | ${meta.errorMessage || "OK"} | ${meta.elapsedMs ?? "?"}ms`;
}

app.post("/api/analyze", async (req, res) => {
  const { imageBase64, mimeType = "image/jpeg", forceFallback = false, mode = "NORMAL" } = req.body || {};
  if (!imageBase64) return res.status(400).json({ error: "imageBase64 is required" });

  const started = Date.now();
  const diagnostics = [];
  let groqError = "";
  if (!forceFallback) {
    try {
      const result = await callGroq(imageBase64, mimeType);
      diagnostics.push(result.meta);
      return res.json({ answer: result.answer, provider: "Groq", model: groqModel, elapsedMs: Date.now() - started, diagnostics });
    } catch (error) {
      const meta = errorMeta(error, "Groq");
      diagnostics.push(meta);
      groqError = meta.errorMessage;
      console.warn("Groq failed; trying Gemini fallback:", meta);
    }
  } else {
    groqError = "Groq skipped by client";
  }

  try {
    const result = await callGemini(imageBase64, mimeType, mode);
    diagnostics.push(result.meta);
    return res.json({ answer: result.answer, provider: "Gemini fallback", model: geminiModel, elapsedMs: Date.now() - started, diagnostics });
  } catch (error) {
    const meta = errorMeta(error, "Gemini");
    diagnostics.push(meta);
    const geminiError = meta.errorMessage;
    console.error("Both AI providers failed", { groqError, geminiError, diagnostics });
    return res.status(503).json({
      error: "Both AI providers failed. See diagnostics for the exact API error.",
      groq: groqError,
      gemini: geminiError,
      elapsedMs: Date.now() - started,
      diagnostics
    });
  }
});

app.post("/api/diagnose", async (req, res) => {
  const { imageBase64, mimeType = "image/jpeg" } = req.body || {};
  if (!imageBase64) return res.status(400).json({ error: "imageBase64 is required" });
  const imageBytesApprox = Math.round((imageBase64.length * 3) / 4);
  const started = Date.now();
  const diagnostics = [];

  try {
    const result = await callGroq(imageBase64, mimeType);
    diagnostics.push(result.meta);
    return res.json({
      ok: true,
      summary: "Groq accepted the image and returned a response.",
      imageBytesApprox,
      elapsedMs: Date.now() - started,
      diagnostics,
      rawAnswerPreview: result.answer.slice(0, 1200)
    });
  } catch (error) {
    diagnostics.push(errorMeta(error, "Groq"));
  }

  try {
    const result = await callGemini(imageBase64, mimeType, "NORMAL");
    diagnostics.push(result.meta);
    return res.json({
      ok: true,
      summary: "Groq failed, but Gemini accepted the same image and returned a response.",
      imageBytesApprox,
      elapsedMs: Date.now() - started,
      diagnostics,
      rawAnswerPreview: result.answer.slice(0, 1200)
    });
  } catch (error) {
    diagnostics.push(errorMeta(error, "Gemini"));
    return res.status(503).json({
      ok: false,
      summary: "Both provider tests failed.",
      imageBytesApprox,
      elapsedMs: Date.now() - started,
      diagnostics
    });
  }
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(port, "0.0.0.0", () => {
  console.log(`FrameSolve Web running on port ${port} with Groq primary + Gemini fallback`);
});
