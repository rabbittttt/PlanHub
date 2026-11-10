import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,realpath,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {spawnService,stopService} from '../scripts/service-process.mjs';
import {startAppServices} from '../scripts/app-services.mjs';

async function fixture(t){
 const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'portal-service-log-')));
 t.after(async()=>{assert.equal(path.dirname(await realpath(root)),await realpath(os.tmpdir()));assert.ok(path.basename(root).startsWith('portal-service-log-'));await rm(root,{recursive:true,force:true});});return root;
}
async function port(){const probe=net.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const value=probe.address().port;await new Promise(r=>probe.close(r));return value;}
async function healthy(url){for(let i=0;i<60;i++){try{const res=await fetch(url,{signal:AbortSignal.timeout(300)});if(res.ok)return await res.json();await res.arrayBuffer();}catch{}await new Promise(r=>setTimeout(r,50));}throw Error('Fixture service did not respond');}

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
  assert.equal(response.prefix,'/fixture/');assert.equal(response.data,'../persistent');
  assert.equal(inherited.APP_PUBLIC_PREFIX,'/previous/');
 }finally{stop();await new Promise(r=>setTimeout(r,200));}
});
