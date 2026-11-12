import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,readFile,readdir,realpath,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {startBackground} from '../scripts/start-background.mjs';
import {probePortal,stopPortal,workspaceId} from '../scripts/portal-instance.mjs';
import {stopService} from '../scripts/service-process.mjs';

const repository=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const instanceModule=pathToFileURL(path.join(repository,'scripts/portal-instance.mjs')).href;
const backgroundModule=pathToFileURL(path.join(repository,'scripts/start-background.mjs')).href;
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));

function alive(pid){try{process.kill(pid,0);return true;}catch{return false;}}
async function eventually(operation,message,{timeout=4000}={}){
  const deadline=Date.now()+timeout;
  do {if(await operation())return;await delay(40);}while(Date.now()<deadline);
  assert.fail(message);
}
async function ports(count){
  const listeners=[];
  try{
    for(let i=0;i<count;i++){
      const server=net.createServer();
      await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
      listeners.push(server);
    }
    return listeners.map(server=>server.address().port);
  }finally{await Promise.all(listeners.map(server=>new Promise(resolve=>server.close(resolve))));}
}
async function fixtureResponse(port){
  try{
    const response=await fetch('http://127.0.0.1:'+port+'/fixture',{signal:AbortSignal.timeout(350)});
    if(!response.ok){await response.arrayBuffer();return null;}
    return await response.json();
  }catch{return null;}
}

// These workers exercise only the portal's health/control protocol. They never
// load Python, application configuration, business code, or real data files.
const workerSource=`
import http from 'node:http';
import {spawn} from 'node:child_process';
import {fstatSync} from 'node:fs';
import {readFile,writeFile,access} from 'node:fs/promises';
import path from 'node:path';
import {createPortalInstance,registerPortal,unregisterPortal,handlePortalControl,probePortal} from ${JSON.stringify(instanceModule)};
const root=process.env.PORTAL_BG_TEST_ROOT;
const mode=process.env.PORTAL_BG_TEST_MODE||'normal';
const port=Number(process.argv[process.argv.indexOf('--port')+1]);
await writeFile(path.join(root,'fixture-pid-'+process.pid+'.json'),JSON.stringify({pid:process.pid,mode}));
console.log('fixture-worker-start '+process.pid);
console.error('fixture-stderr '+mode);
let server,runtime,grandchild,stopping=false;
async function shutdown(){
  if(stopping)return;stopping=true;
  if(grandchild&&grandchild.exitCode===null)grandchild.kill();
  if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  if(runtime)await unregisterPortal(root,runtime);
  process.exit(0);
}
// A test-only stop flag prevents orphan fixtures even when the launcher under
// test is broken. Cleanup never targets an unrelated process by a port or PID.
const safeguard=setInterval(async()=>{try{await access(path.join(root,'fixture-stop'));await shutdown();}catch{}},40);
setTimeout(shutdown,30000).unref();
async function send(message){if(process.connected)await new Promise((resolve,reject)=>process.send(message,error=>error?reject(error):resolve()));}
if(mode==='error'){
  await send({type:'error',message:'fixture startup failed'});
}else if(mode==='hang-tree'){
  const childPort=Number(process.env.PORTAL_BG_TEST_CHILD_PORT);
  const childCode=\
    "const http=require('http'),fs=require('fs'),path=require('path');"+\
    "const root="+JSON.stringify(root)+";"+\
    "fs.writeFileSync(path.join(root,'fixture-pid-'+process.pid+'.json'),JSON.stringify({pid:process.pid,mode:'grandchild'}));"+\
    "const server=http.createServer((q,r)=>{r.setHeader('Content-Type','application/json');r.end(JSON.stringify({fixture:true,pid:process.pid}));}).listen("+childPort+",'127.0.0.1');"+\
    "setInterval(()=>{if(fs.existsSync(path.join(root,'fixture-stop'))){server.closeAllConnections();server.close(()=>process.exit());}},40);setTimeout(()=>process.exit(),30000).unref();";
  grandchild=spawn(process.execPath,['-e',childCode],{windowsHide:true,stdio:'ignore'});
  grandchild.on('error',error=>console.error(error.message));
}else if(mode==='ready-no-listen'){
  await send({type:'ready',reused:false,warnings:[]});
}else if(mode==='reused'){
  if(!await probePortal(port))throw Error('The reused fixture is not running');
  await send({type:'ready',reused:true,warnings:[]});
  clearInterval(safeguard);
  if(process.connected)process.disconnect();
}else{
  runtime=await createPortalInstance(root,port,'background-fixture');
  runtime.stop=shutdown;
  server=http.createServer((request,response)=>{
    if(handlePortalControl(request,response,runtime,new URL(request.url,'http://fixture').pathname))return;
    response.setHeader('Content-Type','application/json');
    response.end(JSON.stringify({fixture:true,pid:process.pid,logFiles:fstatSync(1).isFile()&&fstatSync(2).isFile()}));
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
  await registerPortal(root,runtime);
  await send({type:'ready',reused:false,warnings:mode==='warning'?['fixture optional service missing']:[]});
  if(process.connected)process.disconnect();
  if(mode==='ready-exit')setTimeout(()=>process.exit(7),120);
}
`;

