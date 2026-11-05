// Read-only checks: never starts apps, imports their code, changes config or reads report contents.
import {readFile,readdir,stat,realpath} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {parseArgs} from 'node:util';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {loadAppIntegrations} from './app-integrations.mjs';
import {validateConfig,orderedApps} from '../portal/js/config.js';
import {workspaceId} from './portal-instance.mjs';
import {probeServiceHealth} from './health-check.mjs';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const execute=promisify(execFile);

async function location(filename,directory=false){
  try{const info=await stat(filename);return {path:filename,ok:directory?info.isDirectory():info.isFile()&&info.size>0};}
  catch(error){return {path:filename,ok:false,reason:error.code||'UNAVAILABLE'};}
}
async function httpCheck(url,{method='GET',keys=null,timeoutMs=2500,fetcher=fetch}={}){
  const started=performance.now();
  const result=state=>({...state,method,timeoutMs,elapsedMs:Math.round(performance.now()-started)});
  try{
    const response=await fetcher(url,{method,redirect:'manual',signal:AbortSignal.timeout(timeoutMs)});
    if(keys&&response.ok){
      let body;try{body=await response.json();}catch(error){if(['TimeoutError','AbortError'].includes(error.name))throw error;return result({ok:false,status:response.status,reason:'NOT_JSON'});}
      const missing=keys.filter(key=>!body||!Object.hasOwn(body,key));
      return result({ok:missing.length===0,status:response.status,...(missing.length?{reason:'MISSING_HEALTH_KEYS',missing}:{})});
    }
    await response.arrayBuffer();return result({ok:response.ok,status:response.status});
  }catch(error){return result({ok:false,reason:['TimeoutError','AbortError'].includes(error.name)?'TIMEOUT':error.cause?.code||error.code||'CONNECTION_FAILED'});}
}
async function declaredPackages(directory){
  const found=new Set(),visited=new Set();
  async function read(filename,depth=0){
    if(depth>5||visited.has(filename))return;visited.add(filename);
    let text;try{text=await readFile(filename,'utf8');}catch(error){if(error.code==='ENOENT')return;throw error;}
    for(const raw of text.split(/\r?\n/)){
      const line=raw.trim();if(!line||line.startsWith('#'))continue;
      const include=/^-r\s+([^\s#]+)$/.exec(line);
      if(include){await read(path.resolve(path.dirname(filename),include[1]),depth+1);continue;}
      const name=/^([A-Za-z][A-Za-z0-9_.-]*)(?:\[[^\]]+\])?\s*(?=[<>=!~;#]|$)/.exec(line);
      if(name)found.add(name[1]);
    }
  }
  await read(path.join(directory,'requirements.txt'));return [...found].sort();
}
async function pythonCheck(command,packages,run){
  const script="import sys,json,importlib.metadata as m; result={}; exec('for name in json.loads(sys.argv[1]):\\n try: result[name]=m.version(name)\\n except m.PackageNotFoundError: result[name]=None'); print(json.dumps({'version':sys.version.split()[0],'packages':result}))";
  try{
    const {stdout}=await run(command,['-B','-c',script,JSON.stringify(packages)],{encoding:'utf8',windowsHide:true,timeout:10000,maxBuffer:65536,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}});
    const data=JSON.parse(stdout.trim());return {...data,ok:true,missing:packages.filter(name=>!data.packages[name])};
  }catch{return {ok:false,reason:'PYTHON_UNAVAILABLE'};}
}
async function latestLog(root,id){
  try{
    const entries=await readdir(path.join(root,'artifacts'),{withFileTypes:true});const logs=[];
    for(const entry of entries)if(entry.isDirectory()&&entry.name.startsWith('service-'+id+'-')){
      const filename=path.join(root,'artifacts',entry.name,'stderr.log');try{const info=await stat(filename);logs.push({path:path.relative(root,filename),modifiedAt:info.mtime.toISOString()});}catch{}
    }
    return logs.sort((a,b)=>b.modifiedAt.localeCompare(a.modifiedAt))[0]||null;
  }catch{return null;}
}
export async function collectDiagnostics({root=ROOT,port=4173,fetcher=fetch,run=execute}={}){
  root=await realpath(root);
  const report={root,node:process.versions.node,port,localConfiguration:{apps:(await location(path.join(root,'config.local/apps.json'))).ok,sop:(await location(path.join(root,'config.local/sop.json'))).ok},workspaceFolders:[],portal:{},applications:[]};
  try{report.workspaceFolders=(await readdir(path.dirname(root),{withFileTypes:true})).filter(e=>e.isDirectory()&&!e.name.startsWith('.')).map(e=>e.name);}catch{}
  const origin='http://127.0.0.1:'+port;
  report.portal=await httpCheck(origin+'/api/portal/health',{keys:['appId','workspaceId'],fetcher});
  // Separately compare identity, without printing the response or its control metadata.
  if(report.portal.ok){try{const r=await fetcher(origin+'/api/portal/health',{signal:AbortSignal.timeout(2500),redirect:'error'});const identity=await r.json();report.portal.sameWorkspace=identity.appId==='planhub-local-portal'&&identity.workspaceId===await workspaceId(root);}catch{report.portal.sameWorkspace=false;}}
  let registry,integrations;
  try{registry=validateConfig(JSON.parse((await readFile(path.join(root,'portal/config/apps.json'),'utf8')).replace(/^\uFEFF/,'')));integrations=await loadAppIntegrations(root);}
  catch{report.configurationError='接入配置无效：请核对 portal/config/apps.json、integration/apps.json 和 config.local/apps.json';return report;}
  for(const app of orderedApps(registry.apps)){
    const result={id:app.id,name:app.name,configuredStatus:app.status,checks:[],issues:[]};report.applications.push(result);
    if(app.status!=='ready'){result.note='尚未接入或维护中，不属于启动故障';continue;}
    try{
      const binding=integrations[app.id];
      // Check the lightweight page before a slow business API can add scan load.
      result.page=await httpCheck(origin+app.url,{method:'HEAD',timeoutMs:binding?.type==='proxy'?(binding.healthTimeoutMs??5000):2500,fetcher});
      if(!result.page.ok&&![405,501].includes(result.page.status))result.issues.push('门户页面探测失败：'+(result.page.reason||'HTTP '+result.page.status));
      if(binding?.type==='static'){
        result.type='static';result.checks.push(await location(binding.root,true));result.checks.push(await location(path.join(binding.root,binding.entry)));
        for(const item of binding.publicPaths.filter(p=>p!==binding.entry)){
          const check=await location(path.join(binding.root,item),item.endsWith('/'));
          if(check.ok&&item.endsWith('/')&&(await readdir(check.path)).length===0){check.ok=false;check.reason='EMPTY_PUBLIC_DIRECTORY';}
          result.checks.push(check);
        }
        for(const item of result.checks)if(!item.ok)result.issues.push('缺少发布文件/目录：'+item.path);
        result.hint='业务报表和生成资源不随 Git 下载；在原项目生成或迁移发布物。路径不同用 config.local/apps.json 覆盖。';
      }else if(binding?.type==='proxy'){
        result.type='proxy';result.backend={...await probeServiceHealth(binding,{fetcher}),path:binding.healthPath,timeoutMs:binding.healthTimeoutMs??1500};
        if(!result.backend.ok)result.issues.push('后端健康检查失败：'+(result.backend.reason||'HTTP '+result.backend.status));
        result.dataChecks=[];
        if(result.backend.ok)for(const check of binding.diagnosticChecks||[]){
          const state=await probeServiceHealth({...binding,healthPath:check.path,healthKeys:check.keys,healthText:undefined,healthTimeoutMs:10000},{fetcher});
          result.dataChecks.push({name:check.name,timeoutMs:10000,...state});
          if(!state.ok)result.issues.push(check.name+'异常（与进程存活不同）：'+(state.status?'HTTP '+state.status:state.reason));
        }
        if(binding.start){
          const directory=await location(binding.start.cwd,true),command=await location(binding.start.command);result.checks.push(directory,command);
          if(!directory.ok)result.issues.push('原项目目录不存在：'+directory.path);
          if(!command.ok)result.issues.push('启动程序不存在：'+command.path);
          if(directory.ok&&!binding.start.args.some(a=>['-m','-c','-e'].includes(a))){
            const script=binding.start.args.find(a=>/\.(?:py|m?js)$/i.test(a));if(script){const item=await location(path.resolve(binding.start.cwd,script));result.checks.push(item);if(!item.ok)result.issues.push('启动脚本不存在：'+item.path);}
          }
          if(directory.ok&&command.ok&&/^python(?:w|\d+(?:\.\d+)*)?(?:\.exe)?$/i.test(path.basename(binding.start.command))){
            result.python=await pythonCheck(binding.start.command,await declaredPackages(binding.start.cwd),run);
            if(!result.python.ok)result.issues.push('Python 无法运行；请重新创建该电脑上的环境');
            else if(result.python.missing.length)result.issues.push('缺少原项目声明的依赖：'+result.python.missing.join(', '));
          }
        }
        result.latestLog=await latestLog(root,app.id);result.hint='检查原项目、配置的解释器及其 requirements；SOP 使用的解释器不一定与本服务相同。日志路径仅供定位，不据旧日志断定当前故障。';
      }else if(app.id==='sop')result.type='sop';
      else result.issues.push('没有配置实际挂载或代理');
    }catch(error){result.issues.push('此应用检查未完成：'+(error.code||'CHECK_FAILED'));}
  }
  return report;
}
export function formatDiagnostics(report){
  const lines=['门户只读诊断（不启动服务、不修改配置或业务数据）','门户目录：'+report.root,'同级项目：'+report.workspaceFolders.join('、'),'本机配置：apps.json '+(report.localConfiguration.apps?'存在':'未设置')+'；sop.json '+(report.localConfiguration.sop?'存在':'未设置'),'运行门户：'+(report.portal.ok?(report.portal.sameWorkspace?'同一工作区':'工作区不匹配'):(report.portal.reason||'HTTP '+report.portal.status))];
  if(report.configurationError)lines.push(report.configurationError);
  for(const app of report.applications){
    lines.push('\n['+app.name+'] '+(app.note|| (app.issues.length?'未通过':'已检查')));
    for(const check of app.checks)lines.push('  '+(check.ok?'存在 ':'缺少 ')+check.path);
    if(app.page)lines.push('  页面：'+app.page.method+' '+(app.page.status||app.page.reason)+'；耗时 '+app.page.elapsedMs+'ms；时限 '+app.page.timeoutMs+'ms');
    if(app.backend)lines.push('  后端：'+(app.backend.status||app.backend.reason)+(app.backend.reason?' '+app.backend.reason:'')+'；探针 '+app.backend.path);
    for(const check of app.dataChecks||[])lines.push('  '+check.name+'：'+(check.status||check.reason)+(check.reason==='TIMEOUT'?'（'+check.timeoutMs+'ms 内未完成，不等于服务未启动）':''));
    if(app.python)lines.push('  Python：'+(app.python.version||app.python.reason)+'；已声明依赖仅检查安装情况，不代替版本兼容验证');
    for(const issue of app.issues)lines.push('  问题：'+issue);
    if(app.latestLog)lines.push('  最近日志：'+app.latestLog.path);
    if(app.hint&&app.issues.length)lines.push('  建议：'+app.hint);
  }
  return lines.join('\n');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  try{
    const {values}=parseArgs({options:{port:{type:'string'},json:{type:'boolean'}},strict:true,allowPositionals:false});const port=Number(values.port??4173);
    if(!Number.isInteger(port)||port<1||port>65535)throw new Error('端口必须为1–65535整数');
    const report=await collectDiagnostics({port});console.log(values.json?JSON.stringify(report,null,2):formatDiagnostics(report));
    if(report.configurationError||!report.portal.ok||!report.portal.sameWorkspace||report.applications.some(app=>app.issues.length))process.exitCode=2;
  }catch(error){console.error('诊断未完成：'+error.message);process.exitCode=1;}
}
