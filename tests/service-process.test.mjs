import {createPortalInstance,probePortal} from '../scripts/portal-instance.mjs';
import {createServer} from '../scripts/dev-server.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,realpath,rm,writeFile,stat} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {PassThrough,Readable} from 'node:stream';
import {finished} from 'node:stream/promises';
import {mirrorContainerLog,spawnService,stopService} from '../scripts/service-process.mjs';
import {startAppServices} from '../scripts/app-services.mjs';

async function fixture(t){
 const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'portal-service-log-')));
 t.after(async()=>{assert.equal(path.dirname(await realpath(root)),await realpath(os.tmpdir()));assert.ok(path.basename(root).startsWith('portal-service-log-'));await rm(root,{recursive:true,force:true});});return root;
}
async function port(){const probe=net.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const value=probe.address().port;await new Promise(r=>probe.close(r));return value;}
async function healthy(url){for(let i=0;i<60;i++){try{const res=await fetch(url,{signal:AbortSignal.timeout(300)});if(res.ok)return await res.json();await res.arrayBuffer();}catch{}await new Promise(r=>setTimeout(r,50));}throw Error('Fixture service did not respond');}

test('container output reaches Compose and the rotated runtime log',async t=>{
 const root=await fixture(t),filename=path.join(root,'stdout.log');
 await writeFile(filename,Buffer.alloc(10*1024*1024));
 const output=new PassThrough();
 let consoleText='';output.on('data',chunk=>{consoleText+=chunk;});
 const file=mirrorContainerLog(Readable.from(['first',' second']),output,filename);
 await finished(file);
 assert.equal(consoleText,'first second');
 assert.match(await readFile(filename,'utf8'),/Starting process\nfirst second$/);
 assert.equal((await stat(filename+'.1')).size,10*1024*1024);
});

test('large backend logs go directly to files and requests remain responsive',async t=>{
 const root=await fixture(t),listenPort=await port();
 const code="const fs=require('fs'),http=require('http');const files=fs.fstatSync(1).isFile()&&fs.fstatSync(2).isFile();console.log('x'.repeat(2*1024*1024));console.error('stderr-marker');http.createServer((req,res)=>{console.error('request');res.end(JSON.stringify({files}));}).listen("+listenPort+",'127.0.0.1');";
 const child=spawnService(process.execPath,['-e',code],{cwd:root,logDirectory:root});
 try{
  const body=await healthy('http://127.0.0.1:'+listenPort);assert.equal(body.files,true);
  const out=await readFile(child.serviceLogs.stdout,'utf8'),err=await readFile(child.serviceLogs.stderr,'utf8');
  assert.ok(out.length>=2*1024*1024);assert.match(err,/stderr-marker/);assert.match(err,/request/);
 }finally{stopService(child);await new Promise(r=>setTimeout(r,200));}
});

test('Windows shutdown also stops a launcher-owned grandchild listener',{skip:process.platform!=='win32'},async t=>{
 const root=await fixture(t),listenPort=await port();
 const worker="require('http').createServer((q,r)=>r.end('{}')).listen("+listenPort+",'127.0.0.1');";
 const launcher="const c=require('child_process').spawn(process.execPath,['-e',"+JSON.stringify(worker)+"],{stdio:'inherit',windowsHide:true});c.on('exit',()=>process.exit());setInterval(()=>{},1000);";
 const child=spawnService(process.execPath,['-e',launcher],{cwd:root,logDirectory:root});
 try{await healthy('http://127.0.0.1:'+listenPort);}finally{stopService(child);}
 await new Promise(r=>setTimeout(r,200));
 const probe=net.createServer();
 await new Promise((resolve,reject)=>{probe.once('error',reject);probe.listen(listenPort,'127.0.0.1',resolve);});
 await new Promise(r=>probe.close(r));
});