async function fixture(t){
  const temporary=await realpath(await mkdtemp(path.join(os.tmpdir(),'portal background 测试-')));
  const root=path.join(temporary,'工作台 含空格');
  await mkdir(root);
  const workerPath=path.join(temporary,'worker.mjs');
  await writeFile(workerPath,workerSource);
  const roots=[root],children=[],listeners=[];
  t.after(async()=>{
    // Ask our fixtures to close themselves first; do not kill a discovered PID.
    for(const directory of roots)await writeFile(path.join(directory,'fixture-stop'),'stop');
    for(const {root:directory,port} of listeners){
      try{if((await probePortal(port))?.workspaceId===await workspaceId(directory))await stopPortal(directory,port);}catch{}
    }
    for(const child of children)stopService(child);
    await eventually(async()=>{
      for(const directory of roots){
        for(const name of (await readdir(directory)).filter(name=>name.startsWith('fixture-pid-'))){
          const {pid}=JSON.parse(await readFile(path.join(directory,name),'utf8'));
          if(alive(pid))return false;
        }
      }
      return true;
    },'Test-owned workers did not stop after the fixture cleanup flag',{timeout:5000});
    assert.equal(path.dirname(await realpath(temporary)),await realpath(os.tmpdir()));
    assert.ok(path.basename(temporary).startsWith('portal background 测试-'));
    // Windows may release directory handles shortly after the verified worker exit.
    await rm(temporary,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  });
  return {
    root,temporary,workerPath,children,
    track(port,directory=root){listeners.push({root:directory,port});},
    async otherRoot(){const other=path.join(temporary,'其他 工作区');await mkdir(other);roots.push(other);return other;},
    options(mode='normal',extra={}){
      return {root,workerPath,env:{...process.env,PORTAL_BG_TEST_ROOT:root,PORTAL_BG_TEST_MODE:mode},timeoutMs:6000,settleMs:180,...extra};
    }
  };
}

async function launchedLogs(root){
  const artifacts=path.join(root,'artifacts');
  const directories=(await readdir(artifacts)).filter(name=>name.startsWith('portal-launch-'));
  assert.equal(directories.length,1,'A single launch must retain its own log directory');
  const logDirectory=path.join(artifacts,directories[0]);
  return {logDirectory,stdout:await readFile(path.join(logDirectory,'stdout.log'),'utf8'),stderr:await readFile(path.join(logDirectory,'stderr.log'),'utf8')};
}

test('background HTTP survives its launcher process and the existing stop command can stop it',{timeout:15000},async t=>{
  const f=await fixture(t),[port]=await ports(1);
  f.track(port);
  const output=path.join(f.temporary,'launcher-result.json');
  const runner=path.join(f.temporary,'launcher.mjs');
  await writeFile(runner,`
import {writeFile} from 'node:fs/promises';
import {startBackground} from ${JSON.stringify(backgroundModule)};
const result=await startBackground(['--port',${JSON.stringify(String(port))}],${JSON.stringify(f.options('warning'))});
await writeFile(${JSON.stringify(output)},JSON.stringify(result));
`);
  const launcher=spawn(process.execPath,[runner],{cwd:f.root,windowsHide:true,stdio:['ignore','pipe','pipe']});
  f.children.push(launcher);
  let stdout='',stderr='';
  launcher.stdout.on('data',chunk=>stdout+=chunk);
  launcher.stderr.on('data',chunk=>stderr+=chunk);
  await eventually(()=>launcher.exitCode!==null||launcher.signalCode!==null,'Launcher did not exit after detaching its background worker',{timeout:10000});
  assert.equal(launcher.exitCode,0,stdout+'\n'+stderr);
  const result=JSON.parse(await readFile(output,'utf8'));
  assert.equal(result.url,'http://127.0.0.1:'+port+'/');
  assert.equal(result.reused,false);
  assert.deepEqual(result.warnings,['fixture optional service missing']);
  const health=await probePortal(port);
  assert.ok(health,'Exiting the launcher must not stop its background HTTP server');
  assert.notEqual(health.pid,launcher.pid);
  assert.equal(health.workspaceId,await workspaceId(f.root));
  assert.equal((await fixtureResponse(port)).logFiles,true,'Worker stdout and stderr must be real files, not inherited terminal handles');
  assert.equal(path.dirname(result.logDirectory),path.join(f.root,'artifacts'));
  assert.ok(path.basename(result.logDirectory).startsWith('portal-launch-'));
  assert.match(await readFile(path.join(result.logDirectory,'stdout.log'),'utf8'),/fixture-worker-start/);
  assert.match(await readFile(path.join(result.logDirectory,'stderr.log'),'utf8'),/fixture-stderr warning/);
  await stopPortal(f.root,port);
  await eventually(()=>!alive(health.pid),'The existing stop command did not stop the detached worker');
  assert.equal(await probePortal(port),null);
});

test('the actual Windows CMD exits after the three-second confirmation while its fixture portal stays running',{
  timeout:15000,skip:process.platform!=='win32'
},async t=>{
  const f=await fixture(t),[port]=await ports(1);
  f.track(port);
  const scripts=path.join(f.root,'scripts'),output=path.join(f.temporary,'cmd-result.json');
  await mkdir(scripts);
  // Preserve the actual batch bytes, including its code page and pause logic.
  await writeFile(path.join(f.root,'启动本地门户.cmd'),await readFile(path.join(repository,'启动本地门户.cmd')));
  const options=f.options();
  delete options.settleMs; // Exercise the production three-second default.
  await writeFile(path.join(scripts,'start-background.mjs'),`
import {writeFile} from 'node:fs/promises';
import {startBackground} from ${JSON.stringify(backgroundModule)};
const result=await startBackground(process.argv.slice(2),${JSON.stringify(options)});
await writeFile(${JSON.stringify(output)},JSON.stringify(result));
`);
  const beginning=Date.now();
  const cmd=spawn(process.env.ComSpec??'cmd.exe',['/d','/c','启动本地门户.cmd --port '+port],{
    cwd:f.root,windowsHide:true,stdio:['ignore','pipe','pipe']
  });
  f.children.push(cmd);
  let stdout='',stderr='';
  cmd.stdout.on('data',chunk=>stdout+=chunk);
  cmd.stderr.on('data',chunk=>stderr+=chunk);
  await eventually(()=>cmd.exitCode!==null||cmd.signalCode!==null,'The successful CMD remained open instead of exiting',{timeout:10000});
  assert.equal(cmd.exitCode,0,stdout+'\n'+stderr);
  assert.ok(Date.now()-beginning>=2900,'The real CMD must wait for the three-second readiness confirmation');
  const result=JSON.parse(await readFile(output,'utf8'));
  assert.equal(result.reused,false);
  assert.deepEqual(result.warnings,[]);
  const health=await probePortal(port);
  assert.ok(health,'Exiting the actual CMD must leave the detached portal alive');
  assert.notEqual(health.pid,cmd.pid);
  await stopPortal(f.root,port);
  await eventually(()=>!alive(health.pid),'The stop command did not stop the portal launched through the CMD');
});

test('repeated background launch reuses the running instance without terminating it',{timeout:15000},async t=>{
  const f=await fixture(t),[port]=await ports(1);
  f.track(port);
  await startBackground(['--port',String(port)],f.options());
  const first=await probePortal(port);
  const repeated=await startBackground(['--port',String(port)],f.options('reused'));
  assert.equal(repeated.reused,true);
  assert.equal(repeated.url,'http://127.0.0.1:'+port+'/');
  const current=await probePortal(port);
  assert.equal(current.pid,first.pid);
  assert.equal(current.instanceId,first.instanceId);
  assert.ok(alive(first.pid));
  await stopPortal(f.root,port);
});

test('explicit startup errors reject, retain diagnostics, and terminate the new worker',{timeout:15000},async t=>{
  const f=await fixture(t),[port]=await ports(1);
  await assert.rejects(startBackground(['--port',String(port)],f.options('error')),/fixture startup failed/);
  const logs=await launchedLogs(f.root);
  assert.match(logs.stdout,/fixture-worker-start/);
  assert.match(logs.stderr,/fixture-stderr error/);
  const record=(await readdir(f.root)).find(name=>name.startsWith('fixture-pid-'));
  assert.ok(record);
  const {pid}=JSON.parse(await readFile(path.join(f.root,record),'utf8'));
  await eventually(()=>!alive(pid),'A worker that reported startup failure was left alive');
  assert.equal(await probePortal(port),null);
});

test('a ready message is rejected if the new worker exits during the settling interval',{timeout:15000},async t=>{
  const f=await fixture(t),[port]=await ports(1);
  f.track(port);
  await assert.rejects(startBackground(['--port',String(port)],f.options('ready-exit',{settleMs:600})));
  assert.equal(await probePortal(port),null);
  assert.match((await launchedLogs(f.root)).stdout,/fixture-worker-start/);
});

test('forged readiness cannot adopt or terminate a different workspace instance',{timeout:15000},async t=>{
  const f=await fixture(t),[port]=await ports(1),other=await f.otherRoot();
  const external=spawn(process.execPath,[f.workerPath,'--background-worker','--port',String(port)],{
    cwd:other,windowsHide:true,stdio:'ignore',env:{...process.env,PORTAL_BG_TEST_ROOT:other,PORTAL_BG_TEST_MODE:'normal'}
  });
  f.children.push(external);f.track(port,other);
  await eventually(()=>fixtureResponse(port),'The external fixture did not start');
  const first=await probePortal(port);
  assert.equal(first.workspaceId,await workspaceId(other));
  await assert.rejects(startBackground(['--port',String(port)],f.options('ready-no-listen')));
  const current=await probePortal(port);
  assert.equal(current?.instanceId,first.instanceId,'Failure cleanup must leave an unrelated portal alone');
  assert.ok(alive(external.pid));
  await stopPortal(other,port);
});

test('Windows timeout stops the launcher-owned process tree while leaving another service running',{
  timeout:18000,skip:process.platform!=='win32'
},async t=>{
  const f=await fixture(t),[port,childPort,externalPort]=await ports(3),other=await f.otherRoot();
  const external=spawn(process.execPath,[f.workerPath,'--background-worker','--port',String(externalPort)],{
    cwd:other,windowsHide:true,stdio:'ignore',env:{...process.env,PORTAL_BG_TEST_ROOT:other,PORTAL_BG_TEST_MODE:'normal'}
  });
  f.children.push(external);f.track(externalPort,other);
  await eventually(()=>fixtureResponse(externalPort),'The unrelated fixture did not start');
  const options=f.options('hang-tree',{timeoutMs:4000});
  options.env.PORTAL_BG_TEST_CHILD_PORT=String(childPort);
  // Attach a rejection handler immediately while waiting for the owned child to
  // listen, so a deliberately short launcher timeout is never unhandled.
  const result=startBackground(['--port',String(port)],options).then(value=>({value}),error=>({error}));
  await eventually(()=>fixtureResponse(childPort),'The launcher-owned grandchild never began listening',{timeout:3000});
  const outcome=await result;
  assert.ok(outcome.error instanceof Error,'A worker that never reports ready must time out');
  await eventually(async()=>!await fixtureResponse(childPort),'The timed-out worker left its owned grandchild listener alive');
  assert.ok(await fixtureResponse(externalPort),'Timeout cleanup stopped an unrelated service');
  assert.ok(alive(external.pid));
  assert.match((await launchedLogs(f.root)).stdout,/fixture-worker-start/);
  await stopPortal(other,externalPort);
});
