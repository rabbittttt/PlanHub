import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import crypto from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {mkdtemp,mkdir,writeFile,readFile,rm,readdir,unlink,cp,realpath} from 'node:fs/promises';

// Keep fixture sockets off the user's fixed 4173 portal port. Exercise the same
// launcher in a private temporary code copy, changing only its one exported
// public-port constant; production code keeps its strict 4173 rule.
const harness=await mkdtemp(path.join(os.tmpdir(),'planhub-native-code-'));
after(()=>removeTemporary(harness,'planhub-native-code-'));
const sourceScripts=fileURLToPath(new URL('../scripts/',import.meta.url)),harnessPort=await unusedPort();
for(const name of await readdir(sourceScripts))if(name.endsWith('.mjs'))await cp(path.join(sourceScripts,name),path.join(harness,name));
const gatewayFile=path.join(harness,'local-preview-gateway.mjs'),gatewaySource=await readFile(gatewayFile,'utf8');
assert.match(gatewaySource,/export const LOCAL_PREVIEW_PORT=4173;/);
await writeFile(gatewayFile,gatewaySource.replace('export const LOCAL_PREVIEW_PORT=4173;','export const LOCAL_PREVIEW_PORT='+harnessPort+';'));
const fromHarness=name=>import(pathToFileURL(path.join(harness,name)).href);
const {loadNativePlan,runNativePreview,startNativePreview,stopNativePreview,freePreviewPort}=await fromHarness('native-preview.mjs');
const {spawnService}=await fromHarness('service-process.mjs');
const {createPortalInstance,registerPortal,unregisterPortal,probePortal,workspaceId}=await fromHarness('portal-instance.mjs');
const {createServer}=await fromHarness('dev-server.mjs');
const {runtimeContract}=await fromHarness('delivery-validation.mjs');
const {LOCAL_PREVIEW_PORT:PORT,LOCAL_PREVIEW_ORIGIN:ORIGIN}=await fromHarness('local-preview-gateway.mjs');
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const put=async(file,value)=>{await mkdir(path.dirname(file),{recursive:true});await writeFile(file,typeof value==='string'?value:JSON.stringify(value));};
const readJson=async file=>JSON.parse(await readFile(file,'utf8'));
async function hashFiles(root){
  const files={};
  async function visit(directory){for(const entry of await readdir(directory,{withFileTypes:true})){const filename=path.join(directory,entry.name);if(entry.isDirectory())await visit(filename);else files[path.relative(root,filename).split(path.sep).join('/')]=sha(await readFile(filename));}}
  await visit(root);return files;
}
async function release(root,id,files,type='static'){
  const items=[];for(const [name,value]of Object.entries(files)){await put(path.join(root,'releases',id,'payload',name),value);items.push({path:name,bytes:Buffer.byteLength(value),sha256:sha(value)});}
  await put(path.join(root,'releases',id,'app-release.json'),{schemaVersion:1,appId:id,version:'fixture-v1',type,basePath:'/'+id+'/',entryPoint:type==='static'?'index.html':'server.py',sourceRevision:'fixture',dataMode:type==='static'?'stateless':'external',healthPath:type==='static'?'/':'/healthz',files:items});
}
async function listen(server,port=0){await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});return server.address().port;}
async function close(server){if(server?.listening){server.closeAllConnections?.();await new Promise(resolve=>server.close(resolve));}}
async function unusedPort(){const server=net.createServer(),port=await listen(server);await close(server);return port;}
async function removeTemporary(directory,prefix){
  const resolved=await realpath(directory),temporary=await realpath(os.tmpdir());
  assert.equal(path.dirname(resolved),temporary);assert.ok(path.basename(resolved).startsWith(prefix));
  await rm(resolved,{recursive:true,force:true,maxRetries:10,retryDelay:100});
}
async function fixture(t,{dynamic=true,staticChild=false}={}){
  const root=await mkdtemp(path.join(os.tmpdir(),'planhub-native-test-'));
  const packageRoot=path.join(root,'delivery'),runtimeRoot=path.join(root,'planhub-preview','snapshot-'+'a'.repeat(32));let port=await unusedPort();
  t.after(async()=>{
    const identity=await probePortal(PORT);
    if(identity&&identity.workspaceId===await workspaceId(runtimeRoot))await stopNativePreview(runtimeRoot);
    await removeTemporary(root,'planhub-native-test-');
  });
  while(port===PORT)port=await unusedPort();
  const bindings={planhub:{type:'static',port:4173,healthPath:'/'}},apps=[];
  if(dynamic){bindings['vehicle-config']={type:'service',port:8790,previewPort:port,healthPath:'/healthz',healthExpected:{ok:true,app:'vehicle-config'},arguments:['-B','{payload}/server.py','--port','{port}','--data-dir','{data}'],environment:{}};apps.push({id:'vehicle-config',enabled:true});}
  if(staticChild){bindings.leads={type:'static',port:8781,previewPort:port,healthPath:'/',stripPrefix:true};apps.push({id:'leads',enabled:true});}
  await release(packageRoot,'planhub',{'index.html':'<title>Fixture portal</title>','config/apps.json':JSON.stringify({groups:[{apps}]})});
  if(dynamic)await release(packageRoot,'vehicle-config',{'server.py':'# Immutable fixture, never executed by tests.\n','requirements.txt':''},'service');
  if(staticChild)await release(packageRoot,'leads',{'index.html':'Fixture static application'});
  await put(path.join(packageRoot,'bindings.json'),bindings);
  for(const file of ['runtime/node/node.exe','runtime/python/python.exe','launcher/native-preview.mjs','deploy.ps1','compose.json','build-docker.ps1'])await put(path.join(packageRoot,file),'fixture only');
  const applications=['planhub',...apps.map(app=>app.id)],versions=Object.fromEntries(applications.map(id=>[id,'fixture-v1']));
  const manifest={schemaVersion:2,platform:'windows/amd64+linux/amd64',complete:true,contractHash:sha(JSON.stringify(runtimeContract(bindings))),applications,versions,files:await hashFiles(packageRoot)};
  await put(path.join(packageRoot,'delivery.json'),manifest);
  const config={schemaVersion:1,publicOrigin:ORIGIN,listenAddress:'127.0.0.1',port:PORT,proxySecret:'a'.repeat(64),sopSecret:'b'.repeat(64),vehicleSecret:'c'.repeat(64),sharedDirectory:'shared',sopSharedConfig:'config/shared_config.py',quicklookSourceBase:'shared',preview:{schemaVersion:1,user:'DEPT\\fixture-user',sourceDirectory:path.join(root,'planhub-runtime'),createdAt:new Date().toISOString()}};
  await put(path.join(runtimeRoot,'config.json'),config);await mkdir(config.preview.sourceDirectory,{recursive:true});
  const fake=path.join(root,'fixture-service.mjs');
  await put(fake,"import http from 'node:http';const port=Number(process.argv[2]);const server=http.createServer((req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(req.url==='/healthz'?{ok:true,app:'vehicle-config'}:{user:req.headers['x-config-user'],secret:req.headers['x-config-proxy-key']}));});server.listen(port,'127.0.0.1');");
  return {root,packageRoot,runtimeRoot,port,config,manifest,fake};
}
function fixtureSpawner(f,seen=[]){
  return (command,args,options)=>{
    const port=Number(args[args.indexOf('--port')+1]),child=spawnService(process.execPath,[f.fake,String(port)],options);seen.push({command,args,options,port,pid:child.pid});return child;
  };
}
async function stopOnExit(t,f){t.after(async()=>{const identity=await probePortal(PORT);if(identity&&identity.workspaceId===await workspaceId(f.runtimeRoot))await stopNativePreview(f.runtimeRoot);});}

