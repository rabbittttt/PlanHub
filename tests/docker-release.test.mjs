import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import http from 'node:http';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm,cp} from 'node:fs/promises';
import {buildDelivery} from '../scripts/build-delivery.mjs';
import {collectWindowsRuntime} from '../scripts/build-delivery.mjs';
import {spawnSync} from 'node:child_process';
import {hashFile,validateDelivery,runtimeContract,validateBindings} from '../scripts/delivery-validation.mjs';
import {loadRuntimeBindings} from '../scripts/service-ports.mjs';
import {loadAppIntegrations} from '../scripts/app-integrations.mjs';
import {readRelease} from '../scripts/release-validation.mjs';
import {validateRuntime,containerSpec,createContainerPortal,checkService} from '../scripts/container-runtime.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const json=(file,value)=>writeFile(file,JSON.stringify(value,null,2)+'\n');
const config={schemaVersion:1,publicOrigin:'https://portal.internal',proxySecret:'a'.repeat(64),sopSecret:'b'.repeat(64),vehicleSecret:'c'.repeat(64),sharedDirectory:'shared',sopSharedConfig:'config/shared_config.py',quicklookSourceBase:'shared'};
async function temporary(t){const dir=await mkdtemp(path.join(os.tmpdir(),'planhub-docker-'));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;}
async function release(base,id,files,{type='static',healthPath='/'}={}){
  const directory=path.join(base,id);await mkdir(path.join(directory,'payload'),{recursive:true});const entries=[];
  for(const [name,text] of Object.entries(files)){
    const bytes=Buffer.from(text),file=path.join(directory,'payload',name);await mkdir(path.dirname(file),{recursive:true});await writeFile(file,bytes);
    entries.push({path:name,bytes:bytes.length,sha256:sha(bytes)});
  }
  await json(path.join(directory,'app-release.json'),{schemaVersion:1,appId:id,version:'v1',type,basePath:`/${id}/`,entryPoint:type==='static'?'index.html':'server.py',sourceRevision:'fixture',dataMode:type==='static'?'stateless':'external',healthPath,files:entries});
  return directory;
}
async function fakeRuntime(output,{requirements}){
  await mkdir(path.join(output,'node'),{recursive:true});await writeFile(path.join(output,'node/node.exe'),'fixture Node, never executed');
  if(requirements.length){await mkdir(path.join(output,'python'));await writeFile(path.join(output,'python/python.exe'),'fixture Python, never executed');}
}
test('delivery packages unchanged releases, Windows runtime and Linux materials without Docker',async t=>{
  const base=await temporary(t);
  const portal=await release(base,'planhub',{'index.html':'portal','config/apps.json':JSON.stringify({groups:[{apps:[{id:'leads',enabled:true}]}]})});
  const leads=await release(base,'leads',{'index.html':'original child page'}),before=await hashFile(path.join(leads,'app-release.json'));
  const destination=path.join(base,'delivery');
  await buildDelivery([portal,leads],destination,{complete:true,collectRuntime:fakeRuntime});
  assert.equal(await hashFile(path.join(leads,'app-release.json')),before);
  const names=await readdir(destination);assert.ok(names.every(name=>/^[\x20-\x7e]+$/.test(name)));assert.ok(!names.includes('images.tar'));
  for(const name of ['prepare.cmd','preview.cmd','stop-preview.cmd','build-docker.cmd','start.cmd','runtime','releases','launcher','docker'])assert.ok(names.includes(name));
  const {manifest}=await validateDelivery(destination,{requireComplete:true}),compose=JSON.parse(await readFile(path.join(destination,'compose.json')));
  for(const [name,hash] of Object.entries(manifest.files))assert.equal(await hashFile(path.join(destination,name)),hash);
  assert.deepEqual(manifest.applications,['planhub','leads']);assert.equal(manifest.complete,true);
  assert.equal(compose.services.leads.network_mode,'service:network');assert.equal(compose.services.leads.pull_policy,'never');
  assert.equal(compose.services.leads.volumes[0].target,'/runtime');assert.equal(compose.services.leads.read_only,true);
  assert.equal(Object.values(compose.services).filter(v=>v.ports).length,1);
  assert.equal(await readFile(path.join(destination,'releases/leads/payload/index.html'),'utf8'),'original child page');
  assert.equal(await hashFile(path.join(destination,'releases/leads/app-release.json')),before);
  const dockerfile=await readFile(path.join(destination,'docker/leads.Dockerfile'),'utf8');
  assert.match(dockerfile,/COPY releases\/leads \.\/release/);assert.doesNotMatch(dockerfile,/runtime\/node|runtime\/python/);
  assert.match(await readFile(path.join(destination,'.dockerignore'),'utf8'),/^\*\*/);
  await assert.rejects(buildDelivery([portal,leads],destination,{complete:true,collectRuntime:fakeRuntime}),/exists/);
  await assert.rejects(buildDelivery([portal],path.join(base,'incomplete'),{complete:true,collectRuntime:fakeRuntime}),/Incomplete/);
  await writeFile(path.join(destination,'runtime/node/node.exe'),'corrupted');await assert.rejects(validateDelivery(destination),/damaged/);
  await writeFile(path.join(leads,'payload/index.html'),'tampered');
  await assert.rejects(buildDelivery([leads],path.join(base,'tampered'),{collectRuntime:fakeRuntime}),/校验失败/);
});
test('runtime failure publishes no completed folder and undeclared files fail validation',async t=>{
  const base=await temporary(t),app=await release(base,'leads',{'index.html':'original'}),destination=path.join(base,'failed');
  await assert.rejects(buildDelivery([app],destination,{collectRuntime:async()=>{throw new Error('missing dependency');}}),/missing dependency/);
  await assert.rejects(readFile(path.join(destination,'delivery.json')),/ENOENT/);
  assert.ok(!(await readdir(base)).some(name=>name.startsWith('.planhub-partial-')));
  await buildDelivery([app],destination,{collectRuntime:fakeRuntime});
  await writeFile(path.join(destination,'extra.txt'),'undeclared');await assert.rejects(validateDelivery(destination),/file set/);
});

