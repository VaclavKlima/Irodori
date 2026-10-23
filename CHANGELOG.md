# Changelog

## 0.2.0 — 2026-10-23

Improve Bazzite image editing on maximized ultrawide displays while preserving full-quality refinement, shared history, Undo/Redo and original photographs.

- Adopt ordinary Linux GPU feedback, exact completed-frame reuse, linear64 rendering and fewer unnecessary waits.
- Use native LibRaw/Rust source preparation, a Rust process/protocol bridge with checked generated C++ math for CPU recovery and masks, and native Ultra HDR encoding. Retain the Electron/React interface and validated browser WebGPU/native Dawn processing.
- Move catalog writes into a dedicated worker with durable publication and recovery.
- Add machine-based Automatic RAM/VRAM budgets and optional separate limits in Settings. Active image owners keep frozen budgets; settings apply to later owners.
- Remove obsolete catalog/settings/source/cache compatibility and unused production experiments while retaining independent numerical references.

Acceptance covers all eight enabled sliders, navigation, zoom/pan/drag and real import, individual/batch export, noise merge and HDR merge interference across the recorded Bazzite layouts and 60/120 Hz input. See the [implementation and acceptance ledger](docs/bazzite-native-engine.md) for source-matched evidence and retained failed attempts. Synthetic input cadence, visible updates and physical scanout are distinct; memory snapshots are not continuous peak measurements.

Libraries require current catalog 17/settings 7. Older formats reject before mutation; some old generated sources or merge results can be unavailable. Originals and recoverable bundles remain preserved. macOS acceptance and the older whole-merge timing targets remain separate work.
