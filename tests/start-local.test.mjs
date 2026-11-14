import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {mkdtemp,mkdir,writeFile,realpath,rm} from 'node:fs/promises';
import os from 'node:os';
import {previewOptions} from '../scripts/dev-sop.mjs';
import {readServicePorts} from '../scripts/service-ports.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
test('the default SOP and portal ports come from the shared registry',()=>{
  const ports=readServicePorts(root);
  assert.equal(previewOptions([]).backendPort,ports.applications.sop);
  assert.equal(previewOptions([]).port,ports.portal);
  assert.equal(previewOptions(['--backend-port','19876']).backendPort,19876);
});

test('preview defaults follow registry changes and explicit flags take precedence',async t=>{
  const temporary=await mkdtemp(path.join(os.tmpdir(),'planhub-preview-ports-'));
  t.after(async()=>{
    const resolved=await realpath(temporary);
    assert.equal(path.dirname(resolved),await realpath(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('planhub-preview-ports-'));
    await rm(resolved,{recursive:true,force:true});
  });
  assert.equal(previewOptions([],{root:temporary}).backendPort,readServicePorts(root).applications.sop);
  await mkdir(path.join(temporary,'integration'));
  for(const sop of [18876,18877]) {
    await writeFile(path.join(temporary,'integration/ports.json'),JSON.stringify({schemaVersion:1,portal:14173,applications:{sop}}));
    const options=previewOptions([],{root:temporary});
    assert.equal(options.port,14173);assert.equal(options.backendPort,sop);
  }
  const explicit=previewOptions(['--port','24173','--backend-port','28876'],{root:temporary});
  assert.equal(explicit.port,24173);assert.equal(explicit.backendPort,28876);
});
async function listener() {
  const server=net.createServer();
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  return server;
}
async function close(server){await new Promise(resolve=>server.close(resolve));}

test('occupied portal or SOP ports fail before snapshot reads or Python startup',async()=>{
  const occupied=await listener();
  const available=await listener();
  const busy=occupied.address().port,free=available.address().port;
  await close(available);
  try {
    for(const [port,backend] of [[busy,free],[free,busy]]) {
      const result=spawnSync(process.execPath,[path.join(root,'scripts','dev-sop.mjs'),
        '--port',String(port),'--backend-port',String(backend),
        '--snapshot','--seed-from',path.join(root,'artifacts','nonexistent-preflight-seed')],
      {cwd:root,encoding:'utf8',timeout:5000});
      assert.equal(result.error,undefined);
      assert.equal(result.status,1);
      assert.match(result.stderr,new RegExp(`端口 ${busy} 已被占用`));
      assert.match(result.stderr,/npm run dev/);
      assert.doesNotMatch(result.stdout,/SOP计划工作台已就绪|SOP 门户预览/);
      assert.doesNotMatch(result.stderr,/ENOENT|sales\.json/);
    }
  } finally {await close(occupied);}
});
