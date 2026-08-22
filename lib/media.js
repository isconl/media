'use strict';
/**
 * Local-filesystem half of the media engine (BE26082009). OneDrive
 * playback needs none of this -- see manifest.js's header for why.
 *
 * Three jobs: sandboxed directory listing (cached, size-capped LRU),
 * short-lived signed streaming tickets (a media element's src can't carry
 * an Authorization header, so /stream is authorized by a signed token in
 * the query string instead of the fleet's normal bearer proxy), and
 * Range-aware file streaming for real seek/scrub support.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createLruCache } = require('./lru-cache');

const PLAYABLE_EXT = new Set([
  '.mp3', '.m4a', '.aac', '.flac', '.ogg', '.oga', '.wav', '.opus',
  '.mp4', '.m4v', '.webm', '.mov', '.mkv',
]);
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif']);

function createMediaClient({ localRoot, getTicketSecret, cacheMaxBytes = 8 * 1024 * 1024, ticketTtlMs = 10 * 60 * 1000 }) {
  if (!localRoot) throw new Error('createMediaClient requires localRoot');
  const root = path.resolve(localRoot);
  const listCache = createLruCache({ maxBytes: cacheMaxBytes });

  /** Resolves a client-supplied relative path against `root`, refusing any
   *  escape (`..`, an absolute path, a symlink pointing outside) -- the
   *  one thing a local-file-serving endpoint must never get wrong. */
  function safeResolve(relPath) {
    const rel = String(relPath || '').replace(/^\/+/, '');
    const abs = path.resolve(root, rel);
    const real = fs.existsSync(abs) ? fs.realpathSync(abs) : abs;
    if (real !== root && !real.startsWith(root + path.sep)) {
      throw new Error('path escapes MEDIA_LOCAL_DIR');
    }
    return abs;
  }

  function listDir(relPath) {
    const abs = safeResolve(relPath);
    const st = fs.statSync(abs);
    if (!st.isDirectory()) throw new Error('not a directory');

    const cacheKey = `${abs}:${st.mtimeMs}`;
    const cached = listCache.get(cacheKey);
    if (cached) return cached;

    const names = fs.readdirSync(abs, { withFileTypes: true });
    const entries = names
      .filter(d => !d.name.startsWith('.'))
      .map(d => {
        const entryAbs = path.join(abs, d.name);
        const entryRel = path.relative(root, entryAbs).split(path.sep).join('/');
        if (d.isDirectory()) {
          return { name: d.name, path: entryRel, type: 'dir' };
        }
        const ext = path.extname(d.name).toLowerCase();
        const est = fs.statSync(entryAbs);
        return {
          name: d.name, path: entryRel, type: 'file',
          playable: PLAYABLE_EXT.has(ext), image: IMAGE_EXT.has(ext),
          kind: ext.replace('.', ''),
          bytes: est.size, mtimeIso: est.mtime.toISOString(),
        };
      })
      .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));

    const result = { path: path.relative(root, abs).split(path.sep).join('/'), entries };
    const bytes = Buffer.byteLength(JSON.stringify(result));
    listCache.set(cacheKey, result, bytes);
    return result;
  }

  function b64url(buf) { return Buffer.from(buf).toString('base64url'); }

  function mintTicket(relPath) {
    const abs = safeResolve(relPath); // throws if the path doesn't resolve safely
    const st = fs.statSync(abs);
    if (!st.isFile()) throw new Error('not a file');
    const payload = { p: relPath, exp: Date.now() + ticketTtlMs };
    const payloadB64 = b64url(JSON.stringify(payload));
    const sig = crypto.createHmac('sha256', getTicketSecret()).update(payloadB64).digest('base64url');
    return `${payloadB64}.${sig}`;
  }

  /** Returns the safe absolute path for a valid, unexpired ticket, or null. */
  function verifyTicket(token) {
    const [payloadB64, sig] = String(token || '').split('.');
    if (!payloadB64 || !sig) return null;
    const expectedSig = crypto.createHmac('sha256', getTicketSecret()).update(payloadB64).digest('base64url');
    // Constant-time compare -- same reasoning as checkAuth()'s bearer-token check.
    const a = Buffer.from(sig), b = Buffer.from(expectedSig);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    let payload;
    try { payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')); } catch { return null; }
    if (!payload.exp || Date.now() > payload.exp) return null;
    try { return safeResolve(payload.p); } catch { return null; }
  }

  /** Range-aware file transfer -- a bare `res.end(fs.readFileSync(...))`
   *  can't scrub/seek: the browser needs 206 Partial Content + Content-Range
   *  to jump around an audio/video file instead of only ever playing it
   *  from the start. */
  function streamFile(req, res, absPath) {
    const st = fs.statSync(absPath);
    const ext = path.extname(absPath).toLowerCase();
    const mime = {
      '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.flac': 'audio/flac',
      '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.wav': 'audio/wav', '.opus': 'audio/opus',
      '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska',
      '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif',
    }[ext] || 'application/octet-stream';

    const range = req.headers.range;
    if (!range) {
      res.writeHead(200, { 'Content-Type': mime, 'Content-Length': st.size, 'Accept-Ranges': 'bytes' });
      fs.createReadStream(absPath).pipe(res);
      return;
    }
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    const start = m && m[1] ? parseInt(m[1], 10) : 0;
    const end = m && m[2] ? parseInt(m[2], 10) : st.size - 1;
    if (start >= st.size || end >= st.size || start > end) {
      res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
      res.end();
      return;
    }
    res.writeHead(206, {
      'Content-Type': mime, 'Accept-Ranges': 'bytes',
      'Content-Range': `bytes ${start}-${end}/${st.size}`,
      'Content-Length': end - start + 1,
    });
    fs.createReadStream(absPath, { start, end }).pipe(res);
  }

  return { listDir, mintTicket, verifyTicket, streamFile, root, cache: listCache };
}

module.exports = { createMediaClient, PLAYABLE_EXT, IMAGE_EXT };
