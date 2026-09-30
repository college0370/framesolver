# FrameSolve AI v5.5 — Character Change Detection + Groq/Gemini

Fast mobile-first practice assistant for the user's own non-proctored mock/practice material.

## Flow

**Phone camera → local character/text/number change detection → stable changed frame → Groq vision → Gemini verification/fallback → popup answer → history**

The browser does the continuous detection locally. It does **not** send camera frames continuously to the AI provider.

### Detects changes such as

- Question number changes
- A changed number or character
- Changed question text
- Changed MCQ option text
- Fill-in-the-blank changes
- Scrolling to another question

Broad camera movement/shake is filtered by requiring a localized change and a stable new frame.

## AI provider

This version uses Groq's multimodal `qwen/qwen3.8-27b` model. Groq documents image input, OCR/visual question answering, and low-latency inference for this model.

Create a Groq API key and set it on Render as:

```text
GROQ_API_KEY=your_key
GROQ_MODEL=qwen/qwen3.8-27b
```

Never put the API key in browser JavaScript or commit it to GitHub.

## Render

Root Directory: `server`

Build Command: `npm install`

Start Command: `npm start`

Environment variables:

- `GROQ_API_KEY`
- `GROQ_MODEL` = `qwen/qwen3.8-27b`

## Important

No AI system can guarantee a fixed response time because network/provider availability can vary. This app minimizes avoidable delay by making only one request for each meaningful question change and by using a short output.

Use only with your own non-proctored practice/mock material.


### 30-second response target
The v5.1 server uses a hard 20-second AI request timeout and the browser uses a 22-second request timeout. The app does not retry timed-out requests, so it will not wait minutes for a single answer.


### v5.5 timing and detection
- Detection resolution increased to 192×144 for smaller character/digit changes.
- The detector aligns frames to suppress small camera/table movement while preserving localized text changes.
- A meaningful character, digit, word, option, or question-number change triggers a new analysis after the frame stabilizes.
- Same question is not repeatedly sent to AI.
- Normal Groq request has a ~20s server cap; normal Gemini fallback is ~8s.
- Coding results can receive a longer Gemini verification pass of up to ~60s after the fast Groq result.
- Browser request timeout is 90s so the coding verification window is not cut off.
- Capture uses up to 1280px JPEG at quality 0.88 for better code/text readability.
- History stores the model-returned question text, answer, type, and time; Copy/View are available.


## v6.0 image readability update
- Captures up to 1600px wide at JPEG quality 0.92.
- Removes only the extreme bottom camera/browser area and preserves the full question/options region.
- Applies mild contrast and glare normalization to make screen text more visible.
- Vision prompt explicitly ignores watermarks, logos, timestamps, UI labels, and email addresses that are unrelated to the question.
- Normal Groq request is bounded to 16s; Gemini fallback is bounded to 9s, keeping normal analysis around a 25s window.
- Coding keeps the longer verification path.


## v6.3 automatic retry
If an automatic normal-question request fails or times out, the exact captured frame gets one Gemini-only retry. A newer question can never be overwritten by a late older response.


## v6.3 UI update
- Large centered answer popup with answer only (no explanation).
- Page order: camera, status, AI Answer, History controls.
- History contents remain stored locally but are not displayed on the page.
- One Copy all history button and one Clear history button.
