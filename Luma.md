# Luma — a local photo editor with an AI console

## Application concept

Luma is a desktop photo editor inspired by the Adobe Lightroom workflow. It combines manual editing with the ability to control the same features through an AI agent in an integrated terminal.

Users can edit a photograph manually, give the agent a request in natural language, and then fine-tune its work. Both methods share adjustment settings, the preview, and the edit history.

The application is intended for photographers working with local photographs, including camera RAW files and HDR content.

## First usable release

- A standalone installed application for Windows, Linux, and macOS, with an interface built in HTML, CSS, and TypeScript.
- Open a local folder, browse a thumbnail gallery, select photographs, and view basic metadata.
- Support JPEG, PNG, TIFF, and RAW files according to the chosen engine's compatibility. Verify support for each specific camera and recording mode.
- Adjust exposure, white balance, contrast, highlights, shadows, and saturation; crop and straighten.
- Store edits nondestructively, separately from originals, with history, undo/redo, and before/after comparison. Edits persist after restarting.
- HDR processing, a true HDR preview on supported setups, and HDR export. Provide an appropriate preview for SDR displays and clearly indicate the active mode.
- Export individual photographs or a selection; apply the same adjustments to multiple photographs.
- A collapsible terminal for running a CLI agent chosen by the user, with MCP support.

The default interface will be dark and color-neutral: a large preview in the center, a gallery and navigation on the left, adjustments on the right, and a collapsible terminal at the bottom.

The complete HDR destination includes exposure merging: RAW brackets or supported HDR files → nondestructive HDR editing → HDR and SDR preview → HDR and SDR export. Single RAW photographs also use this HDR processing foundation. Exposure merging follows the processing and display foundations as a staged milestone; the complete destination is not finished until merging and file interoperability are verified. The [feature roadmap and implementation briefs](docs/features/README.md) define this order and its acceptance gates.

These are planned capabilities. The current application provides a managed library, persisted light adjustments, verified Sony RAW white balance and lens corrections, shared history, and preview analysis. Supported Sony RAWs and merge masters use scene-linear Rec.2020 working assets and one automatic ACES 2 HDR/SDR renderer; raster images keep their authored, color-managed appearance. Local Linux and built-in Mac Retina display evidence is recorded; physical luminance, Windows and broader platform certification remain unverified. The bounded Sony HDR merge/noise-stacking workflow remains experimental: supplied handheld portraits pass automatic alignment and native-detail validation, and local 2/3/5/9-frame noise stacks publish within 15 seconds. Larger controlled HDR brackets and 32-frame real RAW sequences still need verification. HDR file import and export are not implemented; the console remains read-only.

Generative retouching, automatic masking, and cloud synchronization belong to later releases.

The default [ACES 2 rendering pipeline](docs/display-rendering.md) preserves capture exposure and As Shot white balance, including night-scene darkness. Its fixed Rec.2020/D65 HDR content rendition uses nominal 1000-nit peak and 100-nit reference; monitor capability changes only presentation and diagnostics. SDR preview retains its direct rendition. It follows white balance and Light adjustments and stays separate from linear working assets. Measured Sony color/exposure calibration and physical screen luminance remain unverified.

## Technical direction and interfaces

- Desktop foundation: [Electron](https://www.electronjs.org/docs/latest/) with React and TypeScript; local application logic in Node.js.
- Terminal: [xterm.js](https://xtermjs.org/) for display and [node-pty](https://github.com/microsoft/node-pty) for running the CLI process.
- Photographic computations will run in a separate process using existing native libraries or a RAW engine.
- Manual controls and MCP will use a shared application API. Agent changes will appear in the sliders, preview, and history.
- MCP will expose photo selection, metadata, current adjustments, previews and image statistics, parameter changes, history, and export.
- The agent will use the user's own authentication and configuration. The editor and photo processing operate locally; AI network requests depend on the chosen agent.

## Validation and specification boundaries

The first technical prototype must validate:

1. Opening an actual RAW file, editing it manually, and exporting it correctly.
2. Editing the same photograph through an agent over MCP, updating the UI, and sharing undo/redo.
3. Preserving the original and restoring saved edits after restarting.
4. HDR preview, HDR export, and SDR preview on the appropriate displays.
5. Running the application and terminal on all three operating systems; the interface remains usable during computations.

Luma is a working name. This document establishes the product intent and scope of the first release. A subsequent technical design will determine the specific RAW engine, HDR export format, and supported combinations of operating systems and hardware based on the prototype results.
