// The double-click launcher owns a hidden, detached portal process, never its console.
import {spawn} from 'node:child_process';
import {openSync,closeSync} from 'node:fs';
import {mkdir,mkdtemp,readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {startLocal} from './start-local.mjs';
import {previewOptions} from './dev-sop.mjs';
import {loadAppIntegrations} from './app-integrations.mjs';
import {probePortal,workspaceId} from './portal-instance.mjs';
import {stopService} from './service-process.mjs';

const SELF=fileURLToPath(import.meta.url),ROOT=path.resolve(path.dirname(SELF),'..');

async function sendStatus(message) {
  if(!process.connected)return;
  await new Promise(resolve=>{try{process.send(message,()=>resolve());}catch{resolve();}});
}

async function worker(args) {
  try {
    const server=await startLocal(args);
    await sendStatus({type:'ready',reused:server===null,warnings:server?.startupWarnings??[]});
  } catch(error) {
    console.error('本地门户未启动：'+error.message);
    await sendStatus({type:'error',message:error.message});
    process.exitCode=1;
  } finally {
    // Losing the opening window, even during startup, must not stop the portal.
    if(process.connected)process.disconnect();
  }
}

export async function startBackground(args=[],{
  root=ROOT,env=process.env,workerPath=SELF,timeoutMs,settleMs=3000,onReady=()=>{}
}={}) {
  if(Number(process.versions.node.split('.')[0])<20)throw new Error('请安装 Node.js 20 或更高版本。');
  const options=previewOptions(args);
  if(options.help){await startLocal(args,{root,env});return {help:true};}
  if(timeoutMs===undefined){
    // Cover existing sequential health checks rather than timing out slow imports early.
    const applications=await loadAppIntegrations(root);
    timeoutMs=180000+Object.values(applications).filter(app=>app.type==='proxy')
      .reduce((sum,app)=>sum+60*((app.healthTimeoutMs??5000)+250),0);
  }
  if(!Number.isFinite(timeoutMs)||timeoutMs<=0||!Number.isFinite(settleMs)||settleMs<0)throw new Error('后台启动等待时间无效。');
  const artifacts=path.join(root,'artifacts');await mkdir(artifacts,{recursive:true});
  const logDirectory=await mkdtemp(path.join(artifacts,'portal-launch-'));
  const descriptors=[];
  let child,exited=false,spawnError;
  try {
    try {
      descriptors.push(openSync(path.join(logDirectory,'stdout.log'),'a'));
      descriptors.push(openSync(path.join(logDirectory,'stderr.log'),'a'));
      child=spawn(process.execPath,[workerPath,'--background-worker',...args],{
        cwd:root,env,detached:true,windowsHide:true,stdio:['ignore',...descriptors,'ipc']
      });
    } finally {for(const fd of descriptors)closeSync(fd);}
    child.on('error',error=>{spawnError=error;});
    child.once('exit',()=>{exited=true;});
    const ready=await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>finish(new Error('后台启动等待超时，请检查日志。')),timeoutMs);
      const message=value=>{
        if(value?.type==='error')finish(new Error(String(value.message)));
        else if(value?.type==='ready'&&typeof value.reused==='boolean'&&Array.isArray(value.warnings)&&value.warnings.every(item=>typeof item==='string'))finish(null,value);
      };
      const exit=(code,signal)=>finish(new Error('后台进程在启动完成前退出（'+(signal??code)+'）。'));
      const finish=(error,value)=>{
        clearTimeout(timer);child.off('message',message);child.off('exit',exit);child.off('error',finish);
        if(error)reject(error);else resolve(value);
      };
      child.on('message',message);child.once('exit',exit);child.once('error',finish);
    });
    const identity=await probePortal(options.port),expectedWorkspace=await workspaceId(root);
    if(!identity||identity.workspaceId!==expectedWorkspace||(!ready.reused&&identity.pid!==child.pid))throw new Error('后台门户尚未通过本工作区的实例检查。');
    const result={url:'http://127.0.0.1:'+options.port+'/',logDirectory,reused:ready.reused,warnings:ready.warnings};
    onReady(result);
    const deadline=Date.now()+settleMs;
    do {
      if(spawnError||(!ready.reused&&exited))throw new Error('后台门户在启动确认期间退出，请检查日志。');
      const current=await probePortal(options.port);
      if(!current||current.workspaceId!==expectedWorkspace||current.instanceId!==identity.instanceId||current.configId!==identity.configId)throw new Error('后台门户在启动确认期间失去响应或实例发生变化。');
      const remaining=deadline-Date.now();
      if(remaining<=0)break;
      await delay(Math.min(250,remaining));
    } while(true);
    return result;
  } catch(error) {
    // Only the worker created by this invocation; never stop a reused portal by port.
    stopService(child);
    error.logDirectory=logDirectory;
    throw error;
  } finally {
    if(child?.connected)child.disconnect();
    child?.unref();
  }
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  const args=process.argv.slice(2);
  if(args[0]==='--background-worker')await worker(args.slice(1));
  else try {
    const result=await startBackground(args,{onReady:({url,logDirectory,warnings,reused})=>{
      console.log((reused?'本地门户已在运行：':'本地门户已在后台启动：')+url);
      console.log('启动日志：'+logDirectory);
      if(!warnings.length)console.log('正在确认服务响应，3 秒后自动关闭窗口。');
    }});
    if(result.warnings?.length){
      console.error('门户继续在后台运行，但部分应用启动异常：');
      for(const message of result.warnings)console.error(message);
      process.exitCode=1;
    }
  } catch(error) {
    console.error('后台启动未完成：'+error.message);
    if(error.logDirectory){
      console.error('启动日志：'+error.logDirectory);
      const stderr=await readFile(path.join(error.logDirectory,'stderr.log'),'utf8').catch(()=>'');
      if(stderr.trim())console.error(stderr.slice(-12000).trim());
    }
    process.exitCode=1;
  }
}
