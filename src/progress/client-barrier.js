'use strict';

/**
 * Main-only FIFO around renderer intention drains and trusted bounded work.
 * Keep this queue outside ProgressService: a renderer may need that service to
 * finish its accepted edits before it can acknowledge preparation.
 *
 * @param {{overlayDrain:{prepare:Function,resume:Function,dispose:Function},quitDrain:{prepare:Function,resume:Function,dispose:Function}}} options
 * @returns {{run:<T>(operation:()=>Promise<T>|T)=>Promise<T>,shutdown:(operation:()=>Promise<void>)=>Promise<void>,active:()=>boolean,dispose:()=>void}}
 */
function createClientProgressBarrier({ overlayDrain, quitDrain }) {
  let tail = Promise.resolve();
  let preparing = false;
  let closing = false;
  let disposed = false;
  let shutdownPromise = null;
  const unavailable = () => Promise.reject(new Error('client-progress-barrier-closed'));
  function enqueue(operation) {
    const pending = tail.then(operation);
    tail = pending.catch(() => {});
    return pending;
  }
  return {
    active: () => preparing || closing,
    run(operation) {
      if (disposed || closing) return unavailable();
      return enqueue(async () => {
        if (disposed) throw new Error('client-progress-barrier-closed');
        preparing = true;
        try {
          await overlayDrain.prepare();
          if (disposed) throw new Error('client-progress-barrier-closed');
          return await operation();
        } finally {
          overlayDrain.resume();
          preparing = false;
        }
      });
    },
    shutdown(operation) {
      if (disposed) return unavailable();
      if (shutdownPromise) return shutdownPromise;
      // Close acceptance immediately, but preserve every already accepted run.
      closing = true;
      shutdownPromise = enqueue(async () => {
        try {
          if (disposed) throw new Error('client-progress-barrier-closed');
          await quitDrain.prepare();
          if (disposed) throw new Error('client-progress-barrier-closed');
          await operation();
          // Successful quit stays frozen until the owner disposes resources.
        } catch (error) {
          quitDrain.resume();
          closing = false;
          shutdownPromise = null;
          throw error;
        }
      });
      return shutdownPromise;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      overlayDrain.dispose();
      quitDrain.dispose();
    },
  };
}

module.exports = { createClientProgressBarrier };
