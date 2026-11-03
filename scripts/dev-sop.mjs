// Development-only portal integration. SOP code is always loaded from its own project.
import {mkdir,mkdtemp,writeFile,copyFile,readdir,stat,readFile,realpath} from 'node:fs/promises';
import {spawn,spawnSync} from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import net from 'node:net';
import {parseArgs} from 'node:util';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createServer} from './dev-server.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');

export function previewOptions(args=process.argv.slice(2)) {
  const {values}=parseArgs({args,options:{
    'sop-source':{type:'string'},'seed-from':{type:'string'},'shared-config':{type:'string'},
    port:{type:'string'},'backend-port':{type:'string'},help:{type:'boolean'}
  },strict:true,allowPositionals:false});
  for(const name of ['sop-source','seed-from','shared-config'])if(values[name]!==undefined&&!values[name].trim())throw new Error(`--${name} 必须指定非空路径。`);
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
export async function resolvePreviewSettings(args=process.argv.slice(2),{root=ROOT,env=process.env,requireData=false}={}) {
  const values=previewOptions(args);
  if(values.help)return null;
  root=await realpath(path.resolve(root));
  const local=await integrationConfig(root);
  const configured=(value)=>value?path.resolve(root,value):null;
  const sourceRoot=values['sop-source']?path.resolve(values['sop-source']):configured(env.SOP_SOURCE_ROOT||local.sourceRoot)||path.resolve(root,'..','PythonProject','计划看板');
  try {await requirePath(path.join(sourceRoot,'server.py'),'独立 SOP 源码入口');}
  catch(error) {throw new Error(`${error.message}\n请用 --sop-source 或 SOP_SOURCE_ROOT 指定唯一 SOP 原项目，不会使用门户内的旧副本。`);}
  const resolvedSource=await realpath(sourceRoot);
  const legacy=path.resolve(root,'services','sop');
  const relativeToLegacy=path.relative(legacy,resolvedSource);
  if(relativeToLegacy===''||(!relativeToLegacy.startsWith('..'+path.sep)&&relativeToLegacy!=='..'&&!path.isAbsolute(relativeToLegacy)))throw new Error('不再支持门户 services/sop 业务源码副本；请指定独立 SOP 原项目。');
  try {
    await requirePath(path.join(sourceRoot,'sop_gateway.py'),'SOP gateway 接入模块');
    await requirePath(path.join(sourceRoot,'web','index.html'),'SOP 页面入口');
  } catch(error) {throw new Error(`${error.message}\n请先把必要的 gateway 适配合入独立 SOP 项目；启动器不会回退到另一套业务源码。`);}
  const dataRoot=values['seed-from']?path.resolve(values['seed-from']):configured(local.dataRoot)||(requireData?sourceRoot:null);
  const sharedConfig=values['shared-config']?path.resolve(values['shared-config']):configured(env.SOP_SHARED_CONFIG||local.sharedConfig)||path.resolve(sourceRoot,'..','订单分析','scripts','config','shared_config.py');
  if(dataRoot) {
    try {
      await requirePath(path.join(dataRoot,'data','sales.json'),'SOP 数据快照');
      await requirePath(path.join(dataRoot,'input_file'),'SOP 原始文件目录',true);
      await requirePath(sharedConfig,'共享业务规则');
    } catch(error) {throw new Error(`${error.message}\n--sop-source 选择运行代码，--seed-from 仅选择数据来源；请核对实际路径。不会自动改用演示数据。`);}
  }
  return {root,sourceRoot:resolvedSource,dataRoot,sharedConfig,port:values.port,backendPort:values.backendPort};
}

export async function assertPreviewPortsAvailable(port,backendPort) {
  for(const [label,value] of [['门户',port],['SOP服务',backendPort]]) {
    await new Promise((resolve,reject)=>{
      const probe=net.createServer();
      probe.once('error',error=>{
        const hint=error.code==='EADDRINUSE'
          ? `${label}端口 ${value} 已被占用。请先在旧的 npm run dev / npm start 窗口按 Ctrl+C 停止服务，或改用 npm start -- --port 4176 --backend-port 8879。`
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
  // Never inspect/copy business data or launch a process when either listener is busy.
  await assertPreviewPortsAvailable(values.port,values.backendPort);
  const settings=await resolvePreviewSettings(args,options);
  const {root,sourceRoot,dataRoot,sharedConfig,port,backendPort}=settings;
  await mkdir(path.join(root,'artifacts'),{recursive:true});
  const preview=await mkdtemp(path.join(root,'artifacts','sop-preview-'));
  const data=path.join(preview,'data'),source=path.join(preview,'input'),config=path.join(preview,'config');
  for(const dir of [data,source,config])await mkdir(dir);
  const python=(options.env||process.env).SOP_PYTHON||'python';
  const rules=path.join(config,'shared_config.py');
  if(dataRoot) {
    await copyFile(path.join(dataRoot,'data','sales.json'),path.join(data,'sales.json'));
    try {await copyFile(path.join(dataRoot,'data','source_settings.json'),path.join(data,'source_settings.json'));}
    catch(error) {if(error.code!=='ENOENT')throw error;}
    for(const entry of await readdir(path.join(dataRoot,'input_file'),{withFileTypes:true})) {
      if(entry.isFile()&&entry.name.endsWith('.xlsx')&&!entry.name.startsWith('~$'))await copyFile(path.join(dataRoot,'input_file',entry.name),path.join(source,entry.name));
    }
    await copyFile(sharedConfig,rules);
    const originalDb=path.join(dataRoot,'data','sop.sqlite3');
    try {
      await stat(originalDb);
      const script="import sqlite3,pathlib,sys; src=sqlite3.connect(pathlib.Path(sys.argv[1]).resolve().as_uri()+'?mode=ro',uri=True); dst=sqlite3.connect(sys.argv[2]); src.backup(dst); dst.close(); src.close()";
      const result=spawnSync(python,['-c',script,originalDb,path.join(data,'sop.sqlite3')],{stdio:'inherit',timeout:30000});
      if(result.error||result.status!==0)throw new Error('无法建立隔离的 SQLite 在线备份，原数据库未被写入。');
    } catch(error) {if(error.code!=='ENOENT')throw error;}
  } else {
    await writeFile(rules,'MERGE_GROUPS = {}\n');
    await writeFile(path.join(data,'sales.json'),JSON.stringify({meta:{notes:['仅供本地界面验收的演示数据，不代表业务数据。']},products:[{id:'preview',brand:'演示',model:'本地验收 2026款',version:'示例版本'}],sales:[]}));
  }
  const secret=crypto.randomBytes(32).toString('hex');
  const gateway={base_path:'/sop',public_origin:`http://127.0.0.1:${port}`,proxy_secret_env:'SOP_DEV_PROXY_SECRET',allow_writes:true,data_dir:data,source_dir:source,shared_config:rules,plan_file:path.join(source,'SOP计划维护.xlsx')};
  const gatewayFile=path.join(config,'gateway.json');
  await writeFile(gatewayFile,JSON.stringify(gateway,null,2));
  const env={...process.env,...(options.env||{}),SOP_DEV_PROXY_SECRET:secret,SOP_EXCEL_ENGINE:'python',PYTHONUNBUFFERED:'1',PYTHONIOENCODING:'utf-8',PYTHONDONTWRITEBYTECODE:'1'};
  const child=spawn(python,[path.join(sourceRoot,'server.py'),'--port',String(backendPort),'--gateway-config',gatewayFile],{cwd:sourceRoot,env,stdio:['ignore','inherit','inherit'],windowsHide:true});
  let failed=false,stopping=false;
  child.on('error',error=>{console.error(error.message);failed=true;});
  child.on('exit',()=>{failed=true;});
  let ready=false;
  for(let i=0;i<100&&!failed;i++) {
    try {
      const response=await fetch(`http://127.0.0.1:${backendPort}/sop/api/session`,{headers:{'X-SOP-Proxy-Key':secret,'X-SOP-User':'DEV\\local-preview'},signal:AbortSignal.timeout(1500)});
      if(response.ok){await response.arrayBuffer();ready=true;break;}
      await response.arrayBuffer();
    } catch {}
    await new Promise(resolve=>setTimeout(resolve,250));
  }
  if(!ready){child.kill();throw new Error('独立 SOP 服务未启动；请检查上方 Python 日志及原项目 gateway 适配。');}
  const server=createServer({root,sopProxy:{port:backendPort,secret,user:'DEV\\local-preview'}});
  const closeChild=()=>{stopping=true;child.kill();process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);};
  function stop(){stopping=true;child.kill();server.close();setTimeout(()=>server.closeAllConnections?.(),1000).unref();}
  server.once('close',closeChild);
  child.on('exit',()=>{if(!stopping&&server.listening){console.error('独立 SOP 服务已退出，本地门户预览随之停止。');server.close();}});
  try {
    await new Promise((resolve,reject)=>{
      server.once('error',reject);
      server.listen(port,'127.0.0.1',()=>{server.removeListener('error',reject);resolve();});
    });
  } catch(error) {closeChild();throw error;}
  console.log(`SOP 门户预览：http://127.0.0.1:${port}/#/app/sop`);
  console.log(`SOP 唯一源码：${sourceRoot}`);
  console.log(dataRoot?`使用隔离业务快照，数据来源：${dataRoot}`:'使用演示数据，仅供界面验收。');
  console.log(`本地预览身份不代表 Windows 域认证；操作仅保存到隔离快照：${preview}，不会回写原项目。重新启动会创建新快照。Ctrl+C 停止。`);
  process.once('SIGINT',stop);process.once('SIGTERM',stop);
  return server;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if(previewOptions().help)console.log('npm run dev:sop -- [--sop-source <独立SOP源码或发布目录>] [--seed-from <数据项目>] [--shared-config <规则文件>] [--port 4173 --backend-port 8877]\n无数据来源时仅使用演示数据，运行代码仍来自独立 SOP 项目。');
    else await runPreview();
  } catch(error) {console.error(`本地门户未启动：${error.message}`);process.exitCode=1;}
}
