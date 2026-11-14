import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,realpath,rm,symlink} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {resolveWindowsRuntime,verifyWindowsRuntime,probeWindowsRuntime} from '../scripts/windows-runtime.mjs';

const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const put=async(file,value)=>{await mkdir(path.dirname(file),{recursive:true});await writeFile(file,typeof value==='string'?value:JSON.stringify(value));};
async function fixture(t) {
  const base=await mkdtemp(path.join(os.tmpdir(),'planhub-runtime-reuse-'));
  t.after(async()=>{const target=await realpath(base);assert.equal(path.dirname(target),await realpath(os.tmpdir()));assert.ok(path.basename(target).startsWith('planhub-runtime-reuse-'));await rm(target,{recursive:true,force:true});});
  async function delivery(name,{mode='included',complete=true,node='fixture Node',legacy=false}={}) {
    const root=path.join(base,name),files={};await mkdir(root);
    if(mode==='included')for(const [file,value] of Object.entries({'runtime/node/node.exe':node,'runtime/node/LICENSE':'fixture license','runtime/python/python.exe':'fixture Python','runtime/python/runtime.json':JSON.stringify({schemaVersion:1,platform:'win32-x64',implementation:'CPython',executable:'python.exe',applicationRootEnvironment:'PLANHUB_PYTHON_APP_ROOT'})})) {
      await put(path.join(root,file),value);files[file]=sha(value);
    }
    const manifest={schemaVersion:2,platform:'windows/amd64+linux/amd64',complete,files,...(legacy?{}:{runtimeMode:mode})};
    await put(path.join(root,'delivery.json'),manifest);
    return {root,manifest,releases:{}};
  }
  return {base,delivery};
}

test('legacy included delivery resolves its own verified runtime and has a stable content fingerprint',async t=>{
  const f=await fixture(t),delivery=await f.delivery('planhub-001',{legacy:true});
  const runtime=await resolveWindowsRuntime(delivery,{probe(){throw new Error('Included runtimes use their build verification');}});
  assert.equal(runtime.directory,path.join(delivery.root,'runtime'));assert.match(runtime.fingerprint,/^[a-f0-9]{64}$/);
  assert.equal(runtime.fingerprint,(await resolveWindowsRuntime(delivery)).fingerprint);
  await put(path.join(delivery.root,'runtime/python/undeclared.txt'),'extra');
  await assert.rejects(verifyWindowsRuntime(delivery.root,delivery.manifest),/file set differs/);
});

test('reuse selects the newest verified included sibling and checks the new releases rather than old application code',async t=>{
  const f=await fixture(t);
  await f.delivery('planhub-100');const selected=await f.delivery('planhub-200');
  await f.delivery('planhub-300',{mode:'reuse'});await f.delivery('planhub-400',{complete:false});
  await put(path.join(selected.root,'launcher/native-preview.mjs'),'throw new Error("Old launcher must never run");');
  const delivery=await f.delivery('planhub-500',{mode:'reuse'}),payload=path.join(delivery.root,'releases/example/payload');
  await put(path.join(payload,'requirements.txt'),'example>=2');delivery.releases.example={manifest:{type:'service'},payload};
  const calls=[];
  const runtime=await resolveWindowsRuntime(delivery,{probe:async(value,requirements)=>calls.push({value,requirements})});
  assert.equal(runtime.packageRoot,selected.root);assert.equal(calls.length,1);
  assert.deepEqual(calls[0].requirements,[path.join(payload,'requirements.txt')]);
  await assert.rejects(readFile(path.join(delivery.root,'runtime/node/node.exe')),/ENOENT/);
  const fingerprint=runtime.fingerprint;
  await put(path.join(selected.root,'runtime/node/node.exe'),'damaged');
  const fallback=await resolveWindowsRuntime(delivery,{probe:async()=>{}});
  assert.equal(path.basename(fallback.packageRoot),'planhub-100');assert.equal(fallback.fingerprint,fingerprint);
});

test('reused environment compatibility falls back to another verified sibling and otherwise asks for a complete runtime',async t=>{
  const f=await fixture(t);await f.delivery('planhub-100');await f.delivery('planhub-200');
  const delivery=await f.delivery('planhub-300',{mode:'reuse'}),checked=[];
  const runtime=await resolveWindowsRuntime(delivery,{probe:async runtime=>{checked.push(path.basename(runtime.packageRoot));if(path.basename(runtime.packageRoot)==='planhub-200')throw new Error('missing dependency: example');}});
  assert.equal(path.basename(runtime.packageRoot),'planhub-100');assert.deepEqual(checked,['planhub-200','planhub-100']);
  await assert.rejects(resolveWindowsRuntime(delivery,{probe:async()=>{throw new Error('missing dependency: example');}}),/complete delivery[\s\S]*missing dependency: example/);
  const alone=await fixture(t),missing=await alone.delivery('planhub-100',{mode:'reuse'});
  await assert.rejects(resolveWindowsRuntime(missing),/No verified compatible sibling.*complete delivery/);
  await put(path.join(missing.root,'runtime/node/node.exe'),'unexpected');
  await assert.rejects(resolveWindowsRuntime(missing),/must not contain runtime/);
});

test('runtime checksum verification rejects damage, undeclared files and linked candidates',async t=>{
  const f=await fixture(t),delivery=await f.delivery('planhub-100');
  await put(path.join(delivery.root,'runtime/node/node.exe'),'damaged');
  await assert.rejects(verifyWindowsRuntime(delivery.root,delivery.manifest),/damaged/);
  await put(path.join(delivery.root,'runtime/node/node.exe'),'fixture Node');
  const file=path.join(delivery.root,'runtime/linked-node');
  await symlink(path.join(delivery.root,'runtime/node'),file,process.platform==='win32'?'junction':'dir');
  await assert.rejects(verifyWindowsRuntime(delivery.root,delivery.manifest),/Linked Windows runtime/);
});

test('compatibility probes require modern x64 Node and the Python worker bootstrap before metadata checks',async t=>{
  const f=await fixture(t),delivery=await f.delivery('planhub-100'),runtime=await verifyWindowsRuntime(delivery.root,delivery.manifest),requirements=['new-release/requirements.txt'];
  for(const node of [{platform:'win32',arch:'x64',version:'18.0.0'},{platform:'win32',arch:'ia32',version:'24.0.0'}])await assert.rejects(probeWindowsRuntime(runtime,requirements,{run:()=>node}),/Node.js 20/);
  const calls=[];
  await probeWindowsRuntime(runtime,requirements,{run:(command,args)=>{calls.push({command,args});return command===runtime.node?{platform:'win32',arch:'x64',version:'24.0.0'}:{compatible:true};}});
  assert.equal(calls[1].command,runtime.python);assert.deepEqual(calls[1].args.slice(-2),['--requirements',requirements[0]]);
  assert.match(calls[1].args[2],/check-windows-runtime\.py$/);
  await put(path.join(runtime.directory,'python/runtime.json'),{schemaVersion:1,platform:'win32-x64',implementation:'CPython',executable:'python.exe'});
  await assert.rejects(probeWindowsRuntime(runtime,requirements,{run:()=>({platform:'win32',arch:'x64',version:'24.0.0'})}),/worker bootstrap/);
});
