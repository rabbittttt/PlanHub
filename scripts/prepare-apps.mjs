// Collect unchanged static release files only. Never copy business source or raw data.
import {mkdir,mkdtemp,readdir,readFile,writeFile,copyFile,realpath,stat,rename,lstat} from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {loadAppIntegrations,publicFile} from './app-integrations.mjs';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const extensions=new Set(['.html','.css','.js','.mjs','.json','.svg','.png','.jpg','.jpeg','.gif','.webp','.ico','.woff','.woff2','.txt']);
function inside(base,target){const rel=path.relative(base,target);return !path.isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..'+path.sep);}
export async function prepareStaticApp(root,id,app) {
  if(!/^[a-z][a-z0-9-]*$/.test(id)||app.type!=='static')throw new Error('Invalid static application');
  root=await realpath(root);
  const source=await realpath(app.root), apps=path.join(root,'apps'), backupRoot=path.join(root,'artifacts');
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
      if(!publicFile(app,relative)||!extensions.has(path.extname(relative).toLowerCase())||relative.split('/').some(p=>p.startsWith('.')||['node_modules','logs','data'].includes(p)))throw new Error('Not a public release asset: '+relative);
      if(!files.includes(relative))files.push(relative);
    }
  }
  for(const relative of app.publicPaths)await collect(relative);
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
  const applications=await loadAppIntegrations(ROOT);
  const requested=process.argv.slice(2);
  for(const id of requested)if(applications[id]?.type!=='static')throw new Error('Unknown static application: '+id);
  for(const [id,app] of Object.entries(applications))if(app.type==='static'&&(!requested.length||requested.includes(id)))console.log(await prepareStaticApp(ROOT,id,app));
}
