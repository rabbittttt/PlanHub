import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, stat, rm, realpath } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import {loadAppIntegrations} from '../scripts/app-integrations.mjs';
import {createServer} from '../scripts/dev-server.mjs';

const windowsOnly={skip:process.platform!=='win32'};
const script=fileURLToPath(new URL('../scripts/Import-OrderIQ.ps1',import.meta.url));
const powershell=path.join(process.env.SystemRoot||'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe');

async function fixture(t){
  const temporaryRoot=await realpath(await mkdtemp(path.join(os.tmpdir(),'portal-import-test-')));
  t.after(async()=>{
    const resolved=await realpath(temporaryRoot);
    assert.equal(path.dirname(resolved),await realpath(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('portal-import-test-'));
    await rm(resolved,{recursive:true,force:true});
  });
  const project=path.join(temporaryRoot,'project'),source=path.join(temporaryRoot,'source.html');
  const registryFile=path.join(project,'portal/config/apps.json');
  const localFile=path.join(project,'config.local/apps.json');
  await mkdir(path.dirname(registryFile),{recursive:true});
  const sourceContent='<!doctype html><html><title>Published fixture</title></html>';
  await writeFile(source,sourceContent);
  await writeFile(registryFile,JSON.stringify({platform:{name:'Fixture'},groups:[{id:'business',name:'Business',apps:[
    {id:'orderiq',name:'Orders',url:'/orderiq/',enabled:false,status:'pending',dataUpdatedAt:null},
  ]}]}));
  const invoke=(extra=[],file=script)=>spawnSync(powershell,['-NoProfile','-NonInteractive','-ExecutionPolicy','RemoteSigned','-File',file,'-SourceHtml',source,'-ProjectRoot',project,...extra],{encoding:'utf8',windowsHide:true});
  return {temporaryRoot,project,source,sourceContent,registryFile,localFile,invoke};
}

test('OrderIQ import supports dry runs, preserves source and selects the imported artifact',windowsOnly,async t=>{
  const f=await fixture(t);
  // Exercise no ProjectRoot from a different CWD and preserve the PS5.1 UTF-8 BOM.
  const copiedScript=path.join(f.project,'scripts/Import-OrderIQ.ps1');
  await mkdir(path.dirname(copiedScript),{recursive:true});
  const scriptBytes=await readFile(script);
  assert.deepEqual(scriptBytes.subarray(0,3),Buffer.from([239,187,191]));
  await writeFile(copiedScript,scriptBytes);
  const originalRegistry=await readFile(f.registryFile,'utf8');
  const defaultDryRun=spawnSync(powershell,['-NoProfile','-NonInteractive','-ExecutionPolicy','RemoteSigned','-File',copiedScript,'-SourceHtml',f.source,'-WhatIf'],{cwd:fileURLToPath(new URL('..',import.meta.url)),encoding:'utf8',windowsHide:true});
  assert.equal(defaultDryRun.status,0,defaultDryRun.stderr);
  assert.equal(await readFile(f.registryFile,'utf8'),originalRegistry);
  await assert.rejects(stat(path.join(f.project,'apps/orderiq/index.html')),{code:'ENOENT'});
  await assert.rejects(stat(path.dirname(f.localFile)),{code:'ENOENT'});
  const dryRun=f.invoke(['-WhatIf']);
  assert.equal(dryRun.status,0,dryRun.stderr);
  await assert.rejects(stat(path.join(f.project,'apps/orderiq/index.html')),{code:'ENOENT'});
  await assert.rejects(stat(f.localFile),{code:'ENOENT'});
  const imported=f.invoke();assert.equal(imported.status,0,imported.stderr);
  assert.equal(await readFile(f.source,'utf8'),f.sourceContent);
  assert.equal(await readFile(path.join(f.project,'apps/orderiq/index.html'),'utf8'),f.sourceContent);
  const registry=JSON.parse(await readFile(f.registryFile,'utf8'));
  assert.equal(registry.groups[0].apps[0].status,'ready');assert.equal(registry.groups[0].apps[0].enabled,true);assert.equal(registry.groups[0].apps[0].dataUpdatedAt,null);
  const metadata=JSON.parse(await readFile(path.join(f.project,'apps/orderiq.import.json'),'utf8'));
  assert.match(metadata.sourceSha256,/^[a-f0-9]{64}$/);assert.ok(!Number.isNaN(Date.parse(metadata.sourceFileModifiedAt)));assert.equal(metadata.dataUpdatedAt,null);
  assert.deepEqual(JSON.parse(await readFile(f.localFile,'utf8')),{applications:{orderiq:{root:'apps/orderiq',entry:'index.html',publicPaths:['index.html']}}});
});

test('import preserves unrelated overrides and serves the selected HTML instead of the default source',windowsOnly,async t=>{
  const f=await fixture(t);
  await mkdir(path.join(f.project,'integration'));
  await writeFile(path.join(f.project,'integration/apps.json'),JSON.stringify({applications:{
    orderiq:{type:'static',root:'../original/output_file',entry:'original.html',publicPaths:['original.html']},
    forecast:{type:'static',root:'../forecast/output_file',entry:'forecast.html',publicPaths:['forecast.html']},
  }}));
  const originalPath=path.join(f.temporaryRoot,'original/output_file/original.html');
  await mkdir(path.dirname(originalPath),{recursive:true});await writeFile(originalPath,'<title>Original default</title>');
  const local={note:'preserve top-level data',applications:{
    orderiq:{type:'static',root:'../previous',entry:'previous.html',publicPaths:['previous.html'],custom:{keep:true}},
    forecast:{root:'../custom-forecast',publicPaths:['forecast.html'],custom:['unchanged']},
  }};
  await mkdir(path.dirname(f.localFile));
  const originalLocal='\ufeff'+JSON.stringify(local,null,2);await writeFile(f.localFile,originalLocal);
  const dryRun=f.invoke(['-WhatIf']);assert.equal(dryRun.status,0,dryRun.stderr);assert.equal(await readFile(f.localFile,'utf8'),originalLocal);
  const imported=f.invoke();assert.equal(imported.status,0,imported.stderr);
  const merged=JSON.parse(await readFile(f.localFile,'utf8'));
  assert.equal(merged.note,local.note);assert.deepEqual(merged.applications.forecast,local.applications.forecast);
  assert.deepEqual(merged.applications.orderiq,{...local.applications.orderiq,root:'apps/orderiq',entry:'index.html',publicPaths:['index.html']});
  const applications=await loadAppIntegrations(f.project);
  assert.equal(applications.orderiq.root,path.join(f.project,'apps/orderiq'));
  const server=createServer({root:f.project,applications});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{const response=await fetch('http://127.0.0.1:'+server.address().port+'/orderiq/');assert.equal(response.status,200);assert.equal(await response.text(),f.sourceContent);}
  finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  assert.equal(await readFile(originalPath,'utf8'),'<title>Original default</title>');
});

test('malformed local integration configuration fails before replacing existing artifacts or metadata',windowsOnly,async t=>{
  const f=await fixture(t);
  const release=path.join(f.project,'apps/orderiq/index.html'),metadata=path.join(f.project,'apps/orderiq.import.json');
  await mkdir(path.dirname(release),{recursive:true});await mkdir(path.dirname(f.localFile));
  await writeFile(release,'previous usable release');await writeFile(metadata,'previous import metadata');
  const registryBefore=await readFile(f.registryFile,'utf8');
  for(const raw of ['{broken','[]','null','[{"applications":{}}]','{"applications":[]}','{"applications":{"orderiq":[]}}','{"applications":{"orderiq":{"type":"proxy"}}}']){
    await writeFile(f.localFile,raw);
    const result=f.invoke();assert.notEqual(result.status,0,'Invalid local configuration unexpectedly accepted: '+raw);
    assert.equal(await readFile(release,'utf8'),'previous usable release');
    assert.equal(await readFile(metadata,'utf8'),'previous import metadata');
    assert.equal(await readFile(f.registryFile,'utf8'),registryBefore);
    assert.equal(await readFile(f.localFile,'utf8'),raw);
  }
  assert.equal(await readFile(f.source,'utf8'),f.sourceContent);
});
