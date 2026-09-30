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
const model = process.env.GROQ_MODEL || "qwen/qwen3.8-27b";

app.use(cors());
app.use(express.json({ limit: "8mb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "FrameSolve Web",
    version: "5.1.0",
    provider: "Groq",
    model
  });
});

app.post("/api/analyze", async (req, res) => {
  try {
    const { imageBase64, mimeType = "image/jpeg" } = req.body || {};

    if (!imageBase64) {
      return res.status(400).json({ error: "imageBase64 is required" });
    }

    if (!process.env.GROQ_API_KEY) {
      return res.status(500).json({ error: "GROQ_API_KEY is not configured" });
    }

    const prompt = `
Read the question visible in this image and answer it for the user's own non-proctored practice material.

Return ONLY this compact format:
ANSWER: <direct answer>
EXPLANATION: <optional one short sentence>

Rules:
- MCQ: give the correct option text.
- English/fill-in-the-blank: give the exact word or phrase.
- Numerical/aptitude: give the final result.
- Programming/CS: give the direct answer; include tiny code only if absolutely necessary.
- If text is unreadable, say: ANSWER: Unable to read the question.
- Do not discuss the image or your reasoning.
`;

    const dataUrl = `data:${mimeType};base64,${imageBase64}`;
    const endpoint = "https://api.groq.com/openai/v1/chat/completions";

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);

    let response;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${process.env.GROQ_API_KEY}`
        },
        body: JSON.stringify({
          model,
          messages: [{
            role: "user",
            content: [
              { type: "text", text: prompt },
              {
                type: "image_url",
                image_url: { url: dataUrl }
              }
            ]
          }],
          temperature: 0.1,
          max_completion_tokens: 60,
          reasoning_effort: "none",
          stream: false
        }),
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeout);
    }

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      const message = data?.error?.message || "Groq request failed";
      return res.status(response.status).json({ error: message });
    }

    const answer = data?.choices?.[0]?.message?.content?.trim();

    if (!answer) {
      return res.status(502).json({ error: "Groq returned no answer" });
    }

    res.json({
      answer,
      model,
      provider: "Groq",
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error(error);
    res.status(error?.name === "AbortError" ? 504 : 500).json({
      error: error?.name === "AbortError"
        ? "AI response timed out. Waiting for the next question."
        : "Server error",
      detail: error?.message || "unknown"
    });
  }
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(port, "0.0.0.0", () => {
  console.log(`FrameSolve Web running on port ${port} using ${model}`);
});
