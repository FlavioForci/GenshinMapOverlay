'use strict';

const defaultFs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { ProgressError } = require('./schema');

// These codes specifically mean that directory fsync is unavailable. In
// particular, permission errors and EIO must never be treated as unsupported.
const UNSUPPORTED_DIRECTORY_SYNC = new Set(['EINVAL', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS']);

/** Internal shared primitive. Windows has no supported directory-fsync phase. */
async function syncDirectory(directory, fs = defaultFs, platform = process.platform) {
  // File data is still synced before every rename on Windows. Skipping this
  // unsupported phase explicitly avoids swallowing permission errors elsewhere.
  if (platform === 'win32') return;
  let handle;
  try {
    handle = await fs.open(directory, 'r');
    await handle.sync();
  } catch (error) {
    if (!UNSUPPORTED_DIRECTORY_SYNC.has(error.code)) throw error;
  } finally {
    if (handle) await handle.close();
  }
}

/** Read at most maxBytes, including when the file grows after stat. */
async function readFileBounded(file, maxBytes, fs = defaultFs) {
  const handle = await fs.open(file, 'r');
  try {
    if ((await handle.stat()).size > maxBytes) throw new ProgressError('limit-exceeded');
    const chunks = [];
    let size = 0;
    for (;;) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, maxBytes + 1 - size));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) return Buffer.concat(chunks, size);
      size += bytesRead;
      if (size > maxBytes) throw new ProgressError('limit-exceeded');
      chunks.push(chunk.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
}

/**
 * Replace a file without ever unlinking its destination. The optional backup
 * receives the previous bytes before replacement; its caller must validate them.
 * Errors after replacement carry replacementOccurred=true and code
 * local-durability-uncertain, because successful rename cannot be rolled back.
 * @param {string} file
 * @param {Buffer} bytes
 * @param {{fs?:object,maxBytes:number,backupFile?:string,platform?:string}} options
 * @returns {Promise<void>}
 */
async function atomicWriteFile(file, bytes, { fs = defaultFs, maxBytes, backupFile, platform = process.platform } = {}) {
  if (!Buffer.isBuffer(bytes) || !Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new ProgressError('invalid-write');
  }
  if (bytes.length > maxBytes) throw new ProgressError('limit-exceeded');
  if (backupFile !== undefined && path.resolve(backupFile) === path.resolve(file)) {
    throw new ProgressError('invalid-write');
  }
  const directory = path.dirname(file);
  const temporary = path.join(directory, `.${path.basename(file)}.${randomUUID()}.tmp`);
  let handle;
  let renameAttempted = false;
  let replacementOccurred = false;
  try {
    handle = await fs.open(temporary, 'wx', 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    if (backupFile !== undefined) {
      let previous;
      try {
        previous = await readFileBounded(file, maxBytes, fs);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      if (previous !== undefined) {
        await atomicWriteFile(backupFile, previous, { fs, maxBytes, platform });
      }
    }
    renameAttempted = true;
    await fs.rename(temporary, file);
    replacementOccurred = true;
    await syncDirectory(directory, fs, platform);
  } catch (cause) {
    // A filesystem adapter may interrupt after performing rename. Check the
    // actual destination rather than claiming the older bytes still win.
    if (renameAttempted && !replacementOccurred) {
      try {
        replacementOccurred = (await readFileBounded(file, maxBytes, fs)).equals(bytes);
      } catch (error) {
        replacementOccurred = error.code !== 'ENOENT';
      }
    }
    const error = new ProgressError(replacementOccurred ? 'local-durability-uncertain' : 'local-write-failed');
    error.replacementOccurred = replacementOccurred;
    throw error;
  } finally {
    if (handle) await handle.close().catch(() => {});
    await fs.unlink(temporary).catch(() => {});
  }
}

module.exports = { atomicWriteFile, readFileBounded, syncDirectory };
