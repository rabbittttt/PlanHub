import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,realpath,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {readServicePorts,loadRuntimeBindings} from '../scripts/service-ports.mjs';

async function fixture(t) {
  const root=await mkdtemp(path.join(os.tmpdir(),'planhub-service-ports-'));
  t.after(async()=>{
    const resolved=await realpath(root);
    assert.equal(path.dirname(resolved),await realpath(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('planhub-service-ports-'));
    await rm(resolved,{recursive:true,force:true});
  });
  for(const dir of ['integration','deploy/docker'])await mkdir(path.join(root,dir),{recursive:true});
  const save=ports=>writeFile(path.join(root,'integration/ports.json'),JSON.stringify(ports));
  return {root,save};
}

test('missing optional registry supports literal-target workspaces; malformed files never become optional',async t=>{
  const {root}=await fixture(t);
  assert.equal(readServicePorts(root,{optional:true}),null);
  assert.throws(()=>readServicePorts(root),/service port registry/);
  await writeFile(path.join(root,'integration/ports.json'),'{');
  assert.throws(()=>readServicePorts(root,{optional:true}),/service port registry/);
});

test('registry rejects invalid port values and collisions including the public portal',async t=>{
  const {root,save}=await fixture(t);
  const ports={schemaVersion:1,portal:14173,applications:{sop:18876,quicklook:19473}};
  await save(ports);assert.deepEqual(readServicePorts(root),ports);
  for(const value of [0,65536,1.5,'18876',null]) {
    await save({...ports,applications:{...ports.applications,sop:value}});
    assert.throws(()=>readServicePorts(root),/1–65535 integer/);
  }
  for(const value of [ports.portal,ports.applications.quicklook]) {
    await save({...ports,applications:{...ports.applications,sop:value}});
    assert.throws(()=>readServicePorts(root),/Duplicate service port/);
  }
  await save({...ports,schemaVersion:2});assert.throws(()=>readServicePorts(root),/schemaVersion 1/);
  await save({...ports,applications:{'bad/id':18876}});assert.throws(()=>readServicePorts(root),/application ID/);
});

test('runtime bindings derive concrete ports from the same registry without changing templates',async t=>{
  const {root,save}=await fixture(t);
  const templates={planhub:{type:'static'},quicklook:{type:'service',arguments:['--port','{port}']}};
  const filename=path.join(root,'deploy/docker/bindings.json');
  await writeFile(filename,JSON.stringify(templates));
  for(const port of [19473,19474]) {
    await save({schemaVersion:1,portal:14173,applications:{quicklook:port}});
    const bindings=await loadRuntimeBindings(root);
    assert.deepEqual(bindings,{planhub:{...templates.planhub,port:14173},quicklook:{...templates.quicklook,port}});
  }
  assert.equal(templates.quicklook.port,undefined);
  await writeFile(filename,JSON.stringify({...templates,missing:{type:'service'}}));
  await assert.rejects(loadRuntimeBindings(root),/missing has no default port/);
  await writeFile(filename,JSON.stringify({...templates,quicklook:{...templates.quicklook,port:19473}}));
  await assert.rejects(loadRuntimeBindings(root),/only in integration\/ports.json/);
});
