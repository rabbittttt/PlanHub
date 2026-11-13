import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink,realpath} from 'node:fs/promises';
import {resolveNodeLicense} from '../scripts/node-runtime-license.mjs';

const version='v22.23.2';
const license=Buffer.from('Node.js is licensed for use as follows:\nCopyright Node.js contributors. All rights reserved.\nPermission is hereby granted, free of charge.\nThe externally maintained libraries used by Node.js are:\n- Fixture dependency notices.\n');
const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
async function put(file,bytes){await mkdir(path.dirname(file),{recursive:true});await writeFile(file,bytes);}
async function fixture(t){
  const base=await mkdtemp(path.join(os.tmpdir(),'planhub-node-license-'));
  t.after(async()=>{
    const resolved=await realpath(base),temporary=await realpath(os.tmpdir());
    assert.equal(path.dirname(resolved),temporary);
    assert.match(path.basename(resolved),/^planhub-node-license-/);
    await rm(resolved,{recursive:true,force:true});
  });
  const executable=path.join(base,'installation/node.exe'),licenseDirectory=path.join(base,'licenses');
  await put(executable,'Fixture executable; never started.');
  return {base,executable,licenseDirectory,version};
}
async function offlineCopy(f,{forVersion=version,bytes=license,entry={}}={}){
  const name=`${forVersion}.LICENSE.txt`;
  await put(path.join(f.licenseDirectory,name),bytes);
  await put(path.join(f.licenseDirectory,'index.json'),JSON.stringify({schemaVersion:1,versions:{[forVersion]:{file:name,source:`https://raw.githubusercontent.com/nodejs/node/${forVersion}/LICENSE`,sha256:digest(bytes),...entry}}}));
}

test('a binary-only Node installation uses the exact-version bundled license offline',async t=>{
  const f=await fixture(t);await offlineCopy(f);
  const result=await resolveNodeLicense(f);
  assert.equal(result.source,'bundled');assert.equal(result.version,version);assert.equal(result.fileName,'LICENSE.txt');
  assert.deepEqual(result.bytes,license);
  assert.equal(await readFile(f.executable,'utf8'),'Fixture executable; never started.');
});

test('the checked-in offline catalog includes A Node 24.16.0 with its complete official notice',async t=>{
  const f=await fixture(t),licenseDirectory=fileURLToPath(new URL('../deploy/licenses/node/',import.meta.url));
  const catalog=JSON.parse(await readFile(path.join(licenseDirectory,'index.json'),'utf8'));
  assert.ok(catalog.versions['v24.16.0']);
  for(const version of Object.keys(catalog.versions)){
    const result=await resolveNodeLicense({...f,version,licenseDirectory});
    assert.equal(result.source,'bundled');assert.equal(result.version,version);
    assert.equal(digest(result.bytes),catalog.versions[version].sha256);
    assert.ok(result.bytes.length>100000);
  }
});

test('a local full Node license is found case-insensitively without requiring an offline catalog',async t=>{
  const f=await fixture(t);await put(path.join(path.dirname(f.executable),'LiCeNsE.TxT'),license);
  const result=await resolveNodeLicense(f);
  assert.equal(result.source,'installation');assert.equal(result.fileName,'LICENSE.txt');assert.deepEqual(result.bytes,license);
});

test('an installed RTF license keeps its exact bytes and RTF extension',async t=>{
  const f=await fixture(t),rtf=Buffer.from(String.raw`{\rtf1\ansi Node.js is licensed for use as follows:\par Copyright Node.js contributors.\par The externally maintained libraries used by Node.js are:\par Fixture notices.}`);
  await put(path.join(path.dirname(f.executable),'license.rtf'),rtf);
  const result=await resolveNodeLicense(f);
  assert.equal(result.source,'installation');assert.equal(result.fileName,'LICENSE.rtf');assert.deepEqual(result.bytes,rtf);
});

test('empty or unrelated local license files cannot suppress the complete offline copy',async t=>{
  const f=await fixture(t);await offlineCopy(f);
  await put(path.join(path.dirname(f.executable),'LICENSE'),'');
  await put(path.join(path.dirname(f.executable),'LICENSE.txt'),'npm package license, not the Node distribution notices');
  const result=await resolveNodeLicense(f);
  assert.equal(result.source,'bundled');assert.deepEqual(result.bytes,license);
});

test('a license for a different Node version is never silently substituted',async t=>{
  const f=await fixture(t);await offlineCopy(f,{forVersion:'v20.20.0'});
  await assert.rejects(resolveNodeLicense(f),error=>{
    assert.match(error.message,/v22\.23\.2/);assert.match(error.message,/matching offline copy/i);return true;
  });
});

test('a damaged bundled license fails closed before it can enter a delivery',async t=>{
  const f=await fixture(t);await offlineCopy(f);
  await put(path.join(f.licenseDirectory,`${version}.LICENSE.txt`),Buffer.concat([license,Buffer.from('corruption')]));
  await assert.rejects(resolveNodeLicense(f),/checksum\/content mismatch/i);
});

test('the offline catalog must point to the exact official version and file',async t=>{
  const f=await fixture(t);
  for(const entry of [{file:'../other.LICENSE.txt'},{source:'https://example.invalid/LICENSE'}]){
    await offlineCopy(f,{entry});await assert.rejects(resolveNodeLicense(f),/Invalid bundled Node\.js license record/);
  }
});

test('a short generic MIT notice is not treated as the full Node distribution license',async t=>{
  const f=await fixture(t);await offlineCopy(f,{bytes:Buffer.from('Permission is hereby granted, free of charge. Copyright Node.js contributors.')});
  await assert.rejects(resolveNodeLicense(f),/checksum\/content mismatch/i);
});

test('version-manager directory aliases resolve the license beside the real executable',async t=>{
  const f=await fixture(t);await put(path.join(path.dirname(f.executable),'LICENSE'),license);
  const alias=path.join(f.base,'node-current');
  try{await symlink(path.dirname(f.executable),alias,process.platform==='win32'?'junction':'dir');}
  catch(error){if(['EPERM','EACCES','ENOSYS'].includes(error.code)){t.skip('Directory links are not available in this environment.');return;}throw error;}
  const result=await resolveNodeLicense({...f,executable:path.join(alias,'node.exe')});
  assert.equal(result.source,'installation');assert.deepEqual(result.bytes,license);
});
