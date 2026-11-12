// Register portal metadata only. Never build, start, rewrite or publish child applications.
import {readFile,writeFile,mkdir,mkdtemp,rename,rm,lstat,readdir,realpath,open} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createInterface} from 'node:readline/promises';
import {validateConfig} from '../portal/js/config.js';
import {loadAppIntegrations,STATIC_MIME_TYPES} from './app-integrations.mjs';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const FILES=['portal/config/apps.json','config.local/apps.json','deploy/config.local.json'];
const PRIVATE=new Set(['data','logs','node_modules','runtime','input_file','config.local']);
const plain=value=>value&&typeof value==='object'&&!Array.isArray(value);
const json=value=>JSON.stringify(value,null,2)+'\n';
async function readOptional(filename){try{return await readFile(filename,'utf8');}catch(e){if(e.code==='ENOENT')return null;throw e;}}
function parse(text,fallback){return text===null?structuredClone(fallback):JSON.parse(text.replace(/^\uFEFF/,''));}
function portable(root,value){
  if(typeof value!=='string'||!value.trim())throw new Error('必须提供文件或目录路径');
  const relative=path.relative(root,path.resolve(root,value.trim()));
  if(path.isAbsolute(relative))throw new Error('项目与门户应在同一磁盘，才能保存可迁移的相对路径');
  return relative.split(path.sep).join('/')||'.';
}
function relativeAsset(value){return typeof value==='string'&&value.length>0&&!/[\\:*?\0]/.test(value)&&!value.startsWith('/')&&value.split('/').filter(Boolean).every(part=>part!=='.'&&part!=='..'&&!part.startsWith('.')&&!PRIVATE.has(part));}
function inside(root,filename){const rel=path.relative(root,filename);return !path.isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..'+path.sep);}
async function validateStatic(root,app){
  if(!relativeAsset(app.entry)||path.extname(app.entry).toLowerCase()!=='.html')throw new Error('入口必须是发布目录内的 HTML 文件');
  if(!Array.isArray(app.publicPaths)||!app.publicPaths.length||!app.publicPaths.every(relativeAsset))throw new Error('公开资源清单无效，逐项填写文件或以 / 结尾的目录');
  if(!app.publicPaths.some(p=>p===app.entry||(p.endsWith('/')&&app.entry.startsWith(p))))throw new Error('公开资源清单必须包含入口');
  const source=await realpath(path.resolve(root,app.root));
  async function check(relative,directory=false){
    const filename=path.join(source,relative),info=await lstat(filename);
    if(info.isSymbolicLink()||!inside(source,await realpath(filename)))throw new Error('发布资源不能使用符号链接或目录联接：'+relative);
    if(info.isDirectory()){
      if(!directory)throw new Error('公开目录必须以 / 结尾：'+relative);
      for(const item of await readdir(filename,{withFileTypes:true}))await check(relative.replace(/\/$/,'')+'/'+item.name,item.isDirectory());
    }else if(!info.isFile()||!relativeAsset(relative)||!Object.hasOwn(STATIC_MIME_TYPES,path.extname(relative).toLowerCase()))throw new Error('不是允许公开的网页资源：'+relative);
  }
  for(const item of app.publicPaths)await check(item,item.endsWith('/'));
  const entry=await lstat(path.join(source,app.entry));
  if(!entry.isFile()||!entry.size)throw new Error('入口不存在或为空');
}
function registrationArguments(args,port){
  if(!Array.isArray(args)||!args.every(value=>typeof value==='string'))throw new Error('启动参数须为 JSON 字符串数组');
  const result=[...args];
  for(let i=0;i<result.length;i++){
    const separate=result[i]==='--port',inline=result[i].startsWith('--port=');
    if(!separate&&!inline)continue;
    const value=separate?result[i+1]:result[i].slice('--port='.length);
    if(value!==String(port)&&value!=='{port}')throw new Error('启动参数 --port 必须使用门户端口或 {port} 占位符');
    if(separate)result[++i]='{port}';else result[i]='--port={port}';
  }
  return result;
}
export async function planRegistration(root,input){
  root=path.resolve(root);
  if(!plain(input))throw new Error('接入说明必须是 JSON 对象');
  if(typeof input.id!=='string'||!/^[a-z][a-z0-9-]{0,39}$/.test(input.id))throw new Error('ID 须以小写字母开头，仅含小写字母、数字、连字符，最长 40 位');
  if(typeof input.name!=='string'||!input.name.trim())throw new Error('应用名称不能为空');
  if(!['static','proxy'].includes(input.type))throw new Error('type 必须为 static 或 proxy');
  const originals=await Promise.all(FILES.map(file=>readOptional(path.join(root,file))));
  if(originals[0]===null)throw new Error('未找到门户注册表，请从门户项目运行');
  const registry=parse(originals[0]),local=parse(originals[1],{applications:{}});
  const deployment=parse(originals[2],parse(await readOptional(path.join(root,'deploy/config.example.json'))));
  if(!plain(local.applications)||!Array.isArray(deployment?.StaticApplications))throw new Error('已有本机配置格式无效，未写入任何文件');
  const existing=registry.groups.flatMap(g=>g.apps).find(app=>app.id===input.id);
  if(existing&&!input.replace)throw new Error('应用 ID 已存在。更新同一应用需明确设置 replace:true');
  if(!existing&&input.replace)throw new Error('replace:true 仅用于更新已有应用');
  if(existing&&existing.url!==`/${input.id}/`)throw new Error('现有应用公共地址不同，请人工核对后更新');
  const group=registry.groups.find(g=>g.id===(input.group||registry.groups.find(g=>g.apps.some(a=>a.id===input.id))?.id||'operations'));
  if(!group)throw new Error('分组不存在，请使用已有分组 ID');
  const app={...existing,id:input.id,name:input.name.trim(),url:`/${input.id}/`,icon:input.icon||existing?.icon||'chart',enabled:true,status:input.status||(input.type==='static'?'ready':'pending'),order:input.order??existing?.order??45};
  for(const current of registry.groups)current.apps=current.apps.filter(a=>a.id!==input.id);
  group.apps.push(app);
  let integration;
  if(input.type==='static'){
    integration={type:'static',root:portable(root,input.root),entry:input.entry||'index.html',publicPaths:input.publicPaths||[input.entry||'index.html']};
    await validateStatic(root,integration);
  }else{
    const port=Number(input.port);
    if(!Number.isInteger(port)||port<1||port>65535)throw new Error('服务端口须为 1–65535');
    if(typeof input.stripPrefix!=='boolean')throw new Error('动态应用必须明确 stripPrefix: true 或 false');
    if(!Array.isArray(input.healthKeys)||!input.healthKeys.length)throw new Error('请提供稳定健康接口返回的 JSON 顶层字段');
    integration={type:'proxy',target:`http://127.0.0.1:${port}`,stripPrefix:input.stripPrefix,rootRoutes:[],healthPath:input.healthPath||'/api/health',healthKeys:input.healthKeys,healthText:null,start:null};
    if(input.healthExpected!==undefined)integration.healthExpected=input.healthExpected;
    if(input.start){
      integration.start={...input.start,cwd:portable(root,input.start.cwd),command:portable(root,input.start.command),args:registrationArguments(input.start.args,port)};
      const cwd=await lstat(path.resolve(root,integration.start.cwd)),command=await lstat(path.resolve(root,integration.start.command));
      if(!cwd.isDirectory()||!command.isFile())throw new Error('启动目录或可执行文件不存在');
    }
  }
  local.applications[input.id]=integration;
  deployment.StaticApplications=deployment.StaticApplications.filter(a=>a.Name!==input.id);
  if(input.type==='static')deployment.StaticApplications.push({Name:input.id,Enabled:true});
  validateConfig(registry);
  // Validate the complete effective integration without touching the live configuration.
  const temporary=await mkdtemp(path.join(os.tmpdir(),'planhub-register-'));
  try{
    for(const dir of ['portal/config','integration','config.local'])await mkdir(path.join(temporary,dir),{recursive:true});
    await writeFile(path.join(temporary,'portal/config/apps.json'),json(registry));
    await writeFile(path.join(temporary,'integration/apps.json'),await readFile(path.join(root,'integration/apps.json'),'utf8'));
    await writeFile(path.join(temporary,'config.local/apps.json'),json(local));
    const integrations=await loadAppIntegrations(temporary);
    if(input.type==='proxy')for(const [id,item] of Object.entries(integrations))if(id!==input.id&&item.type==='proxy'&&item.target===integration.target)throw new Error('服务端口已由应用 '+id+' 使用');
  }finally{if(!inside(os.tmpdir(),temporary))throw new Error('临时目录越界');await rm(temporary,{recursive:true,force:true});}
  return {root,id:input.id,name:app.name,type:input.type,status:app.status,files:FILES.map((file,index)=>({file,original:originals[index],content:json([registry,local,deployment][index])}))};
}
export async function applyRegistration(plan){
  const configDir=path.join(plan.root,'config.local');await mkdir(configDir,{recursive:true});
  const lockPath=path.join(configDir,'register-app.lock');
  let lock;try{lock=await open(lockPath,'wx');}catch(e){if(e.code==='EEXIST')throw new Error('另一个接入操作尚未结束，请勿同时登记应用');throw e;}
  let backup,applied=[];
  try{
    for(const item of plan.files)if(await readOptional(path.join(plan.root,item.file))!==item.original)throw new Error('配置已被其他操作更改，请重新登记：'+item.file);
    const artifacts=path.join(plan.root,'artifacts');await mkdir(artifacts,{recursive:true});
    if(!inside(await realpath(plan.root),await realpath(artifacts)))throw new Error('备份目录越界');
    backup=await mkdtemp(path.join(artifacts,'registration-'));
    await writeFile(path.join(backup,'transaction.json'),json({appId:plan.id,files:plan.files.map(item=>({path:item.file,existed:item.original!==null}))}));
    for(const [index,item] of plan.files.entries()){
      if(item.original!==null)await writeFile(path.join(backup,index+'.before.json'),item.original);
      await writeFile(path.join(backup,index+'.after.json'),item.content);
    }
    for(const item of plan.files){
      const target=path.join(plan.root,item.file);await mkdir(path.dirname(target),{recursive:true});
      const next=target+'.'+crypto.randomUUID()+'.tmp';await writeFile(next,item.content);
      try{await rename(next,target);}catch(e){await rm(next,{force:true});throw e;}
      applied.push(item);
    }
    return {id:plan.id,backup:path.relative(plan.root,backup).split(path.sep).join('/'),files:plan.files.map(item=>item.file)};
  }catch(error){
    const failures=[];
    for(const item of applied.reverse())try{
      const target=path.join(plan.root,item.file);
      if(item.original===null)await rm(target,{force:true});else await writeFile(target,item.original);
    }catch(e){failures.push(item.file+': '+e.message);}
    if(failures.length)throw new Error(error.message+'；部分恢复失败，请使用备份 '+backup+'：'+failures.join('；'));
    throw error;
  }finally{await lock.close();await rm(lockPath,{force:true});}
}
async function interactive(root){
  const rl=createInterface({input:process.stdin,output:process.stdout});
  const ask=async(label,fallback='')=>(await rl.question(label+(fallback?' ['+fallback+']':'')+'：')).trim()||fallback;
  try{
    console.log('登记网页只保存门户配置，不启动业务服务、不修改业务源码、不部署。');
    const input={id:await ask('应用 ID，如 capacity'),name:await ask('导航名称'),type:(await ask('类型，1 静态 / 2 动态','1'))==='1'?'static':'proxy'};
    const registry=parse(await readOptional(path.join(root,'portal/config/apps.json')));
    const existing=registry.groups.flatMap(g=>g.apps).find(app=>app.id===input.id);
    if(existing){if(await ask('已有 '+existing.name+'，更新它？输入 y 继续','n')!=='y')return null;input.replace=true;}
    input.group=await ask('分组 '+registry.groups.map(g=>g.id+'('+g.name+')').join(' / '),registry.groups.find(g=>g.apps.some(a=>a.id===input.id))?.id||'operations');
    input.order=Number(await ask('排序，数字越小越靠前',String(existing?.order??45)));
    if(input.type==='static'){
      input.root=await ask('网页发布目录，相对门户，如 ../产能分析/dist');
      input.entry=await ask('入口文件名','index.html');
      const resources=await ask('额外公开的文件或目录，用英文逗号分隔，目录以 / 结尾，单 HTML 可留空');
      input.publicPaths=[input.entry,...resources.split(',').map(s=>s.trim()).filter(Boolean)];
    }else{
      input.port=Number(await ask('门户为本应用配置的本机端口'));
      input.stripPrefix=await ask('后端接收路径是否去掉 /应用ID/ 前缀？y/n','y')==='y';
      input.healthPath=await ask('健康接口路径','/api/health');
      input.healthKeys=(await ask('健康接口 JSON 顶层字段，用英文逗号分隔','status')).split(',').map(s=>s.trim()).filter(Boolean);
      if(await ask('由门户启动服务？y/n','y')==='y'){
        input.start={cwd:await ask('原项目工作目录，相对门户'),command:await ask('解释器/可执行文件，相对门户','../.venv/Scripts/python.exe'),args:JSON.parse(await ask('启动参数 JSON 数组；支持 {port}、{host}、{basePath}，按原应用 CLI 调整','["-B","server.py","--port","{port}"]'))};
        const env=await ask('环境变量 JSON 对象，可留空');if(env)input.start.env=JSON.parse(env);
      }
      input.status=await ask('原服务已完成页面/接口验收填 ready，否则保持 pending','pending');
    }
    const plan=await planRegistration(root,input);
    console.log('\n'+plan.name+' → /'+plan.id+'/（'+plan.status+'）\n将更新 '+plan.files.map(f=>f.file).join('、'));
    if(await ask('保存接入配置？y/n','y')!=='y')return null;
    return plan;
  }finally{rl.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  try{
    const args=process.argv.slice(2);let configFile,dryRun=false;
    for(let i=0;i<args.length;i++){
      if(args[i]==='--config'&&args[i+1])configFile=args[++i];else if(args[i]==='--dry-run')dryRun=true;
      else if(args[i]==='--help'){console.log('node scripts/register-app.mjs [--config 接入说明.json] [--dry-run]\n无参数进入交互向导；所有文件路径以门户根目录为基准。');process.exit(0);}else throw new Error('未知或缺少参数：'+args[i]);
    }
    if(dryRun&&!configFile)throw new Error('--dry-run 请同时提供 --config');
    const plan=configFile?await planRegistration(ROOT,parse(await readFile(path.resolve(ROOT,configFile),'utf8'))):await interactive(ROOT);
    if(plan){if(dryRun)console.log('校验通过（未写入）：'+plan.name+' /'+plan.id+'/');else{const result=await applyRegistration(plan);console.log('已保存。备份：'+result.backup+'\n重新启动本地门户后查看 /#/app/'+plan.id+'。正式上线另用发布入口。');}}
  }catch(error){console.error('接入未完成：'+error.message);process.exitCode=1;}
}