test('complete program-only update skips Windows environment collection and remains a valid Docker delivery',async t=>{
  const base=await temporary(t);
  const portal=await release(base,'planhub',{'index.html':'portal','config/apps.json':JSON.stringify({groups:[{apps:[{id:'leads',enabled:true}]}]})});
  const leads=await release(base,'leads',{'index.html':'updated page'}),destination=path.join(base,'planhub-update');
  await buildDelivery([portal,leads],destination,{complete:true,withoutRuntime:true,collectRuntime(){throw new Error('Program-only update must not collect an environment');}});
  const {manifest}=await validateDelivery(destination,{requireComplete:true});
  assert.equal(manifest.runtimeMode,'reuse');assert.match(manifest.snapshotContractHash,/^[a-f0-9]{64}$/);
  assert.ok(!(await readdir(destination)).includes('runtime'));assert.ok(!Object.keys(manifest.files).some(name=>name.startsWith('runtime/')));
  assert.ok(Object.keys(manifest.files).includes('runtime-common.ps1'));
  await assert.rejects(buildDelivery([leads],path.join(base,'partial'),{withoutRuntime:true}),/complete application set/);
  manifest.runtimeMode='included';await json(path.join(destination,'delivery.json'),manifest);
  await assert.rejects(validateDelivery(destination),/runtime\/node/);
});
test('dynamic delivery includes its Python dependencies and pins Linux build content',async t=>{
  const base=await temporary(t),app=await release(base,'quicklook',{'server.py':'# source-owned fixture','requirements.txt':'openpyxl>=3.1,<4\n'},{type:'service',healthPath:'/healthz'});
  let seen;
  const destination=path.join(base,'dynamic');await buildDelivery([app],destination,{collectRuntime:async(output,options)=>{seen=options;await fakeRuntime(output,options);}});
  const {manifest}=await validateDelivery(destination);assert.equal(seen.requirements.length,1);assert.equal(await readFile(seen.requirements[0],'utf8'),'openpyxl>=3.1,<4\n');
  assert.match(manifest.images.quicklook.fingerprint,/^[a-f0-9]{64}$/);
  assert.match(await readFile(path.join(destination,'docker/quicklook.Dockerfile'),'utf8'),/RUN python -m pip install/);
});
test('actual bundled Node runs without the build computer PATH or a Node installation', {skip:process.platform!=='win32'||process.arch!=='x64'}, async t=>{
  const base=await temporary(t),output=path.join(base,'runtime');await collectWindowsRuntime(output,{requirements:[]});
  const env={...process.env,PATH:path.join(process.env.SystemRoot,'System32')};
  delete env.NODE_OPTIONS;delete env.NODE_PATH;
  const result=spawnSync(path.join(output,'node/node.exe'),['-e',"process.stdout.write(require('node:crypto').createHash('sha256').update('portable').digest('hex'))"],{cwd:base,env,encoding:'utf8',windowsHide:true});
  assert.equal(result.status,0,result.stderr);assert.equal(result.stdout,sha('portable'));
  const licenseName=(await readdir(path.join(output,'node'))).find(name=>/^LICENSE\.(txt|rtf)$/.test(name));
  assert.ok(licenseName);assert.ok((await readFile(path.join(output,'node',licenseName))).length>1000);
});
test('binary-only Node installation packages offline with the exact bundled license', {skip:process.platform!=='win32'||process.arch!=='x64'}, async t=>{
  const catalog=JSON.parse(await readFile(path.join(root,'deploy/licenses/node/index.json'),'utf8'));
  if(!catalog.versions[process.version]){t.skip('The current Node version has no checked-in offline fallback.');return;}
  const base=await temporary(t),bare=path.join(base,'bare-node'),output=path.join(base,'collected');await mkdir(bare);
  const executable=path.join(bare,'node.exe');await cp(process.execPath,executable);
  const moduleUrl=pathToFileURL(path.join(root,'scripts/build-delivery.mjs')).href;
  const script=`const {collectWindowsRuntime}=await import(${JSON.stringify(moduleUrl)});await collectWindowsRuntime(process.argv[1],{requirements:[]});`;
  const result=spawnSync(executable,['--input-type=module','-e',script,output],{cwd:base,encoding:'utf8',windowsHide:true});
  assert.equal(result.status,0,result.stderr);
  assert.deepEqual(await readFile(path.join(output,'node/LICENSE.txt')),await readFile(path.join(root,'deploy/licenses/node',process.version+'.LICENSE.txt')));
  assert.deepEqual((await readdir(bare)).sort(),['node.exe']);
});
test('release validation rejects undeclared private data and checksum or case collisions',async t=>{
  const base=await temporary(t),app=await release(base,'leads',{'index.html':'original'});
  await writeFile(path.join(app,'payload/secret.db'),'private');await assert.rejects(readRelease(app,'leads'),/私有路径/);
  await rm(path.join(app,'payload/secret.db'));
  const file=path.join(app,'app-release.json'),manifest=JSON.parse(await readFile(file));manifest.files.push({...manifest.files[0],path:'INDEX.HTML'});await json(file,manifest);
  await assert.rejects(readRelease(app,'leads'),/清单无效/);
});
test('container contracts keep original loopback, public prefix, external paths and required identities',async()=>{
  const bindings=await loadRuntimeBindings(root);
  assert.equal(validateRuntime(config),config);
  assert.throws(()=>validateRuntime({...config,sharedDirectory:'../private'}),/relative paths/);
  assert.throws(()=>validateRuntime({...config,publicOrigin:'https://portal.example.invalid'}),/publicOrigin/);
  const order=containerSpec('orderiq',bindings.orderiq,config);assert.ok(order.args.includes('/runtime/data/orderiq/runtime'));assert.ok(order.args.includes('127.0.0.1'));
  const sop=containerSpec('sop',bindings.sop,config);assert.equal(sop.env.SOP_LOCAL_RELEASE_SECRET,config.sopSecret);
  const vehicle=containerSpec('vehicle-config',bindings['vehicle-config'],config);assert.ok(vehicle.args.includes('--require-proxy-identity'));assert.equal(vehicle.env.VEHICLE_CONFIG_PROXY_SECRET,config.vehicleSecret);
  const quick=containerSpec('quicklook',bindings.quicklook,{...config,quicklookSourceBase:'old-source-base'});assert.equal(quick.env.DATA_QUICKLOOK_SOURCE_BASE,'/runtime/old-source-base');
});
test('child defaults use one port registration and retired preview preferences cannot create a second source',async()=>{
  const bindings=await loadRuntimeBindings(root);
  assert.ok(Object.values(bindings).every(binding=>!Object.hasOwn(binding,'previewPort')));
  assert.equal(bindings.quicklook.port,9473);assert.equal(bindings.sop.port,8876);
  const integration=await loadAppIntegrations(root);
  assert.equal(new URL(integration.quicklook.target).port,String(bindings.quicklook.port));
  const legacy=structuredClone(bindings);legacy.quicklook.previewPort=43175;
  assert.deepEqual(runtimeContract(legacy),runtimeContract(bindings));
  const changed=structuredClone(bindings);changed.quicklook.port=changed.sop.port;
  assert.throws(()=>validateBindings(changed,{}),/duplicate runtime port/);
});
async function listen(t,server){await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{server.closeAllConnections?.();server.close(resolve);}));return server.address().port;}
function request(url,headers={}){return new Promise((resolve,reject)=>{const req=http.get(url,{headers},res=>{res.resume();res.on('end',()=>resolve({status:res.statusCode}));});req.on('error',reject);});}
test('authenticated gateway forwards verified per-request identity; forged headers do not reach child services',async t=>{
  const base=await temporary(t);await writeFile(path.join(base,'index.html'),'portal');let seen;
  const upstream=http.createServer((req,res)=>{seen={url:req.url,headers:req.headers};res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ok:true,app:'vehicle-config',public_prefix:'/vehicle-config/'}));});
  const backend=await listen(t,upstream),bindings={planhub:{type:'static'},'vehicle-config':{port:backend,stripPrefix:true},sop:{port:backend}};
  const server=createContainerPortal(base,bindings,config),port=await listen(t,server),url='http://127.0.0.1:'+port;
  assert.equal((await request(url)).status,403);
  const headers={Host:'portal.internal','X-PlanHub-Key':config.proxySecret,'X-PlanHub-User':'DEPT\\alice','X-Config-User':'forged','X-SOP-User':'forged','X-Config-Proxy-Key':'forged'};
  assert.equal((await request(url+'/vehicle-config/healthz',headers)).status,200);
  assert.equal(seen.url,'/healthz');assert.equal(seen.headers['x-config-user'],'DEPT\\alice');assert.equal(seen.headers['x-config-proxy-key'],config.vehicleSecret);
  assert.equal(seen.headers['x-planhub-key'],undefined);assert.equal(seen.headers['x-sop-user'],undefined);
  await request(url+'/sop/api/health',headers);assert.equal(seen.url,'/sop/api/health');assert.equal(seen.headers['x-sop-user'],'b64:'+Buffer.from('DEPT\\alice').toString('base64'));assert.equal(seen.headers['x-sop-proxy-key'],config.sopSecret);
  assert.equal(seen.headers['x-planhub-key'],undefined);assert.equal(seen.headers['x-config-user'],undefined);
  assert.equal((await request(url,{...headers,'X-PlanHub-Key':'bad'})).status,403);
  assert.equal((await request(url,{...headers,Host:'attacker.internal'})).status,403);
  await checkService('planhub',{port,healthPath:'/',type:'static'},config);
});
