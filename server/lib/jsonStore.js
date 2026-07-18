const fs = require('fs');
const path = require('path');

function readJson(filePath, defaultValue) {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return defaultValue;
    throw err;
  }
}

// On Windows, a rename onto an existing file can transiently fail with
// EPERM/EACCES/EBUSY when antivirus, the Search Indexer, or another
// scanner briefly holds an open handle on the source or destination
// path. The lock is normally released within milliseconds, so a short,
// bounded retry with escalating backoff clears the vast majority of
// these without masking a genuine permission problem (which will still
// fail after all retries and be re-thrown).
const RETRYABLE_RENAME_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const RENAME_RETRY_DELAYS_MS = [10, 20, 40, 80, 160];

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function renameWithRetry(tmpPath, filePath, { renameFn = fs.renameSync } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= RENAME_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      renameFn(tmpPath, filePath);
      return;
    } catch (err) {
      lastErr = err;
      if (!RETRYABLE_RENAME_CODES.has(err.code) || attempt === RENAME_RETRY_DELAYS_MS.length) {
        break;
      }
      sleepSync(RENAME_RETRY_DELAYS_MS[attempt]);
    }
  }
  // All attempts exhausted (or a non-retryable error occurred). Clean up
  // the leftover tmp file so failed writes don't accumulate cruft, but
  // never let a cleanup failure hide the original error.
  try {
    fs.unlinkSync(tmpPath);
  } catch (_cleanupErr) {
    // ignore - best-effort cleanup only
  }
  throw lastErr;
}

function writeJson(filePath, value, options) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(value, null, 2), 'utf-8');
  renameWithRetry(tmpPath, filePath, options);
}

module.exports = { readJson, writeJson };
