// Ablauf des Trackers ohne Aufnahme und IPC: Fluss nachführen, ORB verankern, Drift prüfen.
// Läuft im Tracker-Fenster und in der Messbank (Node).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./matcher-core'));
  else root.TrackerCore = factory(root.MatcherCore);
})(typeof self !== 'undefined' ? self : this, function (MatcherCore) {
  // Optischer Fluss trägt die offene Karte; ORB nur zum Verankern und gegen Drift:
  // - Abgleich alle checkMs, neu verankern erst bei zweimal > driftPx (einzelne ORB-Ausreißer ignorieren)
  // - lostAfter Fehlbilder hintereinander → verloren (einzelne Aussetzer beim schnellen Ziehen nicht)
  const DEFAULTS = {
    checkMs: 1000,
    driftPx: 5,
    lostAfter: 3,
    exclude: null,
    // Einstellungen für die Symbol-Maske (uiMask), gilt für den Fluss
    mask: null,
    // Worker-Prüfung mit so vielen Inliern gilt als sicher → schon beim ersten Treffer korrigieren (0 = aus)
    trustInliers: 0,
    // (img, prior) → Promise<Ergebnis wie Matcher.locate>, z. B. Worker; null = im selben Bild prüfen
    check: null,
  };

  // Ansicht als Abbildung Karte → Bild: p = s * m + t
  function compose(a, b) {
    return { s: a.s * b.s, tx: a.s * b.tx + a.tx, ty: a.s * b.ty + a.ty };
  }

  function invert(a) {
    return { s: 1 / a.s, tx: -a.tx / a.s, ty: -a.ty / a.s };
  }

  class TrackerCore {
    constructor(cv, matcher, options) {
      this.o = { ...DEFAULTS, ...(options || {}) };
      this.matcher = matcher;
      this.flow = new MatcherCore.FlowTracker(cv, { exclude: this.o.exclude, mask: this.o.mask });
      this.seq = 0;
      this.reset();
    }

    reset() {
      this.prior = null;
      this.lostFrames = 0;
      this.lastCheck = -Infinity;
      this.driftHits = 0;
      this.pending = null;
      this.correction = null;
      this.flow.reset();
    }

    get locked() {
      return !!this.prior;
    }

    // img = { data (RGBA), width, height }, now in ms → Ergebnis wie Matcher.locate
    step(img, now) {
      const { data, width, height } = img;
      let res = this.prior && this.flow.active ? this.follow(img, now) : null;
      if (!res || !res.ok) {
        res = this.matcher.locate(data, width, height, this.prior);
        // Nachführen gescheitert (z. B. schneller Zoom) → gleich im selben Bild neu suchen
        if (!res.ok && this.prior) res = this.matcher.locate(data, width, height, null);
        if (res.ok) this.anchor(img, res, now);
      }
      if (res.ok) {
        this.prior = res;
        this.lostFrames = 0;
      } else if (this.prior && ++this.lostFrames < this.o.lostAfter) {
        // Aussetzer: Ansicht halten
      } else {
        this.prior = null;
        this.pending = null;
        this.correction = null;
        this.flow.reset();
      }
      return res;
    }

    anchor(img, res, now) {
      this.flow.anchor(img.data, img.width, img.height, res);
      this.lastCheck = now;
      this.driftHits = 0;
      this.pending = null;
      this.correction = null;
    }

    follow(img, now) {
      let res = this.flow.track(img.data, img.width, img.height);
      if (!res.ok) return res;
      if (this.correction) {
        // Prüfung aus dem Worker: Fehler von damals auf das jetzige Bild übertragen
        res = { ...res, ...compose(res, this.correction), mode: 'check' };
        this.anchor(img, res, now);
        return res;
      }
      if (now - this.lastCheck < this.o.checkMs) return res;
      return this.o.check ? this.checkLater(img, res, now) : this.checkNow(img, res, now);
    }

    // Bisheriger Weg: ORB im selben Bild, blockiert den Fluss (~100 ms)
    checkNow(img, res, now) {
      this.lastCheck = now;
      const orb = this.matcher.locate(img.data, img.width, img.height, res);
      if (!orb.ok || MatcherCore.fitDistance(res, orb, img.width, img.height) <= this.o.driftPx) {
        this.driftHits = 0;
        return res;
      }
      if (++this.driftHits < 2) return res;
      this.anchor(img, orb, now);
      return orb;
    }

    // Worker prüft das Bild, der Fluss läuft weiter
    checkLater(img, res, now) {
      if (this.pending) return res;
      this.lastCheck = now;
      const id = ++this.seq;
      this.pending = { id, then: res, width: img.width, height: img.height };
      this.o.check(img, res).then(
        (orb) => this.checked(id, orb),
        () => { if (this.pending && this.pending.id === id) this.pending = null; },
      );
      return res;
    }

    // Fehlschläge zählen nicht und setzen auch nichts zurück (sonst hält ein Wechsel ok/nein eine Drift ewig)
    checked(id, orb) {
      const p = this.pending;
      if (!p || p.id !== id) return;
      this.pending = null;
      if (!orb || !orb.ok || !this.prior) return;
      if (MatcherCore.fitDistance(p.then, orb, p.width, p.height) <= this.o.driftPx) {
        this.driftHits = 0;
        return;
      }
      const sure = this.o.trustInliers > 0 && orb.inliers >= this.o.trustInliers;
      if (!sure && ++this.driftHits < 2) return;
      this.driftHits = 0;
      // Karte (echt) → Karte (laut Fluss); im nächsten Bild: Fluss ∘ Korrektur
      this.correction = compose(invert(p.then), orb);
    }
  }

  return { TrackerCore, DEFAULTS, compose, invert };
});
