# FrameSolve Web v7.1 — 20-Second Question Handoff

This build keeps the v5.9 AI request path and changes the question-detection state machine.

## New flow
1. Camera starts and detects the first stable question.
2. It captures and sends the question to the existing AI endpoint.
3. When an answer is successfully shown, a small **Next question in 7** countdown appears at the top-left of the camera.
4. During the 10-second countdown, question-change detection is paused so the user can switch to the next question.
5. At 0, the answered question's frame becomes the reference image.
6. The detector watches for a meaningful change in the question/options region.
7. When a new question is stable, the old answer popup is hidden, the new frame is captured, and AI analysis starts.
8. After the next answer, the 10-second cycle repeats indefinitely.

The countdown is a UI handoff timer, not an AI timeout. It does not limit how long an AI answer may take.

## Deployment
Replace the repository `server` folder with this `server` folder and push to GitHub. Render can redeploy the existing service.
