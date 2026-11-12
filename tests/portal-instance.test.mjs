import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,realpath,readFile,writeFile,mkdir,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import {createServer} from '../scripts/dev-server.mjs';
import {HEALTH_PATH,STOP_PATH,probePortal,workspaceId,configurationId,createPortalInstance,registerPortal,unregisterPortal,stopPortal} from '../scripts/portal-instance.mjs';

async function fixture(t,beforeRemove=async()=>{}){const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'portal-instance-')));t.after(async()=>{await beforeRemove();assert.equal(path.dirname(await realpath(root)),await realpath(os.tmpdir()));assert.ok(path.basename(root).startsWith('portal-instance-'));await rm(root,{recursive:true,force:true});});return root;}
async function free(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}
async function serve(t,root,runtime){const server=createServer({root,runtime});await new Promise(r=>server.listen(runtime.identity.port,'127.0.0.1',r));runtime.stop=()=>server.close();t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));});return server;}

test('health identifies the workspace without revealing the control token or stopping services',async t=>{
 const root=await fixture(t),port=await free(),runtime=await createPortalInstance(root,port,'config-a');
 await serve(t,root,runtime);await registerPortal(root,runtime);
 const health=await probePortal(port);assert.equal(health.workspaceId,await workspaceId(root));assert.equal(health.instanceId,runtime.identity.instanceId);assert.equal(health.token,undefined);
 const origin='http://127.0.0.1:'+port;
 assert.equal((await fetch(origin+STOP_PATH)).status,405);
 assert.equal((await fetch(origin+STOP_PATH,{method:'POST'})).status,403);
 assert.equal((await fetch(origin+STOP_PATH,{method:'POST',headers:{'X-PlanHub-Control':runtime.token,Origin:'http://elsewhere.invalid'}})).status,403);
 const wrongHost=await new Promise((resolve,reject)=>{const req=http.get({hostname:'127.0.0.1',port,path:HEALTH_PATH,headers:{Host:'elsewhere.invalid'}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);});
 assert.equal(wrongHost,403);
 assert.ok(await probePortal(port));
 await stopPortal(root,port);assert.equal(await probePortal(port),null);await unregisterPortal(root,runtime);
});

test('stale records and another workspace cannot stop or clean up the current instance',async t=>{
 const root=await fixture(t),other=await fixture(t),port=await free(),runtime=await createPortalInstance(root,port,'config-a');
 await serve(t,root,runtime);await registerPortal(root,runtime);
 await assert.rejects(stopPortal(other,port),/其他工作区/);
 const filename=path.join(root,'artifacts/portal-instances',port+'-'+runtime.identity.instanceId+'.json'),record=JSON.parse(await readFile(filename,'utf8'));
 await writeFile(filename,JSON.stringify({...record,instanceId:'stale'}));await assert.rejects(stopPortal(root,port),/不匹配/);assert.ok(await probePortal(port));
 await writeFile(filename,JSON.stringify(record));await unregisterPortal(root,{identity:{port,instanceId:'old'}});assert.equal(JSON.parse(await readFile(filename,'utf8')).instanceId,record.instanceId);
 const successor=await createPortalInstance(root,port,'config-b');await registerPortal(root,successor);
 await unregisterPortal(root,runtime);
 assert.equal(JSON.parse(await readFile(path.join(root,'artifacts/portal-instances',port+'-'+successor.identity.instanceId+'.json'),'utf8')).instanceId,successor.identity.instanceId);
 await registerPortal(root,runtime);await stopPortal(root,port);await unregisterPortal(root,runtime);await unregisterPortal(root,successor);
});

test('configuration identity changes with the backend, source paths, data modes and application mappings',async t=>{
 const sourceRoot=await fixture(t),otherSourceRoot=await fixture(t);
 for(const source of [sourceRoot,otherSourceRoot]){
  await mkdir(path.join(source,'sop'));
  await writeFile(path.join(source,'server.py'),'# server entry\n');
  await writeFile(path.join(source,'sop','gateway.py'),'# backend module\n');
 }
 const settings={root:'workspace',sourceRoot,dataDirectory:'data',salesSourceDir:'sales',planSourceFile:'plan.xlsx',sharedConfig:'rules.py',port:4173,backendPort:8877,snapshot:false,demo:false};
 const applications={forecast:{type:'static',root:'output'}};
 const baseline=await configurationId(settings,applications,'python');
 for(const change of [{backendPort:8878},{dataDirectory:'other'},{planSourceFile:'other.xlsx'},{sourceRoot:otherSourceRoot},{snapshot:true},{demo:true}])assert.notEqual(await configurationId({...settings,...change},applications,'python'),baseline);
 assert.notEqual(await configurationId(settings,{forecast:{type:'static',root:'other'}},'python'),baseline);
 assert.notEqual(await configurationId(settings,applications,'different-python'),baseline);
 await writeFile(path.join(sourceRoot,'server.py'),'# changed server route\n');
 assert.notEqual(await configurationId(settings,applications,'python'),baseline);
 await writeFile(path.join(sourceRoot,'server.py'),'# server entry\n');
 await writeFile(path.join(sourceRoot,'sop','option_mix.py'),'# newly added backend module\n');
 assert.notEqual(await configurationId(settings,applications,'python'),baseline);
});

test('a static-only preview cannot be mistaken for a full portal instance',async t=>{
 const root=await fixture(t),server=createServer({root});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r);}));assert.equal(await probePortal(server.address().port),null);
});


