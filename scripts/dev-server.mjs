import http from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {loadAppIntegrations, publicFile, STATIC_MIME_TYPES} from './app-integrations.mjs';
import {proxyRequest} from './proxy-request.mjs';
import {handlePortalControl} from './portal-instance.mjs';
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PRIVATE = new Set(['web.config', 'deploy', 'data', 'services', 'logs', 'scripts', 'tests', 'node_modules']);

function inside(base, target) {
  const relative = path.relative(base, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export function parseRequestPath(rawUrl) {
  const rawPath = rawUrl.split('?')[0];
  if (!rawPath.startsWith('/') || rawPath.startsWith('//')) throw new Error('Invalid path');
  // Validate the original string before WHATWG URL normalization can erase traversal.
  if (/%(?:2f|5c)/i.test(rawPath)) throw new Error('Encoded separator');
  const decoded = decodeURIComponent(rawPath);
  if (/[\\%:#\x00-\x1f\x7f]/.test(decoded) || decoded.includes('//')) throw new Error('Invalid path');
  const parts = decoded.split('/').filter(Boolean);
  if (parts.some(part => part === '.' || part === '..' || part.startsWith('.') || PRIVATE.has(part.toLowerCase()) || /[. ]$/.test(part))) throw new Error('Private path');
  return { pathname: decoded, parts };
}

/** Local-only preview; the optional loopback SOP bridge does not provide Windows authentication. */
export function createServer({ root = PROJECT_ROOT, portalRoot = path.join(root, 'portal'), sopProxy = null, applications = null, runtime = null } = {}) {
  if (sopProxy && (!Number.isInteger(sopProxy.port) || sopProxy.port < 1 || sopProxy.port > 65535 || typeof sopProxy.secret !== 'string' || sopProxy.secret.length < 32 || !['string','function'].includes(typeof sopProxy.user) || (typeof sopProxy.user === 'string' && /[\r\n]/.test(sopProxy.user)))) throw new Error('Invalid local SOP preview configuration');
  return http.createServer(async (request, response) => {
    const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'SAMEORIGIN' };
    const send = (status, message, extra = {}) => {
      const body = Buffer.from(message);
      response.writeHead(status, { ...headers, 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': body.length, ...extra });
      response.end(request.method === 'HEAD' ? undefined : body);
    };
    let parsed;
    try { parsed = parseRequestPath(request.url); } catch { return send(400, 'Invalid or private request path'); }
    const { pathname, parts } = parsed;
    if (handlePortalControl(request, response, runtime, pathname)) return;
    const proxyEntry = Object.entries(applications || {}).find(([id, app]) => app.type === 'proxy' && (parts[0] === id || app.rootRoutes.includes(pathname)));
    if (proxyEntry) {
      const [id, app] = proxyEntry;
      if (pathname === '/' + id) return send(308, 'Redirecting', {Location: '/' + id + '/' + (request.url.includes('?') ? request.url.slice(request.url.indexOf('?')) : '')});
      const upstreamPath = parts[0] === id && app.stripPrefix ? request.url.slice(id.length + 1) : request.url;
      proxyRequest(request, response, app, upstreamPath, send);
      return;
    }
    if (sopProxy && parts[0] === 'sop') {
      if (pathname === '/sop') return send(308, 'Redirecting', { Location: '/sop/' });
      const forwarded = { ...request.headers, host: `127.0.0.1:${sopProxy.port}` };
      for (const header of Object.keys(forwarded)) if (header.startsWith('x-sop-') || header.startsWith('x-planhub-') || header.startsWith('x-config-') || header.startsWith('x-forwarded-') || ['forwarded', 'connection', 'transfer-encoding', 'proxy-authorization', 'upgrade', 'te', 'trailer'].includes(header)) delete forwarded[header];
      forwarded['x-sop-proxy-key'] = sopProxy.secret;
      forwarded['x-sop-user'] = typeof sopProxy.user === 'function' ? sopProxy.user(request) : sopProxy.user;
      const upstream = http.request({ hostname: '127.0.0.1', port: sopProxy.port, path: request.url, method: request.method, headers: forwarded }, incoming => {
        const incomingHeaders = { ...incoming.headers };
        delete incomingHeaders['transfer-encoding']; delete incomingHeaders.connection;
        response.writeHead(incoming.statusCode, incomingHeaders);
        incoming.pipe(response);
      });
      upstream.setTimeout(30000, () => upstream.destroy(new Error('SOP preview timed out')));
      upstream.on('error', () => { if (!response.headersSent) send(502, 'Local SOP service unavailable'); else response.destroy(); });
      request.on('aborted', () => upstream.destroy());
      request.pipe(upstream);
      return;
    }
    if (!['GET', 'HEAD'].includes(request.method)) return send(405, 'Method not allowed', { Allow: 'GET, HEAD' });
    const configured = applications?.[parts[0]];
    const mount = configured?.type === 'static' ? configured : null;
    const base = mount?.root ?? portalRoot;
    let relativeParts = mount ? parts.slice(1) : parts;
    if (mount) {
      if (relativeParts.length === 0 && !pathname.endsWith('/')) return send(308, 'Redirecting', {Location: pathname + '/' + (request.url.includes('?') ? request.url.slice(request.url.indexOf('?')) : '')});
      if (relativeParts.length === 0 || relativeParts.join('/') === 'index.html') relativeParts = mount.entry.split('/');
      if (!publicFile(mount, relativeParts.join('/'))) return send(404, 'Not found');
    }
    let candidate = path.join(base, ...relativeParts);
    if (!inside(base, candidate)) return send(403, 'Forbidden');
    try {
      const resolvedBase = await realpath(base);
      candidate = await realpath(candidate);
      if (!inside(resolvedBase, candidate)) return send(403, 'Forbidden');
      if (mount && !publicFile(mount, path.relative(resolvedBase, candidate).split(path.sep).join('/'))) return send(403, 'Forbidden');
      let info = await stat(candidate);
      if (info.isDirectory()) {
        if (!pathname.endsWith('/')) {
          const query = request.url.includes('?') ? request.url.slice(request.url.indexOf('?')) : '';
          return send(308, 'Redirecting', { Location: `${encodeURI(pathname)}/${query}` });
        }
        candidate = await realpath(path.join(candidate, 'index.html'));
        if (!inside(resolvedBase, candidate)) return send(403, 'Forbidden');
        info = await stat(candidate);
      }
      if (!info.isFile() || !Object.hasOwn(STATIC_MIME_TYPES, path.extname(candidate).toLowerCase())) return send(404, 'Not found');
      // Read before sending headers so an interrupted publication returns a clear error.
      const content = request.method === 'HEAD' ? null : await readFile(candidate);
      response.writeHead(200, { ...headers, 'Content-Type': STATIC_MIME_TYPES[path.extname(candidate).toLowerCase()], 'Content-Length': content?.length ?? info.size });
      response.end(content);
    } catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes(error.code)) return send(404, 'Not found');
      if (['EACCES', 'EPERM'].includes(error.code)) return send(403, 'Forbidden');
      send(500, 'Unable to read preview file');
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const portIndex = process.argv.indexOf('--port');
  const port = portIndex >= 0 ? Number(process.argv[portIndex + 1]) : 4173;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be between 1 and 65535');
  const applications = await loadAppIntegrations(PROJECT_ROOT);
  for (const [id, app] of Object.entries(applications)) if (app.type === 'proxy' && Number(new URL(app.target).port || 80) === port) throw new Error(id + ' 服务端口不能与门户相同');
  const server = createServer({applications});
  server.on('error', error => { console.error(`Preview failed: ${error.message}`); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => console.log(`本地预览：http://127.0.0.1:${port}/（仅本机，无 Windows 身份认证）`));
}
