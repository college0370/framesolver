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
    version: "6.3.0",
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

async function callGroq(imageBase64, mimeType, attempt = 1, priorAnswer = "") {
  if (!process.env.GROQ_API_KEY) throw new Error("GROQ_API_KEY is not configured");
  const attemptInstructions = [
    "Solve the question independently. Read every visible word, number, symbol, statement, and option before answering.",
    "Re-read the image carefully and independently verify the previous attempt. Pay special attention to digits, NOT/EXCEPT wording, options, and small text. Correct the answer if necessary.",
    "Act as a final verifier. Re-read the image from scratch, compare it with the previous answer, and return the answer you believe is correct. Do not guess unreadable text."
  ][Math.min(attempt - 1, 2)];
  const verification = priorAnswer
    ? `\nPrevious attempt to verify:\n${priorAnswer}\n`
    : "";
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
            { type: "text", text: `${prompt}\n\n${attemptInstructions}${verification}` },
            { type: "image_url", image_url: { url: dataUrl(imageBase64, mimeType), detail: "high" } }
          ]
        }],
        temperature: attempt === 1 ? 0.05 : 0,
        max_completion_tokens: 1300,
        reasoning_effort: "default",
        stream: false
      })
    },
    7800
  );
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error?.message || `Groq HTTP ${response.status}`);
  const answer = data?.choices?.[0]?.message?.content?.trim();
  if (!answer) throw new Error("Groq returned no answer");
  return answer;
}

async function callGemini(imageBase64, mimeType, mode = "NORMAL", timeoutMs = null) {
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
          thinkingConfig: { thinkingLevel: mode === "CODING" ? "high" : "medium" }
        }
      })
    },
    timeoutMs || (mode === "CODING" ? 60000 : 11000)
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
  const { imageBase64, mimeType = "image/jpeg", mode = "AUTO" } = req.body || {};
  if (!imageBase64) return res.status(400).json({ error: "imageBase64 is required" });

  const started = Date.now();
  // Normal questions get a correctness-first ~30s budget. Coding gets a longer
  // budget. Groq gets up to three verification passes inside that budget; Gemini
  // is used when Groq cannot produce a reliable final result.
  const isCoding = mode === "CODING";
  const totalBudget = isCoding ? 90000 : 30000;
  const geminiReserve = isCoding ? 30000 : 7000;
  const groqBudget = Math.max(5000, totalBudget - geminiReserve);

  let bestAnswer = "";
  let previous = "";
  let lastGroqError = "";
  let lastParsed = null;
  const groqStarted = Date.now();

  for (let attempt = 1; attempt <= 3; attempt++) {
    if (Date.now() - started >= groqBudget) break;
    try {
      const answer = await callGroq(imageBase64, mimeType, attempt, previous);
      bestAnswer = answer;
      previous = answer;
      lastParsed = parseStructuredAnswer(answer);

      // Keep going through the three-pass Groq verification budget. The user
      // explicitly prefers correctness over minimum latency.
    } catch (error) {
      lastGroqError = error?.message || "Groq failed";
    }
  }

  // If Groq produced a readable answer, use it. For coding, use the longer
  // Gemini verification pass as an additional correctness check.
  const groqParsed = bestAnswer ? parseStructuredAnswer(bestAnswer) : null;
  const groqReadable = bestAnswer && !looksUnreadable(bestAnswer) && groqParsed?.question;

  if (groqReadable && !isCoding) {
    return res.json({
      answer: bestAnswer,
      provider: "Groq (verified)",
      model: groqModel,
      elapsedMs: Date.now() - started,
      groqAttempts: 3
    });
  }

  const remaining = totalBudget - (Date.now() - started);
  if (remaining <= 1000) {
    if (bestAnswer) {
      return res.json({
        answer: bestAnswer,
        provider: "Groq",
        model: groqModel,
        elapsedMs: Date.now() - started,
        groqAttempts: 3
      });
    }
    return res.status(503).json({ error: "Analysis could not finish within the response window.", groq: lastGroqError });
  }

  try {
    const answer = await callGemini(imageBase64, mimeType, isCoding ? "CODING" : "NORMAL", Math.min(remaining, geminiReserve));
    return res.json({
      answer,
      provider: "Gemini verification",
      model: geminiModel,
      elapsedMs: Date.now() - started,
      groqAttempts: 3
    });
  } catch (error) {
    if (bestAnswer) {
      return res.json({
        answer: bestAnswer,
        provider: "Groq fallback",
        model: groqModel,
        elapsedMs: Date.now() - started,
        groqAttempts: 3
      });
    }
    return res.status(503).json({
      error: isCoding
        ? "Coding analysis could not finish within the verification window."
        : "Analysis could not finish within the response window.",
      groq: lastGroqError,
      gemini: error?.message || "Gemini failed",
      elapsedMs: Date.now() - started
    });
  }
});

function parseStructuredAnswer(text) {
  const normalized = String(text || "").replace(/\r/g, "");
  const questionMatch = normalized.match(/(?:\*\*)?QUESTION(?:\*\*)?\s*:\s*([\s\S]*?)(?=\n\s*(?:\*\*)?OPTIONS(?:\*\*)?\s*:|\n\s*(?:\*\*)?ANSWER(?:\*\*)?\s*:|$)/i);
  const answerMatch = normalized.match(/(?:\*\*)?ANSWER(?:\*\*)?\s*:\s*([\s\S]*?)(?=\n\s*(?:\*\*)?EXPLANATION(?:\*\*)?\s*:|$)/i);
  return { question: questionMatch?.[1]?.trim() || "", answer: answerMatch?.[1]?.trim() || "" };
}
function normalizeAnswer(text) {
  return String(text || "").toLowerCase().replace(/\s+/g, " ").trim();
}
function looksUnreadable(text) {
  return /unable to read|cannot read|can't read|unreadable|not readable|too blurry|could not recover/i.test(String(text || ""));
}

app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(port, "0.0.0.0", () => {
  console.log(`FrameSolve Web running on port ${port} with Groq primary + Gemini fallback`);
});
