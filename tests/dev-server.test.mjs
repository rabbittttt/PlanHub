import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createServer, parseRequestPath } from '../scripts/dev-server.mjs';
import { validateWorkspace } from '../scripts/check.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const directory of ['portal/js', 'portal/config', 'apps/orderiq', 'data', 'services', 'deploy']) {
    await mkdir(path.join(root, directory), { recursive: true });
  }
  await Promise.all([
    writeFile(path.join(root, 'portal/index.html'), '<title>portal</title>'),
    writeFile(path.join(root, 'portal/js/app.js'), 'export const ready = true;'),
    writeFile(path.join(root, 'apps/orderiq/index.html'), '<title>orders</title>'),
    writeFile(path.join(root, 'data/private.txt'), 'private fixture'),
    writeFile(path.join(root, 'portal/web.config'), 'private config fixture'),
  ]);
  return root;
}

function request(port, url, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: url, method }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function serve(t, root) {
  const server = createServer({ root });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return server.address().port;
}

test('preview serves portal and explicit static mounts, including correct HEAD and MIME', async t => {
  const root = await fixture(t);
  const port = await serve(t, root);
  assert.equal((await request(port, '/')).body, '<title>portal</title>');
  assert.equal((await request(port, '/orderiq/')).body, '<title>orders</title>');
  const js = await request(port, '/js/app.js');
  assert.match(js.headers['content-type'], /javascript/);
  const head = await request(port, '/orderiq/', 'HEAD');
  assert.equal(head.status, 200);
  assert.equal(head.body, '');
  assert.equal(Number(head.headers['content-length']), Buffer.byteLength('<title>orders</title>'));
  const redirect = await request(port, '/orderiq?view=all');
  assert.equal(redirect.status, 308);
  assert.equal(redirect.headers.location, '/orderiq/?view=all');
  assert.equal((await request(port, '/', 'POST')).status, 405);
});

test('unknown applications and files produce 404 instead of portal fallbacks', async t => {
  const port = await serve(t, await fixture(t));
  for (const url of ['/unknown/', '/sop/', '/leads/', '/forecast/', '/orderiq/missing.js', '/constructor/', '/toString/']) {
    const result = await request(port, url);
    assert.equal(result.status, 404, url);
    assert.equal(result.body, 'Not found');
  }
});

test('private paths, traversal, Windows alternate streams and encoded evasions are rejected', async t => {
  const port = await serve(t, await fixture(t));
  for (const url of [
    '/../data/private.txt', '/orderiq/../../data/private.txt', '/%2e%2e/data/private.txt',
    '/orderiq/%252e%252e/data/private.txt', '/orderiq%2f..%2fdata/private.txt',
    '/orderiq%5c..%5cdata/private.txt', '/orderiq\\..\\data/private.txt',
    '/data/private.txt', '/services/main.py', '/deploy/config.json', '/.git/config',
    '/.env', '/web.config', '/WEB.CONFIG', '/js/app.js::$DATA', '/js/app.js.', '/%00', '/bad%zz',
  ]) {
    const result = await request(port, url);
    assert.equal(result.status, 400, url);
    assert.doesNotMatch(result.body, /private fixture|private config fixture/);
  }
  assert.throws(() => parseRequestPath('http://evil.test/data/'));
});

test('public directory links cannot expose private files', async t => {
  const root = await fixture(t);
  try { await symlink(path.join(root, 'data'), path.join(root, 'portal/public-link'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) return t.skip('Directory links are unavailable in this sandbox'); throw error; }
  const port = await serve(t, root);
  assert.equal((await request(port, '/public-link/private.txt')).status, 403);
});

test('ready static apps require artifacts while pending and hidden apps do not', async t => {
  const root = await fixture(t);
  const raw = { platform: { name: '检查', defaultApp: 'home' }, groups: [{ id: 'business', name: '业务', apps: [
    { id: 'orderiq', name: '订单', url: '/orderiq/', enabled: true, status: 'ready' },
    { id: 'inventory', name: '库存', url: '/inventory/', enabled: false, status: 'ready' },
    { id: 'sop', name: '计划', url: '/sop/', enabled: true, status: 'pending' },
  ] }] };
  const save = () => writeFile(path.join(root, 'portal/config/apps.json'), JSON.stringify(raw));
  await save();
  assert.equal((await validateWorkspace(root)).warnings.length, 0);
  raw.groups[0].apps[1].enabled = true;
  await save();
  await assert.rejects(validateWorkspace(root), /inventory/);
  raw.groups[0].apps[1].status = 'pending';
  raw.groups[0].apps[0].url = '/wrong/';
  await save();
  await assert.rejects(validateWorkspace(root), /挂载不一致/);
});
