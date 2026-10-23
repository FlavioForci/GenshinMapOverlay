// Tasten-Helfer: dieselbe exe mit --hotkey-helper, als Admin, ohne Fenster.
// - Genshin läuft als Admin → Windows (UIPI) gibt Hotkeys dann nur an Admin-Prozesse
// - Overlay selbst nicht als Admin, sonst startet Chromium keine Bildschirmaufnahme
const crypto = require('crypto');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { app, globalShortcut } = require('electron');

function argValue(name) {
  const prefix = `--${name}=`;
  const arg = process.argv.find((a) => a.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : null;
}

function lineReader(socket, onLine) {
  let buffer = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk) => {
    buffer += chunk;
    let at;
    while ((at = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, at).trim();
      buffer = buffer.slice(at + 1);
      if (line) onLine(line);
    }
  });
}

// ---------- Helfer (Admin) ----------

function runHelper() {
  // Eigenes Profil, sonst Konflikt mit dem des Overlays
  app.setPath('userData', path.join(app.getPath('userData'), 'hotkey-helper'));
  app.disableHardwareAcceleration();
  app.on('window-all-closed', () => {});

  app.whenReady().then(() => {
    const socket = net.connect(Number(argValue('helper-port')), '127.0.0.1', () => {
      socket.write(`hello ${argValue('helper-token')}\n`);
    });
    const send = (msg) => socket.write(`${JSON.stringify(msg)}\n`);
    lineReader(socket, (line) => {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (!msg.hotkeys) return;
      globalShortcut.unregisterAll();
      const errors = [];
      for (const [name, accelerator] of Object.entries(msg.hotkeys)) {
        if (!accelerator) continue;
        let ok = false;
        try {
          ok = globalShortcut.register(accelerator, () => send({ type: 'hotkey', name }));
        } catch {
          ok = false;
        }
        if (!ok) errors.push(name);
      }
      send({ type: 'registered', errors });
    });
    socket.on('close', () => app.quit());
    socket.on('error', () => app.quit());
  });
}

// ---------- Overlay (normale Rechte) ----------

class HotkeyBridge {
  // onHotkey(name), onStatus({ connected, errors }), log(text)
  constructor({ onHotkey, onStatus, log }) {
    this.onHotkey = onHotkey;
    this.onStatus = onStatus;
    this.log = log;
    this.server = null;
    this.socket = null;
    this.token = null;
    this.starting = false;
    this.hotkeys = {};
  }

  get connected() {
    return !!this.socket;
  }

  setHotkeys(hotkeys) {
    this.hotkeys = hotkeys;
    if (this.socket) this.socket.write(`${JSON.stringify({ hotkeys })}\n`);
  }

  async listen() {
    if (this.server) return this.server.address().port;
    this.server = net.createServer((socket) => this.accept(socket));
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', resolve);
    });
    return this.server.address().port;
  }

  accept(socket) {
    let authed = false;
    socket.on('error', () => {});
    lineReader(socket, (line) => {
      if (!authed) {
        // Einmal-Token: kennt nur der eben gestartete Helfer
        if (this.token && line === `hello ${this.token}`) {
          authed = true;
          this.token = null;
          this.starting = false;
          if (this.socket) this.socket.destroy();
          this.socket = socket;
          this.log('hotkey-helper: verbunden');
          // errors: null → Overlay gibt seine Kürzel frei, bevor der Helfer sie registriert
          this.onStatus({ connected: true, errors: null });
          socket.write(`${JSON.stringify({ hotkeys: this.hotkeys })}\n`);
        } else {
          socket.destroy();
        }
        return;
      }
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (msg.type === 'hotkey') this.onHotkey(msg.name);
      if (msg.type === 'registered') this.onStatus({ connected: true, errors: msg.errors || [] });
    });
    socket.on('close', () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.log('hotkey-helper: getrennt');
      this.onStatus({ connected: false, errors: [] });
    });
  }

  // RunAs → ggf. UAC-Abfrage. false = abgelehnt oder fehlgeschlagen
  async start() {
    if (this.socket || this.starting) return true;
    this.starting = true;
    try {
      const port = await this.listen();
      this.token = crypto.randomBytes(16).toString('hex');
      const exe = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
      const args = [...(process.defaultApp ? [app.getAppPath()] : []), '--hotkey-helper', `--helper-port=${port}`, `--helper-token=${this.token}`];
      const quote = (s) => `'${String(s).replace(/'/g, "''")}'`;
      const command = `Start-Process -FilePath ${quote(exe)} -Verb RunAs -ArgumentList ${args.map((a) => quote(`"${a}"`)).join(',')}`;
      const code = await new Promise((resolve) => {
        const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true });
        ps.on('exit', resolve);
        ps.on('error', () => resolve(1));
      });
      if (code !== 0) {
        this.starting = false;
        this.token = null;
        this.log('hotkey-helper: Start abgebrochen');
        return false;
      }
      this.log('hotkey-helper: gestartet');
      // Kein hello binnen 20 s → Start gescheitert
      setTimeout(() => {
        if (this.starting) {
          this.starting = false;
          this.token = null;
          this.log('hotkey-helper: keine Verbindung');
        }
      }, 20000);
      return true;
    } catch (err) {
      this.starting = false;
      this.log(`hotkey-helper: Fehler – ${err.message}`);
      return false;
    }
  }
}

module.exports = { runHelper, HotkeyBridge, isHelperProcess: () => process.argv.includes('--hotkey-helper') };
