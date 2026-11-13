// Container adapter for unchanged, independently validated application releases.
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import {readFile,writeFile,mkdir,access} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {createServer} from './dev-server.mjs';
import {readRelease} from './release-validation.mjs';
import {validatePreviewConfig,startLocalPreviewPortal} from './local-preview-gateway.mjs';

export const readJson=async file=>JSON.parse((await readFile(file,'utf8')).replace(/^\uFEFF/,''));
export function validateRuntime(config,{allowLegacyPreview=false}={}){
  const origin=new URL(config.publicOrigin);
  if(config.schemaVersion!==1||!['http:','https:'].includes(origin.protocol)||origin.origin!==config.publicOrigin||origin.hostname.endsWith('.invalid'))throw new Error('Set publicOrigin to the company gateway origin, without a path or trailing slash.');
  for(const key of ['proxySecret','sopSecret','vehicleSecret'])if(!/^[a-zA-Z0-9_-]{32,}$/.test(config[key]??''))throw new Error('Missing external secret: '+key);
  for(const key of ['sharedDirectory','sopSharedConfig','quicklookSourceBase'])privatePath('/runtime',config[key]);
  if(Object.hasOwn(config,'preview'))validatePreviewConfig(config,{allowLegacy:allowLegacyPreview});
  return config;
}
export function privatePath(root,value){
  if(typeof value!=='string'||!value||/[\\:]/.test(value)||path.posix.isAbsolute(value)||value.split('/').some(p=>!p||p==='.'||p==='..'||p.startsWith('.')))throw new Error('Runtime paths must be relative paths below the external runtime directory.');
  return path.posix.join(root,...value.split('/'));
}
function expand(value,tokens){
  const result=value.replace(/\{([A-Za-z]+)\}/g,(whole,key)=>tokens[key]??whole);
  if(/\{[A-Za-z]+\}/.test(result))throw new Error('Unknown runtime token: '+value);
  return result;
}
export function trustedActor(request,config){
  const raw=request.headers['x-planhub-key'],user=request.headers['x-planhub-user'];
  const supplied=Buffer.from(typeof raw==='string'?raw:''),expected=Buffer.from(config.proxySecret);
  if(supplied.length!==expected.length||!crypto.timingSafeEqual(supplied,expected))return null;
  if(typeof user!=='string'||!/^([A-Za-z0-9_.-]+\\[A-Za-z0-9_.-]+|[A-Za-z0-9_.+-]+@[A-Za-z0-9.-]+)$/.test(user)||user.length>100)return null;
  if(request.headers.host!==new URL(config.publicOrigin).host)return null;
  const names=request.rawHeaders?.filter((_,i)=>i%2===0).map(v=>v.toLowerCase())??[];
  if(['x-planhub-key','x-planhub-user','host'].some(name=>names.filter(n=>n===name).length>1))return null;
  return user;
}
export function containerSpec(id,binding,config,{runtime='/runtime',payload='/app/release/payload',python='/usr/local/bin/python',pathApi=path.posix}={}){
  const localPath=value=>{privatePath('/runtime',value);return pathApi.join(runtime,...value.split('/'));};
  const shared=localPath(config.sharedDirectory),data=pathApi.join(runtime,'data',id);
  const tokens={payload,data,shared,runtime,host:'127.0.0.1',port:String(binding.port),basePath:`/${id}/`,publicOrigin:config.publicOrigin,publicHost:new URL(config.publicOrigin).hostname};
  const args=(binding.arguments??[]).map(v=>expand(v,tokens));
  const env={...process.env,PYTHONDONTWRITEBYTECODE:'1',PYTHONIOENCODING:'utf-8',PYTHONUNBUFFERED:'1'};
  for(const key of Object.keys(env))if(/^(SOP_.*|ORDER_DASHBOARD_.*|DATA_QUICKLOOK_.*|SALES_FORECAST_.*|SHARED_DATA_ROOT|VEHICLE_CONFIG_.*|PYTHONPATH|PYTHONHOME|PLANHUB_PYTHON_APP_ROOT)$/.test(key))delete env[key];
  for(const [key,value] of Object.entries(binding.environment??{}))env[key]=expand(value,tokens);
  if(id==='sop'){env.SOP_LOCAL_RELEASE_SECRET=config.sopSecret;env.SOP_PYTHON_PATH=python;}
  if(id==='vehicle-config')env.VEHICLE_CONFIG_PROXY_SECRET=config.vehicleSecret;
  if(id==='quicklook')env.DATA_QUICKLOOK_SOURCE_BASE=localPath(config.quicklookSourceBase);
  return {args,env,data,shared,healthExpected:Object.fromEntries(Object.entries(binding.healthExpected??{}).map(([k,v])=>[k,typeof v==='string'?expand(v,tokens):v]))};
}
export async function checkService(id,binding,config){
  const headers={Host:new URL(config.publicOrigin).host};
  if(id==='sop')Object.assign(headers,{'X-SOP-Proxy-Key':config.sopSecret,'X-SOP-User':'health@planhub'});
  if(id==='planhub')Object.assign(headers,{'X-PlanHub-Key':config.proxySecret,'X-PlanHub-User':'health@planhub'});
  const body=await new Promise((resolve,reject)=>{
    const request=http.request({host:'127.0.0.1',port:binding.port,path:binding.healthPath,method:binding.type==='service'?'GET':'HEAD',headers},response=>{
      let text='';response.setEncoding('utf8');response.on('error',reject);
      response.on('data',chunk=>{text+=chunk;if(text.length>65536)request.destroy(new Error('Health response too large'));});
      response.on('end',()=>{if(response.statusCode!==200)return reject(new Error(`${id}: HTTP ${response.statusCode}`));try{resolve(binding.type==='service'?JSON.parse(text):null);}catch(error){reject(error);}});
    });
    request.setTimeout(4000,()=>request.destroy(new Error('Health timeout')));request.on('error',reject);request.end();
  });
  if(binding.type==='service'){
    const expected=containerSpec(id,binding,config).healthExpected;
    if(!Object.entries(expected).every(([k,v])=>Object.is(body[k],v)))throw new Error(id+': health identity mismatch');
  }
}
export function createContainerPortal(payload,bindings,config,{root='/runtime',runtime}={}){
  const applications={};
  for(const [id,binding] of Object.entries(bindings)){
    if(['planhub','sop'].includes(id))continue;
    applications[id]={type:'proxy',target:`http://127.0.0.1:${binding.port}`,stripPrefix:binding.stripPrefix!==false,rootRoutes:[]};
    if(id==='vehicle-config')applications[id].headersForRequest=req=>({'x-config-proxy-key':config.vehicleSecret,'x-config-user':req.portalActor});
  }
  const sopProxy=bindings.sop?{port:bindings.sop.port,secret:config.sopSecret,user:req=>'b64:'+Buffer.from(req.portalActor,'utf8').toString('base64')}:null;
  const server=createServer({root,portalRoot:payload,applications,sopProxy,runtime});
  const handler=server.listeners('request')[0];server.removeAllListeners('request');
  server.on('request',(request,response)=>{
    request.portalActor=trustedActor(request,config);
    if(!request.portalActor){response.writeHead(403,{'Content-Type':'text/plain'});response.end('Use the company authenticated gateway.');return;}
    handler(request,response);
  });
  return server;
}
export async function runContainer(id,{appRoot='/app',runtime='/runtime'}={}){
  const config=validateRuntime(await readJson(path.join(runtime,'config.json'))),bindings=await readJson(path.join(appRoot,'bindings.json')),binding=bindings[id];
  if(!binding)throw new Error('Unknown container application: '+id);
  const release=await readRelease(path.join(appRoot,'release'),id);
  if(binding.type!==release.manifest.type)throw new Error('Release type differs from the container binding');
  if(binding.type==='static'){
    let server=id==='planhub'?createContainerPortal(release.payload,bindings,config):createServer({root:runtime,portalRoot:release.payload,applications:{}});
    if(id==='planhub'&&Object.hasOwn(config,'preview'))server=await startLocalPreviewPortal(server,config,{port:binding.port});
    else await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(binding.port,id==='planhub'?'0.0.0.0':'127.0.0.1',resolve);});
    const stop=()=>{server.close();server.closeAllConnections();};process.once('SIGTERM',stop);process.once('SIGINT',stop);
    return server;
  }
  const spec=containerSpec(id,binding,config,{runtime,payload:release.payload});
  await mkdir(spec.data,{recursive:true});
  if(id==='sop'){
    const rules=privatePath(runtime,config.sopSharedConfig);await access(rules);
    await mkdir(path.join(runtime,'config'),{recursive:true});
    await writeFile(path.join(runtime,'config/sop-local.json'),JSON.stringify({base_path:'/sop',public_origin:config.publicOrigin,proxy_secret_env:'SOP_LOCAL_RELEASE_SECRET',allow_writes:true,data_dir:spec.data,source_dir:path.join(spec.shared,'订单汇总'),shared_config:rules,plan_file:path.join(spec.shared,'SOP计划/SOP计划维护.xlsx')}));
  }
  const child=spawn('/usr/local/bin/python',spec.args,{cwd:release.payload,env:spec.env,stdio:'inherit'});
  child.once('error',error=>{console.error(error.message);process.exitCode=1;});
  child.once('exit',(code,signal)=>{process.exitCode=signal?1:(code??1);});
  for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>child.kill(signal));
  return child;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  try{
    const [mode,id]=process.argv.slice(2);
    if(mode==='check')await checkService(id,(await readJson('/app/bindings.json'))[id],validateRuntime(await readJson('/runtime/config.json')));
    else if(mode==='serve')await runContainer(id);
    else throw new Error('Use serve|check APP_ID');
  }catch(error){console.error(error.message);process.exitCode=1;}
}
