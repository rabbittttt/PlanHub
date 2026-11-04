import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,readFile,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import {createServer} from '../scripts/dev-server.mjs';
import {HEALTH_PATH,STOP_PATH,probePortal,workspaceId,configurationId,createPortalInstance,registerPortal,unregisterPortal,stopPortal} from '../scripts/portal-instance.mjs';

async function fixture(t){const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'portal-instance-')));t.after(async()=>{assert.equal(path.dirname(await realpath(root)),await realpath(os.tmpdir()));assert.ok(path.basename(root).startsWith('portal-instance-'));await rm(root,{recursive:true,force:true});});return root;}
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

test('configuration identity changes with the backend, source paths, data modes and application mappings',async()=>{
 const settings={root:'workspace',sourceRoot:'source',dataDirectory:'data',salesSourceDir:'sales',planSourceFile:'plan.xlsx',sharedConfig:'rules.py',port:4173,backendPort:8877,snapshot:false,demo:false};
 const applications={forecast:{type:'static',root:'output'}};
 const baseline=await configurationId(settings,applications,'python');
 for(const change of [{backendPort:8878},{dataDirectory:'other'},{planSourceFile:'other.xlsx'},{sourceRoot:'other-source'},{snapshot:true},{demo:true}])assert.notEqual(await configurationId({...settings,...change},applications,'python'),baseline);
 assert.notEqual(await configurationId(settings,{forecast:{type:'static',root:'other'}},'python'),baseline);
 assert.notEqual(await configurationId(settings,applications,'different-python'),baseline);
});

test('a static-only preview cannot be mistaken for a full portal instance',async t=>{
 const root=await fixture(t),server=createServer({root});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r);}));assert.equal(await probePortal(server.address().port),null);
});
