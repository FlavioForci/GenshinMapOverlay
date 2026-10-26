// Position der Spielfigur aus der Minimap (Weltansicht), für Marker auf der Minimap.
// Minimap-Kreis gegen ein Kachelbild um die letzte Position, normierte Korrelation (Grauwerte).
// - Start an einem Anker: die große Karte öffnet sich auf die Spielfigur zentriert
// - Minimap ist genordet; Zoom je nach Gegend (offene Welt / Stadt) → Stufe mitbestimmen, sonst nur Verschiebung
// - arbeitet in 1080p-Pixeln: der Tracker skaliert die Ecke oben links (GEOMETRY.corner) auf 1080p
// Läuft im Tracker-Fenster und in der Messbank (Node).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MinimapCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  // Gemessen bei 1080p (testbilder/clips/welt1, welt2): Spielfigur bei (168, 125), Kartenkreis r ≈ 100.
  // Bildschirmpixel je Kartenpixel (z13): offene Welt 1,2, Stadt 3,6; skaliert mit der Bildhöhe
  const GEOMETRY = { cx: 168, cy: 125, radius: 100, scales: [1.2, 3.6], corner: { x: 0, y: 0, w: 420, h: 330 } };

  // - tplRadius: Vergleichskreis innerhalb des Rings, arrowRadius: Pfeil der Spielfigur ausblenden
  // - search: Suchweite je Schritt (px), margin: Vorrat des Kachelbilds rundum (px)
  // - minCorr: darunter unsicher (nichts anzeigen), lostMs: so lange unsicher → aufgeben bis zum nächsten Anker
  // - maxJump: größerer Sprung je Schritt gilt als Fehltreffer (px)
  // - zoomCheckEvery: so oft (Schritte) auch die anderen Zoomstufen prüfen, zoomCheckBelow: bei schwächerer Korrelation immer
  // - zoomSwitchCorr/zoomSwitchMargin: Wechsel nur bei so guter Korrelation und so viel Vorsprung
  // - waitRender: auf neues Kachelbild warten statt im Hintergrund (Messbank)
  const DEFAULTS = {
    tplRadius: 86, arrowRadius: 18, search: 24, margin: 160, minCorr: 0.5, lostMs: 3000, maxJump: 40,
    zoomCheckEvery: 8, zoomCheckBelow: 0.8, zoomSwitchCorr: 0.75, zoomSwitchMargin: 0.08, waitRender: false,
  };

  class MinimapTracker {
    // render(cx, cy, scale, size) → Promise<{ data (RGBA), width, height }>: Kachelbild size×size um Kartenpunkt cx/cy
    constructor(cv, render, options) {
      this.cv = cv;
      this.render = render;
      this.o = { ...DEFAULTS, ...(options || {}) };
      const R = this.o.tplRadius;
      this.mask = new cv.Mat(2 * R, 2 * R, cv.CV_8U, new cv.Scalar(0));
      cv.circle(this.mask, new cv.Point(R, R), R - 3, new cv.Scalar(255), -1);
      cv.circle(this.mask, new cv.Point(R, R), this.o.arrowRadius, new cv.Scalar(0), -1);
      this.regions = new Map();
      this.rendering = new Map();
      this.pos = null;
      this.scale = null;
      this.lastGood = 0;
      this.steps = 0;
    }

    get active() {
      return !!this.pos;
    }

    start(x, y, now) {
      this.pos = { x, y };
      this.lastGood = now;
      this.fresh = true;
    }

    stop() {
      this.pos = null;
    }

    // Kachelbild (Grau, float) je Zoomstufe um p, groß genug für Vergleichskreis + Suche + Vorrat.
    // Neu rendern läuft im Hintergrund (erstes Laden der Kacheln dauert bis ~1 s), solange gilt das alte.
    // wait: auf das Rendern warten (Messbank, für wiederholbare Ergebnisse)
    async ensureRegion(p, s, wait) {
      const r = this.regions.get(s);
      const keep = this.o.margin - this.o.search;
      if (r && Math.abs(p.x - r.x) * s < keep && Math.abs(p.y - r.y) * s < keep) return;
      if (!this.rendering.has(s)) {
        const size = 2 * (this.o.tplRadius + this.o.margin);
        const at = { x: p.x, y: p.y };
        this.rendering.set(s, this.render(at.x, at.y, s, size).then((img) => {
          const cv = this.cv;
          const rgba = new cv.Mat(img.height, img.width, cv.CV_8UC4);
          rgba.data.set(img.data);
          const gray = new cv.Mat();
          cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY);
          const f = new cv.Mat();
          gray.convertTo(f, cv.CV_32F);
          rgba.delete();
          gray.delete();
          const old = this.regions.get(s);
          if (old) old.mat.delete();
          this.regions.set(s, { x: at.x, y: at.y, size, mat: f });
        }).finally(() => { this.rendering.delete(s); }));
      }
      if (wait) await this.rendering.get(s);
    }

    // Vergleich bei Zoomstufe s um die letzte Position → { corr, x, y } oder null (Kachelbild fehlt/zu klein)
    match(tpl, s, S) {
      const cv = this.cv;
      const R = this.o.tplRadius;
      const reg = this.regions.get(s);
      if (!reg) return null;
      const half = reg.size / 2;
      const px = half + (this.pos.x - reg.x) * s;
      const py = half + (this.pos.y - reg.y) * s;
      const x0 = Math.max(0, Math.round(px - R - S));
      const y0 = Math.max(0, Math.round(py - R - S));
      const x1 = Math.min(reg.size, Math.round(px + R + S));
      const y1 = Math.min(reg.size, Math.round(py + R + S));
      if (x1 - x0 <= 2 * R || y1 - y0 <= 2 * R) return null;
      const win = reg.mat.roi(new cv.Rect(x0, y0, x1 - x0, y1 - y0));
      const out = new cv.Mat();
      cv.matchTemplate(win, tpl, out, cv.TM_CCOEFF_NORMED, this.mask);
      const mm = cv.minMaxLoc(out);
      // Sub-Pixel: Parabel durch die Nachbarn der Spitze
      const at = (x, y) => out.floatAt(y, x);
      const { x: mxl, y: myl } = mm.maxLoc;
      let fx = 0;
      let fy = 0;
      if (mxl > 0 && mxl < out.cols - 1) {
        const a = at(mxl - 1, myl), b = at(mxl, myl), c = at(mxl + 1, myl);
        const d = a - 2 * b + c;
        if (d < 0) fx = Math.max(-0.5, Math.min(0.5, (a - c) / (2 * d)));
      }
      if (myl > 0 && myl < out.rows - 1) {
        const a = at(mxl, myl - 1), b = at(mxl, myl), c = at(mxl, myl + 1);
        const d = a - 2 * b + c;
        if (d < 0) fy = Math.max(-0.5, Math.min(0.5, (a - c) / (2 * d)));
      }
      win.delete();
      out.delete();
      // Mitte des Treffers im Kachelbild → Kartenpixel
      return { corr: mm.maxVal, x: reg.x + (x0 + mxl + fx + R - half) / s, y: reg.y + (y0 + myl + fy + R - half) / s };
    }

    // corner = Ecke oben links in 1080p-Pixeln ({ data (RGBA), width, height }), now in ms
    async step(corner, now) {
      if (!this.pos) return { ok: false };
      const cv = this.cv;
      const R = this.o.tplRadius;
      // erster Schritt nach dem Anker: weiter suchen (Figur kann sich beim Schließen der Karte schon bewegt haben)
      const S = this.fresh ? this.o.search * 2 : this.o.search;
      // nach Anker/Verlust alle Zoomstufen, sonst die aktuelle und ab und zu die anderen (Stadt betreten/verlassen)
      this.steps++;
      const sure = this.scale && !this.fresh && this.lastCorr >= this.o.zoomCheckBelow;
      const scales = sure && this.steps % this.o.zoomCheckEvery ? [this.scale] : GEOMETRY.scales;
      await Promise.all(scales.map((s) => this.ensureRegion(this.pos, s, this.o.waitRender)));

      const rgba = new cv.Mat(corner.height, corner.width, cv.CV_8UC4);
      rgba.data.set(corner.data);
      const roi = rgba.roi(new cv.Rect(GEOMETRY.cx - R, GEOMETRY.cy - R, 2 * R, 2 * R));
      const gray = new cv.Mat();
      cv.cvtColor(roi, gray, cv.COLOR_RGBA2GRAY);
      const tpl = new cv.Mat();
      gray.convertTo(tpl, cv.CV_32F);
      [rgba, roi, gray].forEach((m) => m.delete());

      let best = null;
      let current = null;
      for (const s of scales) {
        const m = this.match(tpl, s, S);
        if (!m || !Number.isFinite(m.corr)) continue;
        if (s === this.scale) current = { ...m, s };
        if (!best || m.corr > best.corr) best = { ...m, s };
      }
      tpl.delete();
      if (!best) return this.unsure(now, NaN);
      // Zoom nur wechseln, wenn die andere Stufe deutlich besser passt, und das zweimal hintereinander
      // (sonst springt die Figur bei unscharfer Minimap, z. B. 768p, auf einen Zufallstreffer)
      if (this.scale && !this.fresh && best.s !== this.scale) {
        const clear = best.corr >= this.o.zoomSwitchCorr && best.corr - (current ? current.corr : 0) >= this.o.zoomSwitchMargin;
        if (!(clear && this.zoomVote === best.s)) {
          this.zoomVote = clear ? best.s : null;
          if (current) best = current;
          else return this.unsure(now, best.corr);
        } else {
          this.zoomVote = null;
        }
      } else {
        this.zoomVote = null;
      }
      this.lastCorr = best.corr;
      if (best.corr < this.o.minCorr) return this.unsure(now, best.corr);

      const jump = Math.hypot(best.x - this.pos.x, best.y - this.pos.y) * best.s;
      if (!this.fresh && best.s === this.scale && jump > this.o.maxJump) return this.unsure(now, best.corr);
      this.pos = { x: best.x, y: best.y };
      this.scale = best.s;
      this.lastGood = now;
      this.fresh = false;
      return { ok: true, x: best.x, y: best.y, scale: best.s, corr: best.corr };
    }

    unsure(now, corr) {
      if (now - this.lastGood > this.o.lostMs) this.stop();
      return { ok: false, corr, lost: !this.pos };
    }
  }

  return { MinimapTracker, GEOMETRY, DEFAULTS };
});
