import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rename,rm,symlink} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {loadAppIntegrations} from '../scripts/app-integrations.mjs';
import {createServer} from '../scripts/dev-server.mjs';
import {prepareStaticApp} from '../scripts/prepare-apps.mjs';
import {orderedApps,validateConfig} from '../portal/js/config.js';

async function fixture(t){
  const base=await mkdtemp(path.join(os.tmpdir(),'portal-integration-'));
  t.after(()=>rm(base,{recursive:true,force:true}));
  const root=path.join(base,'workspace','portal');
  for(const dir of ['integration','config.local','portal/config'])await mkdir(path.join(root,dir),{recursive:true});
  const release=path.join(root,'../forecast/output_file');
  await mkdir(path.join(release,'forecast_assets'),{recursive:true});
  await writeFile(path.join(release,'report.html'),'<script src="forecast_assets/chunk.js"></script>');
  await writeFile(path.join(release,'forecast_assets/chunk.js'),'window.unchanged=true;');
  await writeFile(path.join(release,'secret.json'),'not public');
  const config={applications:{forecast:{type:'static',root:'../forecast/output_file',entry:'report.html',publicPaths:['report.html','forecast_assets/']}}};
  await writeFile(path.join(root,'integration/apps.json'),JSON.stringify(config));
  return {base,root,release,config};
}
async function listen(t,server){await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));return 'http://127.0.0.1:'+server.address().port;}

test('relative mounts survive a complete workspace move and expose only release assets',async t=>{
  const f=await fixture(t);
  const newWorkspace=path.join(f.base,'moved workspace');
  await rename(path.dirname(f.root),newWorkspace);
  const root=path.join(newWorkspace,'portal'),applications=await loadAppIntegrations(root);
  assert.equal(applications.forecast.root,path.join(newWorkspace,'forecast/output_file'));
  const origin=await listen(t,createServer({root,applications}));
  const page=await fetch(origin+'/forecast/');assert.equal(page.status,200);assert.equal(await page.text(),'<script src="forecast_assets/chunk.js"></script>');
  assert.equal((await fetch(origin+'/forecast/',{method:'HEAD'})).status,200);
  assert.equal(await (await fetch(origin+'/forecast/forecast_assets/chunk.js')).text(),'window.unchanged=true;');
  assert.equal((await fetch(origin+'/forecast?x=1',{redirect:'manual'})).headers.get('location'),'/forecast/?x=1');
  for(const url of ['/forecast/secret.json','/forecast/warehouse.db','/inventory/','/api/unknown'])assert.equal((await fetch(origin+url)).status,404,url);
  try{await symlink(path.join(newWorkspace,'forecast/output_file/secret.json'),path.join(newWorkspace,'forecast/output_file/forecast_assets/leak.json'));}
  catch(error){if(!['EPERM','EACCES'].includes(error.code))throw error;return;}
  assert.equal((await fetch(origin+'/forecast/forecast_assets/leak.json')).status,403);
});

test('proxy preserves request body, public origin, status and security headers without sharing SOP identity',async t=>{
  const f=await fixture(t);const received=[];
  const upstream=http.createServer(async(req,res)=>{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=Buffer.concat(chunks).toString('base64');
    received.push({url:req.url,method:req.method,headers:req.headers,body});
    const forbidden=req.headers.origin&&req.headers.origin!=='http://'+req.headers.host;
    res.writeHead(forbidden?403:201,{'Content-Type':'application/json','X-Frame-Options':'SAMEORIGIN','Content-Security-Policy':"frame-ancestors 'self'"});res.end(JSON.stringify({body}));
  });
  const target=await listen(t,upstream);
  f.config.applications.quicklook={type:'proxy',target,stripPrefix:true,rootRoutes:['/api/import'],healthPath:'/api/catalog',healthKeys:['tables']};
  await writeFile(path.join(f.root,'integration/apps.json'),JSON.stringify(f.config));
  const origin=await listen(t,createServer({root:f.root,applications:await loadAppIntegrations(f.root)}));
  const res=await fetch(origin+'/api/import?filename=test.xlsx',{method:'POST',headers:{Origin:origin,'Content-Type':'application/octet-stream','X-SOP-User':'forged','X-SOP-Proxy-Key':'forged'},body:Buffer.from([0,1,2,10,255])});
  assert.equal(res.status,201);assert.equal(res.headers.get('x-frame-options'),'SAMEORIGIN');assert.equal(res.headers.get('content-security-policy'),"frame-ancestors 'self'");
  assert.equal(received[0].body,Buffer.from([0,1,2,10,255]).toString('base64'));assert.equal(received[0].url,'/api/import?filename=test.xlsx');assert.equal(received[0].headers.host,new URL(origin).host);assert.equal(received[0].headers.origin,origin);assert.equal(received[0].headers['x-sop-user'],undefined);
  assert.equal((await fetch(origin+'/quicklook/app.js?v=abc')).status,201);assert.equal(received[1].url,'/app.js?v=abc');
  assert.equal((await fetch(origin+'/api/import',{method:'POST',headers:{Origin:'http://elsewhere.invalid'}})).status,403);
  assert.equal((await fetch(origin+'/api/unregistered')).status,404);
  assert.equal((await fetch(origin+'/sop/api/catalog')).status,404);
  await new Promise(resolve=>upstream.close(resolve));
  assert.equal((await fetch(origin+'/quicklook/')).status,502);
});

