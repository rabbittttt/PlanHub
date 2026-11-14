import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm,realpath,symlink} from 'node:fs/promises';
import {checkSnapshotCompatibility} from '../scripts/preview-compatibility.mjs';
import {runtimeContract,snapshotContractHash,validateDelivery,DELIVERY_SCHEMA,DELIVERY_PLATFORM} from '../scripts/delivery-validation.mjs';

// No executable runtime, sockets or business services are needed for these
// compatibility proofs: use complete, checksummed program-only deliveries.
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const contractHash=bindings=>sha(JSON.stringify(runtimeContract(bindings)));
const put=async(file,value)=>{
  await mkdir(path.dirname(file),{recursive:true});
  await writeFile(file,typeof value==='string'?value:JSON.stringify(value));
};
async function files(root){
  const result={};
  async function visit(directory){
    for(const entry of await readdir(directory,{withFileTypes:true})){
      const file=path.join(directory,entry.name);
      if(entry.isDirectory())await visit(file);
      else result[path.relative(root,file).split(path.sep).join('/')]=sha(await readFile(file));
    }
  }
  await visit(root);return result;
}
const bindings=()=>({
  planhub:{type:'static',port:4173,healthPath:'/'},
  'vehicle-config':{
    type:'service',port:9473,healthPath:'/healthz',
    healthExpected:{ok:true,app:'vehicle-config'},
    arguments:['-B','{payload}/server.py','--port','{port}','--data-dir','{data}'],
    environment:{FIXTURE_ONE:'one',FIXTURE_TWO:'two'}
  }
});
async function release(root,id,payload,{version='fixture-v1',type='static'}={}){
  const items=[];
  for(const [name,value] of Object.entries(payload)){
    await put(path.join(root,'releases',id,'payload',name),value);
    items.push({path:name,bytes:Buffer.byteLength(value),sha256:sha(value)});
  }
  await put(path.join(root,'releases',id,'app-release.json'),{
    schemaVersion:1,appId:id,version,type,basePath:'/'+id+'/',
    entryPoint:type==='static'?'index.html':'server.py',sourceRevision:'fixture',
    dataMode:type==='static'?'stateless':'external',healthPath:type==='static'?'/':'/healthz',files:items
  });
}
async function delivery(root,serviceBindings,{version='fixture-v1',legacy=false}={}){
  await release(root,'planhub',{
    'index.html':'<title>Compatibility fixture '+version+'</title>',
    'config/apps.json':JSON.stringify({groups:[{apps:[{id:'vehicle-config',enabled:true}]}]})
  },{version});
  await release(root,'vehicle-config',{'server.py':'# Fixture only; never executed.\n'},{version,type:'service'});
  await put(path.join(root,'bindings.json'),serviceBindings);
  for(const name of ['launcher/native-preview.mjs','deploy.ps1','compose.json','build-docker.ps1'])await put(path.join(root,name),'fixture only');
  const manifest={
    schemaVersion:DELIVERY_SCHEMA,platform:DELIVERY_PLATFORM,runtimeMode:'reuse',complete:true,
    contractHash:contractHash(serviceBindings),applications:['planhub','vehicle-config'],
    versions:{planhub:version,'vehicle-config':version},files:await files(root)
  };
  if(!legacy)manifest.snapshotContractHash=snapshotContractHash(serviceBindings);
  await put(path.join(root,'delivery.json'),manifest);
  return manifest;
}
async function fixture(t,current=bindings()){
  const root=await mkdtemp(path.join(os.tmpdir(),'planhub-compatibility-test-'));
  t.after(async()=>{
    const resolved=await realpath(root),temporary=await realpath(os.tmpdir());
    assert.equal(path.dirname(resolved),temporary);
    assert.match(path.basename(resolved),/^planhub-compatibility-test-[A-Za-z0-9]+$/);
    await rm(resolved,{recursive:true,force:true,maxRetries:10,retryDelay:100});
  });
  const packageRoot=path.join(root,'planhub-20261114-new');
  const runtimeRoot=path.join(root,'planhub-preview','snapshot-'+'a'.repeat(32));
  const manifest=await delivery(packageRoot,current);
  await put(path.join(runtimeRoot,'config.json'),{fixture:'keep existing trial configuration'});
  await put(path.join(runtimeRoot,'data/vehicle-config/saved.sqlite3'),'keep trial database bytes');
  await put(path.join(runtimeRoot,'shared/orders.xlsx'),'keep trial shared data bytes');
  return {root,packageRoot,runtimeRoot,manifest,current};
}

test('an identical validated startup contract reuses a real snapshot without an older delivery',async t=>{
  const f=await fixture(t),before=await files(f.runtimeRoot);
  const result=await checkSnapshotCompatibility(f.packageRoot,f.runtimeRoot,f.manifest.contractHash);
  assert.equal(result.compatible,true);
  assert.equal(result.snapshotContractHash,snapshotContractHash(f.current));
  assert.deepEqual(await files(f.runtimeRoot),before);
});

test('a newer program version preserves the snapshot hash and needs no old program payload',async t=>{
  const f=await fixture(t),oldHash=f.manifest.contractHash,oldSnapshotHash=f.manifest.snapshotContractHash;
  // Rebuild in place only within this synthetic fixture, to isolate version
  // identity from the unchanged service startup contract.
  assert.equal(path.dirname(path.resolve(f.packageRoot)),path.resolve(f.root));
  assert.equal(path.basename(f.packageRoot),'planhub-20261114-new');
  await rm(f.packageRoot,{recursive:true,force:true});
  const next=await delivery(f.packageRoot,f.current,{version:'fixture-v2'});
  assert.equal(next.snapshotContractHash,oldSnapshotHash);
  assert.notEqual(next.versions.planhub,f.manifest.versions.planhub);
  assert.equal((await checkSnapshotCompatibility(f.packageRoot,f.runtimeRoot,oldHash)).compatible,true);
});

