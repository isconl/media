'use strict';
/**
 * BS26090501: dev-only auth bypass flag, loopback-gated. Confirms the flag
 * actually bypasses (else the escape hatch is useless) AND that leaving it
 * unset keeps media's normal fail-closed behavior -- a future refactor
 * can't silently invert this.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

async function startServer(envOverrides = {}) {
  const logsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-e2e-logs-'));
  const localDir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-e2e-lib-'));
  const savedEnv = { ...process.env };
  Object.assign(process.env, {
    MEDIA_PORT: '0', MEDIA_BIND: '127.0.0.1',
    MEDIA_LOGS_DIR: logsDir, MEDIA_LOCAL_DIR: localDir,
    MEDIA_TOKEN: 'test-static-token', BWS_ACCESS_TOKEN: '',
    ...envOverrides,
  });
  delete require.cache[require.resolve('../src/server')];
  const { main } = require('../src/server');
  const handle = await main();
  const cleanup = () => {
    Object.keys(process.env).forEach(k => { if (!(k in savedEnv)) delete process.env[k]; });
    Object.assign(process.env, savedEnv);
  };
  return { ...handle, cleanup };
}

test('a protected route with no credential fails closed (silent 404)', async () => {
  const { server, port, cleanup } = await startServer();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/local/list`);
    assert.equal(res.status, 404);
  } finally { server.close(); cleanup(); }
});

test('ISCONL_DEV_NO_AUTH=1 bypasses auth on loopback', async () => {
  const { server, port, cleanup } = await startServer({ ISCONL_DEV_NO_AUTH: '1' });
  try {
    const res = await fetch(`http://127.0.0.1:${port}/local/list`);
    assert.notEqual(res.status, 404);
  } finally { server.close(); cleanup(); }
});

test('ISCONL_DEV_NO_AUTH unset still fails closed with no credential', async () => {
  const { server, port, cleanup } = await startServer();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/local/list`);
    assert.equal(res.status, 404);
  } finally { server.close(); cleanup(); }
});