test('configuration overrides stay portal-relative and reject route collisions or non-loopback targets',async t=>{
  const f=await fixture(t);
  await writeFile(path.join(f.root,'config.local/apps.json'),JSON.stringify({applications:{forecast:{root:'../other-output'}}}));
  assert.equal((await loadAppIntegrations(f.root)).forecast.root,path.resolve(f.root,'../other-output'));
  const proxy={type:'proxy',target:'http://127.0.0.1:8765',stripPrefix:true,rootRoutes:['/api/catalog'],healthPath:'/api/catalog',healthKeys:['tables'],start:null};
  const save=()=>writeFile(path.join(f.root,'integration/apps.json'),JSON.stringify(f.config));
  f.config.applications.one=proxy;f.config.applications.two=proxy;await save();await assert.rejects(loadAppIntegrations(f.root),/冲突/);
  delete f.config.applications.two;f.config.applications.one={...proxy,target:'http://example.com'};await save();await assert.rejects(loadAppIntegrations(f.root),/回环/);
  f.config.applications.one=proxy;await save();await writeFile(path.join(f.root,'portal/config/apps.json'),JSON.stringify({platform:{identityEndpoint:'/api/catalog'}}));await assert.rejects(loadAppIntegrations(f.root),/身份接口冲突/);
});

test('static packaging preserves original bytes, excludes unrelated data and backs up old releases',async t=>{
  const f=await fixture(t), app=(await loadAppIntegrations(f.root)).forecast;
  await mkdir(path.join(f.root,'apps/forecast'),{recursive:true});await writeFile(path.join(f.root,'apps/forecast/index.html'),'previous');
  const result=await prepareStaticApp(f.root,'forecast',app);
  assert.equal(await readFile(path.join(f.root,result.backup,'index.html'),'utf8'),'previous');
  assert.deepEqual(await readFile(path.join(f.root,'apps/forecast/index.html')),await readFile(path.join(f.release,'report.html')));
  await assert.rejects(readFile(path.join(f.root,'apps/forecast/secret.json')),/ENOENT/);
  assert.equal(await readFile(path.join(f.release,'secret.json'),'utf8'),'not public');
});

test('configured navigation order removes inventory and places vehicle configuration after quicklook',async()=>{
  const raw=JSON.parse(await readFile(new URL('../portal/config/apps.json',import.meta.url),'utf8'));
  const config=validateConfig(raw);
  assert.deepEqual(orderedApps(config.apps).map(a=>a.id),['sop','orderiq','forecast','leads','quicklook','vehicle-config']);
  assert.equal(config.apps.find(a=>a.id==='forecast').status,'ready');
});

test('page health checks require an explicit identity marker and bounded timeout',async t=>{
  const f=await fixture(t);
  const proxy={type:'proxy',target:'http://127.0.0.1:8765',stripPrefix:true,rootRoutes:[],healthPath:'/',healthKeys:[],start:null};
  const save=()=>writeFile(path.join(f.root,'integration/apps.json'),JSON.stringify(f.config));
  f.config.applications.quicklook=proxy;await save();await assert.rejects(loadAppIntegrations(f.root),/固定页面标记/);
  f.config.applications.quicklook={...proxy,healthText:'<title>Application</title>',healthTimeoutMs:5000,diagnosticChecks:[{name:'Catalog',path:'/api/catalog',keys:['tables','status']}]};await save();assert.equal((await loadAppIntegrations(f.root)).quicklook.healthTimeoutMs,5000);
  await writeFile(path.join(f.root,'config.local/apps.json'),JSON.stringify({applications:{quicklook:{healthPath:'/api/catalog',healthKeys:['tables']}}}));
  assert.equal((await loadAppIntegrations(f.root)).quicklook.healthText,undefined,'Explicit legacy JSON checks must remain compatible');
  await writeFile(path.join(f.root,'config.local/apps.json'),JSON.stringify({applications:{quicklook:{healthKeys:['tables']}}}));
  const inherited=await loadAppIntegrations(f.root);
  assert.equal(inherited.quicklook.healthText,undefined);
  assert.equal(inherited.quicklook.healthPath,'/api/catalog','Legacy key-only override must keep its JSON endpoint');
  for(const healthPath of ['/api/catalog','/api/custom']){
    await writeFile(path.join(f.root,'config.local/apps.json'),JSON.stringify({applications:{quicklook:{healthPath}}}));
    const legacy=await loadAppIntegrations(f.root);
    assert.equal(legacy.quicklook.healthPath,healthPath);
    assert.equal(legacy.quicklook.healthText,undefined);
    assert.deepEqual(legacy.quicklook.healthKeys,['tables','status'],'Legacy path-only override retains JSON keys');
  }
  await writeFile(path.join(f.root,'config.local/apps.json'),JSON.stringify({applications:{quicklook:{healthKeys:['unknown']}}}));
  await assert.rejects(loadAppIntegrations(f.root),/需明确 healthPath/);
  await writeFile(path.join(f.root,'config.local/apps.json'),JSON.stringify({applications:{}}));
  f.config.applications.quicklook.healthTimeoutMs=60000;await save();await assert.rejects(loadAppIntegrations(f.root),/1000–10000/);
});


