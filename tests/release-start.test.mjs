import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,readFile,readdir,realpath,rename,rm,copyFile} from 'node:fs/promises';
import {loadReleasePlan,runRelease,startReleased} from '../scripts/start-release.mjs';
import {probePortal,stopPortal,workspaceId} from '../scripts/portal-instance.mjs';

const releaseScript=fileURLToPath(new URL('../scripts/start-release.mjs',import.meta.url));
const repository=path.resolve(path.dirname(releaseScript),'..');
const BUNDLE_FILE='bundle.json';
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const sha256=value=>crypto.createHash('sha256').update(value).digest('hex');
const writeJson=(filename,value)=>writeFile(filename,JSON.stringify(value,null,2)+'\n');
function inside(root,filename){const relative=path.relative(root,filename);return relative===''||(!path.isAbsolute(relative)&&relative!=='..'&&!relative.startsWith('..'+path.sep));}
function alive(pid){try{process.kill(pid,0);return true;}catch{return false;}}

async function ports(count){
  const servers=[];
  try{
    for(let index=0;index<count;index++){
      const server=net.createServer();
      await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
      servers.push(server);
    }
    return servers.map(server=>server.address().port);
  }finally{await Promise.all(servers.map(server=>new Promise(resolve=>server.close(resolve))));}
}
async function eventually(operation,message,timeout=6000){
  const deadline=Date.now()+timeout;
  do{if(await operation())return;await delay(50);}while(Date.now()<deadline);
  assert.fail(message);
}
async function portClosed(port){
  return new Promise(resolve=>{
    const socket=net.createConnection({host:'127.0.0.1',port});
    socket.once('connect',()=>{socket.destroy();resolve(false);});
    socket.once('error',error=>{socket.destroy();resolve(error.code==='ECONNREFUSED');});
    socket.setTimeout(350,()=>{socket.destroy();resolve(false);});
  });
}
async function treeSnapshot(directory){
  const result={};
  async function visit(current){
    for(const entry of await readdir(current,{withFileTypes:true})){
      const filename=path.join(current,entry.name),relative=path.relative(directory,filename).split(path.sep).join('/');
      if(entry.isDirectory()){result[relative+'/']='directory';await visit(filename);}
      else result[relative]=sha256(await readFile(filename));
    }
  }
  await visit(directory);return result;
}
async function envelope(bundleRoot,id,files,{type='static',entryPoint='index.html',healthPath='/'}={}){
  const release=path.join('releases',id,'fixture-v1'),root=path.join(bundleRoot,release),entries=[];
  for(const [relative,value] of Object.entries(files)){
    const content=Buffer.from(value),filename=path.join(root,'payload',relative);
    await mkdir(path.dirname(filename),{recursive:true});await writeFile(filename,content);
    entries.push({path:relative,bytes:content.length,sha256:sha256(content)});
  }
  await writeJson(path.join(root,'app-release.json'),{schemaVersion:1,appId:id,version:'fixture-v1',type,basePath:`/${id}/`,entryPoint,sourceRevision:'isolated-release-test',dataMode:type==='static'?'stateless':'external',healthPath,files:entries});
  return {release:release.split(path.sep).join('/')};
}

// This is fixture-owned program code, not a copy of any business application.
// It only writes the explicit external --data directory and has a cleanup flag.
const serviceSource=`
import http from 'node:http';
import path from 'node:path';
import {mkdir,readFile,writeFile,access} from 'node:fs/promises';
const option=name=>process.argv[process.argv.indexOf(name)+1];
const port=Number(option('--port')),data=option('--data');
await mkdir(data,{recursive:true});
const valuePath=path.join(data,'saved-value.txt');
const server=http.createServer(async(request,response)=>{
  try{
    if(request.url==='/healthz'){response.setHeader('Content-Type','application/json');return response.end(JSON.stringify({app:'fixture'}));}
    if(request.url==='/api/value'){
      if(request.method==='POST'){const chunks=[];for await(const chunk of request)chunks.push(chunk);await writeFile(valuePath,Buffer.concat(chunks));}
      const value=await readFile(valuePath,'utf8').catch(error=>{if(error.code==='ENOENT')return '';throw error;});
      response.setHeader('Content-Type','application/json');return response.end(JSON.stringify({value,data}));
    }
    if(request.url==='/'){response.setHeader('Content-Type','text/html');return response.end('<title>Isolated release fixture</title>');}
    response.writeHead(404);response.end('fixture route not found');
  }catch(error){response.writeHead(500);response.end(error.message);}
});
let stopping=false;
function stop(){if(stopping)return;stopping=true;clearInterval(safety);server.closeAllConnections();server.close();}
const safety=setInterval(async()=>{try{await access(path.join(data,'.fixture-stop'));stop();}catch{}},50);
process.once('SIGTERM',stop);process.once('SIGINT',stop);
setTimeout(stop,45000).unref();
server.listen(port,'127.0.0.1',()=>{console.log('fixture release ready');console.error('fixture service stderr');});
`;

