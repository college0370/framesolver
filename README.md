# FrameSolve AI v5 — Local Smart Detection + Groq Vision

Fast mobile-first practice assistant for the user's own non-proctored mock/practice material.

## Flow

**Phone camera → local question/text change detection → stable changed frame → ONE Groq vision request → popup answer → keep watching**

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