test('new service probes and private environment settings are independent of business API routes',async t=>{
  const f=await fixture(t);
  const proxy={type:'proxy',target:'http://127.0.0.1:8765',stripPrefix:true,rootRoutes:[],healthPath:'/healthz',healthKeys:['ok','app'],start:{cwd:'../service',command:'../.venv/Scripts/python.exe',args:['server.py'],env:{APP_PUBLIC_PREFIX:'/service/',APP_DATA_DIR:'../persistent'}}};
  const save=()=>writeFile(path.join(f.root,'integration/apps.json'),JSON.stringify(f.config));
  f.config.applications.service=proxy;await save();
  const result=(await loadAppIntegrations(f.root)).service;
  assert.equal(result.healthPath,'/healthz');assert.deepEqual(result.rootRoutes,[]);
  assert.equal(result.start.env.APP_DATA_DIR,'../persistent','Business env values keep their source application meaning');
  for(const healthPath of ['//other.test/health','/../health','/health?write=1','/health#test','/%2e%2e/api']){
    f.config.applications.service={...proxy,healthPath};await save();await assert.rejects(loadAppIntegrations(f.root),/健康检查路径/);
  }
  for(const env of [{App:'one',APP:'two'},{APP:1},['oops'],{APP:'null\0value'}]){
    f.config.applications.service={...proxy,start:{...proxy.start,env}};await save();await assert.rejects(loadAppIntegrations(f.root),/环境变量/);
  }
});

test('new nested business APIs work through the existing prefix without a portal allowlist',async t=>{
  const f=await fixture(t);
  const upstream=http.createServer(async(req,res)=>{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify({url:req.url,method:req.method,body:Buffer.concat(chunks).toString()}));
  });
  const target=await listen(t,upstream);
  f.config.applications.service={type:'proxy',target,stripPrefix:true,rootRoutes:[],healthPath:'/healthz',healthKeys:['ok'],start:null};
  await writeFile(path.join(f.root,'integration/apps.json'),JSON.stringify(f.config));
  const origin=await listen(t,createServer({root:f.root,applications:await loadAppIntegrations(f.root)}));
  const response=await fetch(origin+'/service/api/new-tab/v2/export?format=csv',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"filter":"demo"}'});
  assert.equal(response.status,200);
  assert.deepEqual(await response.json(),{url:'/api/new-tab/v2/export?format=csv',method:'POST',body:'{"filter":"demo"}'});
  assert.equal((await fetch(origin+'/api/new-tab/v2/export')).status,404);
});


test('service identity expectations reject a standalone instance with the wrong public prefix',async t=>{
  const {probeServiceHealth}=await import('../scripts/health-check.mjs');
  const f=await fixture(t);
  const proxy={type:'proxy',target:'http://127.0.0.1:8780',stripPrefix:true,rootRoutes:[],healthPath:'/healthz',healthKeys:['ok','app'],healthExpected:{ok:true,app:'example-service',public_prefix:'/service/'}};
  f.config.applications.service=proxy;
  await writeFile(path.join(f.root,'integration/apps.json'),JSON.stringify(f.config));
  const app=(await loadAppIntegrations(f.root)).service;
  for(const prefix of ['/','/service/']){
    const result=await probeServiceHealth(app,{fetcher:async()=>new Response(JSON.stringify({ok:true,app:'example-service',public_prefix:prefix,privateField:'do-not-log'}))});
    assert.equal(result.ok,prefix==='/service/');
    if(!result.ok)assert.equal(result.reason,'SERVICE_IDENTITY_MISMATCH');
    assert.doesNotMatch(JSON.stringify(result),/do-not-log/);
  }
  for(const healthExpected of [[],null,{ok:{nested:true}},{ok:[] }]){
    f.config.applications.service={...proxy,healthExpected};
    await writeFile(path.join(f.root,'integration/apps.json'),JSON.stringify(f.config));
    await assert.rejects(loadAppIntegrations(f.root),/期望值/);
  }
});