async function fixture(t){
  const base=await realpath(await mkdtemp(path.join(os.tmpdir(),'planhub-release-test-')));
  const bundleRoot=path.join(base,'发布包 含空格'),runRoot=path.join(base,'独立运行 数据'),data=path.join(runRoot,'data','fixture');
  const [port,backendPort]=await ports(2);
  await mkdir(bundleRoot);await mkdir(data,{recursive:true});
  const registry={platform:{name:'Release fixture',defaultApp:'home'},groups:[{id:'fixture-group',apps:[{id:'fixture',name:'Fixture',enabled:true,status:'ready',url:'/fixture/'},{id:'leads',name:'Static fixture',enabled:true,status:'ready',url:'/leads/'}]}]};
  const applications={
    planhub:await envelope(bundleRoot,'planhub',{'index.html':'<title>Immutable portal fixture</title>','config/apps.json':JSON.stringify(registry)}),
    fixture:await envelope(bundleRoot,'fixture',{'server.mjs':serviceSource},{type:'service',entryPoint:'server.mjs',healthPath:'/healthz'}),
    leads:await envelope(bundleRoot,'leads',{'index.html':'<title>Immutable static fixture</title>','assets/fixture.js':'window.releaseFixture=true;'})
  };
  const bundle={schemaVersion:1,applications};await writeJson(path.join(bundleRoot,BUNDLE_FILE),bundle);
  const config={schemaVersion:1,portalPort:port,python:process.execPath,sharedDirectory:'shared',sopSharedConfig:'config/shared_config.py',applications:{fixture:{port:backendPort,dataDirectory:'data/fixture',arguments:['{payload}/server.mjs','--port','{port}','--data','{data}'],environment:{},stripPrefix:true,healthExpected:{app:'fixture'}}}};
  await writeJson(path.join(runRoot,'config.local.json'),config);
  const cleanups=[],ownedPids=[];
  t.after(async()=>{
    try{
      const running=await probePortal(port);
      if(running?.workspaceId===await workspaceId(runRoot))await stopPortal(runRoot,port);
    }finally{
      for(const cleanup of cleanups.reverse())await cleanup();
      await writeFile(path.join(data,'.fixture-stop'),'stop');
      await eventually(()=>portClosed(backendPort),'The fixture backend was left running during cleanup');
      await eventually(()=>ownedPids.every(pid=>!alive(pid)),'The detached release owner was left running after stop');
      assert.equal(path.dirname(await realpath(base)),await realpath(os.tmpdir()));
      assert.ok(path.basename(base).startsWith('planhub-release-test-'));
      await rm(base,{recursive:true,force:true,maxRetries:5,retryDelay:50});
    }
  });
  return {base,bundleRoot,runRoot,data,port,backendPort,bundle,config,cleanups,ownedPids};
}

test('a moved immutable bundle serves its own portal, static app and proxy with external persistent data',async t=>{
  const f=await fixture(t),moved=path.join(f.base,'已移动发布包');
  await rename(f.bundleRoot,moved);
  const original=await treeSnapshot(moved),plan=await loadReleasePlan(moved,f.runRoot);
  assert.equal(plan.bundleRoot,await realpath(moved));assert.equal(plan.runRoot,await realpath(f.runRoot));assert.equal(plan.port,f.port);
  assert.equal(plan.portalRoot,path.join(moved,f.bundle.applications.planhub.release,'payload'));
  assert.ok(inside(moved,plan.applications.fixture.start.cwd),'Service code must come from the verified payload');
  assert.equal(await portClosed(f.port),true,'Loading a plan must not start the portal');
  await runRelease(plan);
  const origin='http://127.0.0.1:'+f.port;
  assert.match(await fetch(origin+'/').then(r=>r.text()),/Immutable portal fixture/);
  assert.match(await fetch(origin+'/leads/').then(r=>r.text()),/Immutable static fixture/);
  assert.equal(await fetch(origin+'/leads/assets/fixture.js').then(r=>r.text()),'window.releaseFixture=true;');
  assert.deepEqual(await fetch(origin+'/fixture/healthz').then(r=>r.json()),{app:'fixture'});
  const written=await fetch(origin+'/fixture/api/value',{method:'POST',body:'saved outside release'}).then(r=>r.json());
  assert.equal(written.value,'saved outside release');assert.equal(written.data,f.data);
  assert.equal(await readFile(path.join(f.data,'saved-value.txt'),'utf8'),'saved outside release');
  assert.equal((await fetch(origin+'/releases/fixture/fixture-v1/payload/server.mjs')).status,404);
  await stopPortal(f.runRoot,f.port);
  await eventually(()=>portClosed(f.backendPort),'Stopping the release portal left its backend running');
  assert.deepEqual(await treeSnapshot(moved),original,'Startup, saving and stopping must leave every immutable bundle byte unchanged');
});

