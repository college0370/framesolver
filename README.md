# FrameSolve Web v8.0

Question-content detector version.

## Detection flow
- Camera starts and establishes the first question.
- A cheap local visual trigger checks the question region.
- OCR runs only when the visual trigger suggests content changed.
- OCR text is normalized into a question fingerprint.
- If the fingerprint is the same, no AI request is sent.
- If the fingerprint is different, the new question is captured and sent to the existing AI pipeline.
- No 7/10/20-second handoff timer is used.
- The answer popup remains the large centered answer-only popup.
- Status reports detection/AI errors.
- Answer section comes before History; History exposes only Copy all history and Clear history.

## Deploy
Keep Render Root Directory as `server`, Build Command `npm install`, Start Command `npm start`.
Keep existing environment variables. Tesseract.js is loaded in the browser from jsDelivr.
