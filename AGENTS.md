# Repository guidance

Genshin Map Overlay is an Electron application that places interactive map markers over the game using screen capture and image recognition. Node.js 22.12.0 or newer is required.

## Project layout

- `src/main.js` manages the Electron main process, windows, tray and hotkeys.
- `src/overlay/`, `src/tracker/` and `src/settings/` contain renderer interfaces and their preload scripts. `src/shared/` contains shared helpers.
- `src/progress/` handles local profiles, persistence, migration and backups. `src/transfer/` handles local transfer formats, mapping and bundled browser scripts.
- `server/` contains the Cloudflare Pages site and data build tools. The marker data itself is not in the repository.
- `tests/progress/` and `tests/transfer/` contain Node test suites; `tools/` contains build and recognition utilities.

## Working in this repository

- Follow the existing JavaScript and Electron patterns in the affected files. Keep main-process, preload and renderer responsibilities consistent with the existing boundaries.
- Preserve the documented privacy and game-interaction model: screen captures stay local, and the app does not read or modify game memory or files, inject into the game, or send it keys or clicks.
- Treat local progress and backups as user data. Preserve migration, recovery and read-only behavior when changing persistence; cover relevant failure paths.
- Transfer website automation is currently pending. Check `docs/map-transfers.md` and the provider capabilities before making claims about supported integrations. Generated scripts in `src/transfer/scripts/` are built with `npm run build:transfer-scripts`.
- Keep English and German user-facing text consistent with the existing localization approach. Consider Windows, macOS and Linux differences when changing platform behavior.

## Development and checks

- Install dependencies with `npm install`; start the app with `npm start`.
- Run `npm run test:progress` for progress changes and `npm run test:transfer` for transfer changes. Run both when changes cross those boundaries.
- Run `npm run test:match` for relevant map recognition changes. Desktop overlay and capture behavior may also require manual testing on the target platform.
- Before packaging transfer changes, run both suites and `npm run build:transfer-scripts`; follow `docs/map-transfers.md` for determinism and extracted-package verification.
- Packaging commands are `npm run dist` (Windows), `npm run dist:mac`, and `npm run dist:linux`. `npm run server:dev` runs the Pages site locally. Deployments and data imports are separate operations; inspect their effects before running them.
