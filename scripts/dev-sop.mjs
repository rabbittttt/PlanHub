// Local portal integration. SOP code and persistent data belong to the independent project.
import {mkdir,mkdtemp,writeFile,copyFile,readdir,stat,readFile,realpath,unlink,rmdir} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {hostname,userInfo} from 'node:os';
import {spawnService,stopService} from './service-process.mjs';
import crypto from 'node:crypto';
import path from 'node:path';
import net from 'node:net';
import {parseArgs} from 'node:util';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createServer} from './dev-server.mjs';
import {resolveSopPython} from './sop-python.mjs';
import {loadAppIntegrations,loadSharedDataRoot,loadPersistentDataRoot,developmentLogRoot} from './app-integrations.mjs';
import {startAppServices,serviceHealthy} from './app-services.mjs';
import {probePortal,workspaceId,configurationId,createPortalInstance,registerPortal,unregisterPortal} from './portal-instance.mjs';
import {readServicePorts} from './service-ports.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');

function localSopUserHeader() {
  let account;
  if(process.platform==='win32') {
    const systemRoot=process.env.SystemRoot;
    if(!systemRoot||!path.isAbsolute(systemRoot))throw new Error('无法确定 Windows 系统目录。');
    const powershell=path.join(systemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe');
    // Encode inside PowerShell so the Windows console code page cannot corrupt the account name.
    const command='[Console]::Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([Security.Principal.WindowsIdentity]::GetCurrent().Name)))';
    const result=spawnSync(powershell,['-NoLogo','-NoProfile','-NonInteractive','-Command',command],
      {encoding:'utf8',windowsHide:true,timeout:30000});
    const encoded=result.stdout?.trim()||'';
    if(result.error?.code==='ETIMEDOUT')throw new Error('读取 Windows 登录账户超时，请在系统空闲后重试。');
    if(result.error||result.status!==0||!encoded)throw new Error('无法读取当前 Windows 登录账户。');
    account=Buffer.from(encoded,'base64').toString('utf8');
    if(Buffer.from(account,'utf8').toString('base64')!==encoded)throw new Error('当前 Windows 登录账户编码无效。');
  } else {
    account=hostname()+'\\'+userInfo().username;
  }
  if(!/^(?:[^\\@]+\\[^\\@]+|[^\\@]+@[^\\@]+)$/.test(account)||account!==account.trim()||
      Array.from(account).length>100||/[\x00-\x1f\x7f,]/.test(account))throw new Error('当前登录账户格式无效。');
  return 'b64:'+Buffer.from(account,'utf8').toString('base64');
}

export function previewOptions(args=process.argv.slice(2),{root=ROOT}={}) {
  const {values}=parseArgs({args,options:{
    'sop-source':{type:'string'},'seed-from':{type:'string'},'data-root':{type:'string'},'shared-config':{type:'string'},
    snapshot:{type:'boolean'},demo:{type:'boolean'},
    port:{type:'string'},'backend-port':{type:'string'},help:{type:'boolean'}
  },strict:true,allowPositionals:false});
  for(const name of ['sop-source','seed-from','data-root','shared-config'])if(values[name]!==undefined&&!values[name].trim())throw new Error(`--${name} 必须指定非空路径。`);
  if(values['seed-from']&&!values.snapshot)throw new Error('--seed-from 仅用于 --snapshot 测试；日常持久数据目录请用 --data-root。');
  if(values['seed-from']&&values['data-root'])throw new Error('--seed-from 与 --data-root 不能同时使用。');
  if(values.demo&&(!values.snapshot||values['seed-from']||values['data-root']))throw new Error('--demo 只允许与 --snapshot 一起使用，不能指定真实数据来源。');
  const ports=readServicePorts(root,{optional:true})??readServicePorts(ROOT);
  const port=Number(values.port??ports.portal),backendPort=Number(values['backend-port']??ports.applications.sop);
  if(![port,backendPort].every(p=>Number.isInteger(p)&&p>0&&p<65536)||port===backendPort)throw new Error('门户和 SOP 端口必须为两个不同的 1–65535 整数。');
  return {...values,port,backendPort};
}

async function requirePath(filename,label,directory=false) {
  try {
    const item=await stat(filename);
    if(directory?item.isDirectory():item.isFile())return;
  } catch(error) {if(!['ENOENT','ENOTDIR'].includes(error.code))throw error;}
  throw new Error(`${label}不存在：${filename}`);
}

async function integrationConfig(root) {
  const filename=path.join(root,'config.local','sop.json');
  let raw;
  try {raw=JSON.parse((await readFile(filename,'utf8')).replace(/^\uFEFF/,''));}
  catch(error) {
    if(error.code==='ENOENT')return {};
    throw new Error(`SOP 本地接入配置无效：${filename}（${error.message}）`);
  }
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('config.local/sop.json 必须为对象。');
  for(const key of Object.keys(raw)) {
    if(!['sourceRoot','dataRoot','sharedConfig'].includes(key)||typeof raw[key]!=='string'||!raw[key].trim())throw new Error(`SOP 本地接入配置字段无效：${key}`);
  }
  return raw;
}

/** Resolve code and data independently; no portal-owned business source fallback exists. */
export async function resolvePreviewSettings(args=process.argv.slice(2),{root=ROOT,env=process.env}={}) {
  const values=previewOptions(args,{root});
  if(values.help)return null;
  root=await realpath(path.resolve(root));
  const local=await integrationConfig(root);
  const sharedDataRoot=await loadSharedDataRoot(root,{env});
  const configured=(value)=>value?path.resolve(root,value):null;
  const sourceRoot=configured(values['sop-source']||env.SOP_SOURCE_ROOT||local.sourceRoot)||path.resolve(root,'..','SOP维护');
  try {await requirePath(path.join(sourceRoot,'server.py'),'独立 SOP 源码入口');}
  catch(error) {throw new Error(`${error.message}\n请用 --sop-source 或 SOP_SOURCE_ROOT 指定唯一 SOP 原项目，不会使用门户内的旧副本。`);}
  const resolvedSource=await realpath(sourceRoot);
  const legacy=path.resolve(root,'services','sop');
  const relativeToLegacy=path.relative(legacy,resolvedSource);
  if(relativeToLegacy===''||(!relativeToLegacy.startsWith('..'+path.sep)&&relativeToLegacy!=='..'&&!path.isAbsolute(relativeToLegacy)))throw new Error('不再支持门户 services/sop 业务源码副本；请指定独立 SOP 原项目。');
  try {
    await requirePath(path.join(sourceRoot,'sop','gateway.py'),'SOP gateway 接入模块');
    await requirePath(path.join(sourceRoot,'web','index.html'),'SOP 页面入口');
  } catch(error) {throw new Error(`${error.message}\n请先把必要的 gateway 适配合入独立 SOP 项目；启动器不会回退到另一套业务源码。`);}
  const dataRoot=values.demo?null:(configured(values['data-root']||values['seed-from']||local.dataRoot)||sourceRoot);
  const dataRootExplicit=!values.demo&&Boolean(values['data-root']||values['seed-from']||local.dataRoot);
  const persistentRoot=await loadPersistentDataRoot(root,{env});
  const dataDirectory=dataRoot?(configured(env.SOP_DATA_DIR)||(!dataRootExplicit&&persistentRoot?path.join(persistentRoot,'database','sop'):path.join(dataRoot,'data'))):null;
  if(!values.snapshot&&dataDirectory) {
    for(const temporary of ['runtime','artifacts']){
      const rel=path.relative(path.join(root,temporary),dataDirectory);
      if(rel===''||(!path.isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..'+path.sep)))throw new Error('日常持久数据不能指向门户临时快照；请配置原 SOP 数据目录。');
    }
  }
  const sharedConfig=configured(values['shared-config']||env.SOP_SHARED_CONFIG||local.sharedConfig)||path.resolve(sourceRoot,'..','订单分析','scripts','config','shared_config.py');
  let salesSourceDir=dataRoot?path.join(dataRoot,'input_file'):null;
  let planSourceFile=dataRoot?path.join(dataRoot,'input_file','SOP计划维护.xlsx'):null;
  if(dataRoot) {
    const sharedRoot=sharedDataRoot||path.resolve(resolvedSource,'..','工作台数据','shared');
    let useShared=Boolean(sharedDataRoot);
    if(!useShared&&!dataRootExplicit&&(!env.SOP_SOURCE_DIR||!env.SOP_PLAN_DIR)) {
      try {
        if(!(await stat(sharedRoot)).isDirectory())throw new Error(`共享数据根路径不是目录：${sharedRoot}`);
        useShared=true;
      }
      catch(error) {if(error.code!=='ENOENT')throw error;}
    }
    salesSourceDir=configured(env.SOP_SOURCE_DIR)||(useShared?path.join(sharedRoot,'订单汇总'):salesSourceDir);
    const planDirectory=configured(env.SOP_PLAN_DIR)||(!dataRootExplicit&&useShared?path.join(sharedRoot,'SOP计划'):null);
    if(planDirectory)planSourceFile=path.join(planDirectory,'SOP计划维护.xlsx');
    try {
      await requirePath(path.join(dataDirectory,'sales.json'),'SOP 销售数据');
      await requirePath(salesSourceDir,'SOP 销售来源目录',true);
    } catch(error) {throw new Error(`${error.message}\n--sop-source 选择运行代码，--data-root 选择持久数据项目，--snapshot --seed-from 仅用于测试；请核对实际路径。不会自动改用演示数据。`);}
    try { await requirePath(sharedConfig, '共享业务规则'); }
    catch (error) {
      throw new Error(error.message + '\nSOP 需要原项目的真实规则文件。订单仓库的本机 config 目录不随 Git 下载，请核对原规则文件是否存在。\n也可用 --shared-config 或 SOP_SHARED_CONFIG 指定现有文件，相对路径以门户根目录为准。');
    }
  }
  return {root,logRoot:developmentLogRoot(root,persistentRoot),sharedDataRoot,sourceRoot:resolvedSource,dataRoot,dataDirectory,dataRootExplicit,snapshot:Boolean(values.snapshot),demo:Boolean(values.demo),salesSourceDir,planSourceFile,sharedConfig,port:values.port,backendPort:values.backendPort};
}

export async function assertPreviewPortsAvailable(port,backendPort) {
  for(const [label,value] of [['门户',port],['SOP服务',backendPort]]) {
    if(value===undefined)continue;
    await new Promise((resolve,reject)=>{
      const probe=net.createServer();
      probe.once('error',error=>{
        const hint=error.code==='EADDRINUSE'
          ? `${label}端口 ${value} 已被占用。可识别的已运行门户会自动复用；需要重启请运行“停止本地门户.cmd”，或在旧的 npm run dev / npm start 窗口按 Ctrl+C。未识别的占用不会被自动结束。`
          : `无法使用${label}端口 ${value}（${error.code||error.message}）。请检查端口权限或指定其他端口。`;
        reject(new Error(hint));
      });
      probe.listen(value,'127.0.0.1',()=>probe.close(error=>error?reject(error):resolve()));
    });
  }
}

async function startSop(settings,python,runtimeEnv,userHeader,secret,onChild) {
  const {root,sourceRoot,dataRoot,dataDirectory,snapshot,salesSourceDir,planSourceFile,sharedConfig,port,backendPort}=settings;
  const pythonEnv={...runtimeEnv,SOP_PYTHON_PATH:python,PYTHONIOENCODING:'utf-8',PYTHONDONTWRITEBYTECODE:'1'};
  for(const key of Object.keys(pythonEnv))if(key.toLowerCase()==='path')delete pythonEnv[key];
  pythonEnv.PATH=path.dirname(python)+path.delimiter+(runtimeEnv.PATH??runtimeEnv.Path??'');
  const pythonEnvironment=path.dirname(path.dirname(python));
  if(existsSync(path.join(pythonEnvironment,'pyvenv.cfg')))pythonEnv.VIRTUAL_ENV=pythonEnvironment;
  else delete pythonEnv.VIRTUAL_ENV;
  await mkdir(path.join(root,'runtime'),{recursive:true});
  const preview=await mkdtemp(path.join(root,'runtime',snapshot?'sop-preview-':'sop-runtime-'));
  const config=path.join(preview,'config');
  await mkdir(config);
  const data=snapshot?path.join(preview,'data'):dataDirectory;
  const source=snapshot?path.join(preview,'input'):salesSourceDir;
  const rules=snapshot?path.join(config,'shared_config.py'):sharedConfig;
  const plan=snapshot?path.join(source,'SOP计划维护.xlsx'):planSourceFile;
  if(snapshot) {
    for(const dir of [data,source])await mkdir(dir);
    if(dataRoot) {
      await copyFile(path.join(dataDirectory,'sales.json'),path.join(data,'sales.json'));
      try {await copyFile(path.join(dataDirectory,'source_settings.json'),path.join(data,'source_settings.json'));}
      catch(error) {if(error.code!=='ENOENT')throw error;}
      for(const entry of await readdir(salesSourceDir,{withFileTypes:true})) {
        const name=entry.name.toLowerCase();
        if(entry.isFile()&&name.endsWith('.xlsx')&&!entry.name.startsWith('~$')&&!name.endsWith('.pending.xlsx')&&name!=='sop计划维护.xlsx')await copyFile(path.join(salesSourceDir,entry.name),path.join(source,entry.name));
      }
      // The source plan may be shared; the gateway always receives the isolated copy.
      try {await copyFile(planSourceFile,path.join(source,'SOP计划维护.xlsx'));}
      catch(error) {if(error.code!=='ENOENT')throw error;}
      await copyFile(sharedConfig,rules);
      const originalDb=path.join(dataDirectory,'sop.sqlite3');
      try {
        await stat(originalDb);
        const script="import sqlite3,pathlib,sys; src=sqlite3.connect(pathlib.Path(sys.argv[1]).resolve().as_uri()+'?mode=ro',uri=True); dst=sqlite3.connect(sys.argv[2]); src.backup(dst); dst.close(); src.close()";
        const result=spawnSync(python,['-B','-c',script,originalDb,path.join(data,'sop.sqlite3')],{cwd:root,env:pythonEnv,stdio:'inherit',timeout:30000,windowsHide:true});
        if(result.error||result.status!==0)throw new Error('无法建立隔离的 SQLite 在线备份，原数据库未被写入。');
      } catch(error) {if(error.code!=='ENOENT')throw error;}
    } else {
      await writeFile(rules,'MERGE_GROUPS = {}\n');
      await writeFile(path.join(data,'sales.json'),JSON.stringify({meta:{notes:['仅供本地界面验收的演示数据，不代表业务数据。']},products:[{id:'preview',brand:'演示',model:'本地验收 2026款',version:'示例版本'}],sales:[]}));
    }
  }
  const gateway={base_path:'/sop',public_origin:`http://127.0.0.1:${port}`,proxy_secret_env:'SOP_DEV_PROXY_SECRET',allow_writes:true,data_dir:data,source_dir:source,shared_config:rules,plan_file:plan};
  const gatewayFile=path.join(config,'gateway.json');
  await writeFile(gatewayFile,JSON.stringify(gateway,null,2));
  const logDirectory=path.join(settings.logRoot,'sop');
  const env={...pythonEnv,SOP_LOG_DIR:logDirectory,SOP_DEV_PROXY_SECRET:secret,SOP_EXCEL_ENGINE:'python',PYTHONUNBUFFERED:'1'};
  const child=spawnService(python,[path.join(sourceRoot,'server.py'),'--port',String(backendPort),'--gateway-config',gatewayFile],{cwd:sourceRoot,env,logDirectory});
  if(!snapshot)child.once('close',async()=>{
    try{await unlink(gatewayFile);await rmdir(config);await rmdir(preview);}
    catch(error){if(error.code!=='ENOENT')console.warn('运行目录保留：'+preview+'（'+error.code+'）');}
  });
  onChild(child);
  let failed=false;
  child.on('error',error=>{failed=true;console.error(error.message);});
  child.once('exit',()=>{failed=true;});
  let ready=false;
  for(let i=0;i<100&&!failed;i++) {
    try {
      const response=await fetch(`http://127.0.0.1:${backendPort}/sop/api/session`,{headers:{'X-SOP-Proxy-Key':secret,'X-SOP-User':userHeader},signal:AbortSignal.timeout(1500)});
      if(response.ok){await response.arrayBuffer();ready=true;break;}
      await response.arrayBuffer();
    } catch {}
    await new Promise(resolve=>setTimeout(resolve,250));
  }
  if(!ready||failed)throw new Error(`独立 SOP 服务未启动；请查看日志：${child.serviceLogs.stderr}`);
  console.log(`SOP 唯一源码：${sourceRoot}`);
  console.log(`SOP Python：${python}`);
  console.log(`SOP 服务日志：${child.serviceLogs.stderr}`);
  if(snapshot) {
    console.log(dataRoot?`显式测试模式：使用隔离快照，数据来源：${dataRoot}`:'显式演示模式，仅供测试。');
    console.log(`测试数据仅保存在 ${preview}，不回写原项目。`);
  } else {
    console.log(`持久数据：${data}；维护结果直接保存，重启继续使用。`);
    console.log(`销售来源：${source}；计划保存于上述持久数据库，Excel 通过业务页面导入导出。`);
    console.log('共享规则：'+rules);
  }
}

export async function runPreview(args=process.argv.slice(2),options={}) {
  const root=options.root||ROOT;
  const values=previewOptions(args,{root});
  if(values.help)return null;
  const {port,backendPort}=values;
  const strict=Boolean(values.snapshot||options.requireSop);
  const existing=await probePortal(port);
  if(existing&&existing.workspaceId!==await workspaceId(root))throw new Error('门户端口属于另一个工作区；请使用自己的端口。');
  if(!existing)await assertPreviewPortsAvailable(port,strict?backendPort:undefined);
  const runtimeEnv={...process.env,...options.env};
  const shared=await loadSharedDataRoot(root,{env:runtimeEnv});
  if(shared)runtimeEnv.SHARED_DATA_ROOT=shared;
  const applications=await loadAppIntegrations(root,{env:runtimeEnv});
  for(const [id,app] of Object.entries(applications))if(app.type==='proxy'&&[port,backendPort].includes(Number(new URL(app.target).port||80)))throw new Error(id+' 服务端口不能与门户或 SOP 端口相同');
  const bindings=structuredClone(applications);
  async function resolveSop() {
    const settings=await resolvePreviewSettings(args,options);
    const python=resolveSopPython({root,sourceRoot:settings.sourceRoot,env:runtimeEnv});
    const userHeader=localSopUserHeader();
    const configId=await configurationId({...settings,userHeader},bindings,python);
    return {settings,python,userHeader,configId};
  }
  if(existing){
    if(existing.unavailableApps?.length)throw new Error('门户仍在运行，暂不可用：'+existing.unavailableApps.join('、')+'。请查看启动日志。');
    const {configId}=await resolveSop();
    if(existing.configId!==configId)throw new Error('已有门户使用不同代码版本或配置；请先运行“停止本地门户.cmd”再启动。');
    try {
      const session=await fetch('http://127.0.0.1:'+port+'/sop/api/session',{signal:AbortSignal.timeout(2000)});
      await session.arrayBuffer();if(!session.ok)throw new Error('SOP');
      for(const [id,app] of Object.entries(applications))if(app.type==='proxy'&&!await serviceHealthy(app))throw new Error(id);
    }catch(error){throw new Error('门户已运行，但后端尚未响应（'+error.message+'）；请运行“停止本地门户.cmd”后重新启动。');}
    console.log('本地门户已在运行，继续使用：http://127.0.0.1:'+port+'/');
    console.log('未重复启动后端；需要停止时运行“停止本地门户.cmd”。');
    return null;
  }
  const runtime=await createPortalInstance(root,port,crypto.randomUUID());
  const secret=crypto.randomBytes(32).toString('hex');
  let userHeader,child,stopApplications,retryTimer,closing=false,sopReady=false;
  const abort=new AbortController();
  const warnings=[];
  let lastWarning='';
  const retryMs=options.sopRetryMs??60000;
  function markSopUnavailable(message) {
    sopReady=false;
    if(closing||strict)return;
    const warning=`sop 接入暂不可用：${message}；后端端口 ${backendPort}。其他入口继续可用，${Math.ceil(retryMs/1000)} 秒后重试。`;
    if(warning!==lastWarning)console.warn(warning);
    lastWarning=warning;
    clearTimeout(retryTimer);
    retryTimer=setTimeout(()=>{void launchSop();},retryMs);
    retryTimer.unref();
  }
  async function launchSop(){
    try {
      await assertPreviewPortsAvailable(undefined,backendPort);
      const config=await resolveSop();
      if(closing)return;
      userHeader=config.userHeader;
      await startSop(config.settings,config.python,runtimeEnv,userHeader,secret,owned=>{
        child=owned;
        if(closing){stopService(owned);return;}
        owned.once('exit',()=>{
          if(sopReady)markSopUnavailable('服务已退出，日志：'+owned.serviceLogs.stderr);
        });
      });
      if(closing)return;
      runtime.identity.configId=config.configId;
      sopReady=true;
      lastWarning='';
    }catch(error){
      stopService(child);
      markSopUnavailable(error.message);
      if(strict)throw error;
    }
  }
  const server=createServer({root,applications,runtime,localPreview:true,sopProxy:{
    port:backendPort,secret,user:()=>userHeader,available:()=>sopReady
  }});
  Object.defineProperty(runtime.identity,'unavailableApps',{enumerable:true,get:()=>[
    ...(sopReady?[]:['sop']),...Object.keys(applications).filter(id=>applications[id].startupUnavailable)
  ]});
  server.unavailableAppIds=()=>runtime.identity.unavailableApps;
  for(const app of Object.values(applications))if(app.type==='proxy')app.startupUnavailable=true;
  function cleanup(){
    closing=true;
    abort.abort();
    clearTimeout(retryTimer);
    stopService(child);
    stopApplications?.();
  }
  function stop(){cleanup();server.close();server.closeAllConnections?.();}
  runtime.stop=stop;
  process.once('exit',cleanup);
  server.once('close',()=>{
    cleanup();
    process.removeListener('exit',cleanup);
    process.removeListener('SIGINT',stop);
    process.removeListener('SIGTERM',stop);
    void unregisterPortal(root,runtime);
  });
  try{
    await new Promise((resolve,reject)=>{
      server.once('error',reject);
      server.listen(port,'127.0.0.1',()=>{server.removeListener('error',reject);resolve();});
    });
    console.log(`本地门户：http://127.0.0.1:${port}/`);
    process.once('SIGINT',stop);process.once('SIGTERM',stop);
    // Finish ownership registration for both branches even if a strict snapshot fails.
    await registerPortal(root,runtime);
    const results=await Promise.allSettled([launchSop(),startAppServices(applications,{root,env:runtimeEnv,signal:abort.signal}).then(stop=>{
      stopApplications=stop;
      if(closing)stop();
    })]);
    for(const result of results)if(result.status==='rejected')throw result.reason;
    if(closing)throw new Error('门户启动已取消');
    if(lastWarning)warnings.push(lastWarning);
    warnings.push(...stopApplications.failures);
    server.startupWarnings=warnings;
  }catch(error){
    cleanup();
    if(server.listening)await new Promise(resolve=>server.close(resolve));
    else process.removeListener('exit',cleanup);
    throw error;
  }
  console.log('当前为本机入口，代理身份不代表 Windows 域认证。Ctrl+C 停止。');
  return server;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const options=previewOptions();
    if(options.help)console.log(`npm run dev:sop -- [--sop-source <独立SOP项目>] [--data-root <持久数据项目>] [--shared-config <规则文件>] [--port ${options.port} --backend-port ${options.backendPort}]\n默认直接使用原项目持久数据。只有显式 --snapshot 才使用测试副本；--snapshot --demo 使用演示数据。`);
    else await runPreview();
  } catch(error) {console.error(`本地门户未启动：${error.message}`);process.exitCode=1;}
}
