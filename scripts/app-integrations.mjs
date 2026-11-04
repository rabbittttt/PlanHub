// Portal-owned integration metadata only; child source and responses remain unchanged.
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {HEALTH_PATH,STOP_PATH} from './portal-instance.mjs';

async function json(filename, fallback) {
  try {return JSON.parse((await readFile(filename,'utf8')).replace(/^\uFEFF/,''));}
  catch(error){if(error.code==='ENOENT')return fallback;throw error;}
}
function relativeFile(value) {
  return typeof value==='string' && value.length>0 && !value.includes('\\') && !value.includes(':') && !value.startsWith('/') && value.split('/').filter(Boolean).every(p=>p!=='.'&&p!=='..'&&!p.startsWith('.'));
}
export function publicFile(app, relative) {
  return app.publicPaths.some(p=>p.endsWith('/')?relative.startsWith(p):relative===p);
}
export async function loadAppIntegrations(root) {
  const fallback={applications:{orderiq:{type:'static',root:'apps/orderiq',entry:'index.html',publicPaths:['index.html']}}};
  const defaults=await json(path.join(root,'integration/apps.json'),fallback);
  const local=await json(path.join(root,'config.local/apps.json'),{applications:{}});
  if(!defaults.applications||!local.applications)throw new Error('应用接入配置必须包含 applications');
  const result={}; const routes=new Set();
  for(const id of new Set([...Object.keys(defaults.applications),...Object.keys(local.applications)])) {
    if(!/^[a-z][a-z0-9-]*$/.test(id)||['sop','api','assets','config','css','js','home','data','scripts','services','deploy','logs','tests'].includes(id))throw new Error('无效或保留的接入 ID: '+id);
    const app={...defaults.applications[id],...local.applications[id]};
    if(app.type==='static') {
      if(typeof app.root!=='string'||!app.root.trim()||!relativeFile(app.entry)||!Array.isArray(app.publicPaths)||!app.publicPaths.every(relativeFile)||!publicFile(app,app.entry))throw new Error('无效静态接入: '+id);
      app.root=path.resolve(root,app.root);
    } else if(app.type==='proxy') {
      const target=new URL(app.target);
      if(target.protocol!=='http:'||target.hostname!=='127.0.0.1'||target.username||target.password||target.pathname!=='/'||target.search||target.hash)throw new Error('本地代理只允许固定的 HTTP 回环服务: '+id);
      if(typeof app.stripPrefix!=='boolean'||!Array.isArray(app.rootRoutes)||!Array.isArray(app.healthKeys)||!app.healthKeys.length||!app.healthKeys.every(k=>typeof k==='string'))throw new Error('无效代理配置: '+id);
      for(const route of [...app.rootRoutes,app.healthPath]) {
        if(typeof route!=='string'||!/^\/api\/[a-z][a-z0-9-]*$/.test(route))throw new Error('代理接口必须逐项登记: '+id);
      }
      for(const route of app.rootRoutes){if(routes.has(route))throw new Error('根接口路由冲突: '+route);routes.add(route);}
      if(app.start){
        if(typeof app.start.cwd!=='string'||typeof app.start.command!=='string'||!Array.isArray(app.start.args)||!app.start.args.every(a=>typeof a==='string'))throw new Error('无效独立服务启动参数: '+id);
        app.start={...app.start,cwd:path.resolve(root,app.start.cwd),command:path.resolve(root,app.start.command)};
      }
    } else throw new Error('未知接入类型: '+id);
    result[id]=app;
  }
  const registry=await json(path.join(root,'portal/config/apps.json'),{});
  if([HEALTH_PATH,STOP_PATH].includes(registry.platform?.identityEndpoint))throw new Error('门户管理接口不能用作身份接口');
  if(routes.has(registry.platform?.identityEndpoint))throw new Error('业务根接口与门户身份接口冲突');
  return result;
}
