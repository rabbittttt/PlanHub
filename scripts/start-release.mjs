// Runs verified release payloads on loopback. No developer workspace is consulted.
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import net from 'node:net';
import {spawn,spawnSync} from 'node:child_process';
import {openSync,closeSync} from 'node:fs';
import {readFile,writeFile,mkdir,readdir,lstat,realpath,mkdtemp,access,unlink} from 'node:fs/promises';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';
import {createServer} from './dev-server.mjs';
import {spawnService,stopService} from './service-process.mjs';
import {createPortalInstance,registerPortal,unregisterPortal,probePortal,stopPortal,workspaceId} from './portal-instance.mjs';

const SELF=fileURLToPath(import.meta.url);
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const inside=(base,target)=>{const p=path.relative(base,target);return p===''||(!p.startsWith('..'+path.sep)&&p!=='..'&&!path.isAbsolute(p));};
const json=async filename=>JSON.parse((await readFile(filename,'utf8')).replace(/^\uFEFF/,''));
const validId=id=>typeof id==='string'&&/^[a-z][a-z0-9-]{0,39}$/.test(id);
function relative(value){return typeof value==='string'&&value.length>0&&!/[\\:*?"<>|\x00-\x1f]/.test(value)&&!value.startsWith('/')&&value.split('/').every(p=>p&&!p.startsWith('.')&&!/[. ]$/.test(p));}
function publicReleaseFile(value){
  return relative(value)&&!value.split('/').some(p=>/^(?:data|input_file|output_file|logs|backups|node_modules|runtime|tests|__pycache__)$/i.test(p)||/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(p))&&!/\.(?:db|sqlite3?|xlsx?|xlsm|secret|pem|key|pfx|p12|pyc|log|db-wal|db-shm|sqlite-wal|sqlite-shm|sqlite3-wal|sqlite3-shm)$/i.test(value);
}
async function noLinks(filename){
  for(let current=path.resolve(filename);;current=path.dirname(current)){
    try{if((await lstat(current)).isSymbolicLink())throw new Error('不允许链接或重解析路径：'+current);}catch(error){if(error.code!=='ENOENT')throw error;}
    if(path.dirname(current)===current)break;
  }
}
async function filesIn(root){
  const result=[];
  async function visit(directory){
    for(const entry of await readdir(directory,{withFileTypes:true})){
      const filename=path.join(directory,entry.name);await noLinks(filename);
      if(!publicReleaseFile(path.relative(root,filename).split(path.sep).join('/')))throw new Error('发布包含私有路径：'+filename);
      if(entry.isDirectory())await visit(filename);
      else if(entry.isFile())result.push(path.relative(root,filename).split(path.sep).join('/'));
      else throw new Error('发布包含非普通文件：'+filename);
    }
  }
  await visit(root);return result.sort();
}
async function readRelease(root,id){
  await noLinks(root);
  const entries=(await readdir(root)).sort();
  if(entries.join('|')!=='app-release.json|payload')throw new Error(id+' 发布目录只能包含 app-release.json 和 payload');
  await noLinks(path.join(root,'app-release.json'));
  const manifest=await json(path.join(root,'app-release.json'));
  if(manifest.schemaVersion!==1||manifest.appId!==id||!['static','service'].includes(manifest.type)||manifest.basePath!=='/'+id+'/'||!publicReleaseFile(manifest.entryPoint)||!Array.isArray(manifest.files)||!manifest.files.length||typeof manifest.version!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(manifest.version)||manifest.version.endsWith('.')||typeof manifest.sourceRevision!=='string'||!manifest.sourceRevision.trim()||/[\x00-\x1f]/.test(manifest.sourceRevision)||!['external','stateless'].includes(manifest.dataMode))throw new Error(id+' 发布清单无效');
  if(manifest.type==='static'&&(manifest.entryPoint!=='index.html'||manifest.dataMode!=='stateless'||manifest.healthPath!=='/'))throw new Error(id+' 静态发布清单无效');
  const payload=path.join(root,'payload'),names=new Set();
  for(const entry of manifest.files){
    if(!publicReleaseFile(entry.path)||names.has(entry.path.toLowerCase())||!/^[a-f0-9]{64}$/.test(entry.sha256)||!Number.isSafeInteger(entry.bytes)||entry.bytes<0)throw new Error(id+' 文件清单无效');
    if(manifest.type==='static'&&!(id==='planhub'&&entry.path==='web.config')&&!/\.(?:html|css|js|mjs|json|svg|png|jpe?g|gif|webp|ico|woff2?|txt)$/i.test(entry.path))throw new Error(id+' 静态包包含非公开文件');
    names.add(entry.path.toLowerCase());await noLinks(path.join(payload,entry.path));
    const raw=await readFile(path.join(payload,entry.path));
    if(raw.length!==entry.bytes||hash(raw)!==entry.sha256)throw new Error(id+' 发布文件校验失败：'+entry.path);
  }
  const actual=await filesIn(payload);
  if(actual.length!==names.size||actual.some(name=>!names.has(name.toLowerCase()))||!actual.includes(manifest.entryPoint))throw new Error(id+' 发布包文件集合不一致');
  return {root,payload,manifest};
}
function port(value){if(!Number.isInteger(value)||value<1||value>65535)throw new Error('端口必须为 1–65535 整数');return value;}
async function freePort(value){
  return new Promise((resolve,reject)=>{
    const listener=net.createServer();listener.once('error',()=>reject(new Error('端口 '+value+' 已被占用；不会停止或复用未知服务')));
    listener.listen(value,'127.0.0.1',()=>listener.close(resolve));
  });
}
async function pythonPath(value,root){
  if(typeof value!=='string'||!value.trim())throw new Error('请在外置 config.local.json 填写 Python 路径');
  if(path.isAbsolute(value)||/[\\/]/.test(value)){const resolved=path.resolve(root,value);await access(resolved);return resolved;}
  const found=spawnSync(value,['-c','import sys; print(sys.executable)'],{windowsHide:true,encoding:'utf8',timeout:10000});
  if(found.status!==0||!found.stdout?.trim())throw new Error('找不到 Python：'+value+'；请安装并在 config.local.json 填写路径');
  const resolved=path.resolve(found.stdout.trim());await access(resolved);return resolved;
}
function expand(value,tokens){
  if(typeof value!=='string')throw new Error('启动参数和环境变量必须为字符串');
  const result=value.replace(/\{([A-Za-z]+)\}/g,(whole,key)=>Object.hasOwn(tokens,key)?tokens[key]:whole);
  if(/\{[A-Za-z]+\}/.test(result))throw new Error('未识别的启动占位符：'+value);
  return result;
}
export async function loadReleasePlan(bundleRoot,runRoot){
  bundleRoot=await realpath(path.resolve(bundleRoot));runRoot=path.resolve(runRoot);
  await noLinks(bundleRoot);await noLinks(runRoot);
  if(inside(bundleRoot,runRoot)||inside(runRoot,bundleRoot))throw new Error('运行目录和发布目录必须独立，不能相互包含');
  const bundle=await json(path.join(bundleRoot,'bundle.json'));
  if(bundle.schemaVersion!==1||!bundle.applications||typeof bundle.applications!=='object'||Array.isArray(bundle.applications))throw new Error('整套发布清单 bundle.json 无效');
  const releases={};
  for(const [id,binding] of Object.entries(bundle.applications)){
    if(!validId(id)||!relative(binding?.release))throw new Error('发布包路径无效：'+id);
    releases[id]=await readRelease(path.join(bundleRoot,binding.release),id);
  }
  if(releases.planhub?.manifest.type!=='static')throw new Error('缺少门户 planhub 发布包');
  const registry=await json(path.join(releases.planhub.payload,'config/apps.json'));
  const expected=['planhub',...registry.groups.flatMap(group=>group.apps).filter(app=>app.enabled).map(app=>app.id)].sort();
  if(new Set(expected).size!==expected.length||expected.join('|')!==Object.keys(releases).sort().join('|'))throw new Error('整套发布包与门户已启用应用不一致，请重新全部打包');
  const configFile=path.join(runRoot,'config.local.json');
  await noLinks(configFile);
  try{await access(configFile);}catch(error){
    if(error.code!=='ENOENT')throw error;
    await mkdir(runRoot,{recursive:true});
    await writeFile(configFile,await readFile(path.join(bundleRoot,'local.runtime.example.json')),{flag:'wx'});
    console.log('已生成外置本机配置：'+configFile);
  }
  const config=await json(configFile),portalPort=port(config.portalPort),origin='http://127.0.0.1:'+portalPort;
  if(config.schemaVersion!==1||!config.applications||typeof config.applications!=='object')throw new Error('本机运行配置无效：'+configFile);
  if(!Number.isInteger(config.startupTimeoutSeconds??60)||(config.startupTimeoutSeconds??60)<1||(config.startupTimeoutSeconds??60)>600)throw new Error('startupTimeoutSeconds 必须为 1–600 整数');
  async function privatePath(value){
    if(typeof value!=='string'||!value.trim())throw new Error('缺少外置路径配置');
    const resolved=path.resolve(runRoot,value);await noLinks(resolved);
    if(inside(bundleRoot,resolved)||inside(resolved,bundleRoot))throw new Error('数据、配置和运行环境必须与发布目录独立：'+resolved);
    return resolved;
  }
  const shared=await privatePath(config.sharedDirectory),applications={},ports=new Set([portalPort]);
  let sop=null;
  for(const [id,release] of Object.entries(releases)){
    if(id==='planhub')continue;
    if(release.manifest.type==='static'){
      applications[id]={type:'static',root:release.payload,entry:release.manifest.entryPoint,publicPaths:release.manifest.files.map(file=>file.path)};continue;
    }
    const definition=config.applications[id];
    if(!definition||!Array.isArray(definition.arguments)||!definition.healthExpected||!Object.keys(definition.healthExpected).length)throw new Error('缺少 '+id+' 的本机启动绑定，请补充 '+configFile);
    const backendPort=port(definition.port);if(ports.has(backendPort))throw new Error(id+' 端口重复');ports.add(backendPort);
    const data=await privatePath(expand(definition.dataDirectory,{shared,runtime:runRoot})),python=await pythonPath(definition.python??config.python,runRoot);
    if(inside(bundleRoot,python))throw new Error('Python 解释器必须在发布目录外');
    const tokens={payload:release.payload,data,shared,port:String(backendPort),host:'127.0.0.1',basePath:'/'+id+'/',publicOrigin:origin,publicHost:'127.0.0.1',runtime:runRoot};
    const args=definition.arguments.map(value=>expand(value,tokens));
    const env={...process.env};
    for(const key of Object.keys(env))if(/^(PYTHONPATH|PYTHONHOME|SOP_.*|ORDER_DASHBOARD_.*|DATA_QUICKLOOK_.*|SALES_FORECAST_.*|SHARED_DATA_ROOT|VEHICLE_CONFIG_.*)$/i.test(key))delete env[key];
    Object.assign(env,{PYTHONDONTWRITEBYTECODE:'1',PYTHONIOENCODING:'utf-8',PYTHONUNBUFFERED:'1'});
    for(const [key,value] of Object.entries(definition.environment??{})){
      if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)||/^(PATH|PATHEXT|COMSPEC|SYSTEMROOT|WINDIR|HOME|USERPROFILE|CODEX_HOME|PYTHONPATH|PYTHONHOME)$/i.test(key))throw new Error('不允许的运行环境变量：'+key);
      env[key]=expand(value,tokens);
    }
    const healthPath=release.manifest.healthPath;
    if(typeof healthPath!=='string'||!/^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]*$/.test(healthPath))throw new Error(id+' 健康检查路径无效');
    const healthExpected=Object.fromEntries(Object.entries(definition.healthExpected).map(([key,value])=>[key,typeof value==='string'?expand(value,tokens):value]));
    const app={type:'proxy',target:'http://127.0.0.1:'+backendPort,stripPrefix:definition.stripPrefix!==false,rootRoutes:[],healthPath,healthExpected,start:{command:python,args,cwd:release.payload,env},data};
    if(id==='sop'){
      const rules=await privatePath(config.sopSharedConfig);
      try{await access(rules);}catch{throw new Error('SOP 需要真实共享规则文件，请放到配置路径：'+rules+'；不会自动复制开发机规则');}
      const username=process.env.USERNAME||os.userInfo().username;
      const user=(process.env.USERDOMAIN||process.env.COMPUTERNAME||os.hostname())+'\\'+username;
      if(!username||user.length>100||/[,\x00-\x1f\x7f]/.test(user))throw new Error('无法识别本机操作人账号');
      sop={port:backendPort,secret:crypto.randomBytes(32).toString('hex'),user:'b64:'+Buffer.from(user,'utf8').toString('base64'),rules,data,shared};
      app.start.env.SOP_LOCAL_RELEASE_SECRET=sop.secret;
      app.start.env.SOP_PYTHON_PATH=python;
      app.healthPath=healthPath.startsWith('/sop/')?healthPath:'/sop'+healthPath;
      app.healthHeaders={'X-SOP-Proxy-Key':sop.secret,'X-SOP-User':sop.user};
      sop.app=app;
    }else applications[id]=app;
  }
  const toolNames=(await readdir(path.dirname(SELF))).filter(name=>name.endsWith('.mjs')).sort();
  const tools=await Promise.all(toolNames.map(async name=>[name,hash(await readFile(path.join(path.dirname(SELF),name)))]));
  const rulesHash=sop?hash(await readFile(sop.rules)):null;
  const configId=hash(JSON.stringify({bundleRoot,bundle,config,rulesHash,manifests:Object.values(releases).map(r=>r.manifest),tools}));
  return {bundleRoot,runRoot,port:portalPort,configId,applications,portalRoot:releases.planhub.payload,sop,shared,config};
}
async function healthy(app){
  try{
    const response=await fetch(app.target+app.healthPath,{headers:app.healthHeaders,redirect:'manual',signal:AbortSignal.timeout(1500)});
    if(!response.ok){await response.arrayBuffer();return false;}
    const body=await response.json();return Object.entries(app.healthExpected).every(([key,value])=>Object.is(body[key],value));
  }catch{return false;}
}
async function existing(plan){
  const running=await probePortal(plan.port);if(!running)return false;
  if(running.workspaceId!==await workspaceId(plan.runRoot)||running.configId!==plan.configId)throw new Error('已有门户运行其他目录、版本或配置，请用对应停止入口停止后重启');
  for(const [id,app] of Object.entries(plan.applications))if(app.type==='proxy'){
    const publicPath='/'+id+'/'+app.healthPath.replace(/^\//,'');
    if(!await healthy({...app,target:'http://127.0.0.1:'+plan.port,healthPath:publicPath}))throw new Error('已有 '+id+' 服务未响应，请先停止发布版工作台再启动');
  }
  if(plan.sop&&!await healthy({...plan.sop.app,target:'http://127.0.0.1:'+plan.port,healthHeaders:undefined}))throw new Error('已有 SOP 服务未响应，请先停止后启动');
  return true;
}
export async function runRelease(plan){
  if(await existing(plan))return null;
  // The stable external run directory owns one complete process set, even if
  // a newer config changes every port. Never allow two sets to write its data.
  const lockFile=path.join(plan.runRoot,'release-owner.lock'),lease=crypto.randomUUID();
  await noLinks(lockFile);
  try{
    const previous=await json(lockFile);
    if(!Number.isInteger(previous.pid)||previous.pid<=0)throw new Error('运行锁无效，请核对 '+lockFile);
    let alive=true;try{process.kill(previous.pid,0);}catch(error){if(error.code==='ESRCH')alive=false;}
    if(alive)throw new Error('此外置运行目录仍被工作台使用，请先从旧包停止；不会同时写入相同数据');
    await unlink(lockFile);
  }catch(error){if(error.code!=='ENOENT')throw error;}
  await writeFile(lockFile,JSON.stringify({pid:process.pid,lease}),{flag:'wx'});
  const unlock=async()=>{try{const lock=await json(lockFile);if(lock.lease===lease)await unlink(lockFile);}catch(error){if(error.code!=='ENOENT')console.error('请核对运行锁：'+lockFile);}};
  const services=[...(plan.sop?[['sop',plan.sop.app]]:[]),...Object.entries(plan.applications).filter(([,app])=>app.type==='proxy')];
  try{for(const value of [plan.port,...services.map(([,app])=>Number(new URL(app.target).port))])await freePort(value);}catch(error){await unlock();throw error;}
  const children=[];let server,stopping=false;
  const cleanup=()=>{for(const child of children)stopService(child);};
  const runtime=await createPortalInstance(plan.runRoot,plan.port,plan.configId);
  const stop=()=>{if(stopping)return;stopping=true;cleanup();server?.close();server?.closeAllConnections?.();};
  runtime.stop=stop;
  process.once('exit',cleanup);
  try{
    for(const [id,app] of services){
      await mkdir(app.data,{recursive:true});
      if(id==='sop'){
        const gatewayFile=path.join(plan.runRoot,'config','sop-local.json');await mkdir(path.dirname(gatewayFile),{recursive:true});
        await writeFile(gatewayFile,JSON.stringify({base_path:'/sop',public_origin:'http://127.0.0.1:'+plan.port,proxy_secret_env:'SOP_LOCAL_RELEASE_SECRET',allow_writes:true,data_dir:plan.sop.data,source_dir:path.join(plan.shared,'订单汇总'),shared_config:plan.sop.rules,plan_file:path.join(plan.shared,'SOP计划','SOP计划维护.xlsx')}));
      }
      const logDirectory=path.join(plan.runRoot,'logs',id);
      const child=spawnService(app.start.command,app.start.args,{cwd:app.start.cwd,env:app.start.env,logDirectory});children.push(child);
      let failed=false;child.once('error',()=>{failed=true;});
      child.once('exit',()=>{failed=true;if(server?.listening&&!stopping){console.error(id+' 服务退出，已停止本轮发布版工作台');stop();}});
      const timeout=Number(plan.config.startupTimeoutSeconds??60)*1000,started=Date.now();let ready=false;
      while(!failed&&Date.now()-started<timeout){if(await healthy(app)){ready=true;break;}await delay(250);}
      if(!ready||failed)throw new Error(id+' 未能启动，请检查 Python 依赖和日志：'+logDirectory);
      console.log(id+' 已启动；日志：'+logDirectory);
    }
    if(children.some(child=>child.exitCode!==null||child.signalCode!==null))throw new Error('业务服务在启动过程中提前退出，请查看外置日志');
    server=createServer({root:plan.runRoot,portalRoot:plan.portalRoot,applications:plan.applications,runtime,sopProxy:plan.sop});
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(plan.port,'127.0.0.1',resolve);});
    await registerPortal(plan.runRoot,runtime);
    server.runtime=runtime;
    server.once('close',()=>{stopping=true;cleanup();process.removeListener('exit',cleanup);process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);void unregisterPortal(plan.runRoot,runtime);void unlock();});
    process.once('SIGINT',stop);process.once('SIGTERM',stop);
    console.log('发布版工作台：http://127.0.0.1:'+plan.port+'/（仅本机，使用本机操作人身份）');
    return server;
  }catch(error){stop();process.removeListener('exit',cleanup);await unlock();throw error;}
}
export async function startReleased(bundleRoot,runRoot,{settleMs=3000,timeoutMs=null}={}){
  const plan=await loadReleasePlan(bundleRoot,runRoot);
  timeoutMs??=30000+(Object.values(plan.applications).filter(app=>app.type==='proxy').length+(plan.sop?1:0))*(plan.config.startupTimeoutSeconds??60)*1000;
  if(await existing(plan)){console.log('发布版工作台已运行：http://127.0.0.1:'+plan.port+'/');return {reused:true,port:plan.port};}
  await freePort(plan.port);
  const logs=path.join(plan.runRoot,'logs');await mkdir(logs,{recursive:true});
  const logDirectory=await mkdtemp(path.join(logs,'launcher-'));
  const out=openSync(path.join(logDirectory,'stdout.log'),'a'),err=openSync(path.join(logDirectory,'stderr.log'),'a');let child;
  try{child=spawn(process.execPath,[SELF,'worker','--bundle',plan.bundleRoot,'--runtime',plan.runRoot],{cwd:plan.bundleRoot,detached:true,windowsHide:true,stdio:['ignore',out,err,'ipc']});}finally{closeSync(out);closeSync(err);}
  let exited=false;child.once('exit',()=>{exited=true;});
  try{
    const message=await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('发布版工作台启动超时')),timeoutMs);
      const done=fn=>value=>{clearTimeout(timer);fn(value);};
      child.once('message',done(resolve));child.once('error',done(reject));child.once('exit',done(()=>reject(new Error('启动进程提前退出'))));
    });
    if(message.type!=='ready'||message.configId!==plan.configId)throw new Error(message.error||'启动身份不匹配');
    const until=Date.now()+settleMs;
    do{
      const current=await probePortal(plan.port);
      if(exited||!current||current.pid!==child.pid||current.configId!==plan.configId||current.workspaceId!==await workspaceId(plan.runRoot))throw new Error('启动后服务未能保持运行');
      await delay(Math.min(100,Math.max(0,until-Date.now())));
    }while(Date.now()<until);
    if(child.connected)child.disconnect();child.unref();
    console.log('发布版工作台：http://127.0.0.1:'+plan.port+'/');console.log('本机配置和数据：'+plan.runRoot);console.log('启动日志：'+logDirectory);
    return {reused:false,port:plan.port};
  }catch(error){stopService(child);if(child.connected)child.disconnect();child.unref();throw new Error(error.message+'；启动日志：'+logDirectory);}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  try{
    if(Number(process.versions.node.split('.')[0])<20)throw new Error('请先安装 Node.js 20 或更高版本');
    const action=process.argv[2];
    const {values}=parseArgs({args:process.argv.slice(3),options:{bundle:{type:'string'},runtime:{type:'string'}},strict:true,allowPositionals:false});
    const bundleRoot=path.resolve(values.bundle??path.join(path.dirname(SELF),'..'));
    const runRoot=path.resolve(values.runtime??path.join(bundleRoot,'..','PlanHub本地运行'));
    if(action==='stop'){
      const config=await json(path.join(runRoot,'config.local.json'));await stopPortal(runRoot,port(config.portalPort));console.log('发布版工作台及本轮启动的业务服务已停止');
    }else if(action==='start')await startReleased(bundleRoot,runRoot);
    else if(action==='worker'){
      const plan=await loadReleasePlan(bundleRoot,runRoot);await runRelease(plan);
      if(process.connected)process.send({type:'ready',configId:plan.configId});
      if(process.connected)process.disconnect();
    }else throw new Error('操作必须为 start 或 stop');
  }catch(error){
    console.error(error.message);
    if(process.connected){process.send({type:'error',error:error.message});process.disconnect();}
    process.exitCode=1;
  }
}
