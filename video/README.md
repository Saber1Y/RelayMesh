# RelayMesh video

The motion intro (40 seconds), rendered from code with Remotion and narrated by VoiceStudio's "The Neighbor".
Every figure on screen is real: the 10 tPOT transfer of intent `0x6a5230a308fa971043e2ba7f929eb193` and bridge deposit `860457-1`, as served by the live API.

```bash
cd video
pnpm install --ignore-workspace
pnpm voiceover        # regenerate missing voiceover lines (VoiceStudio must be running)
pnpm studio           # preview and scrub in the browser
pnpm render           # out/relaymesh-intro.mp4 (1920x1080)
pnpm render:square    # out/relaymesh-intro-square.mp4 (1080x1080)
pnpm render:vertical  # out/relaymesh-intro-vertical.mp4 (1080x1920)
pnpm still            # out/poster.png
```

Edit a line in `voiceover/lines.json`, then `node voiceover/generate.mjs <line-id>` to regenerate just that one.
Scene timing is worked out from the voiceover lengths (`ORDER` at the top of `src/Intro.tsx`): edit a line, regenerate it, and the scenes re-time themselves.