test('native preview uses one public port with the preferred backend port and stops its owned child',async t=>{
  const f=await fixture(t),plan=await loadNativePlan(f.packageRoot,f.runtimeRoot),seen=[];
  await stopOnExit(t,f);const configBefore=await readFile(path.join(f.runtimeRoot,'config.json')),bindingsBefore=await readFile(path.join(f.packageRoot,'bindings.json'));
  const server=await runNativePreview(plan,{startService:fixtureSpawner(f,seen),serviceTimeoutMs:5000});
  assert.equal(server.address().address,'127.0.0.1');assert.equal(server.address().port,PORT);
  assert.equal(seen[0].port,f.port);assert.equal(plan.bindings['vehicle-config'].port,8790);
  assert.equal(seen[0].command,path.join(f.packageRoot,'runtime/python/python.exe'));
  assert.ok(seen[0].args.map(value=>path.normalize(value)).includes(path.join(f.packageRoot,'releases/vehicle-config/payload/server.py')));
  assert.equal(seen[0].args[1],'-c');assert.match(seen[0].args[2],/sys\.path\.insert/);
  assert.ok(seen[0].args.includes(path.join(f.runtimeRoot,'data/vehicle-config')));
  assert.equal(seen[0].options.env.VEHICLE_CONFIG_PROXY_SECRET,f.config.vehicleSecret);
  assert.equal(seen[0].options.env.PLANHUB_PYTHON_APP_ROOT,path.join(f.packageRoot,'releases/vehicle-config/payload'));
  assert.equal(seen[0].options.env.PATH.split(path.delimiter)[0],path.join(f.packageRoot,'runtime/node'));
  assert.equal(seen[0].options.env.VIRTUAL_ENV,undefined);
  const result=await fetch(ORIGIN+'/vehicle-config/identity',{headers:{'X-PlanHub-User':'FORGED\\user','X-Config-Proxy-Key':'forged'}});
  assert.deepEqual(await result.json(),{user:'DEPT\\fixture-user',secret:f.config.vehicleSecret});
  const identity=await probePortal(PORT),record=await readJson(path.join(f.runtimeRoot,'native-ports.json')),owner=await readJson(path.join(f.runtimeRoot,'native-owner.json'));
  assert.equal(identity.pid,process.pid);assert.equal(record.instanceId,identity.instanceId);assert.equal(record.pid,identity.pid);assert.equal(record.lease,owner.lease);
  assert.deepEqual(record.ports,{'vehicle-config':f.port});
  assert.deepEqual(record.processes,{'vehicle-config':seen[0].pid});
  assert.equal(await runNativePreview(plan,{startService(){throw new Error('Reused preview must not start another child');}}),null);
  await stopNativePreview(f.runtimeRoot);
  await freePreviewPort(f.port);await freePreviewPort(PORT);
  await assert.rejects(readFile(path.join(f.runtimeRoot,'native-ports.json')),/ENOENT/);
  assert.deepEqual(await readFile(path.join(f.runtimeRoot,'config.json')),configBefore);assert.deepEqual(await readFile(path.join(f.packageRoot,'bindings.json')),bindingsBefore);
});

