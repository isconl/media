'use strict';
/**
 * Unit tests for the local-filesystem half of the media engine: sandboxed
 * listing, ticket mint/verify (including expiry and tamper rejection),
 * and Range-request byte-slicing. A real temp directory, not mocks --
 * fs behavior (symlink resolution, mtime) is exactly what a mock would
 * paper over and get wrong.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createMediaClient } = require('../lib/media');

function makeLibrary() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-test-'));
  fs.writeFileSync(path.join(dir, 'song.mp3'), Buffer.alloc(1000, 1));
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'not playable');
  fs.mkdirSync(path.join(dir, 'Album'));
  fs.writeFileSync(path.join(dir, 'Album', 'track.flac'), Buffer.alloc(500, 2));
  return dir;
}

test('listDir flags playable files and lists subfolders', () => {
  const dir = makeLibrary();
  const media = createMediaClient({ localRoot: dir, getTicketSecret: () => 'secret' });
  const listing = media.listDir('');
  const names = listing.entries.map(e => e.name);
  assert.ok(names.includes('song.mp3'));
  assert.ok(names.includes('Album'));
  const song = listing.entries.find(e => e.name === 'song.mp3');
  assert.equal(song.playable, true);
  const notes = listing.entries.find(e => e.name === 'notes.txt');
  assert.equal(notes.playable, false);
  const album = listing.entries.find(e => e.name === 'Album');
  assert.equal(album.type, 'dir');
});

test('listDir refuses to escape localRoot', () => {
  const dir = makeLibrary();
  const media = createMediaClient({ localRoot: dir, getTicketSecret: () => 'secret' });
  assert.throws(() => media.listDir('../../etc'));
});

test('ticket mint/verify round-trips and rejects tampering', () => {
  const dir = makeLibrary();
  const media = createMediaClient({ localRoot: dir, getTicketSecret: () => 'secret' });
  const ticket = media.mintTicket('song.mp3');
  const resolved = media.verifyTicket(ticket);
  assert.ok(resolved.endsWith('song.mp3'));

  assert.equal(media.verifyTicket(ticket + 'x'), null);
  assert.equal(media.verifyTicket(''), null);
});

test('ticket expires', () => {
  const dir = makeLibrary();
  const media = createMediaClient({ localRoot: dir, getTicketSecret: () => 'secret', ticketTtlMs: -1 });
  const ticket = media.mintTicket('song.mp3');
  assert.equal(media.verifyTicket(ticket), null);
});

test('streamFile serves a byte range with 206 + Content-Range', async () => {
  const dir = makeLibrary();
  const media = createMediaClient({ localRoot: dir, getTicketSecret: () => 'secret' });
  const abs = path.join(dir, 'song.mp3');

  const req = { headers: { range: 'bytes=100-199' } };
  let headResult = null;
  const chunks = [];
  const res = {
    writeHead(status, headers) { headResult = { status, headers }; },
    end() {},
    on() {},
  };
  // streamFile pipes a real ReadStream into res -- res needs to look
  // enough like a writable stream for .pipe() to work without throwing.
  res.write = (c) => { chunks.push(c); return true; };
  Object.setPrototypeOf(res, require('stream').Writable.prototype);

  await new Promise((resolve) => {
    const stream = fs.createReadStream(abs, { start: 100, end: 199 });
    stream.on('end', resolve);
    media.streamFile(req, res, abs);
    // media.streamFile creates its OWN stream internally; just wait a tick
    // for headers to be written, then assert on those.
    setImmediate(resolve);
  });

  assert.equal(headResult.status, 206);
  assert.equal(headResult.headers['Content-Range'], 'bytes 100-199/1000');
  assert.equal(headResult.headers['Content-Length'], 100);
});
