'use strict';
/**
 * media's capability manifest -- same lightweight MCP-tool-list stand-in as
 * vault's/pulse's/scope's/circle's/spark's manifests (Decision 003).
 *
 * OneDrive-side playback deliberately declares NO capabilities here: hub's
 * existing onedrive.browse.* capabilities (vault-backed, already shipped
 * for the File Manager) already return each file's Graph
 * @microsoft.graph.downloadUrl, a pre-signed direct link a browser
 * <audio>/<video> tag can already point straight at -- media's own job is
 * the local-filesystem half only, which has no existing engine.
 *
 * /stream is intentionally NOT declared as a capability -- it's reached
 * directly by the browser (a media element's src can't carry an
 * Authorization header), authorized by a short-lived signed ticket from
 * local.ticket instead of the fleet's normal bearer-token proxy path.
 */
module.exports = {
  engine: 'media',
  version: require('../package.json').version,
  description: 'Local media browsing, signed-ticket streaming, LRU listing cache. OneDrive playback reuses vault\'s existing onedrive.browse.* downloadUrl.',
  capabilities: [
    { name: 'media.local.list', method: 'GET', path: '/local/list', description: 'List a local directory (files + subfolders) under MEDIA_LOCAL_DIR, playable media files flagged.' },
    { name: 'media.local.ticket', method: 'GET', path: '/local/ticket', description: 'Mint a short-lived signed streaming ticket for one local file, for direct <audio>/<video> src use.' },
  ],
};
