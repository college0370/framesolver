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
const model = process.env.GEMINI_MODEL || "gemini-3.8-flash";
const fallbackModel = process.env.GEMINI_FALLBACK_MODEL || "gemini-3.6-flash";

app.use(cors());
app.use(express.json({ limit: "8mb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "FrameSolve Web",
    version: "4.2.0",
    model
  });
});

app.post("/api/analyze", async (req, res) => {
  try {
    const { imageBase64, mimeType = "image/jpeg" } = req.body || {};

    if (!imageBase64) {
      return res.status(400).json({ error: "imageBase64 is required" });
    }

    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({ error: "GEMINI_API_KEY is not configured" });
    }

    const prompt = `
You are a study assistant for the user's own non-proctored mock/practice material.

Analyze the question visible in this image.

Return:
ANSWER:
<direct answer; for MCQs include the option>

EXPLANATION:
<concise but useful reasoning>

For programming questions:
- provide correct code when useful
- include time complexity
- include space complexity

For aptitude/math:
- show the essential calculation.

If several questions are visible, answer the most prominent/current one.

If text is unreadable, clearly say what cannot be read. Never invent missing text.
`;

    const requestBody = {
      contents: [{
        role: "user",
        parts: [
          { text: prompt },
          {
            inline_data: {
              mime_type: mimeType,
              data: imageBase64
            }
          }
        ]
      }],
      generationConfig: {
        temperature: 0.10,
        maxOutputTokens: 1000
      }
    };

    // Gemini can temporarily return 429/503 during capacity spikes.
    // Retry transient failures with exponential backoff, then try the
    // stable fallback model once before returning an error to the phone.
    async function callModel(targetModel, maxRetries = 3) {
      let lastData = null;
      let lastStatus = 500;

      for (let attempt = 0; attempt < maxRetries; attempt++) {
        const endpoint =
          `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(targetModel)}:generateContent?key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`;

        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(requestBody)
        });

        const data = await response.json();
        lastData = data;
        lastStatus = response.status;

        if (response.ok) {
          return { response, data, targetModel };
        }

        const transient = [408, 429, 500, 502, 503, 504].includes(response.status);
        if (!transient || attempt === maxRetries - 1) break;

        const delayMs = 2000 * (2 ** attempt) + Math.floor(Math.random() * 700);
        console.warn(`Gemini ${targetModel} returned ${response.status}; retrying in ${delayMs}ms`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }

      return { response: null, data: lastData, status: lastStatus, targetModel };
    }

    let result = await callModel(model, 3);

    // If the primary model is temporarily overloaded, try a second stable
    // Flash model. Do not fallback for invalid-key/permission/client errors.
    if (!result.response && result.status === 503 && fallbackModel && fallbackModel !== model) {
      console.warn(`Primary model ${model} unavailable; trying fallback ${fallbackModel}`);
      result = await callModel(fallbackModel, 2);
    }

    if (!result.response) {
      return res.status(result.status || 502).json({
        error: result?.data?.error?.message || "Gemini request failed after retries"
      });
    }

    const answer = (result.data?.candidates?.[0]?.content?.parts || [])
      .map(part => part?.text || "")
      .join("")
      .trim();

    if (!answer) {
      return res.status(502).json({ error: "Gemini returned no answer" });
    }

    res.json({
      answer,
      model: result.targetModel,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: "Server error",
      detail: error?.message || "unknown"
    });
  }
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(port, "0.0.0.0", () => {
  console.log(`FrameSolve Web running on port ${port}`);
});
