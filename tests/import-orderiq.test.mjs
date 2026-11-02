import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, stat, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

test('OrderIQ import supports dry runs, preserves source and does not invent a data timestamp', { skip: process.platform !== 'win32' }, async t => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'portal-import-test-'));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const project = path.join(temporaryRoot, 'project');
  const source = path.join(temporaryRoot, 'source.html');
  const registryFile = path.join(project, 'portal/config/apps.json');
  await mkdir(path.dirname(registryFile), { recursive: true });
  const sourceContent = '<!doctype html><html><title>Published fixture</title></html>';
  await writeFile(source, sourceContent);
  await writeFile(registryFile, JSON.stringify({ platform: { name: 'Fixture' }, groups: [{ id: 'business', name: 'Business', apps: [
    { id: 'orderiq', name: 'Orders', url: '/orderiq/', enabled: false, status: 'pending', dataUpdatedAt: null },
  ] }] }));
  const script = fileURLToPath(new URL('../scripts/Import-OrderIQ.ps1', import.meta.url));
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  // Exercise the documented command with no ProjectRoot, from a different CWD.
  // Copy the real script bytes to preserve its UTF-8 BOM for PowerShell 5.1.
  const copiedScript = path.join(project, 'scripts/Import-OrderIQ.ps1');
  await mkdir(path.dirname(copiedScript), { recursive: true });
  await writeFile(copiedScript, await readFile(script));
  const originalRegistry = await readFile(registryFile, 'utf8');
  const defaultDryRun = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', copiedScript, '-SourceHtml', source, '-WhatIf'], { cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8' });
  assert.equal(defaultDryRun.status, 0, defaultDryRun.stderr);
  assert.equal(await readFile(registryFile, 'utf8'), originalRegistry);
  await assert.rejects(stat(path.join(project, 'apps/orderiq/index.html')), { code: 'ENOENT' });
  const invoke = extra => spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-SourceHtml', source, '-ProjectRoot', project, ...extra], { encoding: 'utf8' });
  const dryRun = invoke(['-WhatIf']);
  assert.equal(dryRun.status, 0, dryRun.stderr);
  await assert.rejects(stat(path.join(project, 'apps/orderiq/index.html')), { code: 'ENOENT' });
  const imported = invoke([]);
  assert.equal(imported.status, 0, imported.stderr);
  assert.equal(await readFile(source, 'utf8'), sourceContent);
  assert.equal(await readFile(path.join(project, 'apps/orderiq/index.html'), 'utf8'), sourceContent);
  const registry = JSON.parse(await readFile(registryFile, 'utf8'));
  assert.equal(registry.groups[0].apps[0].status, 'ready');
  assert.equal(registry.groups[0].apps[0].enabled, true);
  assert.equal(registry.groups[0].apps[0].dataUpdatedAt, null);
  const metadata = JSON.parse(await readFile(path.join(project, 'apps/orderiq.import.json'), 'utf8'));
  assert.match(metadata.sourceSha256, /^[a-f0-9]{64}$/);
  assert.ok(!Number.isNaN(Date.parse(metadata.sourceFileModifiedAt)));
  assert.equal(metadata.dataUpdatedAt, null);
});
