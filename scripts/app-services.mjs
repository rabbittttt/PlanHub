import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnService,stopService} from './service-process.mjs';
import {probeServiceHealth} from './health-check.mjs';
import net from 'node:net';
import {access,mkdir,mkdtemp} from 'node:fs/promises';
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
export async function startAppServices(applications,{root=ROOT,env=process.env}={}) {
  const children=[],failures=[];
  const stop=()=>{for(const child of children)stopService(child);};
  stop.failures=failures;
  for(const [id,app] of Object.entries(applications)) {
    if(app.type!=='proxy')continue;
    try {
      if(await serviceHealthy(app)){console.log(id+': 使用已有独立服务');continue;}
      if(!app.start)throw new Error('请单独启动配置中的服务');
      if(!await portFree(app))throw new Error('服务端口被占用且健康检查不匹配；不会终止已有进程');
      await access(app.start.command);await access(app.start.cwd);
      const artifacts=path.join(root,'artifacts');await mkdir(artifacts,{recursive:true});
      const logDirectory=await mkdtemp(path.join(artifacts,'service-'+id+'-'));
      const child=spawnService(app.start.command,app.start.args,{cwd:app.start.cwd,env:serviceEnvironment(app.start,env),logDirectory});
      children.push(child);
      let failed=false;child.on('error',()=>{failed=true;});child.on('exit',()=>{failed=true;});
      let ready=false;
      for(let attempt=0;attempt<60&&!failed;attempt++){
        if(await serviceHealthy(app)){ready=true;break;}
        await new Promise(resolve=>setTimeout(resolve,250));
      }
      if(!ready){stopService(child);throw new Error('独立服务未通过健康检查，日志：'+child.serviceLogs.stderr);}
      console.log(id+': 已从独立项目启动；数据仍由原项目管理；日志：'+child.serviceLogs.stderr);
    } catch(error) {
      const message=id+' 接入暂不可用：'+error.message+'。可修正 config.local/apps.json 后重启；其他入口继续可用。';
      failures.push(message);console.warn(message);
    }
  }
  return stop;
}
