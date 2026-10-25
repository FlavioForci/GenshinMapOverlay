'use strict';

/** Prevent native quit until accepted persistence drains. Failed attempts remain retryable. */
function createQuitGuard({ shutdown, quit, onReady = () => {}, onError = () => {} }) {
  let complete = false;
  let pending = null;
  return {
    ready: () => complete,
    beforeQuit(event) {
      if (complete) return;
      event.preventDefault();
      if (pending) return pending;
      pending = (async () => {
        try {
          await shutdown();
          onReady();
          complete = true;
          quit();
        } catch (error) { onError(error); }
        finally { pending = null; }
      })();
      return pending;
    },
  };
}

module.exports = { createQuitGuard };

/**
 * Main-owned, bounded prepare/ack protocol. Clients freeze their own acceptance
 * before draining; only their captured live local main frame can acknowledge.
 * No renderer operation, path or source text is accepted through this protocol.
 */
function createRendererQuitDrain({ ipcMain, getClients, uuid = require('node:crypto').randomUUID,
  setTimer = setTimeout, clearTimer = clearTimeout }) {
  let active = null;
  let disposed = false;
  const live = client => client.window && !client.window.isDestroyed()
    && client.window.webContents && !client.window.webContents.isDestroyed();
  const current = client => live(client) && client.window.webContents === client.contents
    && getClients().some(value => value.window === client.window && value.url === client.url)
    && client.contents.getURL() === client.url;

  function stop(request) {
    clearTimer(request.timer);
    request.cleanups.splice(0).forEach(cleanup => cleanup());
  }
  function fail(request) {
    if (active !== request || request.settled) return;
    request.settled = true;
    stop(request);
    request.reject(new Error('renderer-quit-drain-failed'));
  }
  function finish(request) {
    if (request.settled || request.clients.some(client => !client.ready)) return;
    if (request.clients.some(client => !current(client) || client.contents.mainFrame !== client.frame)) { fail(request); return; }
    request.settled = true;
    stop(request);
    request.resolve();
  }
  function sendPrepare(request, client) {
    if (active !== request || request.settled || client.sent) return;
    if (!current(client)) { fail(request); return; }
    client.frame = client.contents.mainFrame;
    client.sent = true;
    try { client.contents.send('progress:prepare-quit', { requestId: request.id }); }
    catch { fail(request); }
  }
  function listen(request, emitter, event, callback) {
    emitter.on(event, callback);
    request.cleanups.push(() => emitter.removeListener(event, callback));
  }
  function acknowledge(event, payload, ...extra) {
    const request = active;
    if (!request || request.settled || extra.length || !payload || typeof payload !== 'object') return;
    const descriptors = Object.getOwnPropertyDescriptors(payload);
    if (Reflect.ownKeys(descriptors).length !== 2 || !descriptors.requestId?.enumerable || !descriptors.ok?.enumerable
      || !Object.hasOwn(descriptors.requestId, 'value') || !Object.hasOwn(descriptors.ok, 'value')
      || descriptors.requestId.value !== request.id || typeof descriptors.ok.value !== 'boolean') return;
    const client = request.clients.find(value => value.sent && !value.ready && current(value)
      && event?.sender === value.contents && event.senderFrame === value.frame && value.contents.mainFrame === value.frame);
    if (!client) return;
    if (!descriptors.ok.value) { fail(request); return; }
    client.ready = true;
    finish(request);
  }
  ipcMain.on('progress:quit-ready', acknowledge);

  return {
    active: () => active !== null,
    prepare() {
      if (disposed) return Promise.reject(new Error('renderer-quit-drain-disposed'));
      if (active) return active.promise;
      const request = { id: uuid(), clients: [], cleanups: [], settled: false, timer: null };
      request.promise = new Promise((resolve, reject) => { request.resolve = resolve; request.reject = reject; });
      active = request;
      request.clients = getClients().filter(live).map(value => ({ ...value, contents: value.window.webContents, sent: false, ready: false }));
      request.timer = setTimer(() => fail(request), 10000);
      for (const client of request.clients) {
        if (request.settled) break;
        listen(request, client.window, 'closed', () => fail(request));
        listen(request, client.contents, 'destroyed', () => fail(request));
        listen(request, client.contents, 'render-process-gone', () => fail(request));
        listen(request, client.contents, 'did-start-navigation', (_event, _url, _inPlace, isMainFrame) => {
          if (client.sent && isMainFrame !== false) fail(request);
        });
        listen(request, client.contents, 'did-finish-load', () => sendPrepare(request, client));
        const loading = typeof client.contents.isLoadingMainFrame === 'function'
          ? client.contents.isLoadingMainFrame() : client.contents.isLoading();
        const url = client.contents.getURL();
        if (!loading && url === client.url) sendPrepare(request, client);
        else if (!loading && url !== '' && url !== 'about:blank') fail(request);
      }
      finish(request);
      return request.promise;
    },
    resume() {
      const request = active;
      if (!request) return;
      if (!request.settled) fail(request);
      stop(request);
      for (const client of request.clients) {
        if (client.sent && current(client) && client.contents.mainFrame === client.frame) {
          try { client.contents.send('progress:resume-after-quit', { requestId: request.id }); }
          catch { /* A destroyed client will initialize unfrozen when reopened. */ }
        }
      }
      active = null;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (active) {
        if (!active.settled) fail(active);
        stop(active);
      }
      active = null;
      ipcMain.removeListener('progress:quit-ready', acknowledge);
    },
  };
}

module.exports.createRendererQuitDrain = createRendererQuitDrain;