test('changing only a service target updates launch arguments, environment and identity without altering app literals',async t=>{
  const f=await fixture(t);
  const proxy={type:'proxy',target:'http://127.0.0.1:19881',stripPrefix:true,rootRoutes:[],healthPath:'/healthz',healthKeys:['app'],
    healthExpected:{app:'example',public_prefix:'{basePath}',port:'{port}',unchanged:42},
    start:{cwd:'../service',command:'../runtime.exe',args:['server.py','--port','{port}','--host={host}','--public-prefix','{basePath}','{businessValue}'],
      env:{APP_ORIGIN:'http://{host}:{port}',APP_PUBLIC_PREFIX:'{basePath}',APP_JSON:'{"value":"{businessValue}"}',APP_DATA:'../persistent'}}};
  f.config.applications.service=proxy;
  await writeFile(path.join(f.root,'integration/apps.json'),JSON.stringify(f.config));
  for(const port of ['19881','19882']){
    await writeFile(path.join(f.root,'config.local/apps.json'),JSON.stringify({applications:{service:{target:'http://127.0.0.1:'+port}}}));
    const app=(await loadAppIntegrations(f.root)).service;
    assert.deepEqual(app.start.args,['server.py','--port',port,'--host=127.0.0.1','--public-prefix','/service/','{businessValue}']);
    assert.equal(app.start.env.APP_ORIGIN,'http://127.0.0.1:'+port);
    assert.equal(app.start.env.APP_PUBLIC_PREFIX,'/service/');
    assert.equal(app.start.env.APP_JSON,'{"value":"{businessValue}"}');
    assert.equal(app.start.env.APP_DATA,'../persistent');
    assert.deepEqual(app.healthExpected,{app:'example',public_prefix:'/service/',port,unchanged:42});
  }
  assert.equal(f.config.applications.service.start.args[2],'{port}','Reading config must not mutate template inputs');
  await writeFile(path.join(f.root,'config.local/apps.json'),JSON.stringify({applications:{service:{target:'http://example.invalid:19883'}}}));
  await assert.rejects(loadAppIntegrations(f.root),/回环/);
});

test('a template-launched fixture listens on the portal target and keeps its public prefix in the proxy',async t=>{
  const f=await fixture(t);
  const {spawnService,stopService}=await import('../scripts/service-process.mjs');
  const net=await import('node:net');
  const probe=net.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));
  const port=probe.address().port;await new Promise(r=>probe.close(r));
  const code="require('http').createServer((q,r)=>{r.setHeader('Content-Type','application/json');r.end(JSON.stringify({app:'fixture',prefix:process.env.PUBLIC_PREFIX,port:process.argv[1],path:q.url}));}).listen(Number(process.argv[1]),process.env.LISTEN_HOST);";
  f.config.applications.service={type:'proxy',target:'http://127.0.0.1:'+port,stripPrefix:true,rootRoutes:[],healthPath:'/healthz',healthKeys:['app'],healthExpected:{app:'fixture',prefix:'{basePath}'},start:{cwd:'.',command:process.execPath,args:['-e',code,'{port}'],env:{PUBLIC_PREFIX:'{basePath}',LISTEN_HOST:'{host}'}}};
  await writeFile(path.join(f.root,'integration/apps.json'),JSON.stringify(f.config));
  const app=(await loadAppIntegrations(f.root)).service;
  const child=spawnService(app.start.command,app.start.args,{cwd:app.start.cwd,env:{...process.env,...app.start.env},logDirectory:path.join(f.root,'fixture-logs')});
  try{
    const {probeServiceHealth}=await import('../scripts/health-check.mjs');
    let healthy=false;
    for(let i=0;i<60;i++){
      if((await probeServiceHealth(app)).ok){healthy=true;break;}
      await new Promise(r=>setTimeout(r,50));
    }
    assert.ok(healthy,'Template-launched fixture must be reachable at the target');
    const origin=await listen(t,createServer({root:f.root,applications:{service:app}}));
    const body=await (await fetch(origin+'/service/api/new-page')).json();
    assert.deepEqual(body,{app:'fixture',prefix:'/service/',port:String(port),path:'/api/new-page'});
  }finally{
    stopService(child);await new Promise(r=>setTimeout(r,200));
  }
});
