// Nimmt eine Kartenfahrt so auf, wie der Tracker sie sieht (1280 breit, 30 Bilder/s), für bench-track.js.
//   npx electron tools/record.js --name mondstadt --seconds 20 --delay 5 [--display 0] [--minimap]
// Ergebnis: testbilder/clips/<name>/ mit 00000.jpg … und frames.json { width, height, frames: [{ file, t }] }
// --minimap: zusätzlich die Ecke oben links in voller Auflösung (m00000.png), Bereich in frames.json als crop
// --full: zusätzlich das ganze Bild in voller Auflösung (f00000.jpg), z. B. für Fenstermodus/andere Seitenverhältnisse
// Overlay vorher ausschalten (F7), damit nur das Spiel im Bild ist.
const { app, BrowserWindow, desktopCapturer, ipcMain, screen, session } = require('electron');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const name = opt('name', `clip-${Date.now()}`);
const seconds = Number(opt('seconds', 20));
const delay = Number(opt('delay', 5));
const outDir = path.join(__dirname, '..', 'testbilder', 'clips', name);
// Ecke mit der Minimap, in 1080p-Pixeln (skaliert mit der Höhe)
const MINIMAP_CORNER = { x: 0, y: 0, w: 420, h: 330 };
const minimap = args.includes('--minimap');
const fullRes = args.includes('--full');

// Seite: Aufnahme lesen, auf 1280 verkleinern, als JPEG an den Hauptprozess
const PAGE = `
const { ipcRenderer } = require('electron');
(async () => {
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 30, max: 30 } }, audio: false });
  const reader = new MediaStreamTrackProcessor({ track: stream.getVideoTracks()[0], maxBufferSize: 4 }).readable.getReader();
  const end = performance.now() + ${seconds * 1000};
  let canvas = null;
  let corner = null;
  let crop = null;
  let whole = null;
  let busy = 0;
  let index = 0;
  let dropped = 0;
  while (performance.now() < end) {
    const { value: frame, done } = await reader.read();
    if (done) break;
    if (busy > 3) { frame.close(); dropped++; continue; }
    const w = 1280;
    const h = Math.round((w * frame.displayHeight) / frame.displayWidth);
    if (!canvas || canvas.height !== h) canvas = new OffscreenCanvas(w, h);
    canvas.getContext('2d').drawImage(frame, 0, 0, w, h);
    let cornerBlob = null;
    if (${minimap}) {
      const k = frame.displayHeight / 1080;
      crop = { x: Math.round(${MINIMAP_CORNER.x} * k), y: Math.round(${MINIMAP_CORNER.y} * k), w: Math.round(${MINIMAP_CORNER.w} * k), h: Math.round(${MINIMAP_CORNER.h} * k), frameW: frame.displayWidth, frameH: frame.displayHeight };
      if (!corner || corner.width !== crop.w || corner.height !== crop.h) corner = new OffscreenCanvas(crop.w, crop.h);
      corner.getContext('2d').drawImage(frame, crop.x, crop.y, crop.w, crop.h, 0, 0, crop.w, crop.h);
      cornerBlob = corner.convertToBlob({ type: 'image/png' });
    }
    let wholeBlob = null;
    if (${fullRes}) {
      if (!whole || whole.width !== frame.displayWidth || whole.height !== frame.displayHeight) whole = new OffscreenCanvas(frame.displayWidth, frame.displayHeight);
      whole.getContext('2d').drawImage(frame, 0, 0);
      wholeBlob = whole.convertToBlob({ type: 'image/jpeg', quality: 0.95 });
    }
    const t = frame.timestamp / 1000;
    frame.close();
    const i = index++;
    busy++;
    Promise.all([canvas.convertToBlob({ type: 'image/jpeg', quality: 0.92 }), cornerBlob, wholeBlob]).then(async ([blob, cb, wb]) => {
      ipcRenderer.send('frame', { i, t, w, h, crop, bytes: new Uint8Array(await blob.arrayBuffer()), corner: cb ? new Uint8Array(await cb.arrayBuffer()) : null, whole: wb ? new Uint8Array(await wb.arrayBuffer()) : null });
      busy--;
    });
  }
  stream.getTracks().forEach((t) => t.stop());
  while (busy) await new Promise((r) => setTimeout(r, 20));
  ipcRenderer.send('done', { dropped });
})();
`;

app.whenReady().then(async () => {
  const displays = screen.getAllDisplays();
  const primary = displays.findIndex((d) => d.id === screen.getPrimaryDisplay().id);
  const display = displays[Number(opt('display', primary))];
  session.defaultSession.setDisplayMediaRequestHandler(async (_req, callback) => {
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
    callback({ video: sources.find((s) => s.display_id === String(display.id)) || sources[0] });
  }, { useSystemPicker: false });

  fs.mkdirSync(outDir, { recursive: true });
  const frames = [];
  let size = null;
  let crop = null;
  ipcMain.on('frame', (_e, f) => {
    const file = `${String(f.i).padStart(5, '0')}.jpg`;
    fs.writeFileSync(path.join(outDir, file), Buffer.from(f.bytes));
    if (f.corner) fs.writeFileSync(path.join(outDir, `m${file.replace('.jpg', '.png')}`), Buffer.from(f.corner));
    if (f.whole) fs.writeFileSync(path.join(outDir, `f${file}`), Buffer.from(f.whole));
    frames.push({ file, t: f.t, ...(f.corner ? { corner: `m${file.replace('.jpg', '.png')}` } : {}), ...(f.whole ? { full: `f${file}` } : {}) });
    size = { width: f.w, height: f.h };
    if (f.crop) crop = f.crop;
  });
  ipcMain.on('done', (_e, info) => {
    frames.sort((a, b) => a.t - b.t);
    fs.writeFileSync(path.join(outDir, 'frames.json'), JSON.stringify({ ...size, ...(crop ? { crop } : {}), frames }));
    const span = frames.length > 1 ? (frames[frames.length - 1].t - frames[0].t) / 1000 : 0;
    console.log(`fertig: ${frames.length} Bilder in ${span.toFixed(1)} s (${(frames.length / Math.max(span, 0.001)).toFixed(1)}/s), ${info.dropped} verworfen → ${outDir}`);
    app.quit();
  });

  console.log(`Bildschirm ${display.id} (${display.size.width}×${display.size.height}), Aufnahme startet in ${delay} s für ${seconds} s …`);
  await new Promise((r) => setTimeout(r, delay * 1000));
  console.log('Aufnahme läuft');
  const win = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false } });
  // file:// gilt als sicher, about:blank nicht (dort fehlt getDisplayMedia)
  const blank = path.join(require('os').tmpdir(), 'gmo-record.html');
  fs.writeFileSync(blank, '<!doctype html><title>Aufnahme</title>');
  await win.loadFile(blank);
  win.webContents.executeJavaScript(PAGE);
});