test('service launcher passes per-application environment without changing its parent environment',async t=>{
 const root=await fixture(t),listenPort=await port();
 const code="require('http').createServer((q,r)=>{r.setHeader('Content-Type','application/json');r.end(JSON.stringify({app:'fixture',prefix:process.env.APP_PUBLIC_PREFIX,data:process.env.APP_DATA_DIR}));}).listen("+listenPort+",'127.0.0.1');";
 const inherited={...process.env,APP_PUBLIC_PREFIX:'/previous/'};
 const stop=await startAppServices({fixture:{type:'proxy',target:'http://127.0.0.1:'+listenPort,healthPath:'/healthz',healthKeys:['app'],start:{cwd:root,command:process.execPath,args:['-e',code],env:{APP_PUBLIC_PREFIX:'/fixture/',APP_DATA_DIR:'../persistent'}}}},{root,env:inherited});
 try{
  const response=await healthy('http://127.0.0.1:'+listenPort+'/healthz');
  assert.ok((await stat(path.join(root,'artifacts','logs','fixture','stderr.log'))).isFile());
  assert.equal(response.prefix,'/fixture/');assert.equal(response.data,'../persistent');
  assert.equal(inherited.APP_PUBLIC_PREFIX,'/previous/');
 }finally{stop();await new Promise(r=>setTimeout(r,200));}
});

test('partial startup reports warnings and stopping the portal preserves a reused independent service',async t=>{
 const root=await fixture(t),listenPort=await port(),missingPort=await port();
 const code="require('http').createServer((q,r)=>r.end(JSON.stringify({app:'reused-fixture'}))).listen("+listenPort+",'127.0.0.1');";
 const independent=spawnService(process.execPath,['-e',code],{cwd:root,logDirectory:root});
 try{
  await healthy('http://127.0.0.1:'+listenPort);
  const stop=await startAppServices({
   reused:{type:'proxy',target:'http://127.0.0.1:'+listenPort,healthPath:'/',healthKeys:['app'],healthExpected:{app:'reused-fixture'}},
   missing:{type:'proxy',target:'http://127.0.0.1:'+missingPort,healthPath:'/',healthKeys:['app']}
  },{root});
  assert.equal(stop.failures.length,1);assert.match(stop.failures[0],/missing.*暂不可用/);
  stop();
  assert.equal((await healthy('http://127.0.0.1:'+listenPort)).app,'reused-fixture');
 }finally{stopService(independent);await new Promise(r=>setTimeout(r,200));}
});


test('managed services reject healthy foreign listeners and their portal routes stay unavailable',async t=>{
 const root=await fixture(t),listenPort=await port();
 const code="require('http').createServer((q,r)=>r.end(JSON.stringify({app:'foreign'}))).listen("+listenPort+",'127.0.0.1');";
 const independent=spawnService(process.execPath,['-e',code],{cwd:root,logDirectory:root});
 let portal,stop;
 try{
  await healthy('http://127.0.0.1:'+listenPort);
  const apps={example:{type:'proxy',target:'http://127.0.0.1:'+listenPort,stripPrefix:true,rootRoutes:['/api/legacy'],healthPath:'/',healthKeys:['app'],healthExpected:{app:'foreign'},start:{cwd:root,command:process.execPath,args:['-e',code]}}};
  stop=await startAppServices(apps,{root});
  assert.equal(stop.failures.length,1);assert.match(stop.failures[0],/不自动复用/);
  assert.deepEqual(stop.unavailableApps,['example']);
  const portalPort=await port();
  const runtime=await createPortalInstance(root,portalPort,'fixture-config');
  runtime.identity.unavailableApps=stop.unavailableApps;
  portal=createServer({root,applications:apps,runtime});
  await new Promise(resolve=>portal.listen(portalPort,'127.0.0.1',resolve));
  assert.deepEqual((await probePortal(portalPort)).unavailableApps,['example']);
  const origin='http://127.0.0.1:'+portal.address().port;
  for(const endpoint of ['/example/','/example/api/new','/api/legacy']){
   assert.equal((await fetch(origin+endpoint)).status,503);
   assert.equal((await fetch(origin+endpoint,{method:'POST',body:'must not reach old service'})).status,503);
  }
  stop();assert.equal((await healthy('http://127.0.0.1:'+listenPort)).app,'foreign');
 }finally{stop?.();if(portal){portal.closeAllConnections();await new Promise(resolve=>portal.close(resolve));}stopService(independent);await new Promise(r=>setTimeout(r,200));}
});
