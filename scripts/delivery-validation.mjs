import path from 'node:path';
import crypto from 'node:crypto';
import {createReadStream} from 'node:fs';
import {readFile,readdir,lstat} from 'node:fs/promises';
import {readRelease} from './release-validation.mjs';

export const DELIVERY_SCHEMA=2;
export const DELIVERY_PLATFORM='windows/amd64+linux/amd64';
export const readJson=async file=>JSON.parse((await readFile(file,'utf8')).replace(/^\uFEFF/,''));
export async function hashFile(file){const hash=crypto.createHash('sha256');for await(const bytes of createReadStream(file))hash.update(bytes);return hash.digest('hex');}
export function safeName(name){return typeof name==='string'&&name.length>0&&!/[\\:*?"<>|\x00-\x1f]/.test(name)&&!name.startsWith('/')&&name.split('/').every(p=>p&&!p.startsWith('.')&&!/[. ]$/.test(p));}
export async function noLinks(file){
  for(let current=path.resolve(file);;current=path.dirname(current)){
    try{if((await lstat(current)).isSymbolicLink())throw new Error('Linked delivery paths are not allowed: '+current);}catch(error){if(error.code!=='ENOENT')throw error;}
    if(path.dirname(current)===current)break;
  }
}
export async function deliveryFiles(root){
  await noLinks(root);
  const result=[];
  async function visit(directory){
    for(const entry of await readdir(directory,{withFileTypes:true})){
      const filename=path.join(directory,entry.name),name=path.relative(root,filename).split(path.sep).join('/');
      await noLinks(filename);
      // .dockerignore is the sole deliberately hidden, public build file.
      if(name!=='.dockerignore'&&!safeName(name))throw new Error('Invalid delivery path: '+name);
      if(entry.isDirectory())await visit(filename);
      else if(entry.isFile())result.push(name);
      else throw new Error('Delivery contains a non-file: '+name);
    }
  }
  await visit(root);return result.sort();
}
export async function validateReleases(releases,{complete=false}={}){
  if(!Object.keys(releases).length)throw new Error('No releases supplied');
  if(complete){
    if(!releases.planhub)throw new Error('Complete delivery requires planhub');
    const registry=await readJson(path.join(releases.planhub.payload,'config/apps.json'));
    const expected=['planhub',...registry.groups.flatMap(group=>group.apps).filter(app=>app.enabled).map(app=>app.id)].sort();
    if(new Set(expected).size!==expected.length||expected.join('|')!==Object.keys(releases).sort().join('|'))throw new Error('Incomplete delivery: releases must exactly match enabled portal applications');
  }
}
export function validateBindings(bindings,releases){
  const ports=new Set();
  for(const [id,binding] of Object.entries(bindings)){
    if(!/^[a-z][a-z0-9-]{0,39}$/.test(id)||!Number.isInteger(binding.port)||binding.port<1024||binding.port>65535||binding.port===4174||ports.has(binding.port))throw new Error('Invalid or duplicate runtime port: '+id);
    ports.add(binding.port);
  }
  for(const [id,release] of Object.entries(releases)){
    if(!bindings[id]||bindings[id].type!==release.manifest.type)throw new Error('Configure the runtime binding for '+id);
    const health=id==='sop'?'/sop'+release.manifest.healthPath.replace(/^\/sop/,''):release.manifest.healthPath;
    if(bindings[id].healthPath!==health)throw new Error('Health path differs from runtime binding: '+id);
  }
}
export async function validateDelivery(packageRoot,{requireComplete=false}={}){
  const root=path.resolve(packageRoot);await noLinks(root);
  const manifest=await readJson(path.join(root,'delivery.json'));
  if(manifest.schemaVersion!==DELIVERY_SCHEMA||manifest.platform!==DELIVERY_PLATFORM||typeof manifest.complete!=='boolean'||(requireComplete&&!manifest.complete))throw new Error('Use a complete current delivery folder (selection 0) for local preview.');
  if(!Array.isArray(manifest.applications)||!manifest.applications.length||new Set(manifest.applications).size!==manifest.applications.length||manifest.applications.some(id=>!/^[a-z][a-z0-9-]{0,39}$/.test(id)||id==='network'))throw new Error('Invalid delivery application set');
  if(!manifest.files||typeof manifest.files!=='object'||Array.isArray(manifest.files))throw new Error('Invalid delivery checksums');
  const names=new Set();
  for(const [name,hash] of Object.entries(manifest.files)){
    if((name!=='.dockerignore'&&!safeName(name))||name==='delivery.json'||names.has(name.toLowerCase())||!/^[a-f0-9]{64}$/.test(hash))throw new Error('Invalid delivery checksum entry');
    names.add(name.toLowerCase());await noLinks(path.join(root,name));
    if(await hashFile(path.join(root,name))!==hash)throw new Error('Delivery file is damaged: '+name);
  }
  const actual=(await deliveryFiles(root)).filter(name=>name!=='delivery.json');
  if(actual.length!==names.size||actual.some(name=>!Object.hasOwn(manifest.files,name)))throw new Error('Delivery file set differs from its manifest');
  const releases={};
  for(const id of manifest.applications){releases[id]=await readRelease(path.join(root,'releases',id),id);if(manifest.versions?.[id]!==releases[id].manifest.version)throw new Error('Delivery version differs: '+id);}
  await validateReleases(releases,{complete:manifest.complete});
  const bindings=await readJson(path.join(root,'bindings.json'));validateBindings(bindings,releases);
  if(crypto.createHash('sha256').update(JSON.stringify(bindings)).digest('hex')!==manifest.contractHash)throw new Error('Runtime bindings differ from delivery');
  for(const file of ['runtime/node/node.exe','launcher/native-preview.mjs','deploy.ps1','compose.json','build-docker.ps1'])if(!Object.hasOwn(manifest.files,file))throw new Error('Required launcher file is missing: '+file);
  if(Object.values(releases).some(release=>release.manifest.type==='service')&&!Object.hasOwn(manifest.files,'runtime/python/python.exe'))throw new Error('Bundled Python is missing');
  return {root,manifest,bindings,releases};
}