test('an occupied preferred backend port automatically falls back without using or stopping its owner',async t=>{
  const f=await fixture(t),plan=await loadNativePlan(f.packageRoot,f.runtimeRoot);let foreignRequests=0;
  const foreign=http.createServer((_request,response)=>{foreignRequests++;response.end('foreign program');});
  await listen(foreign,f.port);t.after(()=>close(foreign));await stopOnExit(t,f);
  const seen=[];await runNativePreview(plan,{startService:fixtureSpawner(f,seen),serviceTimeoutMs:5000});
  assert.notEqual(seen[0].port,f.port);assert.equal(foreignRequests,0);
  assert.equal((await fetch(ORIGIN+'/vehicle-config/identity')).status,200);
  assert.equal((await readJson(path.join(f.runtimeRoot,'native-ports.json'))).ports['vehicle-config'],seen[0].port);
  await stopNativePreview(f.runtimeRoot);await freePreviewPort(seen[0].port);
  assert.equal(foreign.listening,true);assert.equal(await (await fetch('http://127.0.0.1:'+f.port)).text(),'foreign program');
});

test('an occupied public portal port remains an error and no backend is started',async t=>{
  const f=await fixture(t),plan=await loadNativePlan(f.packageRoot,f.runtimeRoot),foreign=http.createServer((_request,response)=>response.end('foreign'));
  await listen(foreign,PORT);t.after(()=>close(foreign));let starts=0;
  await assert.rejects(runNativePreview(plan,{startService(){starts++;}}),/unavailable \(EADDRINUSE\)/);
  assert.equal(starts,0);assert.equal(foreign.listening,true);
  await assert.rejects(readFile(path.join(f.runtimeRoot,'native-owner.json')),/ENOENT/);
  await assert.rejects(readFile(path.join(f.runtimeRoot,'native-ports.json')),/ENOENT/);
});

test('release damage, incomplete app closure and arbitrary snapshot paths fail before service startup',async t=>{
  const f=await fixture(t);
  await assert.rejects(loadNativePlan(f.packageRoot,path.join(f.root,'formal-data')),/snapshot created/);
  await put(path.join(f.packageRoot,'releases/vehicle-config/payload/server.py'),'tampered');
  await assert.rejects(loadNativePlan(f.packageRoot,f.runtimeRoot),/damaged/);
  const g=await fixture(t);g.manifest.complete=false;await put(path.join(g.packageRoot,'delivery.json'),g.manifest);
  await assert.rejects(loadNativePlan(g.packageRoot,g.runtimeRoot),/complete current delivery/);
});

