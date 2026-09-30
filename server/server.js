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
    version: "6.2.0",
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
  if (!process.env.GROQ_API_KEY) throw new Error("GROQ_API_KEY is not configured");
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
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error?.message || `Groq HTTP ${response.status}`);
  const answer = data?.choices?.[0]?.message?.content?.trim();
  if (!answer) throw new Error("Groq returned no answer");
  return answer;
}

async function callGemini(imageBase64, mimeType, mode = "NORMAL") {
  if (!process.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is not configured");
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(geminiModel)}:generateContent?key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`;
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
    mode === "CODING" ? 60000 : 11000
  );
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error?.message || `Gemini HTTP ${response.status}`);
  const answer = (data?.candidates?.[0]?.content?.parts || [])
    .map(part => part?.text || "")
    .join("")
    .trim();
  if (!answer) throw new Error("Gemini returned no answer");
  return answer;
}

app.post("/api/analyze", async (req, res) => {
  const { imageBase64, mimeType = "image/jpeg", forceFallback = false, mode = "NORMAL" } = req.body || {};
  if (!imageBase64) return res.status(400).json({ error: "imageBase64 is required" });

  const started = Date.now();
  let groqError = "";
  if (!forceFallback) {
    try {
      const answer = await callGroq(imageBase64, mimeType);
      return res.json({ answer, provider: "Groq", model: groqModel, elapsedMs: Date.now() - started });
    } catch (error) {
      groqError = error?.message || "Groq failed";
      console.warn("Groq failed; trying Gemini fallback:", groqError);
    }
  } else {
    groqError = "Groq unreadable response; forced Gemini fallback";
  }

  try {
    const answer = await callGemini(imageBase64, mimeType, mode);
    return res.json({
      answer,
      provider: "Gemini fallback",
      model: geminiModel,
      elapsedMs: Date.now() - started
    });
  } catch (error) {
    const geminiError = error?.message || "Gemini fallback failed";
    console.error("Both AI providers failed", { groqError, geminiError });
    return res.status(503).json({
      error: mode === "CODING"
        ? "Coding analysis could not finish within the allowed verification window."
        : "Analysis could not finish within the normal response window.",
      groq: groqError,
      gemini: geminiError,
      elapsedMs: Date.now() - started
    });
  }
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(port, "0.0.0.0", () => {
  console.log(`FrameSolve Web running on port ${port} with Groq primary + Gemini fallback`);
});