test('changed release bytes are rejected before starting anything',async t=>{
  const f=await fixture(t);
  await writeFile(path.join(f.bundleRoot,f.bundle.applications.fixture.release,'payload/server.mjs'),serviceSource+'\n// tampered\n');
  await assert.rejects(loadReleasePlan(f.bundleRoot,f.runRoot));
  assert.equal(await portClosed(f.port),true);assert.equal(await portClosed(f.backendPort),true);
});

test('an enabled registered application cannot be omitted from the bundle',async t=>{
  const f=await fixture(t);delete f.bundle.applications.fixture;
  await writeJson(path.join(f.bundleRoot,BUNDLE_FILE),f.bundle);
  await assert.rejects(loadReleasePlan(f.bundleRoot,f.runRoot));
  assert.equal(await portClosed(f.port),true);
});

test('unsafe and case-duplicate manifest paths are rejected',async t=>{
  for(const entry of [{path:'../outside.txt',bytes:1,sha256:sha256('x')},{path:'SERVER.MJS',bytes:Buffer.byteLength(serviceSource),sha256:sha256(serviceSource)}]){
    await t.test(entry.path,async sub=>{
      const f=await fixture(sub),manifestPath=path.join(f.bundleRoot,f.bundle.applications.fixture.release,'app-release.json');
      const manifest=JSON.parse(await readFile(manifestPath,'utf8'));manifest.files.push(entry);await writeJson(manifestPath,manifest);
      await assert.rejects(loadReleasePlan(f.bundleRoot,f.runRoot));
    });
  }
});

test('local mutable data and the runtime root must stay outside every bundle version',async t=>{
  const f=await fixture(t);
  f.config.applications.fixture.dataDirectory=path.join(f.bundleRoot,'releases/fixture/fixture-v1/payload/private-state');
  await writeJson(path.join(f.runRoot,'config.local.json'),f.config);
  await assert.rejects(loadReleasePlan(f.bundleRoot,f.runRoot));
  const nestedRuntime=path.join(f.bundleRoot,'local-runtime');await mkdir(nestedRuntime);
  f.config.applications.fixture.dataDirectory='data/fixture';await writeJson(path.join(nestedRuntime,'config.local.json'),f.config);
  await assert.rejects(loadReleasePlan(f.bundleRoot,nestedRuntime));
});

test('an occupied healthy-looking backend is neither reused nor stopped',async t=>{
  const f=await fixture(t),external=http.createServer((request,response)=>{response.setHeader('Content-Type','application/json');response.end(JSON.stringify({app:'fixture',external:true}));});
  await new Promise(resolve=>external.listen(f.backendPort,'127.0.0.1',resolve));
  f.cleanups.push(async()=>{external.closeAllConnections();await new Promise(resolve=>external.close(resolve));});
  const plan=await loadReleasePlan(f.bundleRoot,f.runRoot);
  await assert.rejects(runRelease(plan));
  const response=await fetch('http://127.0.0.1:'+f.backendPort+'/healthz').then(r=>r.json());
  assert.equal(response.external,true);assert.equal(await probePortal(f.port),null);
});

test('the runtime fingerprint changes when persistent data bindings change',async t=>{
  const f=await fixture(t),before=await loadReleasePlan(f.bundleRoot,f.runRoot);
  f.config.applications.fixture.dataDirectory='data/other';await mkdir(path.join(f.runRoot,'data/other'));
  await writeJson(path.join(f.runRoot,'config.local.json'),f.config);
  const after=await loadReleasePlan(f.bundleRoot,f.runRoot);
  assert.notEqual(after.configId,before.configId);
});