test('detached preview reuses the owned actual mapping after a preferred static port conflict',async t=>{
  const f=await fixture(t,{dynamic:false,staticChild:true}),foreign=http.createServer((_request,response)=>response.end('foreign'));
  await listen(foreign,f.port);t.after(()=>close(foreign));await stopOnExit(t,f);
  const first=await startNativePreview(f.packageRoot,f.runtimeRoot,{settleMs:100,timeoutMs:10000});
  assert.equal(first.reused,false);
  const identity=await probePortal(PORT);assert.notEqual(identity.pid,process.pid);
  const mapping=await readJson(path.join(f.runtimeRoot,'native-ports.json'));assert.notEqual(mapping.ports.leads,f.port);
  assert.equal(await (await fetch(ORIGIN+'/leads/')).text(),'Fixture static application');
  const again=await startNativePreview(f.packageRoot,f.runtimeRoot,{settleMs:100,timeoutMs:10000});assert.equal(again.reused,true);
  assert.deepEqual(await readJson(path.join(f.runtimeRoot,'native-ports.json')),mapping);
  mapping.instanceId=crypto.randomUUID();await put(path.join(f.runtimeRoot,'native-ports.json'),mapping);
  await assert.rejects(startNativePreview(f.packageRoot,f.runtimeRoot,{settleMs:100,timeoutMs:10000}),/port record does not match/);
  await stopNativePreview(f.runtimeRoot);await freePreviewPort(PORT);assert.equal(foreign.listening,true);
});

test('a failed child startup releases all reservations and its own metadata',async t=>{
  const f=await fixture(t),plan=await loadNativePlan(f.packageRoot,f.runtimeRoot);
  await assert.rejects(runNativePreview(plan,{startService(command,args,options){return spawnService(process.execPath,['-e','process.exit(7)'],options);},serviceTimeoutMs:1000}),/did not start/);
  await assert.rejects(readFile(path.join(f.runtimeRoot,'native-owner.json')),/ENOENT/);
  await assert.rejects(readFile(path.join(f.runtimeRoot,'native-ports.json')),/ENOENT/);
  await freePreviewPort(PORT);await freePreviewPort(f.port);
});

test('a matching foreign health listener is rejected before any request while the owned child is still starting',{skip:process.platform!=='win32'},async t=>{
  const f=await fixture(t),plan=await loadNativePlan(f.packageRoot,f.runtimeRoot);let foreign,requests=0,child;
  t.after(()=>close(foreign));
  await assert.rejects(runNativePreview(plan,{startService(_command,args){
    const port=Number(args[args.indexOf('--port')+1]);
    foreign=http.createServer((_request,response)=>{requests++;response.setHeader('Content-Type','application/json');response.end(JSON.stringify({ok:true,app:'vehicle-config'}));});
    foreign.listen(port,'127.0.0.1');
    child=spawnService(process.execPath,['-e','setTimeout(()=>process.exit(7),5000)'],{logDirectory:path.join(f.runtimeRoot,'logs/race')});return child;
  },serviceTimeoutMs:5000}),/does not belong to the process/);
  assert.equal(requests,0);assert.equal(foreign.listening,true);assert.equal(await probePortal(PORT),null);
  await assert.rejects(readFile(path.join(f.runtimeRoot,'native-ports.json')),/ENOENT/);
});

test('legacy 4174 snapshots can be securely stopped without touching the new public port',async t=>{
  const f=await fixture(t,{dynamic:false}),legacyPort=4174;
  f.config.publicOrigin='http://127.0.0.1:'+legacyPort;f.config.port=legacyPort;await put(path.join(f.runtimeRoot,'config.json'),f.config);
  const runtime=await createPortalInstance(f.runtimeRoot,legacyPort,'legacy-fixture'),owner=path.join(f.runtimeRoot,'native-owner.json');
  await put(owner,{pid:process.pid,lease:'legacy-fixture'});
  const portal=createServer({root:f.runtimeRoot,portalRoot:path.join(f.packageRoot,'releases/planhub/payload'),applications:{},runtime});
  const unrelated=http.createServer((_request,response)=>response.end('keep running'));
  await listen(unrelated,PORT);t.after(()=>close(unrelated));await listen(portal,legacyPort);t.after(()=>close(portal));await registerPortal(f.runtimeRoot,runtime);
  runtime.stop=()=>{portal.close();portal.closeAllConnections?.();void unlink(owner);void unregisterPortal(f.runtimeRoot,runtime);};
  await stopNativePreview(f.runtimeRoot);assert.equal(unrelated.listening,true);await freePreviewPort(legacyPort);
});
