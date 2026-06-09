# PhoneBridge ⚡

Terminal-native phone-to-PC bridge. Beam clipboard, files, and links from your
iPhone to your Windows PC over Wi-Fi. No Electron, no installer, no headaches.

This repo contains only what's needed to **build the shareable `.exe`**.

---

## Build the .exe

You need [Node.js](https://nodejs.org/) installed. Then just:

**Double-click `Build.bat`.**

It will:

1. Install build dependencies (first time only, ~30s)
2. Inline the web assets into `embedded.js`
3. Compile a single self-contained `dist/PhoneBridge.exe` with the PB icon
   embedded (downloads the Node base binary ~40 MB on the first build)
4. Verify the embedded icon, then open the `dist` folder

The finished `dist/PhoneBridge.exe` (~50 MB) is fully self-contained — anyone on
Windows can double-click it. No Node.js, no setup, nothing else required.

> First run on another PC: **SmartScreen** may warn ("unknown publisher" — click
> More info → Run anyway, normal for unsigned exes) and **Windows Firewall** will
> ask to allow on private networks (click Allow). One-time clicks.

---

## Using PhoneBridge

1. Run the exe — the terminal shows a QR code. Point your iPhone camera at it.
2. Tap the link, then in Safari: Share → Add to Home Screen.
3. From your iPhone, send text/clipboard, files (land in `Downloads/PhoneBridge`),
   and links to your PC. Every transfer scrolls live in the terminal.

Close the terminal or press Ctrl+C to stop.

---

## What's in here

| File | Role |
|------|------|
| `Build.bat` | One-click build entry point |
| `server.js` | The app (HTTP server + QR + clipboard/file handling) |
| `phone.html` | The phone-side web UI |
| `manifest.webmanifest` | PWA manifest for "Add to Home Screen" |
| `prepare.js` | Inlines html/manifest/icons into `embedded.js` |
| `build-with-icon.js` | Compiles the exe with the icon embedded in the Node base |
| `verify-build.js` | Confirms the icon embedded correctly |
| `assets/` | App icons (`.ico` + PWA pngs) |

`node_modules/`, `dist/`, and the generated `embedded.js` are produced by the
build and intentionally not tracked.

---

*By: PskXClaude*
