# FrameSolve AI

Mobile-first camera practice assistant for **your own non-proctored mock/practice material**.

## Detection architecture

- Camera is sampled continuously with a cheap local visual trigger.
- The visual trigger is **not** the question identity; it only wakes OCR.
- OCR builds a normalized question fingerprint from the visible question/options/code area.
- Fingerprint detection is capped at an **8.5 second OCR budget**, keeping the change-detection target below 10 seconds.
- Phone movement or camera shake can trigger OCR, but if the fingerprint is still the same, no AI request is made.
- A genuinely different fingerprint immediately captures one high-quality frame and starts AI analysis.
- AI analysis is **independent of the 10-second detector budget**. It is not cancelled just because detection is fast.
- Groq is attempted first; Gemini is the fallback in the current server implementation.
- The client protects against stale AI responses overwriting a newer detected question.
- There is no manual Analyze Now button.

## Deploy

Render root directory: `server`

Build command: `npm install`

Start command: `npm start`

Keep provider API keys server-side in Render environment variables.
