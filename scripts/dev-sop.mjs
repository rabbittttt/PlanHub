// Development only: loopback preview with an isolated database and a read-only identity.
import {mkdir,mkdtemp,writeFile,copyFile,readdir,stat} from 'node:fs/promises';
import {spawn,spawnSync} from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from './dev-server.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
function option(name,fallback){const i=process.argv.indexOf(name);return i<0?fallback:process.argv[i+1];}
const port=Number(option('--port','4173')),backendPort=Number(option('--backend-port','8877'));
if(![port,backendPort].every(p=>Number.isInteger(p)&&p>0&&p<65536)||port===backendPort)throw new Error('Invalid preview ports');
await mkdir(path.join(root,'artifacts'),{recursive:true});
const preview=await mkdtemp(path.join(root,'artifacts','sop-preview-'));
const data=path.join(preview,'data'),source=path.join(preview,'input'),config=path.join(preview,'config');
for(const dir of [data,source,config])await mkdir(dir);
const python=process.env.SOP_PYTHON||'python';
const seed=option('--seed-from',null);
const rules=path.join(config,'shared_config.py');
if(seed){
  const seedRoot=path.resolve(seed);
  await copyFile(path.join(seedRoot,'data','sales.json'),path.join(data,'sales.json'));
  try{await copyFile(path.join(seedRoot,'data','source_settings.json'),path.join(data,'source_settings.json'));}catch(e){if(e.code!=='ENOENT')throw e;}
  for(const entry of await readdir(path.join(seedRoot,'input_file'),{withFileTypes:true})){
    if(entry.isFile()&&entry.name.endsWith('.xlsx')&&!entry.name.startsWith('~$'))await copyFile(path.join(seedRoot,'input_file',entry.name),path.join(source,entry.name));
  }
  await copyFile(path.resolve(option('--shared-config',path.join(seedRoot,'..','订单分析','scripts','config','shared_config.py'))),rules);
  const originalDb=path.join(seedRoot,'data','sop.sqlite3');
  try{
    await stat(originalDb);
    const script="import sqlite3,pathlib,sys; src=sqlite3.connect(pathlib.Path(sys.argv[1]).resolve().as_uri()+'?mode=ro',uri=True); dst=sqlite3.connect(sys.argv[2]); src.backup(dst); dst.close(); src.close()";
    const result=spawnSync(python,['-c',script,originalDb,path.join(data,'sop.sqlite3')],{stdio:'inherit'});
    if(result.error||result.status!==0)throw new Error('Unable to create an isolated SQLite online backup');
  }catch(e){if(e.code!=='ENOENT')throw e;}
}else{
  await writeFile(rules,'MERGE_GROUPS = {}\n');
  await writeFile(path.join(data,'sales.json'),JSON.stringify({meta:{notes:['仅供本地界面验收的演示数据，不代表业务数据。']},products:[{id:'preview',brand:'演示',model:'本地验收',version:'示例版本'}],sales:[]}));
}
const secret=crypto.randomBytes(32).toString('hex');
const gateway={base_path:'/sop',public_origin:`http://127.0.0.1:${port}`,proxy_secret_env:'SOP_DEV_PROXY_SECRET',allow_writes:false,data_dir:data,source_dir:source,shared_config:rules,plan_file:path.join(source,'SOP计划维护.xlsx')};
const gatewayFile=path.join(config,'gateway.json');
await writeFile(gatewayFile,JSON.stringify(gateway,null,2));
const env={...process.env,SOP_DEV_PROXY_SECRET:secret,SOP_EXCEL_ENGINE:'python',PYTHONUNBUFFERED:'1',PYTHONIOENCODING:'utf-8'};
const child=spawn(python,['server.py','--port',String(backendPort),'--gateway-config',gatewayFile],{cwd:path.join(root,'services','sop'),env,stdio:['ignore','inherit','inherit'],windowsHide:true});
let failed=false;
child.on('error',e=>{console.error(e.message);failed=true;});
child.on('exit',code=>{if(code)failed=true;});
let ready=false;
for(let i=0;i<100&&!failed;i++){
  try{const res=await fetch(`http://127.0.0.1:${backendPort}/sop/api/session`,{headers:{'X-SOP-Proxy-Key':secret,'X-SOP-User':'DEV\\local-preview'},signal:AbortSignal.timeout(1500)});if(res.ok){await res.arrayBuffer();ready=true;break;}}catch{}
  await new Promise(r=>setTimeout(r,250));
}
if(!ready){child.kill();throw new Error('SOP preview did not start; inspect the service error above');}
const server=createServer({root,sopProxy:{port:backendPort,secret,user:'DEV\\local-preview'}});
server.on('error',error=>{console.error(error.message);child.kill();process.exitCode=1;});
server.listen(port,'127.0.0.1',()=>{
  console.log(`SOP 门户预览：http://127.0.0.1:${port}/#/app/sop`);
  console.log(seed?'使用隔离业务快照；原始项目未被此预览写入。':'使用演示数据，仅供界面验收。');
  console.log('本地预览身份不代表 Windows 域认证；全部写入关闭。Ctrl+C 停止。');
});
function stop(){child.kill();server.close(()=>process.exit());setTimeout(()=>process.exit(),1000).unref();}
process.once('SIGINT',stop);process.once('SIGTERM',stop);
