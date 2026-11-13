import path from 'node:path';
import crypto from 'node:crypto';
import {readFile,readdir,realpath,stat} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const sourceFor=version=>`https://raw.githubusercontent.com/nodejs/node/${version}/LICENSE`;
const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function completeLicense(bytes,{rtf=false}={}){
  const text=bytes.toString('utf8').replace(/^\uFEFF/,'');
  return (!rtf||text.startsWith('{\\rtf'))&&text.includes('Node.js is licensed for use as follows:')&&/externally maintained libraries/i.test(text);
}
async function licenseBytes(file){
  const details=await stat(file);
  if(!details.isFile()||details.size===0||details.size>4*1024*1024)return null;
  return readFile(file);
}
export async function resolveNodeLicense({executable=process.execPath,version=process.version,licenseDirectory=path.join(ROOT,'deploy/licenses/node')}={}){
  if(!/^v\d+\.\d+\.\d+$/.test(version))throw new Error('Use an official stable Node.js release for Windows delivery: '+version);
  const actual=await realpath(executable);
  const directories=[...new Set([path.dirname(actual),path.dirname(path.resolve(executable))])];
  for(const directory of directories){
    let names;
    try{names=await readdir(directory);}catch(error){if(!['ENOENT','EACCES','EPERM'].includes(error.code))throw error;continue;}
    for(const candidate of ['license','license.txt','license.rtf']){
      const name=names.find(value=>value.toLowerCase()===candidate);if(!name)continue;
      let bytes;
      try{bytes=await licenseBytes(path.join(directory,name));}catch(error){if(!['ENOENT','EACCES','EPERM'].includes(error.code))throw error;continue;}
      const rtf=candidate.endsWith('.rtf');
      if(bytes&&completeLicense(bytes,{rtf}))return {bytes,fileName:rtf?'LICENSE.rtf':'LICENSE.txt',source:'installation',version};
    }
  }
  let catalog;
  try{catalog=JSON.parse((await readFile(path.join(licenseDirectory,'index.json'),'utf8')).replace(/^\uFEFF/,''));}catch(error){if(error.code!=='ENOENT')throw error;}
  const entry=catalog?.schemaVersion===1?catalog.versions?.[version]:null;
  if(entry){
    if(entry.file!==`${version}.LICENSE.txt`||entry.source!==sourceFor(version)||!/^[a-f0-9]{64}$/.test(entry.sha256))throw new Error('Invalid bundled Node.js license record: '+version);
    const bytes=await licenseBytes(path.join(licenseDirectory,entry.file));
    if(!bytes||digest(bytes)!==entry.sha256||!completeLicense(bytes))throw new Error('Bundled Node.js license checksum/content mismatch: '+version);
    return {bytes,fileName:'LICENSE.txt',source:'bundled',version};
  }
  throw new Error(`Node.js ${version} is missing its full distribution license and has no matching offline copy. The portal maintainer must add this exact version's official LICENSE to deploy/licenses/node; no Docker or Node.js reinstall is needed.`);
}
