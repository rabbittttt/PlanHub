// Select only an immutable Windows runtime; never execute an older delivery's launcher.
import path from 'node:path';
import crypto from 'node:crypto';
import {createReadStream} from 'node:fs';
import {readFile,readdir,lstat} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const CHECKER=fileURLToPath(new URL('./check-windows-runtime.py',import.meta.url));
const FULL_PACKAGE='Create a new complete delivery with its Windows runtime and copy it to B. No dependencies were installed or changed.';
const json=async file=>JSON.parse((await readFile(file,'utf8')).replace(/^\uFEFF/,''));
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const safe=name=>typeof name==='string'&&!/[\\:*?"<>|\x00-\x1f]/.test(name)&&name.split('/').every(part=>part&&!part.startsWith('.')&&!/[. ]$/.test(part));
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');

async function noLinks(file) {
  for(let current=path.resolve(file);;current=path.dirname(current)) {
    if((await lstat(current)).isSymbolicLink())throw new Error('Linked Windows runtime paths are not allowed: '+current);
    if(path.dirname(current)===current)return;
  }
}
async function hashFile(file) {
  const hash=crypto.createHash('sha256');for await(const bytes of createReadStream(file))hash.update(bytes);return hash.digest('hex');
}
function manifestMode(manifest) {
  const mode=Object.hasOwn(manifest,'runtimeMode')?manifest.runtimeMode:'included';
  if(!['included','reuse'].includes(mode))throw new Error('Unknown Windows runtime mode. '+FULL_PACKAGE);
  return mode;
}
function completeManifest(manifest) {
  if(!object(manifest)||manifest.schemaVersion!==2||manifest.platform!=='windows/amd64+linux/amd64'||manifest.complete!==true||!object(manifest.files))throw new Error('Use a complete Windows delivery. '+FULL_PACKAGE);
  return manifestMode(manifest);
}
function describeRuntime(packageRoot,manifest) {
  const directory=path.join(packageRoot,'runtime'),entries=Object.entries(manifest.files).filter(([name])=>name.startsWith('runtime/')).sort(([a],[b])=>a<b?-1:a>b?1:0);
  return {packageRoot,directory,node:path.join(directory,'node/node.exe'),python:path.join(directory,'python/python.exe'),fingerprint:sha(JSON.stringify(entries))};
}
export async function verifyWindowsRuntime(packageRoot,manifest) {
  packageRoot=path.resolve(packageRoot);await noLinks(path.join(packageRoot,'delivery.json'));
  if(completeManifest(manifest)!=='included')throw new Error('The candidate does not include a Windows runtime.');
  const expected=new Map(),lower=new Set();
  for(const [name,hash] of Object.entries(manifest.files))if(name.startsWith('runtime/')) {
    if(!safe(name)||typeof hash!=='string'||!/^[a-f0-9]{64}$/.test(hash)||lower.has(name.toLowerCase()))throw new Error('Invalid Windows runtime checksum: '+name);
    expected.set(name,hash);lower.add(name.toLowerCase());
  }
  if(!expected.has('runtime/node/node.exe'))throw new Error('The candidate has no bundled Node.js.');
  const actual=[];
  async function visit(directory) {
    await noLinks(directory);
    for(const entry of await readdir(directory,{withFileTypes:true})) {
      const file=path.join(directory,entry.name),name=path.relative(packageRoot,file).split(path.sep).join('/');
      await noLinks(file);
      if(!safe(name))throw new Error('Invalid Windows runtime path: '+name);
      if(entry.isDirectory())await visit(file);
      else if(entry.isFile())actual.push(name);
      else throw new Error('Non-file Windows runtime entry: '+name);
    }
  }
  await visit(path.join(packageRoot,'runtime'));
  if(actual.length!==expected.size||actual.some(name=>!expected.has(name)))throw new Error('Windows runtime file set differs from its delivery manifest.');
  for(const name of actual)if(await hashFile(path.join(packageRoot,name))!==expected.get(name))throw new Error('Windows runtime file is damaged: '+name);
  return describeRuntime(packageRoot,manifest);
}
function cleanEnvironment() {
  return Object.fromEntries(Object.entries(process.env).filter(([key])=>!/^NODE_(OPTIONS|PATH)$/i.test(key)&&!/^PYTHON/i.test(key)&&!/^PLANHUB_PYTHON_APP_ROOT$/i.test(key)&&!/^VIRTUAL_ENV$/i.test(key)));
}
function runProbe(command,args) {
  const result=spawnSync(command,args,{windowsHide:true,encoding:'utf8',timeout:60000,maxBuffer:2*1024*1024,env:cleanEnvironment()});
  if(result.error||result.status!==0)throw new Error(result.error?.message||result.stderr?.trim()||'The selected Windows runtime could not run its compatibility check.');
  try{return JSON.parse(result.stdout.trim());}catch{throw new Error('The selected Windows runtime returned an invalid compatibility result.');}
}
export async function probeWindowsRuntime(runtime,requirements,{run=runProbe}={}) {
  const node=run(runtime.node,['-e','process.stdout.write(JSON.stringify({platform:process.platform,arch:process.arch,version:process.versions.node}))']);
  if(node.platform!=='win32'||node.arch!=='x64'||!/^\d+\./.test(node.version)||Number(node.version.split('.')[0])<20)throw new Error('The selected runtime requires Windows x64 Node.js 20 or newer.');
  if(!requirements.length)return;
  const summary=await json(path.join(runtime.directory,'python/runtime.json'));
  if(summary.schemaVersion!==1||summary.platform!=='win32-x64'||summary.implementation!=='CPython'||summary.executable!=='python.exe'||summary.applicationRootEnvironment!=='PLANHUB_PYTHON_APP_ROOT')throw new Error('The selected Python runtime lacks the required application worker bootstrap.');
  const result=run(runtime.python,['-I','-B',CHECKER,'--runtime',path.join(runtime.directory,'python'),...requirements.flatMap(file=>['--requirements',file])]);
  if(result.compatible!==true)throw new Error('The selected Python environment is incompatible with the new application requirements.');
}
export async function resolveWindowsRuntime(delivery,{probe=probeWindowsRuntime}={}) {
  const packageRoot=path.resolve(delivery.root),manifest=delivery.manifest;
  const mode=completeManifest(manifest);
  // The caller already validated this complete delivery, including every file.
  if(mode==='included')return describeRuntime(packageRoot,manifest);
  const localRuntime=path.join(packageRoot,'runtime');
  try{await lstat(localRuntime);throw new Error('A runtime-reuse delivery must not contain runtime/.');}catch(error){if(error.code!=='ENOENT')throw error;}
  const parent=path.dirname(packageRoot);await noLinks(parent);
  const candidates=(await readdir(parent,{withFileTypes:true})).filter(entry=>entry.isDirectory()&&/^planhub-[A-Za-z0-9][A-Za-z0-9._-]*$/.test(entry.name)&&path.join(parent,entry.name)!==packageRoot).map(entry=>entry.name).sort().reverse();
  const rejected=[];
  const requirements=Object.values(delivery.releases).filter(release=>release.manifest.type==='service').map(release=>path.join(release.payload,'requirements.txt'));
  for(const name of candidates) {
    const candidate=path.join(parent,name);
    try {
      await noLinks(path.join(candidate,'delivery.json'));
      const oldManifest=await json(path.join(candidate,'delivery.json'));
      if(completeManifest(oldManifest)!=='included')continue;
      const selected=await verifyWindowsRuntime(candidate,oldManifest);
      await probe(selected,requirements);
      return selected;
    }catch(error){rejected.push(name+': '+error.message);}
  }
  throw new Error('No verified compatible sibling planhub-* complete delivery includes a reusable Windows runtime. '+FULL_PACKAGE+(rejected.length?'\n'+rejected.slice(0,3).join('\n'):''));
}
