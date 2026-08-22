'use strict';
/**
 * Minimal size-capped LRU, mirroring `_kit/cache/`'s eviction shape
 * (bounded total bytes, oldest-touched evicted first) rather than a
 * bounded entry COUNT -- a handful of huge directory listings shouldn't
 * be treated the same as a thousand tiny ones.
 *
 * Byte size per entry is caller-supplied (JSON.stringify(...).length for
 * a directory listing here) rather than measured here, since "how big is
 * this value" is a judgment call specific to what's being cached.
 */
function createLruCache({ maxBytes = 8 * 1024 * 1024 } = {}) {
  const map = new Map(); // key -> { value, bytes }
  let totalBytes = 0;

  function evictUntilFits(incomingBytes) {
    while (totalBytes + incomingBytes > maxBytes && map.size > 0) {
      const oldestKey = map.keys().next().value;
      const entry = map.get(oldestKey);
      map.delete(oldestKey);
      totalBytes -= entry.bytes;
    }
  }

  return {
    get(key) {
      if (!map.has(key)) return undefined;
      const entry = map.get(key);
      map.delete(key);
      map.set(key, entry); // move to the end (most-recently-used)
      return entry.value;
    },
    set(key, value, bytes) {
      if (map.has(key)) { totalBytes -= map.get(key).bytes; map.delete(key); }
      evictUntilFits(bytes);
      map.set(key, { value, bytes });
      totalBytes += bytes;
    },
    delete(key) {
      if (!map.has(key)) return;
      totalBytes -= map.get(key).bytes;
      map.delete(key);
    },
    get size() { return map.size; },
    get bytes() { return totalBytes; },
  };
}

module.exports = { createLruCache };
