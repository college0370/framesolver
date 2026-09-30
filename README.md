# FrameSolve Web 4.4 — Final Camera Practice Assistant

Mobile-first web app for your own non-proctored mock/practice material.

## Flow

Phone browser
  -> camera permission
  -> live preview
  -> local frame-change detection
  -> stable changed frame
  -> backend `/api/analyze`
  -> Gemini Vision
  -> answer + explanation

The browser does the frame comparison locally. It does not upload every video frame.

## Requirements

- Node.js 20+
- A Gemini API key
- HTTPS in deployment (camera access generally requires a secure context)

## Local setup

```bash
cd server
npm install
copy .env.example .env
```

Put your Gemini key in `.env`:

```env
GEMINI_API_KEY=YOUR_KEY
PORT=8080
GEMINI_MODEL=gemini-3.8-flash
GEMINI_FALLBACK_MODEL=gemini-3.6-flash
```

Start:

```bash
npm start
```

Open the displayed local URL from a browser on the same device. For phone testing against a PC backend, use an HTTPS tunnel or deploy the server, because mobile browsers generally require HTTPS for camera access.

## Cloud deployment

Deploy the `server` directory to a Node-compatible HTTPS host.

Set:
- `GEMINI_API_KEY`
- `GEMINI_MODEL` (optional)
- `PORT` (host may provide it)

The server serves the web app from `server/public`, so one deployment gives one URL.

Example:

```text
https://your-app.example.com
```

## Usage

1. Open the URL on your phone.
2. Tap Start Camera.
3. Allow camera access.
4. Point the camera at your own practice/mock question.
5. When the visible question changes, the app waits for it to stabilize.
6. One image is sent to the backend.
7. Gemini returns the answer and explanation.
8. The app waits for the next meaningful change.

## Tuning

Use the Settings panel:
- Change sensitivity
- Change stability frames
- Change minimum AI interval

## Security

- Gemini key stays on the server.
- Do not commit `.env`.
- Add authentication/rate limiting before making a public service.
- HTTPS is recommended/required for camera access in normal browser contexts.

## Use restriction

Use this for your own study and non-proctored practice/mock material. Do not use it to obtain answers during a live monitored/proctored recruitment, academic, certification, or other assessment or to bypass monitoring.


## Core design

- Automatic mode continuously watches the camera locally and sends only stabilized, meaningful visual changes to the AI.
- Duplicate-looking frames are skipped before an API call.
- There is **no question/session count limit** in the application.
- The browser shows AI-call and skipped-frame counters for visibility; these counters can be reset without stopping the camera.
- Captures are resized to a maximum width of 1024px and JPEG quality 0.70 to reduce upload size.
- Default model is `gemini-3.8-flash-lite`; change `GEMINI_MODEL` if your API project uses another supported multimodal model.
- The minimum AI interval protects against accidental repeated calls when the camera view changes rapidly.

Use this only with your own non-proctored practice/mock material.


### Automatic Gemini retry/fallback
The server retries transient Gemini 429/5xx responses with exponential backoff. If Gemini 3.8 Flash remains temporarily unavailable with HTTP 503, it tries the stable Gemini 3.6 Flash fallback.


## 4.4 UI and detection update
- Detects localized changes such as a changed number, character, option, or fill-in-the-blank text.
- Shows the latest answer in a compact camera overlay popup.
- Keeps the full answer in the lower panel for reference.
- Gemini uses low thinking and medium media resolution for a latency/legibility balance.
