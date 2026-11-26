// Collect unchanged static release files only. Never copy business source or raw data.
import {mkdir,mkdtemp,readdir,readFile,writeFile,copyFile,realpath,stat,rename,lstat} from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {loadAppIntegrations,publicFile,STATIC_MIME_TYPES} from './app-integrations.mjs';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
function inside(base,target){const rel=path.relative(base,target);return !path.isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..'+path.sep);}
export async function prepareStaticApp(root,id,app) {
  if(!/^[a-z][a-z0-9-]*$/.test(id)||app.type!=='static')throw new Error('Invalid static application');
  root=await realpath(root);
  const configHint=`请核对 A 上的业务文件位置，或在 config.local/apps.json 中设置 applications.${id}.root。`;
  let source;
  try { source=await realpath(app.root); }
  catch(error) {
    if(error.code!=='ENOENT')throw error;
    const roots=[...new Set([app.root,app.previousRoot].filter(Boolean))];
    throw new Error(`静态网页 ${id} 缺少源目录。请检查：\n${roots.map(dir=>path.join(dir,app.entry)).join('\n')}\n${configHint}`);
  }
  const apps=path.join(root,'apps'), backupRoot=path.join(root,'config.local','backups');
  await mkdir(apps,{recursive:true});await mkdir(backupRoot,{recursive:true});
  for(const folder of [apps,backupRoot])if(!inside(root,await realpath(folder)))throw new Error('Release destination escapes portal');
  const destination=path.join(apps,id);
  if(source===destination&&app.entry==='index.html'){await stat(path.join(source,app.entry));return {id,unchanged:true};}
  if(inside(source,destination)||inside(destination,source))throw new Error('Source and release directories overlap');
  const files=[];
  async function collect(relative) {
    const filename=path.join(source,relative), info=await lstat(filename);
    if(info.isSymbolicLink()||!inside(source,await realpath(filename)))throw new Error('Release links are not allowed: '+relative);
    if(info.isDirectory()) {
      for(const entry of await readdir(filename))await collect(relative.replace(/\/$/,'')+'/'+entry);
    } else if(info.isFile()) {
      if(!publicFile(app,relative)||!Object.hasOwn(STATIC_MIME_TYPES,path.extname(relative).toLowerCase())||relative.split('/').some(p=>p.startsWith('.')||['node_modules','logs','data'].includes(p)))throw new Error('Not a public release asset: '+relative);
      if(!files.includes(relative))files.push(relative);
    }
  }
  try { for(const relative of app.publicPaths)await collect(relative); }
  catch(error) {
    if(error.code!=='ENOENT')throw error;
    throw new Error(`静态网页 ${id} 缺少已登记的发布文件：${error.path}。请核对 config.local/apps.json 中该应用的 root、entry 和 publicPaths。`);
  }
  if(!files.includes(app.entry))throw new Error('Missing release entry');
  const temporary=await mkdtemp(path.join(apps,'.prepare-'+id+'-'));
  const hashes={};
  for(const relative of files){
    const target=path.join(temporary,relative);await mkdir(path.dirname(target),{recursive:true});
    await copyFile(path.join(source,relative),target);
    hashes[relative]=crypto.createHash('sha256').update(await readFile(target)).digest('hex');
  }
  if(app.entry!=='index.html')await copyFile(path.join(temporary,app.entry),path.join(temporary,'index.html'));
  let backup=null;
  try {
    const info=await lstat(destination);
    if(info.isSymbolicLink()||!inside(apps,await realpath(destination)))throw new Error('Invalid existing release destination');
    backup=path.join(backupRoot,'static-backup-'+id+'-'+crypto.randomUUID());
    await rename(destination,backup);
  } catch(error){if(error.code!=='ENOENT')throw error;}
  try {await rename(temporary,destination);}
  catch(error){if(backup)await rename(backup,destination);throw error;}
  const manifest={id,source:path.relative(root,source).split(path.sep).join('/'),entry:app.entry,createdAt:new Date().toISOString(),files:hashes,backup:backup?path.relative(root,backup):null};
  await writeFile(path.join(apps,id+'.import.json'),JSON.stringify(manifest,null,2)+'\n');
  return {id,files:files.length,backup:manifest.backup};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  try {
    const applications=await loadAppIntegrations(ROOT);
    const requested=process.argv.slice(2);
    for(const id of requested)if(applications[id]?.type!=='static')throw new Error('Unknown static application: '+id);
    for(const [id,app] of Object.entries(applications)){
      if(app.type!=='static'||(requested.length&&!requested.includes(id)))continue;
      console.log(`静态网页 ${id} 来源：${path.join(app.root,app.entry)}`);
      console.log(await prepareStaticApp(ROOT,id,app));
    }
  } catch(error) {
    console.error(error.message);
    process.exitCode=1;
  }
}