test('one runtime cannot start a second owner on different ports while retaining the same persistent data',async t=>{
  const f=await fixture(t),originalPlan=await loadReleasePlan(f.bundleRoot,f.runRoot);
  await runRelease(originalPlan);
  const originalIdentity=await probePortal(f.port),lockPath=path.join(f.runRoot,'release-owner.lock');
  assert.ok(originalIdentity);
  const originalLock=await readFile(lockPath,'utf8'),[newPortal,newBackend]=await ports(2);
  // A regression must still clean the isolated second instance if it unexpectedly starts.
  f.cleanups.push(async()=>{
    const second=await probePortal(newPortal);
    if(second?.workspaceId===await workspaceId(f.runRoot))await stopPortal(f.runRoot,newPortal);
    await eventually(()=>portClosed(newBackend),'The second fixture backend was left running');
  });
  f.config.portalPort=newPortal;f.config.applications.fixture.port=newBackend;
  await writeJson(path.join(f.runRoot,'config.local.json'),f.config);
  const changedPlan=await loadReleasePlan(f.bundleRoot,f.runRoot);
  assert.equal(changedPlan.applications.fixture.data,f.data,'The second plan must retain the original persistent data directory');
  assert.notEqual(changedPlan.configId,originalPlan.configId);
  await assert.rejects(runRelease(changedPlan));
  assert.equal(await portClosed(newPortal),true);assert.equal(await portClosed(newBackend),true);
  assert.equal(await readFile(lockPath,'utf8'),originalLock,'A rejected owner must not replace or release the running owner lease');
  const remaining=await probePortal(f.port);assert.equal(remaining?.instanceId,originalIdentity.instanceId);
  assert.match(await fetch('http://127.0.0.1:'+f.port+'/').then(response=>response.text()),/Immutable portal fixture/);
  assert.deepEqual(await fetch('http://127.0.0.1:'+f.port+'/fixture/healthz').then(response=>response.json()),{app:'fixture'});
  await stopPortal(f.runRoot,f.port);
  await eventually(async()=>{try{await readFile(lockPath);return false;}catch(error){if(error.code==='ENOENT')return true;throw error;}},'Stopping the original owner did not release its runtime lease');
});

test('a detached released portal survives its opener, reuses the same bundle and stops through the release CLI',async t=>{
  const f=await fixture(t),original=await treeSnapshot(f.bundleRoot);
  await startReleased(f.bundleRoot,f.runRoot,{settleMs:50,timeoutMs:15000});
  const first=await probePortal(f.port);
  assert.ok(first);assert.notEqual(first.pid,process.pid,'The release must run in its own background process');
  f.ownedPids.push(first.pid);
  await delay(150);
  assert.match(await fetch('http://127.0.0.1:'+f.port+'/').then(r=>r.text()),/Immutable portal fixture/);
  assert.deepEqual(await fetch('http://127.0.0.1:'+f.port+'/fixture/healthz').then(r=>r.json()),{app:'fixture'});
  await startReleased(f.bundleRoot,f.runRoot,{settleMs:0,timeoutMs:15000});
  const repeated=await probePortal(f.port);
  assert.equal(repeated.instanceId,first.instanceId);assert.equal(repeated.pid,first.pid,'Repeated launch must not create another owner or backend');
  const stopped=spawnSync(process.execPath,[releaseScript,'stop','--bundle',f.bundleRoot,'--runtime',f.runRoot],{encoding:'utf8',timeout:15000,windowsHide:true});
  assert.equal(stopped.error,undefined);assert.equal(stopped.status,0,stopped.stderr);
  assert.equal(await probePortal(f.port),null);await eventually(()=>portClosed(f.backendPort),'The release CLI left its owned backend listening');
  assert.deepEqual(await treeSnapshot(f.bundleRoot),original);
});

