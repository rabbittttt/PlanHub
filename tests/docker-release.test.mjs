import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import http from 'node:http';
import {fileURLToPath} from 'node:url';
import {writeFileSync} from 'node:fs';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {buildDockerPackage,hashFile} from '../scripts/build-docker.mjs';
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
function fakeDocker(){
  const images=new Map(),calls=[];
  function execute(args,options={}){
    calls.push(args);
    if(args[0]==='info')return 'linux/x86_64';
    if(args[0]==='compose')return args[1]==='version'?'2.24.0':'';
    if(args[0]==='build'){
      const tag=args[args.indexOf('--tag')+1],label=args[args.indexOf('--label')+1].split('=')[1];
      images.set(tag,{Id:'sha256:'+sha(tag),Os:'linux',Architecture:'amd64',Config:{Labels:{'planhub.fingerprint':label}}});return '';
    }
    if(args[1]==='inspect')return images.has(args[2])?JSON.stringify([images.get(args[2])]):options.allowMissing?null:assert.fail('Unknown image');
    if(args[1]==='save'){writeFileSync(args[args.indexOf('--output')+1],'fixture image archive');return '';}
    assert.fail('Unexpected Docker command: '+args.join(' '));
  }
  return {execute,calls,images};
}
test('complete Docker delivery is one ASCII folder, with unchanged verified releases and offline images',async t=>{
  const base=await temporary(t),docker=fakeDocker();
  const portal=await release(base,'planhub',{'index.html':'portal','config/apps.json':JSON.stringify({groups:[{apps:[{id:'leads',enabled:true}]}]})});
  const leads=await release(base,'leads',{'index.html':'original child page'}),before=await hashFile(path.join(leads,'app-release.json'));
  const destination=path.join(base,'delivery');
  await buildDockerPackage([portal,leads],destination,{complete:true,execute:docker.execute,workDirectory:path.join(base,'build')});
  assert.equal(await hashFile(path.join(leads,'app-release.json')),before);
  const names=await readdir(destination);assert.ok(names.every(name=>/^[\x20-\x7e]+$/.test(name)));
  assert.deepEqual(names.sort(),['README.md','compose.json','delivery.json','deploy.ps1','images.tar','preview.cmd','preview.ps1','runtime.example.json','start.cmd','stop-preview.cmd','stop.cmd']);
  const manifest=JSON.parse(await readFile(path.join(destination,'delivery.json'))),compose=JSON.parse(await readFile(path.join(destination,'compose.json')));
  for(const [name,hash] of Object.entries(manifest.files))assert.equal(await hashFile(path.join(destination,name)),hash);
  assert.deepEqual(manifest.applications,['planhub','leads']);assert.equal(manifest.complete,true);
  assert.equal(compose.services.leads.network_mode,'service:network');assert.equal(compose.services.leads.pull_policy,'never');
  assert.equal(compose.services.leads.volumes[0].target,'/runtime');assert.equal(compose.services.leads.read_only,true);
  assert.equal(Object.values(compose.services).filter(v=>v.ports).length,1);
  const context=docker.calls.find(args=>args[0]==='build'&&args.includes(manifest.images.leads.tag)).at(-1);
  assert.equal(await readFile(path.join(context,'release/payload/index.html'),'utf8'),'original child page');
  assert.equal(await hashFile(path.join(context,'release/app-release.json')),before);
  assert.equal(await readFile(path.join(context,'launcher/local-preview-gateway.mjs'),'utf8'),await readFile(path.join(root,'scripts/local-preview-gateway.mjs'),'utf8'));
  await assert.rejects(buildDockerPackage([portal,leads],destination,{complete:true,execute:docker.execute,workDirectory:path.join(base,'build')}),/exists/);
  await assert.rejects(buildDockerPackage([portal],path.join(base,'incomplete'),{complete:true,execute:docker.execute,workDirectory:path.join(base,'build')}),/Incomplete/);
  await writeFile(path.join(leads,'payload/index.html'),'tampered');
  await assert.rejects(buildDockerPackage([leads],path.join(base,'tampered'),{execute:docker.execute,workDirectory:path.join(base,'build')}),/校验失败/);
});
test('build failure publishes no delivery, and an existing immutable image cannot be replaced',async t=>{
  const base=await temporary(t),app=await release(base,'leads',{'index.html':'original'}),docker=fakeDocker(),destination=path.join(base,'failed');
  const execute=(args,options)=>{if(args[1]==='save')throw new Error('export failed');return docker.execute(args,options);};
  await assert.rejects(buildDockerPackage([app],destination,{execute,workDirectory:path.join(base,'build')}),/export failed/);
  await assert.rejects(readFile(path.join(destination,'delivery.json')),/ENOENT/);
  const first=[...docker.images.keys()][0];docker.images.get(first).Config.Labels['planhub.fingerprint']='tampered';
  await assert.rejects(buildDockerPackage([app],destination,{execute:docker.execute,workDirectory:path.join(base,'build')}),/Immutable image/);
});
test('release validation rejects undeclared private data and checksum or case collisions',async t=>{
  const base=await temporary(t),app=await release(base,'leads',{'index.html':'original'});
  await writeFile(path.join(app,'payload/secret.db'),'private');await assert.rejects(readRelease(app,'leads'),/私有路径/);
  await rm(path.join(app,'payload/secret.db'));
  const file=path.join(app,'app-release.json'),manifest=JSON.parse(await readFile(file));manifest.files.push({...manifest.files[0],path:'INDEX.HTML'});await json(file,manifest);
  await assert.rejects(readRelease(app,'leads'),/清单无效/);
});
test('container contracts keep original loopback, public prefix, external paths and required identities',async()=>{
  const bindings=JSON.parse(await readFile(path.join(root,'deploy/docker/bindings.json')));
  assert.equal(validateRuntime(config),config);
  assert.throws(()=>validateRuntime({...config,sharedDirectory:'../private'}),/relative paths/);
  assert.throws(()=>validateRuntime({...config,publicOrigin:'https://portal.example.invalid'}),/publicOrigin/);
  const order=containerSpec('orderiq',bindings.orderiq,config);assert.ok(order.args.includes('/runtime/data/orderiq/runtime'));assert.ok(order.args.includes('127.0.0.1'));
  const sop=containerSpec('sop',bindings.sop,config);assert.equal(sop.env.SOP_LOCAL_RELEASE_SECRET,config.sopSecret);
  const vehicle=containerSpec('vehicle-config',bindings['vehicle-config'],config);assert.ok(vehicle.args.includes('--require-proxy-identity'));assert.equal(vehicle.env.VEHICLE_CONFIG_PROXY_SECRET,config.vehicleSecret);
  const quick=containerSpec('quicklook',bindings.quicklook,{...config,quicklookSourceBase:'old-source-base'});assert.equal(quick.env.DATA_QUICKLOOK_SOURCE_BASE,'/runtime/old-source-base');
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
