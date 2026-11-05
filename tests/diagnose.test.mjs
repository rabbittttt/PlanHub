import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,realpath,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {collectDiagnostics,formatDiagnostics} from '../scripts/diagnose.mjs';
import {workspaceId} from '../scripts/portal-instance.mjs';
async function fixture(t){
 const base=await realpath(await mkdtemp(path.join(os.tmpdir(),'portal-diagnose-'))),root=path.join(base,'portal');
 await mkdir(path.join(root,'integration'),{recursive:true});await mkdir(path.join(root,'portal/config'),{recursive:true});
 const applications={orderiq:{type:'static',root:'apps/orderiq',entry:'index.html',publicPaths:['index.html']},forecast:{type:'static',root:'../forecast/release',entry:'report.html',publicPaths:['report.html','assets/']},quicklook:{type:'proxy',target:'http://127.0.0.1:8765',stripPrefix:true,rootRoutes:[],healthPath:'/api/catalog',healthKeys:['tables','status'],start:{cwd:'../quicklook',command:'../.venv/python.exe',args:['-B','server.py']}}};
 await writeFile(path.join(root,'integration/apps.json'),JSON.stringify({applications}));
 const apps=['sop','orderiq','forecast','quicklook','leads'].map(id=>({id,name:id,url:'/'+id+'/',enabled:true,status:id==='leads'?'pending':'ready'}));
 await writeFile(path.join(root,'portal/config/apps.json'),JSON.stringify({platform:{name:'Test'},groups:[{id:'test',name:'Test',apps}]}));
 t.after(async()=>{assert.equal(path.dirname(await realpath(base)),await realpath(os.tmpdir()));assert.ok(path.basename(base).startsWith('portal-diagnose-'));await rm(base,{recursive:true,force:true});});
 return {base,root};
}
async function transport(root,{catalog='ok'}={}){
 const id=await workspaceId(root);
 return async (url,options={})=>{
  url=String(url);
  if(url.includes('/api/portal/health'))return new Response(JSON.stringify({appId:'planhub-local-portal',workspaceId:id,token:'DO_NOT_COPY_THIS_TOKEN'}));
  if(url.includes(':8765/')){if(catalog==='refused')throw Object.assign(Error('unreachable'),{cause:{code:'ECONNREFUSED'}});if(catalog==='not-json')return new Response('PRIVATE BUSINESS CONTENT');return new Response(JSON.stringify({tables:['PRIVATE BUSINESS CONTENT'],status:{}}));}
  return new Response(null,{status:options.method==='HEAD'&&url.includes('/sop/')?200:404});
 };
}

test('fresh-clone gaps are reported independently without stopping at the first missing HTML',async t=>{
 const {root}=await fixture(t);let probes=0;const before=await readdir(root);
 const report=await collectDiagnostics({root,fetcher:await transport(root,{catalog:'refused'}),run:async()=>{probes++;throw Error('must not run missing interpreter');}});
 assert.equal(report.portal.sameWorkspace,true);
 assert.ok(report.applications.find(a=>a.id==='orderiq').issues.some(s=>s.includes('index.html')));
 assert.ok(report.applications.find(a=>a.id==='forecast').issues.some(s=>s.includes('report.html')));
 const quicklook=report.applications.find(a=>a.id==='quicklook');assert.equal(quicklook.backend.reason,'ECONNREFUSED');assert.ok(quicklook.issues.some(s=>s.includes('启动程序不存在')));
 assert.equal(report.applications.find(a=>a.id==='leads').issues.length,0);assert.ok(report.applications.find(a=>a.id==='leads').note);
 assert.equal(report.applications.find(a=>a.id==='sop').page.status,200);assert.equal(probes,0);assert.deepEqual(await readdir(root),before);
 assert.doesNotMatch(JSON.stringify(report),/DO_NOT_COPY_THIS_TOKEN|PRIVATE BUSINESS CONTENT/);
});

