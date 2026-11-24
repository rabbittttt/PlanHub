import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnService,stopService} from './service-process.mjs';
import {loadPersistentDataRoot,developmentLogRoot} from './app-integrations.mjs';
import {probeServiceHealth} from './health-check.mjs';
import net from 'node:net';
import {access} from 'node:fs/promises';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');

// The application owns the meaning of its environment paths (usually relative to cwd).
export function serviceEnvironment(start, inherited=process.env) {
  const result={...inherited};
  for(const [key,value] of Object.entries({...start?.env,PYTHONDONTWRITEBYTECODE:'1',PYTHONIOENCODING:'utf-8',PYTHONUNBUFFERED:'1'})){
    // Windows treats names case-insensitively; remove inherited spelling before overriding.
    if(process.platform==='win32')for(const name of Object.keys(result))if(name.toUpperCase()===key.toUpperCase())delete result[name];
    result[key]=value;
  }
  return result;
}

export async function serviceHealthy(app) {
  return (await probeServiceHealth(app)).ok;
}
async function portFree(app) {
  const target=new URL(app.target);
  return new Promise(resolve=>{
    const server=net.createServer();
    server.once('error',()=>resolve(false));
    server.listen(Number(target.port||80),target.hostname,()=>server.close(()=>resolve(true)));
  });
}
// Only processes created here are stopped; already-running independent apps stay running.
export async function startAppServices(applications,{root=ROOT,env=process.env,logRoot,signal}={}) {
  const children=[],failures=[],unavailableApps=[];
  const stop=()=>{for(const child of children)stopService(child);};
  signal?.addEventListener('abort',stop,{once:true});
  stop.failures=failures;
  stop.unavailableApps=unavailableApps;
  for(const [id,app] of Object.entries(applications)) {
    if(signal?.aborted)break;
    if(app.type!=='proxy')continue;
    const unavailable=()=>{app.startupUnavailable=true;if(!unavailableApps.includes(id))unavailableApps.push(id);};
    app.startupUnavailable=true;
    try {
      if(!app.start){
        if(!app.healthExpected||!Object.keys(app.healthExpected).length)throw new Error('外部管理的服务须配置 healthExpected 核对运行身份');
        if(!await serviceHealthy(app))throw new Error('外部管理的服务未通过约定健康检查，请按原方式启动或修正配置');
        app.startupUnavailable=false;
        console.log(id+': 使用显式配置的外部服务');continue;
      }
      if(!await portFree(app))throw new Error('端口已被独立进程占用；本应用由门户管理，不自动复用。请按原启动方式停止旧服务后重启门户；不会终止未知进程');
      await access(app.start.command);await access(app.start.cwd);
      logRoot??=developmentLogRoot(root,await loadPersistentDataRoot(root,{env}));
      const logDirectory=path.join(logRoot,id);
      const childEnv=serviceEnvironment(app.start,env);
      childEnv.PLANHUB_APP_LOG_DIR=logDirectory;
      if(signal?.aborted)break;
      const child=spawnService(app.start.command,app.start.args,{cwd:app.start.cwd,env:childEnv,logDirectory});
      children.push(child);
      let failed=false;child.on('error',()=>{failed=true;unavailable();});child.on('exit',()=>{failed=true;unavailable();});
      let ready=false;
      for(let attempt=0;attempt<60&&!failed&&!signal?.aborted;attempt++){
        if(await serviceHealthy(app)){ready=true;break;}
        await new Promise(resolve=>setTimeout(resolve,250));
      }
      if(!ready){stopService(child);throw new Error('独立服务未通过健康检查，日志：'+child.serviceLogs.stderr);}
      app.startupUnavailable=false;
      console.log(id+': 已从独立项目启动；数据仍由原项目管理；日志：'+child.serviceLogs.stderr);
    } catch(error) {
      unavailable();
      const message=`${id} 接入暂不可用：${error.message}；后端 ${app.target}${app.healthPath}；共享目录 ${env.SHARED_DATA_ROOT||'未指定'}。详情可运行 npm run diagnose。`;
      failures.push(message);console.warn(message);
    }
  }
  return stop;
}