test('stop waits for portal and backend ports when shutdown blocks the event loop',{timeout:15000},async t=>{
 let child,exited;
 const waitForExit=async timeout=>{
  let timer;
  try{return await Promise.race([exited.then(()=>true),new Promise(resolve=>{timer=setTimeout(()=>resolve(false),timeout);})]);}
  finally{clearTimeout(timer);}
 };
 const root=await fixture(t,async()=>{
  if(!child)return;
  if(child.exitCode===null&&child.signalCode===null&&child.connected)child.send({type:'cleanup'},()=>{});
  if(!await waitForExit(4000)){
   child.kill(); // Only the child handle spawned by this fixture; never a discovered PID.
   assert.equal(await waitForExit(3000),true,'The test-owned fixture must exit before directory cleanup');
  }
 });
 const worker=path.join(root,'blocking-stop-fixture.mjs');
 const instanceModule=new URL('../scripts/portal-instance.mjs',import.meta.url).href;
 await writeFile(worker,`
import http from 'node:http';
import {createPortalInstance,registerPortal,unregisterPortal,handlePortalControl} from ${JSON.stringify(instanceModule)};
const root=process.argv[2];
let backend,portal,runtime,stopping=false;
async function shutdown(block=false){
 if(stopping)return;stopping=true;
 if(block)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,2000);
 if(backend){backend.closeAllConnections();await new Promise(resolve=>backend.close(resolve));}
 if(portal){portal.closeAllConnections();await new Promise(resolve=>portal.close(resolve));}
 if(runtime)await unregisterPortal(root,runtime);
 if(process.connected)process.disconnect();
}
process.on('message',message=>{if(message?.type==='cleanup')void shutdown();});
setTimeout(()=>void shutdown(),12000).unref();
backend=http.createServer((request,response)=>response.end('fixture backend'));
await new Promise((resolve,reject)=>{backend.once('error',reject);backend.listen(0,'127.0.0.1',resolve);});
portal=http.createServer((request,response)=>{
 if(handlePortalControl(request,response,runtime,new URL(request.url,'http://fixture').pathname))return;
 response.writeHead(404);response.end();
});
await new Promise((resolve,reject)=>{portal.once('error',reject);portal.listen(0,'127.0.0.1',resolve);});
const port=portal.address().port;
runtime=await createPortalInstance(root,port,'blocking-stop-fixture');
runtime.stop=()=>void shutdown(true);
await registerPortal(root,runtime);
process.send({type:'ready',port,backendPort:backend.address().port});
`);
 child=spawn(process.execPath,[worker,root],{cwd:root,windowsHide:true,stdio:['ignore','ignore','ignore','ipc']});
 exited=new Promise(resolve=>{child.once('exit',resolve);child.once('error',resolve);});
 const ready=await new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>reject(new Error('Timed out starting the isolated shutdown fixture')),4000);
  child.once('message',message=>{clearTimeout(timer);resolve(message);});
  child.once('error',()=>{clearTimeout(timer);reject(new Error('Could not start the isolated shutdown fixture'));});
  child.once('exit',code=>{clearTimeout(timer);reject(new Error('Shutdown fixture exited before readiness: '+code));});
 });
 assert.equal(ready.type,'ready');
 const released=port=>new Promise((resolve,reject)=>{
  const listener=net.createServer();
  listener.once('error',error=>error.code==='EADDRINUSE'?resolve(false):reject(error));
  listener.listen({port,host:'127.0.0.1',exclusive:true},()=>listener.close(()=>resolve(true)));
 });
 await stopPortal(root,ready.port);
 const [portalReleased,backendReleased]=await Promise.all([released(ready.port),released(ready.backendPort)]);
 assert.deepEqual({portalReleased,backendReleased},{portalReleased:true,backendReleased:true},
  'An unresponsive health request is not proof that shutdown released either listening port');
});