test('a validated legacy delivery proves port-only and recursively reordered JSON contracts compatible',async t=>{
  const current=bindings(),f=await fixture(t,current),before=await files(f.runtimeRoot);
  const old={
    'vehicle-config':{
      environment:{FIXTURE_TWO:'two',FIXTURE_ONE:'one'},
      arguments:[...current['vehicle-config'].arguments],
      healthExpected:{app:'vehicle-config',ok:true},
      healthPath:'/healthz',previewPort:43175,port:8765,type:'service'
    },
    planhub:{healthPath:'/',port:4173,type:'static'}
  };
  const oldManifest=await delivery(path.join(f.root,'planhub-20261113-old'),old,{legacy:true});
  assert.equal(oldManifest.snapshotContractHash,undefined);
  assert.notEqual(oldManifest.contractHash,f.manifest.contractHash);
  assert.equal(snapshotContractHash(old),f.manifest.snapshotContractHash);
  const result=await checkSnapshotCompatibility(f.packageRoot,f.runtimeRoot,oldManifest.contractHash);
  assert.equal(result.compatible,true);
  assert.equal(result.snapshotContractHash,f.manifest.snapshotContractHash);
  assert.match(result.reason,/previous delivery/);
  assert.deepEqual(await files(f.runtimeRoot),before);
});

test('missing older delivery evidence rejects the legacy hash and retains all snapshot files',async t=>{
  const f=await fixture(t),old=bindings();old['vehicle-config'].port=8765;
  const before=await files(f.runtimeRoot);
  await assert.rejects(checkSnapshotCompatibility(f.packageRoot,f.runtimeRoot,contractHash(old)),/Cannot verify the previous snapshot contract/);
  assert.deepEqual(await files(f.runtimeRoot),before);
});

test('a modified old bindings file is not evidence even when its manifest claims the old contract',async t=>{
  const f=await fixture(t),old=bindings();old['vehicle-config'].port=8765;
  const previous=path.join(f.root,'planhub-20261113-old'),manifest=await delivery(previous,old,{legacy:true});
  old['vehicle-config'].port=8766;
  await put(path.join(previous,'bindings.json'),old);
  await assert.rejects(checkSnapshotCompatibility(f.packageRoot,f.runtimeRoot,manifest.contractHash),/Cannot verify/);
  // A new file checksum still cannot forge the original full contract hash.
  manifest.files['bindings.json']=sha(await readFile(path.join(previous,'bindings.json')));
  await put(path.join(previous,'delivery.json'),manifest);
  await assert.rejects(checkSnapshotCompatibility(f.packageRoot,f.runtimeRoot,manifest.contractHash),/Cannot verify/);
});

test('a real startup-argument change rejects reuse instead of copying or overwriting trial data',async t=>{
  const current=bindings();current['vehicle-config'].arguments.push('--new-startup-mode');
  const f=await fixture(t,current),before=await files(f.runtimeRoot);
  const old=await delivery(path.join(f.root,'planhub-20261113-old'),bindings(),{legacy:true});
  await assert.rejects(checkSnapshotCompatibility(f.packageRoot,f.runtimeRoot,old.contractHash),/startup contract changed beyond ports/);
  assert.deepEqual(await files(f.runtimeRoot),before);
});

test('snapshot paths must be existing directories with the exact private sibling shape',async t=>{
  const f=await fixture(t);
  for(const invalid of [
    path.join(f.root,'planhub-runtime'),
    path.join(f.root,'planhub-preview','snapshot-short'),
    path.join(f.packageRoot,'planhub-preview','snapshot-'+'b'.repeat(32)),
    path.join(f.root,'planhub-preview','snapshot-'+'b'.repeat(32))
  ]){
    await assert.rejects(checkSnapshotCompatibility(f.packageRoot,invalid,f.manifest.contractHash),/snapshot|ENOENT/i);
  }
  const file=path.join(f.root,'planhub-preview','snapshot-'+'c'.repeat(32));
  await put(file,'not a directory');
  await assert.rejects(checkSnapshotCompatibility(f.packageRoot,file,f.manifest.contractHash),/snapshot|directory/i);
});

test('junction snapshot paths and invalid historical hashes cannot bypass the compatibility boundary',async t=>{
  const f=await fixture(t),linked=path.join(f.root,'planhub-preview','snapshot-'+'d'.repeat(32));
  await symlink(f.runtimeRoot,linked,process.platform==='win32'?'junction':'dir');
  await assert.rejects(checkSnapshotCompatibility(f.packageRoot,linked,f.manifest.contractHash),/Linked delivery paths/);
  for(const invalid of ['',null,'g'.repeat(64),'a'.repeat(63),f.manifest.contractHash.toUpperCase()]){
    await assert.rejects(checkSnapshotCompatibility(f.packageRoot,f.runtimeRoot,invalid),/Invalid previous snapshot contract/);
  }
});

test('the current program-only package must still pass complete checksummed delivery validation',async t=>{
  const f=await fixture(t);
  const validated=await validateDelivery(f.packageRoot,{requireComplete:true});
  assert.equal(validated.manifest.runtimeMode,'reuse');
  assert.ok(!Object.keys(validated.manifest.files).some(name=>name.startsWith('runtime/')));
  await put(path.join(f.packageRoot,'bindings.json'),{...f.current,extra:{type:'static',port:9474}});
  await assert.rejects(checkSnapshotCompatibility(f.packageRoot,f.runtimeRoot,f.manifest.contractHash),/damaged/);
});
