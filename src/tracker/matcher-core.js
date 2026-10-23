// Bildvergleich: welcher Kartenausschnitt ist auf dem Screenshot zu sehen?
// ORB-Merkmale Screenshot vs. Referenz (aus den Kacheln), RANSAC → bildschirm = s * karte + t.
// Läuft im Tracker-Fenster und in den Test-Tools (Node).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MatcherCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const DESC_BYTES = 32;

  const DEFAULTS = {
    reference: { density: 0.0006, scaleFactor: 1.2, nlevels: 3, fastThreshold: 10 },
    maxWidth: 1280,
    // Grobsuche: kleines Bild, ganze Referenz. Läuft auch ohne offene Karte → billig halten.
    global: { width: 640, nfeatures: 1200, scaleFactor: 1.2, nlevels: 6, fastThreshold: 10, minInliers: 12, retryInliers: 5 },
    // Volle Auflösung, wenn die Grobsuche knapp scheitert (≥ retryInliers, gut verteilt):
    // - z. B. nah reingezoomt mit viel Meer
    // - ohne offene Karte keine Treffer → der teure Versuch entfällt
    globalDetail: { nfeatures: 2500, scaleFactor: 1.2, nlevels: 6, fastThreshold: 10, minInliers: 12 },
    // Nachführen: volles Bild, nur Referenzpunkte in der Nähe und mit passender Zoomstufe.
    // nlevels 6 = Pyramide bis 1/2.5, nötig wenn weiter reingezoomt als die feinste Referenz.
    track: { nfeatures: 1500, scaleFactor: 1.2, nlevels: 6, fastThreshold: 10, minInliers: 12 },
    lsh: { tables: 16, bits: 13 },
    ratio: 0.8,
    maxHamming: 70,
    ransacIterations: 1500,
    inlierThreshold: 5, // Pixel im jeweils genutzten Bild
    minSpread: 0.25, // Inlier über ≥ 1/4 von Breite und Höhe → schließt die Minikarte aus
    zoomRange: [-4.5, 2.5], // erlaubtes log2(s): s = Bildschirmpixel je Kartenpixel
    globalLevels: null, // null = alle Referenz-Zoomstufen
    maskUi: true, // Symbole/Schrift der Ingame-Karte ausblenden
  };

  function mergeOptions(options) {
    const o = { ...DEFAULTS, ...(options || {}) };
    for (const key of ['reference', 'global', 'globalDetail', 'track', 'lsh']) o[key] = { ...DEFAULTS[key], ...((options && options[key]) || {}) };
    return o;
  }

  function rgbaToGray(cv, rgba, width, height) {
    const rgbaMat = new cv.Mat(height, width, cv.CV_8UC4);
    rgbaMat.data.set(rgba);
    const gray = new cv.Mat();
    cv.cvtColor(rgbaMat, gray, cv.COLOR_RGBA2GRAY);
    rgbaMat.delete();
    return gray;
  }

  function createOrb(cv, nfeatures, p) {
    return new cv.ORB(nfeatures, p.scaleFactor, p.nlevels, 31, 0, 2, cv.ORB_HARRIS_SCORE, 31, p.fastThreshold);
  }

  // usable: optionale Maske, 0 = dort keine Merkmale suchen
  function detect(cv, gray, nfeatures, params, usable) {
    const orb = createOrb(cv, nfeatures, params);
    const keypoints = new cv.KeyPointVector();
    const descriptors = new cv.Mat();
    const mask = usable || new cv.Mat();
    orb.detectAndCompute(gray, mask, keypoints, descriptors);
    const count = Math.min(keypoints.size(), descriptors.rows);
    const pts = new Float64Array(count * 2);
    for (let i = 0; i < count; i++) {
      const kp = keypoints.get(i);
      pts[2 * i] = kp.pt.x;
      pts[2 * i + 1] = kp.pt.y;
    }
    const desc = new Uint8Array(descriptors.data.subarray(0, count * DESC_BYTES));
    orb.delete();
    keypoints.delete();
    descriptors.delete();
    if (!usable) mask.delete();
    return { count, pts, desc };
  }

  // Symbole/Schrift der Ingame-Karte ausblenden (fehlen in den Kacheln):
  // - fast weiß, orange Schilder, sehr dunkle Rahmen, jeweils samt Rand (erode)
  function uiMask(cv, rgba, width, height) {
    const mask = new cv.Mat(height, width, cv.CV_8U);
    const m = mask.data;
    for (let i = 0, p = 0; p < m.length; i += 4, p++) {
      const r = rgba[i];
      const g = rgba[i + 1];
      const b = rgba[i + 2];
      const min = r < g ? (r < b ? r : b) : (g < b ? g : b);
      const max = r > g ? (r > b ? r : b) : (g > b ? g : b);
      const white = min > 215;
      const orange = r > 190 && b < 110 && r - b > 100 && g > 100 && g < 200;
      const dark = max < 45;
      m[p] = white || orange || dark ? 0 : 255;
    }
    const kernel = cv.Mat.ones(9, 9, cv.CV_8U);
    cv.erode(mask, mask, kernel);
    kernel.delete();
    return mask;
  }

  // origin*/mapPerPx: Bildpixel → Kartenpixel. Nur Punkte im Kern, sonst doppeln sich Blöcke.
  function referenceBlock(cv, rgba, width, height, block, options) {
    const o = mergeOptions(options);
    const gray = rgbaToGray(cv, rgba, width, height);
    const coreArea = block.coreW * block.coreH;
    const found = detect(cv, gray, Math.max(200, Math.round(coreArea * o.reference.density)), o.reference);
    gray.delete();
    const pts = [];
    const desc = [];
    for (let i = 0; i < found.count; i++) {
      const px = found.pts[2 * i];
      const py = found.pts[2 * i + 1];
      if (px < block.coreX || py < block.coreY || px >= block.coreX + block.coreW || py >= block.coreY + block.coreH) continue;
      pts.push(block.originX + px * block.mapPerPx, block.originY + py * block.mapPerPx);
      desc.push(found.desc.subarray(i * DESC_BYTES, (i + 1) * DESC_BYTES));
    }
    const out = new Uint8Array(desc.length * DESC_BYTES);
    desc.forEach((d, i) => out.set(d, i * DESC_BYTES));
    return { count: desc.length, pts: Float64Array.from(pts), desc: out, level: block.level };
  }

  function buildReference(blocks) {
    const count = blocks.reduce((n, b) => n + b.count, 0);
    const pts = new Float64Array(count * 2);
    const desc = new Uint8Array(count * DESC_BYTES);
    const level = new Uint8Array(count);
    let at = 0;
    for (const b of blocks) {
      pts.set(b.pts, at * 2);
      desc.set(b.desc, at * DESC_BYTES);
      level.fill(b.level, at, at + b.count);
      at += b.count;
    }
    return indexReference({ count, pts, desc, level });
  }

  function indexReference(ref) {
    return { ...ref, levels: [...new Set(ref.level)].sort((a, b) => a - b) };
  }

  // Teil-Referenz für einige Zoomstufen: eigene Indizes, gleiche Kartenpixel
  function referenceLevels(ref, levels) {
    const keep = [];
    for (let i = 0; i < ref.count; i++) if (levels.includes(ref.level[i])) keep.push(i);
    const pts = new Float64Array(keep.length * 2);
    const desc = new Uint8Array(keep.length * DESC_BYTES);
    const level = new Uint8Array(keep.length);
    keep.forEach((src, i) => {
      pts[2 * i] = ref.pts[2 * src];
      pts[2 * i + 1] = ref.pts[2 * src + 1];
      desc.set(ref.desc.subarray(src * DESC_BYTES, (src + 1) * DESC_BYTES), i * DESC_BYTES);
      level[i] = ref.level[src];
    });
    return indexReference({ count: keep.length, pts, desc, level });
  }

  // Format: u32 JSON-Länge, JSON-Kopf, dann pts, desc, level
  function serializeReference(ref, meta) {
    const head = new TextEncoder().encode(JSON.stringify({ ...meta, count: ref.count }));
    const total = 4 + head.length + ref.count * (16 + DESC_BYTES + 1);
    const buf = new Uint8Array(total);
    new DataView(buf.buffer).setUint32(0, head.length, true);
    buf.set(head, 4);
    let at = 4 + head.length;
    buf.set(new Uint8Array(ref.pts.buffer, ref.pts.byteOffset, ref.count * 16), at);
    at += ref.count * 16;
    buf.set(ref.desc.subarray(0, ref.count * DESC_BYTES), at);
    at += ref.count * DESC_BYTES;
    buf.set(ref.level.subarray(0, ref.count), at);
    return buf;
  }

  function deserializeReference(bytes) {
    const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const headLen = new DataView(buf.buffer, buf.byteOffset).getUint32(0, true);
    const meta = JSON.parse(new TextDecoder().decode(buf.subarray(4, 4 + headLen)));
    const count = meta.count;
    let at = 4 + headLen;
    const pts = new Float64Array(count * 2);
    new Uint8Array(pts.buffer).set(buf.subarray(at, at + count * 16));
    at += count * 16;
    // Kopien: Node-Buffer teilen sich Speicher und sind evtl. nicht ausgerichtet
    const desc = new Uint8Array(buf.subarray(at, at + count * DESC_BYTES));
    at += count * DESC_BYTES;
    const level = new Uint8Array(buf.subarray(at, at + count));
    return { meta, ref: indexReference({ count, pts, desc, level }) };
  }

  // LSH statt Vergleich mit allen Referenzpunkten:
  // - Schlüssel = zufällig gewählte Bits der Beschreibung, eine Hash-Tabelle je Auswahl
  // - verglichen wird nur, was in mind. einer Tabelle denselben Schlüssel hat
  function toWords(desc, count) {
    if (desc.byteOffset % 4 === 0) return new Uint32Array(desc.buffer, desc.byteOffset, count * 8);
    return new Uint32Array(new Uint8Array(desc.subarray(0, count * DESC_BYTES)).buffer);
  }

  function popcount(x) {
    x -= (x >>> 1) & 0x55555555;
    x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
    return Math.imul((x + (x >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24;
  }

  function hamming(a, ai, b, bi) {
    return popcount(a[ai] ^ b[bi]) + popcount(a[ai + 1] ^ b[bi + 1]) + popcount(a[ai + 2] ^ b[bi + 2])
      + popcount(a[ai + 3] ^ b[bi + 3]) + popcount(a[ai + 4] ^ b[bi + 4]) + popcount(a[ai + 5] ^ b[bi + 5])
      + popcount(a[ai + 6] ^ b[bi + 6]) + popcount(a[ai + 7] ^ b[bi + 7]);
  }

  function lshKey(words, base, positions) {
    let key = 0;
    for (let b = 0; b < positions.length; b++) {
      const p = positions[b];
      key |= ((words[base + (p >>> 5)] >>> (p & 31)) & 1) << b;
    }
    return key;
  }

  function buildLsh(ref, tables, bits) {
    let seed = 20240917;
    const rnd = () => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return seed / 4294967296;
    };
    const words = toWords(ref.desc, ref.count);
    const size = 1 << bits;
    const list = [];
    for (let t = 0; t < tables; t++) {
      const chosen = new Set();
      while (chosen.size < bits) chosen.add((rnd() * 256) | 0);
      const positions = Int32Array.from(chosen);
      const keys = new Uint32Array(ref.count);
      const offsets = new Uint32Array(size + 1);
      for (let i = 0; i < ref.count; i++) {
        keys[i] = lshKey(words, i * 8, positions);
        offsets[keys[i] + 1]++;
      }
      for (let k = 0; k < size; k++) offsets[k + 1] += offsets[k];
      const fill = offsets.slice(0, size);
      const items = new Int32Array(ref.count);
      for (let i = 0; i < ref.count; i++) items[fill[keys[i]]++] = i;
      list.push({ positions, offsets, items });
    }
    return { words, tables: list, stamp: new Uint32Array(ref.count), generation: 0 };
  }

  // accept(refIdx): Filter nach Ausschnitt/Zoomstufe.
  // Ratio-Test nur gegen entfernte Kandidaten (gleicher Punkt, andere Stufe zählt nicht)
  function matchLsh(query, ref, lsh, accept, o) {
    const qWords = toWords(query.desc, query.count);
    const { words, tables, stamp } = lsh;
    const far2 = 64 * 64;
    const pairs = [];
    for (let q = 0; q < query.count; q++) {
      const gen = ++lsh.generation;
      const qBase = q * 8;
      let best = -1;
      let bestD = 1e9;
      let second = -1;
      let secondD = 1e9;
      for (const table of tables) {
        const key = lshKey(qWords, qBase, table.positions);
        const end = Math.min(table.offsets[key + 1], table.offsets[key] + 256);
        for (let k = table.offsets[key]; k < end; k++) {
          const r = table.items[k];
          if (stamp[r] === gen) continue;
          stamp[r] = gen;
          if (accept && !accept(r)) continue;
          const d = hamming(qWords, qBase, words, r * 8);
          if (d < bestD) {
            if (best >= 0) {
              const dx = ref.pts[2 * r] - ref.pts[2 * best];
              const dy = ref.pts[2 * r + 1] - ref.pts[2 * best + 1];
              if (dx * dx + dy * dy > far2) {
                second = best;
                secondD = bestD;
              }
            }
            best = r;
            bestD = d;
          } else if (d < secondD) {
            const dx = ref.pts[2 * r] - ref.pts[2 * best];
            const dy = ref.pts[2 * r + 1] - ref.pts[2 * best + 1];
            if (dx * dx + dy * dy > far2) {
              second = r;
              secondD = d;
            }
          }
        }
      }
      if (best < 0 || bestD > o.maxHamming) continue;
      if (second >= 0 && bestD >= o.ratio * secondD) continue;
      pairs.push({ q, r: best, d: bestD });
    }
    return pairs;
  }

  // RANSAC für bildschirm = s * karte + t, ohne Drehung: Ingame-Karte ist immer genordet
  function ransacSimilarity(query, ref, pairs, o, width, height) {
    const n = pairs.length;
    if (n < 4) return null;
    const qx = new Float64Array(n);
    const qy = new Float64Array(n);
    const rx = new Float64Array(n);
    const ry = new Float64Array(n);
    pairs.forEach((p, i) => {
      qx[i] = query.pts[2 * p.q];
      qy[i] = query.pts[2 * p.q + 1];
      rx[i] = ref.pts[2 * p.r];
      ry[i] = ref.pts[2 * p.r + 1];
    });
    const thr2 = o.inlierThreshold * o.inlierThreshold;
    const [logMin, logMax] = o.zoomRange;
    const cosTol = Math.cos((8 * Math.PI) / 180);
    let best = null;

    const countInliers = (s, tx, ty, collect) => {
      let c = 0;
      for (let i = 0; i < n; i++) {
        const ex = s * rx[i] + tx - qx[i];
        const ey = s * ry[i] + ty - qy[i];
        if (ex * ex + ey * ey < thr2) {
          c++;
          if (collect) collect.push(i);
        }
      }
      return c;
    };

    for (let it = 0; it < o.ransacIterations; it++) {
      const i = (Math.random() * n) | 0;
      const j = (Math.random() * n) | 0;
      if (i === j) continue;
      const dxr = rx[j] - rx[i];
      const dyr = ry[j] - ry[i];
      const dxq = qx[j] - qx[i];
      const dyq = qy[j] - qy[i];
      const dr = Math.hypot(dxr, dyr);
      const dq = Math.hypot(dxq, dyq);
      if (dr < 1e-6 || dq < 20) continue;
      if ((dxr * dxq + dyr * dyq) / (dr * dq) < cosTol) continue;
      const s = dq / dr;
      const ls = Math.log2(s);
      if (ls < logMin || ls > logMax) continue;
      const tx = qx[i] - s * rx[i];
      const ty = qy[i] - s * ry[i];
      const c = countInliers(s, tx, ty, null);
      if (!best || c > best.count) best = { s, tx, ty, count: c };
    }
    if (!best || best.count < 4) return null;

    // Kleinste Quadrate über alle Inlier, zwei Runden für eine stabilere Inlier-Menge
    let { s, tx, ty } = best;
    let inliers = [];
    for (let round = 0; round < 2; round++) {
      inliers = [];
      countInliers(s, tx, ty, inliers);
      if (inliers.length < 4) return null;
      let mqx = 0;
      let mqy = 0;
      let mrx = 0;
      let mry = 0;
      for (const i of inliers) {
        mqx += qx[i];
        mqy += qy[i];
        mrx += rx[i];
        mry += ry[i];
      }
      const m = inliers.length;
      mqx /= m;
      mqy /= m;
      mrx /= m;
      mry /= m;
      let num = 0;
      let den = 0;
      for (const i of inliers) {
        num += (qx[i] - mqx) * (rx[i] - mrx) + (qy[i] - mqy) * (ry[i] - mry);
        den += (rx[i] - mrx) ** 2 + (ry[i] - mry) ** 2;
      }
      if (den <= 0) return null;
      s = num / den;
      tx = mqx - s * mrx;
      ty = mqy - s * mry;
    }

    let minQx = Infinity;
    let maxQx = -Infinity;
    let minQy = Infinity;
    let maxQy = -Infinity;
    for (const i of inliers) {
      minQx = Math.min(minQx, qx[i]);
      maxQx = Math.max(maxQx, qx[i]);
      minQy = Math.min(minQy, qy[i]);
      maxQy = Math.max(maxQy, qy[i]);
    }
    return {
      s,
      tx,
      ty,
      inliers: inliers.length,
      inlierIdx: inliers,
      candidates: n,
      spreadX: (maxQx - minQx) / width,
      spreadY: (maxQy - minQy) / height,
    };
  }

  function resized(cv, gray, scale, interpolation) {
    const out = new cv.Mat();
    cv.resize(gray, out, new cv.Size(Math.round(gray.cols * scale), Math.round(gray.rows * scale)), 0, 0, interpolation || cv.INTER_AREA);
    return out;
  }

  class Matcher {
    constructor(cv, ref, options) {
      this.cv = cv;
      this.ref = ref;
      this.o = mergeOptions(options);
      this.lsh = buildLsh(ref, this.o.lsh.tables, this.o.lsh.bits);
      // Grobsuche: eigener, kleinerer Index nur mit globalLevels
      const levels = this.o.globalLevels;
      if (levels && levels.length && !ref.levels.every((z) => levels.includes(z))) {
        this.globalRef = referenceLevels(ref, levels);
        this.globalLsh = buildLsh(this.globalRef, this.o.lsh.tables, this.o.lsh.bits);
      } else {
        this.globalRef = ref;
        this.globalLsh = this.lsh;
      }
    }

    // prior (Pixel dieses Bildes) → nur Punkte nahe dem letzten Ausschnitt, passender Zoom
    pass(gray, params, prior, usable) {
      const started = Date.now();
      const query = detect(this.cv, gray, params.nfeatures, params, usable);
      const tDetect = Date.now() - started;
      const { pts, level } = this.ref;
      let accept = null;
      let levels = this.globalRef.levels;
      let ref = this.globalRef;
      let lsh = this.globalLsh;
      if (prior) {
        ref = this.ref;
        lsh = this.lsh;
        const { s, tx, ty } = prior;
        const x0 = (0 - tx) / s;
        const x1 = (gray.cols - tx) / s;
        const y0 = (0 - ty) / s;
        const y1 = (gray.rows - ty) / s;
        const mx = (x1 - x0) * 0.6;
        const my = (y1 - y0) * 0.6;
        // Pyramide der Aufnahme verkleinert → Referenzstufen dürfen gröber sein als der Zoom
        const zView = 13 + Math.log2(s);
        levels = this.ref.levels.filter((z) => z - zView >= -2.2 && z - zView <= 0.9);
        if (!levels.length) levels = [this.ref.levels.reduce((a, b) => (Math.abs(b - zView) < Math.abs(a - zView) ? b : a))];
        const lx0 = x0 - mx;
        const lx1 = x1 + mx;
        const ly0 = y0 - my;
        const ly1 = y1 + my;
        const levelOk = new Uint8Array(32);
        for (const z of levels) levelOk[z] = 1;
        accept = (r) => levelOk[level[r]] === 1 && pts[2 * r] >= lx0 && pts[2 * r] <= lx1 && pts[2 * r + 1] >= ly0 && pts[2 * r + 1] <= ly1;
      }
      const pairs = matchLsh(query, ref, lsh, accept, this.o);
      const tMatch = Date.now() - started - tDetect;
      const fit = ransacSimilarity(query, ref, pairs, this.o, gray.cols, gray.rows);
      const ok = !!fit && fit.inliers >= params.minInliers && fit.spreadX >= this.o.minSpread && fit.spreadY >= this.o.minSpread;
      return { ok, fit, levels, pairs: pairs.length, features: query.count, tDetect, tMatch };
    }

    // prior: letztes Ergebnis (Original-Bildschirmpixel) → nur in der Nähe suchen.
    // Ohne prior: Grobsuche auf kleinem Bild, bei Erfolg Feinsuche zur Bestätigung.
    locate(rgba, width, height, prior) {
      const cv = this.cv;
      const started = Date.now();
      let gray = rgbaToGray(cv, rgba, width, height);
      let usable = this.o.maskUi ? uiMask(cv, rgba, width, height) : null;
      const scale = Math.min(1, this.o.maxWidth / width);
      if (scale < 1) {
        const small = resized(cv, gray, scale);
        gray.delete();
        gray = small;
        if (usable) {
          const smallMask = resized(cv, usable, scale, cv.INTER_NEAREST);
          usable.delete();
          usable = smallMask;
        }
      }

      const timing = { detect: 0, match: 0 };
      let mode = 'track';
      let start = prior ? { s: prior.s * scale, tx: prior.tx * scale, ty: prior.ty * scale } : null;
      let result = null;

      if (!start) {
        mode = 'global';
        const gScale = Math.min(1, this.o.global.width / gray.cols);
        const small = gScale < 1 ? resized(cv, gray, gScale) : gray;
        const smallMask = usable && gScale < 1 ? resized(cv, usable, gScale, cv.INTER_NEAREST) : usable;
        const coarse = this.pass(small, this.o.global, null, smallMask);
        if (small !== gray) small.delete();
        if (smallMask && smallMask !== usable) smallMask.delete();
        timing.detect += coarse.tDetect;
        timing.match += coarse.tMatch;
        result = coarse;
        if (coarse.ok) {
          start = { s: coarse.fit.s / gScale, tx: coarse.fit.tx / gScale, ty: coarse.fit.ty / gScale };
        } else if (gScale < 1 && coarse.fit && coarse.fit.inliers >= this.o.global.retryInliers
          && coarse.fit.spreadX >= this.o.minSpread && coarse.fit.spreadY >= this.o.minSpread) {
          mode = 'global-detail';
          const detail = this.pass(gray, this.o.globalDetail, null, usable);
          timing.detect += detail.tDetect;
          timing.match += detail.tMatch;
          result = detail;
          if (detail.ok) start = { s: detail.fit.s, tx: detail.fit.tx, ty: detail.fit.ty };
        }
      }

      if (start) {
        const fine = this.pass(gray, this.o.track, start, usable);
        timing.detect += fine.tDetect;
        timing.match += fine.tMatch;
        result = fine;
      }
      gray.delete();
      if (usable) usable.delete();

      const fit = result.fit;
      return {
        ok: result.ok,
        mode,
        ms: Date.now() - started,
        timing,
        features: result.features,
        levels: result.levels,
        pairs: result.pairs,
        inliers: fit ? fit.inliers : 0,
        spread: fit ? [fit.spreadX, fit.spreadY] : [0, 0],
        // in Original-Bildschirmpixeln
        s: fit ? fit.s / scale : 0,
        tx: fit ? fit.tx / scale : 0,
        ty: fit ? fit.ty / scale : 0,
      };
    }
  }

  // Nachführen per optischem Fluss (Lucas-Kanade) zwischen zwei Aufnahmen:
  // - Punkte bekommen beim Verankern eine feste Kartenkoordinate → Fehler summieren sich nicht
  // - Karte steht → Fluss ~0 → ruhig; ORB nur zum Verankern und Nachprüfen
  const FLOW_DEFAULTS = {
    maxPoints: 200,
    minPoints: 40, // darunter verloren
    refillBelow: 150, // darunter neue Punkte dazu
    quality: 0.01,
    minDistance: 12,
    winSize: 15,
    maxLevel: 3,
    maxBackError: 1, // Vorwärts-Rückwärts-Abweichung in Pixeln
    inlierThreshold: 2,
    minInlierRatio: 0.5,
    minSpread: 0.2,
    exclude: null, // (W, H) → [[x0, y0, x1, y1]]: feste Bedienelemente, dort keine Punkte
  };

  class FlowTracker {
    constructor(cv, options) {
      this.cv = cv;
      this.o = { ...FLOW_DEFAULTS, ...(options || {}) };
      this.ransac = { ...DEFAULTS, inlierThreshold: this.o.inlierThreshold, ransacIterations: 300 };
      this.criteria = new cv.TermCriteria(cv.TERM_CRITERIA_EPS | cv.TERM_CRITERIA_COUNT, 30, 0.01);
      this.prev = null;
      this.pts = null; // Bildpixel, x/y abwechselnd
      this.map = null; // Kartenpixel je Punkt
      this.fit = null;
    }

    get active() {
      return !!this.prev;
    }

    reset() {
      if (this.prev) this.prev.delete();
      this.prev = null;
      this.pts = null;
      this.map = null;
      this.fit = null;
    }

    // Punkte im Bild suchen, Kartenkoordinate über fit (s, tx, ty in Pixeln dieses Bildes)
    anchor(rgba, width, height, fit) {
      this.reset();
      const gray = rgbaToGray(this.cv, rgba, width, height);
      this.pts = new Float64Array(0);
      this.map = new Float64Array(0);
      this.addPoints(gray, this.pointMask(rgba, width, height), fit);
      this.prev = gray;
      this.fit = fit;
    }

    // Kartenfläche ohne Symbole/Schrift und ohne feste Bedienelemente
    pointMask(rgba, width, height) {
      const cv = this.cv;
      const mask = uiMask(cv, rgba, width, height);
      for (const [x0, y0, x1, y1] of this.o.exclude ? this.o.exclude(width, height) : []) {
        cv.rectangle(mask, new cv.Point(Math.round(x0), Math.round(y0)), new cv.Point(Math.round(x1), Math.round(y1)), new cv.Scalar(0), -1);
      }
      return mask;
    }

    addPoints(gray, mask, fit) {
      const cv = this.cv;
      const room = this.o.maxPoints - this.pts.length / 2;
      if (room <= 0) {
        mask.delete();
        return;
      }
      // wie goodFeaturesToTrack (fehlt in opencv.js): stärkste Shi-Tomasi-Ecke je Rasterzelle
      const eig = new cv.Mat();
      cv.cornerMinEigenVal(gray, eig, 7, 3);
      const E = eig.data32F;
      const M = mask.data;
      const W = gray.cols;
      const H = gray.rows;
      let maxV = 0;
      for (let i = 0; i < E.length; i++) if (M[i] && E[i] > maxV) maxV = E[i];
      const thr = maxV * this.o.quality;
      const cell = this.o.minDistance * 2;
      const candidates = [];
      for (let cy = 0; cy + cell <= H; cy += cell) {
        for (let cx = 0; cx + cell <= W; cx += cell) {
          let best = -1;
          let bestV = thr;
          for (let y = cy; y < cy + cell; y++) {
            for (let x = cx, i = y * W + cx; x < cx + cell; x++, i++) {
              if (M[i] && E[i] > bestV) {
                bestV = E[i];
                best = i;
              }
            }
          }
          if (best >= 0) candidates.push([best % W, (best / W) | 0, bestV]);
        }
      }
      eig.delete();
      mask.delete();
      candidates.sort((a, b) => b[2] - a[2]);
      const found = candidates.slice(0, room).flatMap(([x, y]) => [x, y]);
      const pts = new Float64Array(this.pts.length + found.length);
      const map = new Float64Array(pts.length);
      pts.set(this.pts);
      map.set(this.map);
      for (let i = 0; i < found.length; i += 2) {
        const k = this.pts.length + i;
        pts[k] = found[i];
        pts[k + 1] = found[i + 1];
        map[k] = (found[i] - fit.tx) / fit.s;
        map[k + 1] = (found[i + 1] - fit.ty) / fit.s;
      }
      this.pts = pts;
      this.map = map;
    }

    // Nächstes Bild → wie Matcher.locate: { ok, s, tx, ty, inliers, ... }
    track(rgba, width, height) {
      const cv = this.cv;
      const started = Date.now();
      const fail = (why) => ({ ok: false, mode: 'flow', why, ms: Date.now() - started, inliers: 0, s: 0, tx: 0, ty: 0 });
      if (!this.prev) return fail('nicht verankert');
      const n = this.pts.length / 2;
      if (n < this.o.minPoints) return fail('zu wenige Punkte');
      const gray = rgbaToGray(cv, rgba, width, height);
      const p0 = cv.matFromArray(n, 1, cv.CV_32FC2, Array.from(this.pts));
      const p1 = new cv.Mat();
      const back = new cv.Mat();
      const st1 = new cv.Mat();
      const st2 = new cv.Mat();
      const err = new cv.Mat();
      const win = new cv.Size(this.o.winSize, this.o.winSize);
      cv.calcOpticalFlowPyrLK(this.prev, gray, p0, p1, st1, err, win, this.o.maxLevel, this.criteria);
      cv.calcOpticalFlowPyrLK(gray, this.prev, p1, back, st2, err, win, this.o.maxLevel, this.criteria);

      // nur Punkte, die vorwärts und zurück am selben Fleck landen
      const a = p0.data32F;
      const b = p1.data32F;
      const c = back.data32F;
      const keep = [];
      for (let i = 0; i < n; i++) {
        if (!st1.data[i] || !st2.data[i]) continue;
        if (Math.hypot(c[2 * i] - a[2 * i], c[2 * i + 1] - a[2 * i + 1]) > this.o.maxBackError) continue;
        keep.push(i);
      }
      const q = new Float64Array(keep.length * 2);
      const r = new Float64Array(keep.length * 2);
      keep.forEach((i, k) => {
        q[2 * k] = b[2 * i];
        q[2 * k + 1] = b[2 * i + 1];
        r[2 * k] = this.map[2 * i];
        r[2 * k + 1] = this.map[2 * i + 1];
      });
      [p0, p1, back, st1, st2, err].forEach((m) => m.delete());

      const pairs = keep.map((_, k) => ({ q: k, r: k }));
      const fit = keep.length >= this.o.minPoints ? ransacSimilarity({ pts: q }, { pts: r }, pairs, this.ransac, width, height) : null;
      const ok = !!fit && fit.inliers >= this.o.minPoints && fit.inliers >= keep.length * this.o.minInlierRatio
        && fit.spreadX >= this.o.minSpread && fit.spreadY >= this.o.minSpread;
      if (!ok) {
        gray.delete();
        return fail(fit ? 'zu wenige Inlier' : 'Punkte verloren');
      }

      // nur Inlier behalten, bei Bedarf auffüllen
      this.pts = new Float64Array(fit.inliers * 2);
      this.map = new Float64Array(fit.inliers * 2);
      fit.inlierIdx.forEach((k, j) => {
        this.pts[2 * j] = q[2 * k];
        this.pts[2 * j + 1] = q[2 * k + 1];
        this.map[2 * j] = r[2 * k];
        this.map[2 * j + 1] = r[2 * k + 1];
      });
      if (fit.inliers < this.o.refillBelow) {
        const mask = this.pointMask(rgba, width, height);
        for (let j = 0; j < fit.inliers; j++) cv.circle(mask, new cv.Point(Math.round(this.pts[2 * j]), Math.round(this.pts[2 * j + 1])), this.o.minDistance, new cv.Scalar(0), -1);
        this.addPoints(gray, mask, fit);
      }
      this.prev.delete();
      this.prev = gray;
      this.fit = fit;
      return {
        ok: true,
        mode: 'flow',
        ms: Date.now() - started,
        inliers: fit.inliers,
        pairs: keep.length,
        spread: [fit.spreadX, fit.spreadY],
        s: fit.s,
        tx: fit.tx,
        ty: fit.ty,
      };
    }
  }

  // größte Abweichung zweier Ergebnisse in Bildpixeln (Ecken + Mitte)
  function fitDistance(a, b, width, height) {
    let worst = 0;
    for (const [px, py] of [[0, 0], [width, 0], [0, height], [width, height], [width / 2, height / 2]]) {
      const mx = (px - a.tx) / a.s;
      const my = (py - a.ty) / a.s;
      worst = Math.max(worst, Math.hypot(b.s * mx + b.tx - px, b.s * my + b.ty - py));
    }
    return worst;
  }

  return {
    DESC_BYTES,
    DEFAULTS,
    detect,
    rgbaToGray,
    referenceBlock,
    buildReference,
    serializeReference,
    deserializeReference,
    Matcher,
    FlowTracker,
    fitDistance,
  };
});
