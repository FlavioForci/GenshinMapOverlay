# Genshin Map Overlay

Every map marker, right on your **in-game map**. Press **M** in Genshin Impact and the overlay lays
chests, oculi, puzzles and 690 more marker types onto the map, with a photo of every spot. It follows
when you drag and zoom, and it never touches the game.

**[Download the latest version](https://github.com/FlavioForci/GenshinMapOverlay/releases/latest)** ·
[Website](https://genshin-map-overlay.pages.dev) · [Discord](https://discord.gg/TaKd4BU8f) ·
[Support on Ko-fi](https://ko-fi.com/s/819525a108)

Deutsche Anleitung: [README.de.md](README.de.md)

## Features

- Markers on the in-game map, placed by image recognition. They follow while you drag and zoom.
- Click a marker for the community's top-voted photo of the spot, plus a video where there is one.
- Right-click marks a marker as found. Hide found ones with one key and see your progress per type.
- 690+ marker types in categories, with search.
- Hotkeys that work in game, English and German, scales with your resolution up to 4K.

## Installation

1. Download `GenshinMapOverlay-Setup-<version>.exe` from
   [Releases](https://github.com/FlavioForci/GenshinMapOverlay/releases/latest).
2. Run it. Windows may say **"Windows protected your PC"** because the app isn't code-signed yet:
   click **More info**, then **Run anyway**.
3. Pick the overlay language (English or German) and install. No admin rights needed.
4. The overlay starts and sits in the system tray (compass icon next to the clock). On first start it
   downloads the marker data and map recognition, which takes a few seconds.
5. Start the game from the tray menu with **Start Genshin borderless**.
6. Open the map in game with **M**. The markers appear on their own.

Tip: tray menu → **Start with Windows**, so the overlay is always ready.

### Requirements

- Windows 10 (version 2004 or newer) or Windows 11
- Genshin Impact for PC, in borderless or window mode (not exclusive fullscreen, see below)
- Tested at 1920×1080 and 4K

### macOS (Apple Silicon, beta)

There is a Mac version for Apple Silicon (M1 and newer). It isn't tested as much as the Windows
version yet, so please report anything odd on [Discord](https://discord.gg/TaKd4BU8f).

1. Download `GenshinMapOverlay-<version>-mac-arm64.zip` from
   [Releases](https://github.com/FlavioForci/GenshinMapOverlay/releases/latest), unzip it and move
   **Genshin Map Overlay.app** to your Applications folder.
2. The app isn't signed with an Apple developer certificate, so macOS blocks the first start. Open
   **System Settings → Privacy & Security**, scroll down and click **Open Anyway**. Alternatively, in
   Terminal: `xattr -dr com.apple.quarantine "/Applications/Genshin Map Overlay.app"`
3. Allow screen recording: **System Settings → Privacy & Security → Screen Recording**, switch on
   **Genshin Map Overlay**, then quit and restart the overlay.
4. The overlay lives in the menu bar (compass icon), there is no Dock icon. On Mac keyboards the
   F keys may need **fn**.

"Start Genshin borderless" and the hotkey helper are Windows-only and not needed on a Mac.

### Linux (x64, beta)

There is a Linux version as AppImage and `.deb`. It is new and has hardly been tested with the game
yet, so please report anything odd on [Discord](https://discord.gg/TaKd4BU8f). Genshin runs on Linux
only through Wine or Proton. HoYoverse doesn't support that officially, regardless of the overlay.

1. Download `GenshinMapOverlay-<version>-linux-x86_64.AppImage` from
   [Releases](https://github.com/FlavioForci/GenshinMapOverlay/releases/latest), make it executable
   (`chmod +x GenshinMapOverlay-*.AppImage`) and start it. AppImages need FUSE 2: on Ubuntu 22.04
   `sudo apt install libfuse2`, on Ubuntu 24.04 `sudo apt install libfuse2t64`.
   On Debian/Ubuntu you can install `GenshinMapOverlay-<version>-linux-amd64.deb` instead
   (`sudo apt install ./GenshinMapOverlay-*-linux-amd64.deb`) and start it from the app menu.
2. The overlay sits in the system tray. On GNOME this needs the extension **AppIndicator and
   KStatusNotifierItem Support** (Ubuntu has it built in). Without a tray, the hotkeys and the
   **Markers** tab on the map still work. Quit with `pkill -f genshin-map-overlay`.
3. Put Genshin in window or borderless mode in its graphics settings and open the map with **M**.

Requirements: x64 Linux with X11, or a Wayland desktop with XWayland (GNOME, KDE Plasma and most
others), and a compositor for the see-through window.

Limits on Linux:

- **Wayland:** the overlay restarts itself on XWayland (X11), because native Wayland doesn't let apps
  place an always-on-top, click-through window or catch hotkeys. Screen capture goes through the
  system dialog (PipeWire): pick the screen with the game. The dialog comes back each time the overlay
  starts. Force native Wayland with `--ozone-platform=wayland`, but expect position, clicks and
  hotkeys to break.
- **Hotkeys** work while the game window has focus. If the game grabs the keyboard in fullscreen, use
  the tray menu or the tab on the map.
- **Screenshots:** Linux can't hide a window from screen captures. The overlay shows up in
  screenshots and streams, and the **Visible in screenshots** switch is missing in the panel. The map
  recognition sees the markers too, which may make it a little less steady.
- **Start Genshin borderless** and the hotkey helper are Windows-only.
- Not tested yet: several monitors, Gamescope, Wine's virtual desktop, typing in the panel search.

Settings, cache, log and found markers are in `~/.config/Genshin Map Overlay`. Tray menu →
**Start on login** adds the overlay to `~/.config/autostart`.

## How to use it

| Key | What it does |
|---|---|
| **M** (in game) | Open the map, markers appear automatically |
| **F7** | Overlay on/off (off = no screen capture, no CPU use) |
| **F8** | Open/close the marker panel |
| **F9** | Show/hide found markers |
| **F10** | Change marker opacity |

- **Left-click a marker:** the spot card opens with the photo or video. Click the photo to enlarge it.
- **Right-click a marker:** mark it as found (or not found again).
- **Panel:** tick which marker types to show, search by name, set size and opacity.
  You can also open it with the **Markers** tab on the right edge of the map.
- Clicks next to markers go to the game as usual (drag, zoom, set waypoints).
- Outside the map the game locks the mouse. Hold **Alt** to click in the panel there.

Found markers are saved only on your PC (`%APPDATA%\Genshin Map Overlay\found.json`).

## Is it safe for my account?

The overlay is a separate, see-through window. It

- does **not** read or change the game's memory or files,
- injects **nothing** (no DLL, no graphics hook),
- sends **no** keys or clicks to the game.

To know where the map is, it takes a normal screen capture, the same way OBS or Discord screen sharing
does. HoYoverse doesn't officially approve any overlay, so nobody can promise zero risk, but a window
that never touches the game is the safest way to build one.

## Troubleshooting

- **No markers:** Genshin's exclusive fullscreen hides every other window. Start the game with
  **Start Genshin borderless** from the tray menu, or choose window mode in the game's graphics
  settings. With several monitors, pick the right one under **Screen with the game** in the tray menu.
- **Hotkeys don't work in game:** Genshin runs as administrator, and Windows only passes hotkeys to
  programs with the same rights. The overlay starts a small helper for F7–F10 and Windows asks once
  for permission. If you declined: tray menu → **Enable hotkeys in game**. The panel also opens with
  the tab on the map.
- **"Screen capture failed":** the overlay was started as administrator. Start it normally.
- **A key is taken:** the overlay tells you on start. Change it in the settings file.
- **Markers look off:** post a screenshot of the open map (`Win` + `Print`) in the
  [Discord](https://discord.gg/TaKd4BU8f).

## Settings

Tray menu → **Advanced** → **Open settings file**, then **Reload settings**.

| Key | Meaning |
|---|---|
| `hotkeys` | Keys, e.g. `"F7"`, `"Alt+M"`, `"Ctrl+Shift+F1"` |
| `markerSize` | Marker size in pixels at 1080p (also in the panel) |
| `language` | `"en"` or `"de"`; empty = from the setup or Windows |
| `showInCaptures` | `true` = overlay shows up in screenshots, recordings and streams (also in the panel) |
| `genshinPath` | Path to `GenshinImpact.exe` if it isn't found automatically |

## Privacy

The overlay downloads marker data, photos and the map recognition from
`genshin-map-overlay.pages.dev`, and YouTube preview images for spots with a video. It uploads
nothing. Screen captures stay on your PC and are never saved.

## Uninstall

Windows Settings → Apps → **Genshin Map Overlay**. Settings, cache and found markers are in
`%APPDATA%\Genshin Map Overlay` and can be deleted afterwards.

## Building from source

Requires [Node.js](https://nodejs.org) 20 or newer.

```bash
npm install
```

```bash
npm start
```

Build the installer (ends up in `dist\`):

```bash
npm run dist
```

On Linux, `npm run dist:linux` builds the AppImage and `.deb` instead. The GitHub Actions workflows
`linux.yml` and `mac.yml` build the other platforms.

| Path | Contents |
|---|---|
| `src/main.js` | Main process: windows, hotkeys, tray, data |
| `src/overlay/` | Transparent overlay: markers, panel, spot card |
| `src/tracker/` | Hidden window: screen capture and map recognition (ORB + optical flow) |
| `src/data/` | Download and cache of the data, categories, found markers |
| `src/shared/` | Code shared by overlay, tracker and tools (texts, map math, UI zones) |
| `server/` | Website and data server (Cloudflare Pages), the data itself isn't in the repository |
| `tools/match-test.js` | Test for the map recognition with real or synthetic screenshots |

## Credits

Fan project, not affiliated with or endorsed by HoYoverse. Genshin Impact and all related names and
images are trademarks of HoYoverse. Marker data and photos come from the community of
[genshin-impact-map.appsample.com](https://genshin-impact-map.appsample.com), .
