import path from 'node:path';
import crypto from 'node:crypto';
import {readFile,readdir,lstat} from 'node:fs/promises';
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const json=async filename=>JSON.parse((await readFile(filename,'utf8')).replace(/^\uFEFF/,''));
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
export async function readRelease(root,id){
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