test('the delivered launcher modules and real Windows CMD files run independently and retain the bundle bytes',{skip:process.platform!=='win32'},async t=>{
  const f=await fixture(t),launcher=path.join(f.bundleRoot,'_launcher');
  await mkdir(launcher);
  // Keep this explicit runtime inventory aligned with New-LocalBundle.ps1.
  const modules=['start-release.mjs','dev-server.mjs','app-integrations.mjs','proxy-request.mjs','portal-instance.mjs','service-process.mjs','health-check.mjs'];
  for(const name of modules)await copyFile(path.join(repository,'scripts',name),path.join(launcher,name));
  for(const name of ['启动发布版工作台.cmd','停止发布版工作台.cmd']){
    await copyFile(path.join(repository,'deploy','local-bundle',name),path.join(f.bundleRoot,name));
    const script=await readFile(path.join(f.bundleRoot,name),'utf8');
    assert.ok(script.includes('\r\n')&&!/(^|[^\r])\n/.test(script),name+' must be delivered with CRLF line endings for Windows CMD');
  }
  const original=await treeSnapshot(f.bundleRoot),cmd=path.join(process.env.SystemRoot,'System32','cmd.exe');
  const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>key.toUpperCase()!=='PATH'));
  env.PATH=path.dirname(process.execPath)+path.delimiter+(process.env.PATH??process.env.Path??'');
  const invoke=name=>spawnSync(cmd,['/d','/s','/c',`${name} --runtime "${f.runRoot}"`],{cwd:f.bundleRoot,env,encoding:'utf8',input:'\r\n',timeout:20000,windowsHide:true,windowsVerbatimArguments:true});
  const began=Date.now(),started=invoke('启动发布版工作台.cmd'),elapsed=Date.now()-began;
  assert.equal(started.error,undefined);assert.equal(started.status,0,started.stderr+'\n'+started.stdout);
  assert.ok(elapsed>=2900,'A fresh delivered CMD launch must retain its default three-second readiness confirmation: '+started.stdout+'\n'+started.stderr);
  const identity=await probePortal(f.port);assert.ok(identity);f.ownedPids.push(identity.pid);
  await delay(150);
  assert.match(await fetch('http://127.0.0.1:'+f.port+'/').then(response=>response.text()),/Immutable portal fixture/);
  assert.deepEqual(await fetch('http://127.0.0.1:'+f.port+'/fixture/healthz').then(response=>response.json()),{app:'fixture'});
  assert.equal((await readdir(launcher)).sort().join('|'),modules.slice().sort().join('|'),'The delivered launcher must not rely on undeclared repository modules');
  const stopped=invoke('停止发布版工作台.cmd');
  assert.equal(stopped.error,undefined);assert.equal(stopped.status,0,stopped.stderr+'\n'+stopped.stdout);
  assert.equal(await probePortal(f.port),null);await eventually(()=>portClosed(f.backendPort),'The delivered stop CMD left its owned backend running');
  assert.deepEqual(await treeSnapshot(f.bundleRoot),original,'The delivered CMD launch must not write logs, configuration, data or generated files into the bundle');
});

test('a later service startup failure cleans the already-started owned service and preserves every release byte',async t=>{
  const f=await fixture(t);
  let [brokenPort]=await ports(1);while([f.port,f.backendPort].includes(brokenPort))[brokenPort]=await ports(1);
  f.bundle.applications.broken=await envelope(f.bundleRoot,'broken',{'server.mjs':'throw new Error("fixture must use its deliberately missing entry argument");'},{type:'service',entryPoint:'server.mjs',healthPath:'/healthz'});
  const portal=path.join(f.bundleRoot,f.bundle.applications.planhub.release),registryPath=path.join(portal,'payload/config/apps.json');
  const registry=JSON.parse(await readFile(registryPath,'utf8'));
  registry.groups[0].apps.push({id:'broken',name:'Broken fixture',enabled:true,status:'ready',url:'/broken/'});
  await writeJson(registryPath,registry);
  const manifestPath=path.join(portal,'app-release.json'),manifest=JSON.parse(await readFile(manifestPath,'utf8')),registryBytes=await readFile(registryPath);
  Object.assign(manifest.files.find(file=>file.path==='config/apps.json'),{bytes:registryBytes.length,sha256:sha256(registryBytes)});
  await writeJson(manifestPath,manifest);await writeJson(path.join(f.bundleRoot,BUNDLE_FILE),f.bundle);
  f.config.startupTimeoutSeconds=1;
  f.config.applications.broken={port:brokenPort,dataDirectory:'data/broken',arguments:['{payload}/missing-fixture-entry.mjs','--port','{port}'],environment:{},stripPrefix:true,healthExpected:{app:'broken'}};
  await writeJson(path.join(f.runRoot,'config.local.json'),f.config);
  const original=await treeSnapshot(f.bundleRoot),plan=await loadReleasePlan(f.bundleRoot,f.runRoot);
  await assert.rejects(runRelease(plan));
  await eventually(()=>portClosed(f.backendPort),'The healthy earlier service was left running after a later startup failure');
  assert.equal(await portClosed(brokenPort),true);assert.equal(await probePortal(f.port),null);
  assert.deepEqual(await treeSnapshot(f.bundleRoot),original);
});
