# Local desktop application

The selected Little Jizō supplies the application header mark and runtime
window/Dock identity. The header displays the bundled 64px PNG at 32px beside
the Irodori wordmark, within the existing 48px header. The user explicitly
requested this header replacement on 2026-11-02; it overrides the aperture mark
in the unchanged historical prototype. [Original provenance](../assets/app/icons/manifest.json) is unchanged;
[derived assets](../assets/app/icons/generated/manifest.json) contain reproducible
PNG sizes, macOS ICNS and Windows ICO. Regenerate with `npm run icons:generate`.
The script verifies the original SHA-256, uses the locked sharp/libvips versions
and deterministic Lanczos3 reduction, and strips metadata only from derivatives.

## Build on the target host

```sh
npm ci
npm run setup:electron
npm run package:desktop
```

On Linux, prepare the pinned native helpers described in the root README first.
Packaging uses [@electron/packager](https://electron.github.io/packager/main/interfaces/Options.html)
and the installed Electron version for the current host/architecture. It produces
`dist/Irodori-darwin-<arch>/Irodori.app` or `dist/Irodori-linux-<arch>/irodori`.
The macOS application is unsigned and intended for local use. Public installers,
signing, notarization, Windows packaging and cross-compilation are separate work.

The stage contains the built application, matching installed production dependency
graph, licenses and icon provenance. Development dependencies, source photographs,
fixtures and test/benchmark directories are excluded. Workers, sharp, ExifTool,
LibRaw WASM, Dawn, the bundled Node binary and native helpers remain ordinary files
outside ASAR. Existing userData/sessionData/library paths, sandboxing and the typed
renderer bridge are preserved. The temporary packaging stage is removed afterwards.

## Bazzite user-local launcher

```sh
npm run package:desktop -- --install-launcher
```

The optional Linux-only flag writes the desktop entry into
`${XDG_DATA_HOME:-$HOME/.local/share}/applications/` and its icon into the matching
`icons/hicolor/256x256/apps/` tree. It needs no system installation or root access.
The launcher uses absolute, quoted paths and the desktop ID
`io.github.vaclavklima.Irodori`, matching Electron's desktop name and window class.
Keep the packaged application at its generated path, or regenerate the launcher
after moving it. Windows assets are supplied without claiming Windows runtime acceptance.

## Focused acceptance

`desktop-integration` verifies original/derivative hashes, alpha and dimensions,
platform container headers and desktop-entry path quoting. Real packaged startup
uses the shared launch/cleanup module with explicit isolated profiles and offline
networking. The original packaged main entry requires a foreground launch; it is
never silently substituted into a hidden test or added to routine fast checks.

```sh
npm run verify -- --target desktop-package --foreground
```

Set `IRODORI_PACKAGED_EXECUTABLE` to test another existing host-native output.
The case checks packaged paths/security, byte-preserved Sony RAW import, the exact
shipped Node/worker decoder fallback, offline fonts/icon, restart and profile cleanup.
Finder/Dock/application-switcher and Bazzite launcher/dock appearance require actual
foreground verification. Keep unavailable platform criteria open under backlog #21.
See [Sunflower acceptance](design/sunflower-acceptance.md) for this migration's evidence.
