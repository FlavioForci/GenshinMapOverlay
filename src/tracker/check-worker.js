// Drift-Prüfung (ORB, ~100 ms) neben dem Tracker-Fenster, damit der Fluss nicht stockt.
// Nachrichten: init { bytes, options } → ready; check { id, data, width, height, prior } → result { id, res }
/* global MatcherCore */
importScripts('matcher-core.js', '../../node_modules/@techstark/opencv-js/dist/opencv.js');

let matcher = null;

const cvReady = new Promise((resolve) => {
  const mod = self.cv;
  if (typeof mod.then === 'function') mod.then(resolve);
  else if (mod.Mat) resolve(mod);
  else mod.onRuntimeInitialized = () => resolve(mod);
});

self.onmessage = async (event) => {
  const msg = event.data;
  if (msg.type === 'init') {
    const cv = await cvReady;
    const { ref } = MatcherCore.deserializeReference(new Uint8Array(msg.bytes));
    matcher = new MatcherCore.Matcher(cv, ref, msg.options);
    self.postMessage({ type: 'ready' });
  } else if (msg.type === 'check') {
    let res = null;
    try {
      const r = matcher.locate(new Uint8ClampedArray(msg.data), msg.width, msg.height, msg.prior);
      res = { ok: r.ok, mode: r.mode, s: r.s, tx: r.tx, ty: r.ty, inliers: r.inliers, pairs: r.pairs, spread: r.spread, ms: r.ms };
    } catch (err) {
      res = { ok: false, error: String(err && err.message ? err.message : err) };
    }
    self.postMessage({ type: 'result', id: msg.id, res });
  }
};
