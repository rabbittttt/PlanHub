import {readFile,writeFile,mkdir,realpath,unlink,readdir} from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import {fileURLToPath} from 'node:url';

export const HEALTH_PATH='/api/portal/health';
export const STOP_PATH='/api/portal/stop';
const APP_ID='planhub-local-portal';
const SCRIPTS=path.dirname(fileURLToPath(import.meta.url));
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
export async function workspaceId(root){return hash(await realpath(root));}

async function sopBackendCode(sourceRoot){
  const files=['server.py'];
  async function visit(relative){
    for(const entry of await readdir(path.join(sourceRoot,relative),{withFileTypes:true})){
      const filename=path.join(relative,entry.name);
      if(entry.isDirectory())await visit(filename);
      else if(entry.isFile()&&entry.name.endsWith('.py'))files.push(filename);
    }
  }
  await visit('sop');
  files.sort();
  return Promise.all(files.map(async filename=>[
    filename.split(path.sep).join('/'),hash(await readFile(path.join(sourceRoot,filename)))
  ]));
}

export async function configurationId(settings,applications,python){
  const files=(await readdir(SCRIPTS)).filter(name=>name.endsWith('.mjs')).sort();
  const code=await Promise.all(files.map(async name=>[name,hash(await readFile(path.join(SCRIPTS,name)))]));
  const backendCode=await sopBackendCode(settings.sourceRoot);
  return hash(JSON.stringify({settings,applications,python,code,backendCode}));
}
export async function probePortal(port){
  try {
    const response=await fetch('http://127.0.0.1:'+port+HEALTH_PATH,{redirect:'error',signal:AbortSignal.timeout(1000)});
    if(!response.ok){await response.arrayBuffer();return null;}
    const data=await response.json();
    return data?.appId===APP_ID&&data.protocol===1&&Number.isInteger(data.pid)&&data.pid>0&&data.port===port&&typeof data.instanceId==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(data.instanceId)&&typeof data.workspaceId==='string'&&typeof data.configId==='string'?data:null;
  }catch{return null;}
}
function recordPath(root,port,instanceId){return path.join(root,'artifacts','portal-instances',port+'-'+instanceId+'.json');}
export async function createPortalInstance(root,port,configId){
  const identity={appId:APP_ID,protocol:1,pid:process.pid,port,workspaceId:await workspaceId(root),configId,instanceId:crypto.randomUUID()};
  const token=crypto.randomBytes(32).toString('hex');
  return {identity,token,stop:null};
}
export async function registerPortal(root,runtime){
  const filename=recordPath(root,runtime.identity.port,runtime.identity.instanceId);
  await mkdir(path.dirname(filename),{recursive:true});
  await writeFile(filename,JSON.stringify({...runtime.identity,token:runtime.token}),{mode:0o600});
}
export async function unregisterPortal(root,runtime){
  const filename=recordPath(root,runtime.identity.port,runtime.identity.instanceId);
  try{const record=JSON.parse(await readFile(filename,'utf8'));if(record.instanceId===runtime.identity.instanceId)await unlink(filename);}
  catch(error){if(error.code!=='ENOENT')console.warn('无法清理门户实例记录：'+error.message);}
}
export function handlePortalControl(request,response,runtime,pathname){
  if(!runtime||![HEALTH_PATH,STOP_PATH].includes(pathname))return false;
  const json=(status,value)=>{const body=Buffer.from(JSON.stringify(value));response.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','Content-Length':body.length,'X-Content-Type-Options':'nosniff'});response.end(request.method==='HEAD'?undefined:body);};
  const host=request.headers.host;
  const hosts=new Set(['127.0.0.1:'+runtime.identity.port,'localhost:'+runtime.identity.port]);
  if(runtime.identity.port===80){hosts.add('127.0.0.1');hosts.add('localhost');}
  if(!hosts.has(host)||(request.headers.origin&&request.headers.origin!=='http://'+host)){json(403,{error:'Local origin required'});return true;}
  if(pathname===HEALTH_PATH){if(!['GET','HEAD'].includes(request.method)){json(405,{error:'Method not allowed'});return true;}json(200,runtime.identity);return true;}
  if(request.method!=='POST'){json(405,{error:'Method not allowed'});return true;}
  const supplied=request.headers['x-planhub-control'];
  const valid=typeof supplied==='string'&&Buffer.byteLength(supplied)===Buffer.byteLength(runtime.token)&&crypto.timingSafeEqual(Buffer.from(supplied),Buffer.from(runtime.token));
  if(request.socket.remoteAddress!=='127.0.0.1'||!valid){json(403,{error:'Local control token required'});return true;}
  if(!runtime.stop){json(503,{error:'Portal is not ready'});return true;}
  json(202,{stopping:true});setImmediate(()=>runtime.stop());return true;
}
function portalPortClosed(port){
  return new Promise(resolve=>{
    const socket=net.createConnection({host:'127.0.0.1',port});
    const finish=closed=>{socket.destroy();resolve(closed);};
    socket.once('connect',()=>finish(false));
    socket.once('error',error=>finish(error.code==='ECONNREFUSED'));
    socket.setTimeout(500,()=>finish(false));
  });
}
export async function stopPortal(root,port){
  const running=await probePortal(port);
  if(!running)throw new Error('未找到可识别的门户；不会结束占用端口的其他程序。');
  if(running.workspaceId!==await workspaceId(root))throw new Error('端口属于其他工作区，不会停止。');
  let record;
  try{record=JSON.parse(await readFile(recordPath(root,port,running.instanceId),'utf8'));}catch{throw new Error('缺少当前门户的本机实例记录；不会按端口强制结束程序。');}
  if(record.instanceId!==running.instanceId||record.pid!==running.pid||typeof record.token!=='string')throw new Error('门户实例记录不匹配；不会停止。');
  const response=await fetch('http://127.0.0.1:'+port+STOP_PATH,{method:'POST',redirect:'error',headers:{'X-PlanHub-Control':record.token},signal:AbortSignal.timeout(3000)});
  await response.arrayBuffer();if(response.status!==202)throw new Error('门户未接受停止请求。');
  for(let attempt=0;attempt<50;attempt++){
    const current=await probePortal(port);
    if(current&&current.instanceId!==running.instanceId)return;
    // A slow shutdown can block health responses while its listener is still open.
    if(!current&&await portalPortClosed(port))return;
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  throw new Error('门户仍在停止中，请稍后重试。');
}
