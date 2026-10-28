# Motion Studio

Renders explainer films where every frame is a pure function of time
(`window.seek(t)` paints frame `t`). Score and SFX are synthesized in code,
the beat grid is measured from the rendered score (`beats.json`), and the mix
is normalized to -14 LUFS.

```bash
node motion-studio/tts.mjs motion-studio/projects/trailers          # narration (Gemini TTS)
node motion-studio/build-audio.mjs motion-studio/projects/trailers  # score, beats.json, SFX, mix, timeline.json
node motion-studio/render.mjs motion-studio/projects/trailers --contact   # one frame per beat
node motion-studio/render.mjs motion-studio/projects/trailers             # full render → out/film.mp4
```

Set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` when the installed Chromium does not
match the bundled Playwright, and `RENDER_WORKERS` to render frames in parallel.
Generated files land in `projects/<name>/out/` and are not committed.
