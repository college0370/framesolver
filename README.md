# FrameSolve Web v6.9

Known-good AI request configuration based on the previously working v5.9 build, with the later automatic question-change/queue behavior retained.

AI flow for the user's own non-proctored practice/mock material:
- One Groq visual pass, up to 16 seconds.
- If Groq fails/unreadable, the same captured image is automatically sent to Gemini for up to the remaining portion of a 40-second total window (maximum 24 seconds).
- No 3-Groq verification chain.
- No `reasoning_format` parameter.
- Gemini uses low thinking for faster response.