test('local path overrides and declared Python dependency gaps are diagnosed without importing app code',async t=>{
 const {base,root}=await fixture(t),source=path.join(base,'renamed-query');
 await mkdir(source);await mkdir(path.join(base,'.venv'));await writeFile(path.join(base,'.venv/python.exe'),'fixture');
 await writeFile(path.join(source,'server.py'),'raise RuntimeError("business code must not run")');await writeFile(path.join(source,'requirements.txt'),'pandas>=2.2\n-r extra.txt\n');await writeFile(path.join(source,'extra.txt'),'openpyxl>=3\n');
 await mkdir(path.join(root,'config.local'));await writeFile(path.join(root,'config.local/apps.json'),JSON.stringify({applications:{quicklook:{start:{cwd:'../renamed-query',command:'../.venv/python.exe',args:['-B','server.py']}}}}));
 const original=await readFile(path.join(source,'server.py'));let probes=0;
 const report=await collectDiagnostics({root,fetcher:await transport(root),run:async(command,args)=>{probes++;assert.equal(command,path.join(base,'.venv/python.exe'));assert.equal(args[0],'-B');assert.equal(args[1],'-c');assert.deepEqual(JSON.parse(args[3]),['openpyxl','pandas']);return {stdout:JSON.stringify({version:'3.11.9',packages:{openpyxl:'3.1.5',pandas:null}})};}});
 const app=report.applications.find(a=>a.id==='quicklook');assert.equal(probes,1);assert.deepEqual(app.python.missing,['pandas']);assert.equal(app.backend.ok,true);assert.ok(app.issues.some(s=>s.includes('pandas')));assert.equal(report.localConfiguration.apps,true);
 assert.deepEqual(await readFile(path.join(source,'server.py')),original);assert.doesNotMatch(formatDiagnostics(report),/PRIVATE BUSINESS CONTENT|DO_NOT_COPY_THIS_TOKEN/);
});

test('empty resource directories and a non-JSON backend are explicit failures',async t=>{
 const {base,root}=await fixture(t);await mkdir(path.join(base,'forecast/release/assets'),{recursive:true});await writeFile(path.join(base,'forecast/release/report.html'),'fixture HTML');
 const report=await collectDiagnostics({root,fetcher:await transport(root,{catalog:'not-json'})});
 assert.equal(report.applications.find(a=>a.id==='quicklook').backend.reason,'NOT_JSON');
 assert.ok(report.applications.find(a=>a.id==='forecast').checks.some(c=>c.reason==='EMPTY_PUBLIC_DIRECTORY'));
 assert.doesNotMatch(formatDiagnostics(report),/PRIVATE BUSINESS CONTENT/);
});

test('a live page does not hide catalog HTTP errors in the separate data check',async t=>{
 const {root}=await fixture(t),file=path.join(root,'integration/apps.json'),config=JSON.parse(await readFile(file,'utf8'));
 Object.assign(config.applications.quicklook,{healthPath:'/',healthKeys:[],healthText:'<title>数据速查</title>',healthTimeoutMs:5000,start:null,diagnosticChecks:[{name:'目录接口',path:'/api/catalog',keys:['tables','status']}]});
 await writeFile(file,JSON.stringify(config));
 const ordinary=await transport(root);
 const fetcher=async(url,options)=>{
  const parsed=new URL(String(url));
  if(parsed.port==='8765')return parsed.pathname==='/'?new Response('<title>数据速查</title>'):new Response(JSON.stringify({error:'PRIVATE API DETAILS'}),{status:400});
  return ordinary(url,options);
 };
 const report=await collectDiagnostics({root,fetcher}),app=report.applications.find(a=>a.id==='quicklook');
 assert.equal(app.backend.ok,true);assert.equal(app.dataChecks[0].status,400);assert.ok(app.issues.some(s=>s.includes('HTTP 400')));assert.ok(!app.issues.some(s=>s.includes('后端健康检查失败')));
 assert.doesNotMatch(formatDiagnostics(report),/PRIVATE API DETAILS/);
});

test('page is checked before scanning APIs and uses the configured service deadline',async t=>{
 const {root}=await fixture(t),file=path.join(root,'integration/apps.json'),config=JSON.parse(await readFile(file,'utf8'));
 Object.assign(config.applications.quicklook,{healthPath:'/',healthKeys:[],healthText:'<title>数据速查</title>',healthTimeoutMs:5000,start:null,diagnosticChecks:[{name:'Catalog',path:'/api/catalog',keys:['tables','status']}]});
 await writeFile(file,JSON.stringify(config));
 let scanStarted=false,pageCalls=0;const ordinary=await transport(root);
 const fetcher=async(url,options)=>{
  const parsed=new URL(String(url));
  if(parsed.pathname==='/quicklook/'){
   pageCalls++;assert.equal(options.method,'HEAD');assert.equal(scanStarted,false,'Page probing must precede the heavy API');
   return new Response(null,{status:200});
  }
  if(parsed.port==='8765'){
   if(parsed.pathname==='/api/catalog'){scanStarted=true;return new Response(JSON.stringify({tables:[],status:{}}));}
   return new Response('<title>数据速查</title>');
  }
  return ordinary(url,options);
 };
 const report=await collectDiagnostics({root,fetcher}),app=report.applications.find(a=>a.id==='quicklook');
 assert.equal(pageCalls,1);assert.equal(scanStarted,true);assert.equal(app.page.ok,true);assert.equal(app.page.timeoutMs,5000);assert.ok(app.page.elapsedMs>=0);
 assert.equal(app.dataChecks[0].ok,true);assert.equal(app.issues.length,0);
});
