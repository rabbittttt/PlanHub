// Local portal integration. SOP code and persistent data belong to the independent project.
import {mkdir,mkdtemp,writeFile,copyFile,readdir,stat,readFile,realpath} from 'node:fs/promises';
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
import {loadAppIntegrations} from './app-integrations.mjs';
import {startAppServices,serviceHealthy} from './app-services.mjs';
import {probePortal,workspaceId,configurationId,createPortalInstance,registerPortal,unregisterPortal} from './portal-instance.mjs';

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
      {encoding:'utf8',windowsHide:true,timeout:10000});
    const encoded=result.stdout?.trim()||'';
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

export function previewOptions(args=process.argv.slice(2)) {
  const {values}=parseArgs({args,options:{
    'sop-source':{type:'string'},'seed-from':{type:'string'},'data-root':{type:'string'},'shared-config':{type:'string'},
    snapshot:{type:'boolean'},demo:{type:'boolean'},
    port:{type:'string'},'backend-port':{type:'string'},help:{type:'boolean'}
  },strict:true,allowPositionals:false});
  for(const name of ['sop-source','seed-from','data-root','shared-config'])if(values[name]!==undefined&&!values[name].trim())throw new Error(`--${name} 必须指定非空路径。`);
  if(values['seed-from']&&!values.snapshot)throw new Error('--seed-from 仅用于 --snapshot 测试；日常持久数据目录请用 --data-root。');
  if(values['seed-from']&&values['data-root'])throw new Error('--seed-from 与 --data-root 不能同时使用。');
  if(values.demo&&(!values.snapshot||values['seed-from']||values['data-root']))throw new Error('--demo 只允许与 --snapshot 一起使用，不能指定真实数据来源。');
  const port=Number(values.port??'4173'),backendPort=Number(values['backend-port']??'8877');
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
  const values=previewOptions(args);
  if(values.help)return null;
  root=await realpath(path.resolve(root));
  const local=await integrationConfig(root);
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
  const dataDirectory=dataRoot?(configured(env.SOP_DATA_DIR)||path.join(dataRoot,'data')):null;
  if(!values.snapshot&&dataDirectory) {
    const rel=path.relative(path.join(root,'artifacts'),dataDirectory);
    if(rel===''||(!path.isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..'+path.sep)))throw new Error('日常持久数据不能指向门户 artifacts 临时快照；请配置原 SOP 数据目录。');
  }
  const sharedConfig=configured(values['shared-config']||env.SOP_SHARED_CONFIG||local.sharedConfig)||path.resolve(sourceRoot,'..','订单分析','scripts','config','shared_config.py');
  let salesSourceDir=dataRoot?path.join(dataRoot,'input_file'):null;
  let planSourceFile=dataRoot?path.join(dataRoot,'input_file','SOP计划维护.xlsx'):null;
  if(dataRoot) {
    const sharedRoot=configured(env.SHARED_DATA_ROOT)||path.resolve(resolvedSource,'..','共享数据');
    let useShared=Boolean(env.SHARED_DATA_ROOT);
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
      throw new Error(error.message + '\nSOP 需要原项目的真实规则文件。订单仓库的本机 config 目录不随 Git 下载，请先在内网迁入原文件，再双击“配置SOP规则.bat”选择它。\n也可用 --shared-config 或 SOP_SHARED_CONFIG 指定现有文件，相对路径以门户根目录为准。');
    }
  }
  return {root,sourceRoot:resolvedSource,dataRoot,dataDirectory,dataRootExplicit,snapshot:Boolean(values.snapshot),demo:Boolean(values.demo),salesSourceDir,planSourceFile,sharedConfig,port:values.port,backendPort:values.backendPort};
}

export async function assertPreviewPortsAvailable(port,backendPort) {
  for(const [label,value] of [['门户',port],['SOP服务',backendPort]]) {
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

export async function runPreview(args=process.argv.slice(2),options={}) {
  const values=previewOptions(args);
  if(values.help)return null;
  const requestedRoot=options.root||ROOT;
  const existing=await probePortal(values.port);
  if(existing&&existing.workspaceId!==await workspaceId(requestedRoot))throw new Error('门户端口属于另一个工作区；请使用自己的端口。');
  // An unknown listener must still fail before inspecting/copying business data.
  if(!existing)await assertPreviewPortsAvailable(values.port,values.backendPort);
  const settings=await resolvePreviewSettings(args,options);
  const {root,sourceRoot,dataRoot,dataDirectory,snapshot,salesSourceDir,planSourceFile,sharedConfig,port,backendPort}=settings;
  const runtimeEnv={...process.env,...(options.env||{})};
  const applications=await loadAppIntegrations(root);
  for(const [id,app] of Object.entries(applications))if(app.type==='proxy'&&[port,backendPort].includes(Number(new URL(app.target).port||80)))throw new Error(id+' 服务端口不能与门户或 SOP 端口相同');
  const python=resolveSopPython({root,sourceRoot,env:runtimeEnv});
  const userHeader=localSopUserHeader();
  const configId=await configurationId({...settings,userHeader},applications,python);
  if(existing){
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
  const runtime=await createPortalInstance(root,port,configId);
  const pythonEnv={...runtimeEnv,SOP_PYTHON_PATH:python,PYTHONIOENCODING:'utf-8',PYTHONDONTWRITEBYTECODE:'1'};
  for(const key of Object.keys(pythonEnv))if(key.toLowerCase()==='path')delete pythonEnv[key];
  pythonEnv.PATH=path.dirname(python)+path.delimiter+(runtimeEnv.PATH??runtimeEnv.Path??'');
  const pythonEnvironment=path.dirname(path.dirname(python));
  if(existsSync(path.join(pythonEnvironment,'pyvenv.cfg')))pythonEnv.VIRTUAL_ENV=pythonEnvironment;
  else delete pythonEnv.VIRTUAL_ENV;
  await mkdir(path.join(root,'artifacts'),{recursive:true});
  const preview=await mkdtemp(path.join(root,'artifacts',snapshot?'sop-preview-':'sop-runtime-'));
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
  const secret=crypto.randomBytes(32).toString('hex');
  const gateway={base_path:'/sop',public_origin:`http://127.0.0.1:${port}`,proxy_secret_env:'SOP_DEV_PROXY_SECRET',allow_writes:true,data_dir:data,source_dir:source,shared_config:rules,plan_file:plan};
  const gatewayFile=path.join(config,'gateway.json');
  await writeFile(gatewayFile,JSON.stringify(gateway,null,2));
  const env={...pythonEnv,SOP_DEV_PROXY_SECRET:secret,SOP_EXCEL_ENGINE:'python',PYTHONUNBUFFERED:'1'};
  const child=spawnService(python,[path.join(sourceRoot,'server.py'),'--port',String(backendPort),'--gateway-config',gatewayFile],{cwd:sourceRoot,env,logDirectory:path.join(preview,'logs')});
  let failed=false,stopping=false;
  child.on('error',error=>{console.error(error.message);failed=true;});
  child.on('exit',()=>{failed=true;});
  let ready=false;
  for(let i=0;i<100&&!failed;i++) {
    try {
      const response=await fetch(`http://127.0.0.1:${backendPort}/sop/api/session`,{headers:{'X-SOP-Proxy-Key':secret,'X-SOP-User':userHeader},signal:AbortSignal.timeout(1500)});
      if(response.ok){await response.arrayBuffer();ready=true;break;}
      await response.arrayBuffer();
    } catch {}
    await new Promise(resolve=>setTimeout(resolve,250));
  }
  if(!ready){stopService(child);throw new Error(`独立 SOP 服务未启动；请查看日志：${child.serviceLogs.stderr}`);}
  const stopApplications=await startAppServices(applications,{root,env:runtimeEnv});
  if(failed){stopApplications();stopService(child);throw new Error('SOP 在其他应用启动期间已退出，请检查原项目日志。');}
  const server=createServer({root,applications,runtime,sopProxy:{port:backendPort,secret,user:userHeader}});
  const closeChild=()=>{stopping=true;stopService(child);stopApplications();process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);};
  function stop(){stopping=true;stopService(child);stopApplications();server.close();setTimeout(()=>server.closeAllConnections?.(),1000).unref();}
  runtime.stop=stop;
  server.once('close',()=>{closeChild();void unregisterPortal(root,runtime);});
  child.on('exit',()=>{if(!stopping&&server.listening){console.error('独立 SOP 服务已退出，本地门户预览随之停止。');server.close();}});
  try {
    await new Promise((resolve,reject)=>{
      server.once('error',reject);
      server.listen(port,'127.0.0.1',()=>{server.removeListener('error',reject);resolve();});
    });
  } catch(error) {closeChild();throw error;}
  try {await registerPortal(root,runtime);} catch(error){stop();throw error;}
  console.log(`SOP 门户预览：http://127.0.0.1:${port}/#/app/sop`);
  console.log(`SOP 唯一源码：${sourceRoot}`);
  console.log(`SOP Python：${python}`);
  console.log(`SOP 服务日志：${child.serviceLogs.stderr}`);
  if(snapshot) {
    console.log(dataRoot?`显式测试模式：使用隔离快照，数据来源：${dataRoot}`:'显式演示模式，仅供测试。');
    console.log(`测试数据仅保存在 ${preview}，不回写原项目。`);
  } else {
    console.log(`持久数据：${data}；维护结果直接保存，重启继续使用。`);
    console.log(`销售来源：${source}；计划维护表：${plan}`);
    console.log('共享规则：'+rules);
  }
  console.log('当前为本机入口，代理身份不代表 Windows 域认证。Ctrl+C 停止。');
  process.once('SIGINT',stop);process.once('SIGTERM',stop);
  return server;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if(previewOptions().help)console.log('npm run dev:sop -- [--sop-source <独立SOP项目>] [--data-root <持久数据项目>] [--shared-config <规则文件>] [--port 4173 --backend-port 8877]\n默认直接使用原项目持久数据。只有显式 --snapshot 才使用测试副本；--snapshot --demo 使用演示数据。');
    else await runPreview();
  } catch(error) {console.error(`本地门户未启动：${error.message}`);process.exitCode=1;}
}
