#!/usr/bin/env node
'use strict';
/**
 * media engine -- HTTP entry point. Same boot sequence/style as vault,
 * pulse, scope, circle, spark. BE26082009: local-filesystem browsing +
 * signed-ticket streaming; OneDrive playback reuses vault's existing
 * onedrive.browse.* downloadUrl (see manifest.js's header).
 */

const http = require('http');
const path = require('path');
const secretStore = require('../lib/secrets');
const { createAuditLog } = require('../lib/audit');
const { createMediaClient } = require('../lib/media');
const manifest = require('../lib/manifest');

const PORT = parseInt(process.env.MEDIA_PORT || process.env.PORT || '8086', 10);
const BIND = process.env.MEDIA_BIND || '127.0.0.1';
const LOGS_DIR = process.env.MEDIA_LOGS_DIR || path.join(__dirname, '..', 'runtime', 'logs');
// No hardcoded personal path -- an empty/neutral default the same way
// spark's ARTICLES_DIR is genericized; set MEDIA_LOCAL_DIR to browse
// anywhere real (e.g. a Music/Video library) on the machine this runs on.
const LOCAL_DIR = process.env.MEDIA_LOCAL_DIR || path.join(__dirname, '..', 'library');

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

let _devAuthBypassLog = null; // set once main() creates auditLog; used by ISCONL_DEV_NO_AUTH (BS26090501)

function checkAuth(req) {
  // BS26090501: dev-only, loopback-gated (enforced at boot below), env-only -- never request-derived.
  if (process.env.ISCONL_DEV_NO_AUTH === '1') {
    if (_devAuthBypassLog) _devAuthBypassLog.log('dev_auth_bypass', { engine: 'media', path: req.url });
    return true;
  }
  const token = process.env.MEDIA_TOKEN || process.env.ISCONL_TOKEN || secretStore.get('MEDIA_TOKEN') || '';
  if (!token) return false;
  const auth = req.headers.authorization || '';
  const provided = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  return provided.length === token.length && provided === token;
}

function getTicketSecret() {
  // Falls back to the same token used for bearer auth -- one secret to
  // configure, not two, and a ticket is scoped/short-lived regardless.
  return process.env.MEDIA_TICKET_SECRET || process.env.MEDIA_TOKEN || process.env.ISCONL_TOKEN || secretStore.get('MEDIA_TOKEN') || 'media-dev-secret';
}

async function main() {
  const secretsResult = await secretStore.init();
  console.log(`  secrets: ${secretsResult.source}, ${secretsResult.count} key(s)`);

  const auditLog = createAuditLog({ logsDir: LOGS_DIR });
  _devAuthBypassLog = auditLog;
  const media = createMediaClient({ localRoot: LOCAL_DIR, getTicketSecret, cacheMaxBytes: 8 * 1024 * 1024 });
  console.log(`  local library root: ${media.root}`);

  const tokenConfigured = !!(process.env.MEDIA_TOKEN || process.env.ISCONL_TOKEN || secretStore.get('MEDIA_TOKEN'));
  const isLoopback = ['127.0.0.1', '::1', 'localhost'].includes(BIND);
  if (process.env.ISCONL_DEV_NO_AUTH === '1' && !isLoopback) {
    console.error('  REFUSING TO BIND: ISCONL_DEV_NO_AUTH is set but BIND is not loopback -- dev auth bypass is loopback-only.');
    process.exit(1);
  }
  if (!isLoopback && !tokenConfigured) {
    console.error('  REFUSING TO BIND: no MEDIA_TOKEN/ISCONL_TOKEN configured and BIND is not loopback.');
    process.exit(1);
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const { pathname } = url;

    if (pathname === '/health' && req.method === 'GET') {
      return sendJson(res, 200, { status: 'ok', engine: 'media', version: manifest.version });
    }
    if (pathname === '/manifest' && req.method === 'GET') {
      return sendJson(res, 200, manifest);
    }

    // /stream is reached directly by the browser's <audio>/<video> src,
    // which can't carry an Authorization header -- authorized by the
    // signed ticket itself, not the bearer-token gate below.
    if (pathname === '/stream' && req.method === 'GET') {
      const abs = media.verifyTicket(url.searchParams.get('t') || '');
      if (!abs) return sendJson(res, 403, { error: 'Invalid or expired ticket' });
      try {
        media.streamFile(req, res, abs);
      } catch (e) {
        auditLog.log('stream_failed', { error: String(e.message || e) });
        if (!res.headersSent) sendJson(res, 500, { error: String(e.message || e) });
      }
      return;
    }

    if (!checkAuth(req)) return sendJson(res, 404, { error: 'Not Found' });

    try {
      if (pathname === '/local/list' && req.method === 'GET') {
        return sendJson(res, 200, media.listDir(url.searchParams.get('path') || ''));
      }
      if (pathname === '/local/ticket' && req.method === 'GET') {
        const p = url.searchParams.get('path') || '';
        const ticket = media.mintTicket(p);
        return sendJson(res, 200, { ticket, path: p });
      }
    } catch (e) {
      return sendJson(res, 400, { success: false, error: String(e.message || e) });
    }

    return sendJson(res, 404, { error: 'Not Found' });
  });

  return new Promise((resolve) => {
    server.listen(PORT, BIND, () => {
      const actualPort = server.address().port;
      console.log(`  media listening on ${BIND}:${actualPort}`);
      resolve({ server, media, auditLog, secretStore, port: actualPort });
    });
  });
}

if (require.main === module) {
  main().catch(e => { console.error('media failed to start:', e); process.exit(1); });
}

module.exports = { main };
