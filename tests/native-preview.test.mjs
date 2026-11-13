import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import crypto from 'node:crypto';
import {mkdtemp,mkdir,writeFile,readFile,rm,readdir} from 'node:fs/promises';
import {loadNativePlan,runNativePreview,startNativePreview,stopNativePreview,freePreviewPort} from '../scripts/native-preview.mjs';
import {spawnService} from '../scripts/service-process.mjs';
import {probePortal} from '../scripts/portal-instance.mjs';
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const put=async(file,value)=>{await mkdir(path.dirname(file),{recursive:true});await writeFile(file,typeof value==='string'?value:JSON.stringify(value));};
async function hashFiles(root){
  const files={};
  async function visit(directory){for(const entry of await readdir(directory,{withFileTypes:true})){const filename=path.join(directory,entry.name);if(entry.isDirectory())await visit(filename);else files[path.relative(root,filename).split(path.sep).join('/')]=sha(await readFile(filename));}}
  await visit(root);return files;
}
async function release(root,id,files,type='static'){
  const items=[];for(const [name,value]of Object.entries(files)){await put(path.join(root,'releases',id,'payload',name),value);items.push({path:name,bytes:Buffer.byteLength(value),sha256:sha(value)});}
  await put(path.join(root,'releases',id,'app-release.json'),{schemaVersion:1,appId:id,version:'fixture-v1',type,basePath:`/${id}/`,entryPoint:type==='static'?'index.html':'server.py',sourceRevision:'fixture',dataMode:type==='static'?'stateless':'external',healthPath:type==='static'?'/':'/healthz',files:items});
}
async function unusedPort(){const server=net.createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;}
async function fixture(t,{dynamic=true}={}){
  const root=await mkdtemp(path.join(os.tmpdir(),'planhub-native-test-'));t.after(()=>rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100}));
  const packageRoot=path.join(root,'delivery'),runtimeRoot=path.join(root,'planhub-preview','snapshot-'+'a'.repeat(32)),port=await unusedPort();
  const bindings={planhub:{type:'static',port:4173,healthPath:'/'}};
  if(dynamic)bindings['vehicle-config']={type:'service',port,healthPath:'/healthz',healthExpected:{ok:true,app:'vehicle-config'},arguments:['-B','{payload}/server.py','--port','{port}','--data-dir','{data}'],environment:{}};
  await release(packageRoot,'planhub',{'index.html':'<title>Fixture portal</title>','config/apps.json':JSON.stringify({groups:[{apps:dynamic?[{id:'vehicle-config',enabled:true}]:[]}]})});
  if(dynamic)await release(packageRoot,'vehicle-config',{'server.py':'# Immutable fixture, never executed by tests.\n','requirements.txt':''},'service');
  await put(path.join(packageRoot,'bindings.json'),bindings);
  for(const file of ['runtime/node/node.exe','runtime/python/python.exe','launcher/native-preview.mjs','deploy.ps1','compose.json','build-docker.ps1'])await put(path.join(packageRoot,file),'fixture only');
  const manifest={schemaVersion:2,platform:'windows/amd64+linux/amd64',complete:true,contractHash:sha(JSON.stringify(bindings)),applications:dynamic?['planhub','vehicle-config']:['planhub'],versions:dynamic?{planhub:'fixture-v1','vehicle-config':'fixture-v1'}:{planhub:'fixture-v1'},files:await hashFiles(packageRoot)};
  await put(path.join(packageRoot,'delivery.json'),manifest);
  const config={schemaVersion:1,publicOrigin:'http://127.0.0.1:4174',listenAddress:'127.0.0.1',port:4174,proxySecret:'a'.repeat(64),sopSecret:'b'.repeat(64),vehicleSecret:'c'.repeat(64),sharedDirectory:'shared',sopSharedConfig:'config/shared_config.py',quicklookSourceBase:'shared',preview:{schemaVersion:1,user:'DEPT\\fixture-user',sourceDirectory:path.join(root,'planhub-runtime'),createdAt:new Date().toISOString()}};
  await put(path.join(runtimeRoot,'config.json'),config);await mkdir(config.preview.sourceDirectory,{recursive:true});
  const fake=path.join(root,'fixture-service.mjs');
  await put(fake,`import http from 'node:http';const port=Number(process.argv[2]);const server=http.createServer((req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(req.url==='/healthz'?{ok:true,app:'vehicle-config'}:{user:req.headers['x-config-user'],secret:req.headers['x-config-proxy-key']}));});server.listen(port,'127.0.0.1');`);
  return {root,packageRoot,runtimeRoot,port,config,manifest,fake};
}
test('native preview runs only release payloads on loopback and stops its owned fixture child',async t=>{
  const f=await fixture(t),plan=await loadNativePlan(f.packageRoot,f.runtimeRoot),seen=[];
  let server;
  t.after(async()=>{if(server?.listening){server.close();server.closeAllConnections?.();await new Promise(resolve=>server.once('close',resolve));}});
  server=await runNativePreview(plan,{startService(command,args,options){seen.push({command,args,options});return spawnService(process.execPath,[f.fake,String(f.port)],options);},serviceTimeoutMs:5000});
  assert.equal(server.address().address,'127.0.0.1');
  assert.equal(seen[0].command,path.join(f.packageRoot,'runtime/python/python.exe'));
  assert.ok(seen[0].args.map(value=>path.normalize(value)).includes(path.join(f.packageRoot,'releases/vehicle-config/payload/server.py')));
  assert.equal(seen[0].args[1],'-c');assert.match(seen[0].args[2],/sys\.path\.insert/);
  assert.ok(seen[0].args.includes(path.join(f.runtimeRoot,'data/vehicle-config')));
  assert.equal(seen[0].options.env.VEHICLE_CONFIG_PROXY_SECRET,f.config.vehicleSecret);
  assert.equal(seen[0].options.env.PLANHUB_PYTHON_APP_ROOT,path.join(f.packageRoot,'releases/vehicle-config/payload'));
  assert.equal(seen[0].options.env.PATH.split(path.delimiter)[0],path.join(f.packageRoot,'runtime/node'));
  assert.equal(seen[0].options.env.VIRTUAL_ENV,undefined);
  const result=await fetch('http://127.0.0.1:4174/vehicle-config/identity',{headers:{'X-PlanHub-User':'FORGED\\user','X-Config-Proxy-Key':'forged'}});
  assert.deepEqual(await result.json(),{user:'DEPT\\fixture-user',secret:f.config.vehicleSecret});
  const identity=await probePortal(4174);assert.equal(identity.pid,process.pid);
  await stopNativePreview(f.runtimeRoot);
  await freePreviewPort(f.port);await freePreviewPort(4174);
  assert.ok(await readFile(path.join(f.runtimeRoot,'config.json')));
  assert.equal(await probePortal(4174),null);
});
test('foreign occupied backend port is neither reused nor terminated',async t=>{
  const f=await fixture(t),plan=await loadNativePlan(f.packageRoot,f.runtimeRoot),server=net.createServer();
  await new Promise(resolve=>server.listen(f.port,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  let starts=0;await assert.rejects(runNativePreview(plan,{startService(){starts++;}}),/already in use/);
  assert.equal(starts,0);assert.equal(server.listening,true);
  await assert.rejects(readFile(path.join(f.runtimeRoot,'native-owner.json')),/ENOENT/);
});
test('release damage, incomplete app closure and arbitrary snapshot paths fail before service startup',async t=>{
  const f=await fixture(t);
  await assert.rejects(loadNativePlan(f.packageRoot,path.join(f.root,'formal-data')),/snapshot created/);
  await put(path.join(f.packageRoot,'releases/vehicle-config/payload/server.py'),'tampered');
  await assert.rejects(loadNativePlan(f.packageRoot,f.runtimeRoot),/damaged/);
  const g=await fixture(t);g.manifest.complete=false;await put(path.join(g.packageRoot,'delivery.json'),g.manifest);
  await assert.rejects(loadNativePlan(g.packageRoot,g.runtimeRoot),/complete current delivery/);
});
test('detached preview remains alive after its startup returns, reuses itself, then stops securely',async t=>{
  const f=await fixture(t,{dynamic:false});
  t.after(async()=>{if(await probePortal(4174))await stopNativePreview(f.runtimeRoot);});
  const first=await startNativePreview(f.packageRoot,f.runtimeRoot,{settleMs:100,timeoutMs:10000});
  assert.equal(first.reused,false);
  const identity=await probePortal(4174);assert.notEqual(identity.pid,process.pid);
  const again=await startNativePreview(f.packageRoot,f.runtimeRoot,{settleMs:100,timeoutMs:10000});assert.equal(again.reused,true);
  await stopNativePreview(f.runtimeRoot);await freePreviewPort(4174);
});
test('a failed child startup releases the snapshot lease and leaves the portal port unused',async t=>{
  const f=await fixture(t),plan=await loadNativePlan(f.packageRoot,f.runtimeRoot);
  await assert.rejects(runNativePreview(plan,{startService(command,args,options){return spawnService(process.execPath,['-e','process.exit(7)'],options);},serviceTimeoutMs:1000}),/did not start/);
  await assert.rejects(readFile(path.join(f.runtimeRoot,'native-owner.json')),/ENOENT/);
  await freePreviewPort(4174);await freePreviewPort(f.port);
});
