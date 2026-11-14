// Windows-only preview of immutable release payloads. No source checkout is used.
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import {spawn,spawnSync} from 'node:child_process';
import {openSync,closeSync} from 'node:fs';
import {access,lstat,readdir,writeFile,mkdir,unlink,mkdtemp} from 'node:fs/promises';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';
import {validateDelivery} from './delivery-validation.mjs';
import {checkSnapshotCompatibility} from './preview-compatibility.mjs';
import {containerSpec,checkService,createContainerPortal,validateRuntime,readJson} from './container-runtime.mjs';
import {startLocalPreviewPortal,LOCAL_PREVIEW_PORT,LOCAL_PREVIEW_ORIGIN} from './local-preview-gateway.mjs';
import {createServer} from './dev-server.mjs';
import {spawnService,stopService} from './service-process.mjs';
import {createPortalInstance,registerPortal,unregisterPortal,probePortal,stopPortal,workspaceId} from './portal-instance.mjs';
import {resolveWindowsRuntime} from './windows-runtime.mjs';

const SELF=fileURLToPath(import.meta.url);
const PORT=LOCAL_PREVIEW_PORT;
const digest=value=>crypto.createHash('sha256').update(value).digest('hex');
const inside=(base,target)=>{const value=path.relative(base,target);return !value||(!value.startsWith('..'+path.sep)&&value!=='..'&&!path.isAbsolute(value));};
export async function noPreviewLinks(filename){
  let current=path.resolve(filename);
  for(;;){
    try{if((await lstat(current)).isSymbolicLink())throw new Error('Linked preview paths are not allowed: '+current);}catch(error){if(error.code!=='ENOENT')throw error;}
    const parent=path.dirname(current);if(parent===current)return;current=parent;
  }
}
export async function freePreviewPort(port){
  return new Promise((resolve,reject)=>{
    const listener=net.createServer();
    listener.once('error',error=>reject(new Error('Port '+port+' is unavailable ('+error.code+'). No other program will be stopped.')));
    listener.listen(port,'127.0.0.1',()=>listener.close(resolve));
  });
}
async function noTreeLinks(root){
  await noPreviewLinks(root);
  for(const entry of await readdir(root,{withFileTypes:true})){
    const filename=path.join(root,entry.name);await noPreviewLinks(filename);
    if(entry.isDirectory())await noTreeLinks(filename);
    else if(!entry.isFile())throw new Error('Non-file snapshot entries are not allowed: '+filename);
  }
}
export async function loadNativePlan(packageRoot,runtimeRoot){
  packageRoot=path.resolve(packageRoot);runtimeRoot=path.resolve(runtimeRoot);
  await noPreviewLinks(runtimeRoot);
  const previewRoot=path.join(path.dirname(packageRoot),'planhub-preview');
  if(path.dirname(runtimeRoot)!==previewRoot||!/^snapshot-[a-f0-9]{32}$/.test(path.basename(runtimeRoot)))throw new Error('Use the snapshot created by preview.cmd.');
  if(inside(packageRoot,runtimeRoot)||inside(runtimeRoot,packageRoot))throw new Error('Preview data must be outside the program package.');
  const delivery=await validateDelivery(packageRoot,{requireComplete:true});
  await noTreeLinks(runtimeRoot);
  const configFile=path.join(runtimeRoot,'config.json');await noPreviewLinks(configFile);
  const config=validateRuntime(await readJson(configFile));
  if(!config.preview)throw new Error('Native preview requires an isolated snapshot configuration.');
  if(inside(runtimeRoot,path.resolve(config.preview.sourceDirectory))||inside(path.resolve(config.preview.sourceDirectory),runtimeRoot))throw new Error('Source data and preview snapshot must be separate.');
  const windowsRuntime=await resolveWindowsRuntime(delivery);
  const python=windowsRuntime.python;
  if(Object.values(delivery.releases).some(release=>release.manifest.type==='service'))await access(python);
  const bindings={};
  for(const id of delivery.manifest.applications){
    const binding=delivery.bindings[id],release=delivery.releases[id];
    if(!binding||binding.type!==release.manifest.type)throw new Error('Release binding differs for '+id);
    bindings[id]={...binding};
  }
  const source=path.resolve(config.preview.sourceDirectory);await noPreviewLinks(source);
  const configId=digest(JSON.stringify({packageRoot,delivery:delivery.manifest,config,runtimeDirectory:windowsRuntime.directory,runtimeFingerprint:windowsRuntime.fingerprint}));
  return {...delivery,packageRoot,runtimeRoot,config,configId,bindings,python,node:windowsRuntime.node,runtimeDirectory:windowsRuntime.directory,runtimeFingerprint:windowsRuntime.fingerprint,port:PORT};
}
async function existing(plan){
  const running=await probePortal(plan.port);if(!running)return false;
  if(running.workspaceId!==await workspaceId(plan.runtimeRoot)||running.configId!==plan.configId)throw new Error('Another package or snapshot is running. Stop it with its stop-preview.cmd first.');
  const record=await readPortRecord(plan,running);
  for(const [id,binding] of Object.entries(plan.bindings))if(id!=='planhub'){
    if(!verifyNativeListener({pid:record.processes[id]},record.ports[id]))throw new Error('A preview backend is no longer listening. Stop this preview before restarting.');
    await checkService(id,{...binding,port:record.ports[id]},plan.config);
  }
  return true;
}
async function readPortRecord(plan,running){
  const filename=path.join(plan.runtimeRoot,'native-ports.json');await noPreviewLinks(filename);
  const ownerFile=path.join(plan.runtimeRoot,'native-owner.json');await noPreviewLinks(ownerFile);
  const owner=await readJson(ownerFile),record=await readJson(filename),ids=Object.keys(plan.bindings).filter(id=>id!=='planhub').sort(),ports=new Set([plan.port]);
  if(record.schemaVersion!==1||record.pid!==running.pid||record.instanceId!==running.instanceId||record.configId!==plan.configId||owner.pid!==running.pid||typeof owner.lease!=='string'||owner.lease!==record.lease||!record.ports||Array.isArray(record.ports)||Object.keys(record.ports).sort().join('|')!==ids.join('|')||!record.processes||Array.isArray(record.processes)||Object.keys(record.processes).sort().join('|')!==ids.join('|'))throw new Error('Running preview port record does not match its owned process. Stop this preview before restarting.');
  for(const id of ids){
    const port=record.ports[id],pid=record.processes[id];
    if(!Number.isInteger(port)||port<1024||port>65535||ports.has(port)||!Number.isInteger(pid)||pid<=0||(plan.bindings[id].type==='static'&&pid!==running.pid))throw new Error('Invalid running preview port mapping. Stop this preview before restarting.');ports.add(port);
  }
  return record;
}
async function clearPortRecord(plan,lease){
  const filename=path.join(plan.runtimeRoot,'native-ports.json');
  try{await noPreviewLinks(filename);const current=await readJson(filename);if(current.pid===process.pid&&current.configId===plan.configId&&current.lease===lease)await unlink(filename);}catch(error){if(error.code!=='ENOENT')console.error('Check preview port record: '+filename);}
}
async function reserveBackendPort(preferred){
  async function reserve(port){
    const listener=net.createServer(socket=>socket.destroy());
    await listen(listener,port);
    return {port:listener.address().port,release:()=>new Promise((resolve,reject)=>{if(!listener.listening){resolve();return;}listener.close(error=>error?reject(error):resolve());})};
  }
  try{return await reserve(preferred);}catch(error){if(!['EADDRINUSE','EACCES'].includes(error.code))throw error;return reserve(0);}
}
async function allocateBackendBindings(plan){
  const bindings={planhub:plan.bindings.planhub},reservations=new Map();
  try{
    for(const [id,binding] of Object.entries(plan.bindings)){
      if(id==='planhub')continue;
      const reservation=await reserveBackendPort(binding.port);reservations.set(id,reservation);
      bindings[id]={...binding,port:reservation.port};
    }
    return {bindings,reservations};
  }catch(error){await Promise.allSettled([...reservations.values()].map(reservation=>reservation.release()));throw error;}
}
function verifyNativeListener(child,port){
  if(process.platform!=='win32')return true;
  const fail=message=>{const error=new Error(message);error.code='PREVIEW_PORT_OWNERSHIP';return error;};
  const executable=path.join(process.env.SystemRoot,'System32','netstat.exe');
  const result=spawnSync(executable,['-ano','-p','tcp'],{windowsHide:true,encoding:'utf8',timeout:10000,maxBuffer:4*1024*1024});
  if(result.error||result.status!==0)throw fail('Could not verify the owned backend listener on port '+port+'. No existing program will be reused.');
  const listener=new RegExp('^\\s*TCP\\s+127\\.0\\.0\\.1:'+port+'\\s+0\\.0\\.0\\.0:0\\s+LISTEN(?:ING)?\\s+(\\d+)\\s*$','i');
  const owners=result.stdout.split(/\r?\n/).map(line=>line.match(listener)).filter(Boolean).map(match=>Number(match[1]));
  if(!owners.length)return false;
  if(!Number.isInteger(child.pid)||owners.length!==1||owners[0]!==child.pid)throw fail('Backend port '+port+' does not belong to the process started by this preview. Retry preview.cmd; no other program will be stopped.');
  return true;
}
async function claimRuntime(runtimeRoot){
  const filename=path.join(runtimeRoot,'native-owner.json');await noPreviewLinks(filename);
  try{
    const previous=await readJson(filename);
    if(!Number.isInteger(previous.pid)||previous.pid<=0||typeof previous.lease!=='string')throw new Error('Invalid native preview owner record: '+filename);
    let alive=true;try{process.kill(previous.pid,0);}catch(error){if(error.code==='ESRCH')alive=false;else throw error;}
    if(alive)throw new Error('This snapshot is still owned by a running preview. Stop it first.');
    await unlink(filename);
  }catch(error){if(error.code!=='ENOENT')throw error;}
  const lease=crypto.randomUUID();await writeFile(filename,JSON.stringify({pid:process.pid,lease}),{flag:'wx'});
  const unlock=async()=>{try{if((await readJson(filename)).lease===lease)await unlink(filename);}catch(error){if(error.code!=='ENOENT')console.error('Check preview owner record: '+filename);}};
  unlock.lease=lease;return unlock;
}
function listen(server,port){return new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});}
export function portablePythonArguments(args,release){
  const script=path.join(release.payload,release.manifest.entryPoint);
  if(args[0]!=='-B'||typeof args[1]!=='string'||path.normalize(args[1])!==path.normalize(script))throw new Error('Native Python binding must start with -B and the declared release entry point.');
  // The bundled interpreter uses an isolated ._pth file. Explicitly add only
  // this verified release's script directory, without inheriting A's paths.
  const bootstrap='import runpy,sys,pathlib;script=sys.argv[1];sys.argv=sys.argv[1:];sys.path.insert(0,str(pathlib.Path(script).resolve().parent));runpy.run_path(script,run_name="__main__")';
  return ['-B','-c',bootstrap,...args.slice(1)];
}
export async function runNativePreview(plan,{startService=spawnService,serviceTimeoutMs=90000}={}){
  if(await existing(plan))return null;
  const unlock=await claimRuntime(plan.runtimeRoot);
  const children=[],staticServers=[];let server,stopping=false,allocation;
  const cleanup=()=>{for(const child of children)stopService(child);for(const listener of staticServers){listener.close();listener.closeAllConnections?.();}};
  let runtime;
  const stop=()=>{if(stopping)return;stopping=true;cleanup();server?.close();server?.closeAllConnections?.();};
  process.once('exit',cleanup);
  try{
    runtime=await createPortalInstance(plan.runtimeRoot,plan.port,plan.configId);
    // Let the authenticated inner response pass through the loopback bridge
    // before closing either side of the accepted control request.
    runtime.stop=()=>setTimeout(stop,100);
    await freePreviewPort(plan.port);
    allocation=await allocateBackendBindings(plan);
    const ports=Object.fromEntries(Object.entries(allocation.bindings).filter(([id])=>id!=='planhub').map(([id,binding])=>[id,binding.port]));
    const portFile=path.join(plan.runtimeRoot,'native-ports.json');await noPreviewLinks(portFile);
    const portRecord={schemaVersion:1,pid:process.pid,instanceId:runtime.identity.instanceId,lease:unlock.lease,configId:plan.configId,ports,processes:{}};
    await writeFile(portFile,JSON.stringify(portRecord));
    for(const [id,binding] of Object.entries(allocation.bindings)){
      if(id==='planhub')continue;
      const release=plan.releases[id];
      if(binding.type==='static'){
        const listener=createServer({root:plan.runtimeRoot,portalRoot:release.payload,applications:{}});
        staticServers.push(listener);await allocation.reservations.get(id).release();await listen(listener,binding.port);portRecord.processes[id]=process.pid;continue;
      }
      const spec=containerSpec(id,binding,plan.config,{runtime:plan.runtimeRoot,payload:release.payload,python:plan.python,pathApi:path});
      spec.env.PLANHUB_PYTHON_APP_ROOT=release.payload;
      delete spec.env.VIRTUAL_ENV;
      const nodeDirectory=path.join(plan.runtimeDirectory,'node');
      spec.env.PATH=[nodeDirectory,path.dirname(plan.python),spec.env.PATH??spec.env.Path??''].join(path.delimiter);
      delete spec.env.Path;
      if(id==='sop')spec.env.SOP_NODE_PATH=path.join(nodeDirectory,'node.exe');
      await mkdir(spec.data,{recursive:true});await noPreviewLinks(spec.data);
      if(id==='sop'){
        const rules=path.join(plan.runtimeRoot,...plan.config.sopSharedConfig.split('/'));await noPreviewLinks(rules);await access(rules);
        const gatewayFile=path.join(plan.runtimeRoot,'config/sop-local.json');await noPreviewLinks(gatewayFile);await mkdir(path.dirname(gatewayFile),{recursive:true});
        await writeFile(gatewayFile,JSON.stringify({base_path:'/sop',public_origin:plan.config.publicOrigin,proxy_secret_env:'SOP_LOCAL_RELEASE_SECRET',allow_writes:true,data_dir:spec.data,source_dir:path.join(spec.shared,'订单汇总'),shared_config:rules,plan_file:path.join(spec.shared,'SOP计划','SOP计划维护.xlsx')}));
      }
      const logDirectory=path.join(plan.runtimeRoot,'logs',id);
      await allocation.reservations.get(id).release();
      const child=startService(plan.python,portablePythonArguments(spec.args,release),{cwd:release.payload,env:spec.env,logDirectory});children.push(child);
      portRecord.processes[id]=child.pid;
      let failed=false;
      child.once('error',()=>{failed=true;});
      child.once('exit',()=>{failed=true;if(server?.listening&&!stopping){console.error(id+' exited. Stopping this preview process set.');stop();}});
      const started=Date.now();let ready=false;
      while(!failed&&Date.now()-started<serviceTimeoutMs){
        try{
          // Ownership is checked before health: SOP health includes a proxy key.
          if(verifyNativeListener(child,binding.port)){await checkService(id,binding,plan.config);ready=true;break;}
        }catch(error){if(error.code==='PREVIEW_PORT_OWNERSHIP')throw error;}
        await delay(250);
      }
      if(!ready||failed)throw new Error(id+' did not start. See '+logDirectory);
      console.log(id+' ready (loopback port '+binding.port+').');
    }
    if(children.some(child=>child.exitCode!==null||child.signalCode!==null))throw new Error('A preview service exited during startup. See snapshot logs.');
    await writeFile(portFile,JSON.stringify(portRecord));
    const portal=createContainerPortal(plan.releases.planhub.payload,allocation.bindings,plan.config,{root:plan.runtimeRoot,runtime});
    server=await startLocalPreviewPortal(portal,plan.config,{port:plan.port,host:'127.0.0.1',allowControl:true});
    await registerPortal(plan.runtimeRoot,runtime);server.runtime=runtime;
    server.once('close',async()=>{stopping=true;cleanup();process.removeListener('exit',cleanup);process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);await unregisterPortal(plan.runtimeRoot,runtime);await clearPortRecord(plan,unlock.lease);await unlock();});
    process.once('SIGINT',stop);process.once('SIGTERM',stop);
    return server;
  }catch(error){stop();process.removeListener('exit',cleanup);if(allocation)await Promise.allSettled([...allocation.reservations.values()].map(reservation=>reservation.release()));await clearPortRecord(plan,unlock.lease);await unlock();throw error;}
}
export async function startNativePreview(packageRoot,runtimeRoot,{settleMs=3000,timeoutMs=600000}={}){
  const plan=await loadNativePlan(packageRoot,runtimeRoot);
  if(await existing(plan)){console.log('Local preview is already running: '+LOCAL_PREVIEW_ORIGIN+'/');return {reused:true,port:plan.port};}
  await freePreviewPort(plan.port);
  const logs=path.join(plan.runtimeRoot,'logs');await noPreviewLinks(logs);await mkdir(logs,{recursive:true});
  const logDirectory=await mkdtemp(path.join(logs,'launcher-'));
  const out=openSync(path.join(logDirectory,'stdout.log'),'a'),err=openSync(path.join(logDirectory,'stderr.log'),'a');let child;
  try{child=spawn(plan.manifest.runtimeMode==='reuse'?plan.node:process.execPath,[SELF,'worker','--package',plan.packageRoot,'--runtime',plan.runtimeRoot],{cwd:plan.packageRoot,detached:true,windowsHide:true,stdio:['ignore',out,err,'ipc']});}finally{closeSync(out);closeSync(err);}
  let exited=false;child.once('exit',()=>{exited=true;});
  try{
    const message=await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('Preview startup timed out.')),timeoutMs);
      const done=fn=>value=>{clearTimeout(timer);fn(value);};
      child.once('message',done(resolve));child.once('error',done(reject));child.once('exit',done(()=>reject(new Error('Preview worker exited before becoming ready.'))));
    });
    if(message.type!=='ready'||message.configId!==plan.configId)throw new Error(message.error||'Preview worker identity mismatch.');
    const end=Date.now()+settleMs;
    do{
      const current=await probePortal(plan.port);
      if(exited||!current||current.pid!==child.pid||current.configId!==plan.configId||current.workspaceId!==await workspaceId(plan.runtimeRoot))throw new Error('Preview did not stay running after startup.');
      await delay(Math.min(100,Math.max(0,end-Date.now())));
    }while(Date.now()<end);
    if(child.connected)child.disconnect();child.unref();
    console.log('Local preview: '+LOCAL_PREVIEW_ORIGIN+'/');console.log('Snapshot and logs: '+plan.runtimeRoot);
    return {reused:false,port:plan.port};
  }catch(error){stopService(child);if(child.connected)child.disconnect();child.unref();throw new Error(error.message+' See launcher logs: '+logDirectory);}
}
export async function stopNativePreview(runtimeRoot){
  await noPreviewLinks(runtimeRoot);
  const config=validateRuntime(await readJson(path.join(runtimeRoot,'config.json')),{allowLegacyPreview:true});
  if(!config.preview)throw new Error('Stop requires a native preview snapshot.');
  const port=config.port,identity=await probePortal(port);
  if(!identity){
    try{const owner=await readJson(path.join(runtimeRoot,'native-owner.json'));try{process.kill(owner.pid,0);throw new Error('Preview is still starting or has not finished stopping. Retry shortly.');}catch(error){if(error.code!=='ESRCH')throw error;}}catch(error){if(error.code!=='ENOENT')throw error;}
    console.log('No native preview is running.');return;
  }
  await stopPortal(runtimeRoot,port);
  for(let attempt=0;attempt<50;attempt++){
    try{await access(path.join(runtimeRoot,'native-owner.json'));}catch(error){
      if(error.code!=='ENOENT')throw error;
      let exited=identity.pid===process.pid;
      if(!exited){try{process.kill(identity.pid,0);}catch(error){if(error.code==='ESRCH')exited=true;else throw error;}}
      if(exited){console.log('Local preview and its child services stopped. Snapshot retained.');return;}
    }
    await delay(100);
  }
  throw new Error('The preview is still releasing its process lease. Retry stop-preview.cmd shortly.');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  try{
    const mode=process.argv[2];
    const {values}=parseArgs({args:process.argv.slice(3),options:{package:{type:'string'},runtime:{type:'string'},'contract-hash':{type:'string'}},strict:true});
    if(!values.runtime)throw new Error('Use preview.cmd to select an isolated runtime snapshot.');
    const packageRoot=path.resolve(values.package??path.join(path.dirname(SELF),'..')),runtimeRoot=path.resolve(values.runtime);
    if(mode==='check-snapshot')console.log(JSON.stringify(await checkSnapshotCompatibility(packageRoot,runtimeRoot,values['contract-hash'])));
    else if(mode==='start')await startNativePreview(packageRoot,runtimeRoot);
    else if(mode==='stop')await stopNativePreview(runtimeRoot);
    else if(mode==='worker'){
      const plan=await loadNativePlan(packageRoot,runtimeRoot);await runNativePreview(plan);
      if(process.connected)process.send({type:'ready',configId:plan.configId});if(process.connected)process.disconnect();
    }else throw new Error('Use start or stop.');
  }catch(error){console.error(error.message);if(process.connected){process.send({type:'error',error:error.message});process.disconnect();}process.exitCode=1;}
}
