# Recording preview wheel input

Use the opt-in recorder when physical mouse zoom feels inconsistent. Start Irodori normally with `npm run dev`, open a photograph, and wait for the full preview. In a second terminal, run:

```sh
node scripts/record-preview-wheel.mjs --duration 60
```

The script attaches to the existing development window through the loopback debugging endpoint. It observes input and view state without changing the photo, selection, zoom, library, or profile. It disconnects when finished and leaves Irodori running. Automated reproduction and imports still require an isolated test profile.

While recording:

1. Place the pointer over the photograph and hold **Ctrl**.
2. Scroll up exactly one physical wheel notch, pause for one second, and scroll down one notch.
3. Repeat three times. Note any notch that feels different.
4. Zoom in farther, then scroll down toward Fit. Note whether Fit is reached.
5. Release Ctrl. Press **Ctrl+C** in the recorder terminal to save early, or wait for the duration to end.

Avoid reloading or restarting the renderer during the sample. A renderer reload or close interrupts recording; previously collected records are retained. Run `node scripts/record-preview-wheel.mjs --help` for the duration, record-limit, and loopback endpoint options.

Each invocation saves `summary.md` and `recording.json` in a unique ignored directory under `artifacts/wheel/`. The log contains raw `deltaX`, `deltaY`, `deltaMode`, modifiers, trusted-event status, pointer position inside the viewport, independently observed physical-Control evidence, and preview scale/Fit/pan state. Blur and visibility events include trusted-event status, document visibility, and focus. When available, canvas `requestedView` and `presentedView` distinguish the requested rendering view from the last published rendering view. Filenames, photo IDs, metadata, image pixels, typed text, and source filesystem paths are not collected. Preview and image dimensions describe zoom geometry.

Read the compact summary first, then compare each `wheel` record with its matching `dispatch` and `frame` records using the event `id`. `before` is the last published view before input. Frame 1 and frame 2 sample the published view on subsequent animation callbacks; several wheel events can share the same presentation frame. Separate `view` records timestamp observed scale/Fit/pan mutations. Check the physical-Control evidence when a Ctrl-wheel event seems unexpectedly sensitive, and compare raw deltas when ostensibly identical notches differ.

The browser does not expose physical wheel-notch counts or a reliable device identifier. One notch may produce several events, and events may be coalesced. Trusted events establish browser-delivered input, not a measured physical notch count. These records describe input and application view state; they do not measure GPU completion, input-to-photon latency, or display scanout. Use one-notch samples with pauses to make comparison meaningful.
