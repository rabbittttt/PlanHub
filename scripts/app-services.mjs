import {spawn} from 'node:child_process';
import net from 'node:net';
import {access} from 'node:fs/promises';

export async function serviceHealthy(app) {
  try {
    const response=await fetch(new URL(app.healthPath,app.target),{signal:AbortSignal.timeout(1500),redirect:'error'});
    if(!response.ok){await response.arrayBuffer();return false;}
    const body=await response.json();
    return body && app.healthKeys.every(key=>Object.hasOwn(body,key));
  } catch{return false;}
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
export async function startAppServices(applications,{env=process.env}={}) {
  const children=[];
  const stop=()=>{for(const child of children)if(child.exitCode===null)child.kill();};
  for(const [id,app] of Object.entries(applications)) {
    if(app.type!=='proxy')continue;
    try {
      if(await serviceHealthy(app)){console.log(id+': 使用已有独立服务');continue;}
      if(!app.start)throw new Error('请单独启动配置中的服务');
      if(!await portFree(app))throw new Error('服务端口被占用且健康检查不匹配；不会终止已有进程');
      await access(app.start.command);await access(app.start.cwd);
      const child=spawn(app.start.command,app.start.args,{cwd:app.start.cwd,env:{...env,PYTHONDONTWRITEBYTECODE:'1',PYTHONIOENCODING:'utf-8',PYTHONUNBUFFERED:'1'},stdio:['ignore','inherit','inherit'],windowsHide:true});
      children.push(child);
      let failed=false;child.on('error',()=>{failed=true;});child.on('exit',()=>{failed=true;});
      let ready=false;
      for(let attempt=0;attempt<60&&!failed;attempt++){
        if(await serviceHealthy(app)){ready=true;break;}
        await new Promise(resolve=>setTimeout(resolve,250));
      }
      if(!ready){child.kill();throw new Error('独立服务未通过健康检查，请检查原项目启动日志');}
      console.log(id+': 已从独立项目启动；数据仍由原项目管理');
    } catch(error) {console.warn(id+' 接入暂不可用：'+error.message+'。可修正 config.local/apps.json 后重启；其他入口继续可用。');}
  }
  return stop;
}
