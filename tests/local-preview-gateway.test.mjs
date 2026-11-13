import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import os from 'node:os';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {createContainerPortal,validateRuntime} from '../scripts/container-runtime.mjs';
import {LOCAL_PREVIEW_ORIGIN,validatePreviewConfig,startLocalPreviewPortal} from '../scripts/local-preview-gateway.mjs';

const configuration=()=>({schemaVersion:1,publicOrigin:LOCAL_PREVIEW_ORIGIN,port:4173,listenAddress:'127.0.0.1',proxySecret:'a'.repeat(64),sopSecret:'b'.repeat(64),vehicleSecret:'c'.repeat(64),sharedDirectory:'shared',sopSharedConfig:'config/shared_config.py',quicklookSourceBase:'shared',preview:{schemaVersion:1,user:'DEPT\\alice',sourceDirectory:'original-runtime',createdAt:'2026-11-13T00:00:00.000Z'}});
const listen=(server,port=0)=>new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',()=>resolve(server.address().port));});
async function close(server){if(server.listening){server.closeAllConnections?.();await new Promise(resolve=>server.close(resolve));}}
function request(port,{url='/',method='GET',headers={Host:'127.0.0.1:4173'},body}={}){
  return new Promise((resolve,reject)=>{
    const req=http.request({host:'127.0.0.1',port,path:url,method,headers},res=>{const buffers=[];res.on('data',chunk=>buffers.push(chunk));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(buffers).toString('utf8')}));res.on('error',reject);});
    req.on('error',reject);req.end(body);
  });
}
async function fixture(t,config=configuration()){
  const directory=await mkdtemp(path.join(os.tmpdir(),'planhub-preview-http-'));
  t.after(async()=>{assert.equal(path.dirname(directory),path.resolve(os.tmpdir()));assert.ok(path.basename(directory).startsWith('planhub-preview-http-'));await rm(directory,{recursive:true,force:true});});
  await writeFile(path.join(directory,'index.html'),'unchanged portal page');
  const calls=[];
  const upstream=http.createServer((req,res)=>{
    const buffers=[];req.on('data',chunk=>buffers.push(chunk));req.on('end',()=>{
      calls.push({path:req.url,method:req.method,headers:req.headers,body:Buffer.concat(buffers).toString('utf8')});
      res.writeHead(req.method==='POST'?201:200,{'Content-Type':'application/json','X-Frame-Options':'SAMEORIGIN','X-PlanHub-Key':config.proxySecret,'X-Config-Proxy-Key':config.vehicleSecret});
      res.end(JSON.stringify({ok:true,actor:req.headers['x-config-user']??null}));
    });
  });
  const backend=await listen(upstream);t.after(()=>close(upstream));
  const bindings={planhub:{port:4173},'vehicle-config':{port:backend,stripPrefix:true},sop:{port:backend}};
  const authenticated=createContainerPortal(directory,bindings,config);
  const gateway=await startLocalPreviewPortal(authenticated,config,{host:'127.0.0.1',port:0});t.after(()=>close(gateway));
  return {gateway,authenticated,port:gateway.address().port,calls,directory,config};
}

test('preview configuration is explicit, loopback-only and uses the actual launcher identity contract',()=>{
  const config=configuration();assert.equal(validateRuntime(config),config);assert.equal(validatePreviewConfig(config),config.preview);
  assert.equal(validatePreviewConfig({...config,preview:{...config.preview,user:'SID\\S-1-5-21-12345-1001'}}).user,'SID\\S-1-5-21-12345-1001');
  assert.equal(validatePreviewConfig({...config,preview:{...config.preview,user:'alice@dept.internal'}}).user,'alice@dept.internal');
  for(const invalid of [
    {...config,preview:null},{...config,preview:{...config.preview,schemaVersion:2}},
    {...config,publicOrigin:'http://localhost:4173'}, {...config,publicOrigin:'http://127.0.0.1:4173/'},
    {...config,publicOrigin:'https://127.0.0.1:4173'}, {...config,port:4174},
    {...config,port:'4173'}, {...config,listenAddress:'0.0.0.0'},
    {...config,preview:{...config.preview,user:'container-root'}},
    {...config,preview:{...config.preview,user:'DEPT\\alice\r\nInjected: true'}},
    {...config,preview:{...config.preview,user:'DEPT\\中文'}},
    {...config,preview:{...config.preview,sourceDirectory:''}},
    {...config,preview:{...config.preview,createdAt:'not-a-date'}},
  ])assert.throws(()=>validateRuntime(invalid));
});

test('legacy preview port is accepted only for controlled stop or migration',()=>{
  const legacy={...configuration(),publicOrigin:'http://127.0.0.1:4174',port:4174};
  assert.throws(()=>validateRuntime(legacy));
  assert.equal(validateRuntime(legacy,{allowLegacyPreview:true}),legacy);
  assert.throws(()=>validatePreviewConfig(legacy));
});

test('preview streams requests through the authenticated portal and replaces all browser identity headers',async t=>{
  const f=await fixture(t);
  const page=await request(f.port);assert.equal(page.status,200);assert.equal(page.body,'unchanged portal page');
  const forged={Host:'127.0.0.1:4173',Origin:LOCAL_PREVIEW_ORIGIN,'Sec-Fetch-Site':'same-origin','Content-Type':'application/json','X-PlanHub-Key':'forged','X-PlanHub-User':'DEPT\\mallory','X-Config-User':'forged','X-Config-Proxy-Key':'forged','X-SOP-User':'forged','X-SOP-Proxy-Key':'forged','X-Forwarded-User':'forged',Forwarded:'for=attacker'};
  const body=JSON.stringify({text:'preserve original bytes 汉字',quantity:12});
  const result=await request(f.port,{method:'POST',url:'/vehicle-config/api/anything/nested?value=one%20two',headers:forged,body});
  assert.equal(result.status,201);assert.equal(JSON.parse(result.body).actor,'DEPT\\alice');
  const call=f.calls.at(-1);assert.equal(call.method,'POST');assert.equal(call.path,'/api/anything/nested?value=one%20two');assert.equal(call.body,body);
  assert.equal(call.headers.host,'127.0.0.1:4173');assert.equal(call.headers.origin,LOCAL_PREVIEW_ORIGIN);
  assert.equal(call.headers['x-config-user'],'DEPT\\alice');assert.equal(call.headers['x-config-proxy-key'],f.config.vehicleSecret);
  for(const header of ['x-planhub-key','x-planhub-user','x-sop-user','x-sop-proxy-key','x-forwarded-user','forwarded'])assert.equal(call.headers[header],undefined);
  for(const header of ['x-planhub-key','x-config-proxy-key','x-sop-proxy-key'])assert.equal(result.headers[header],undefined);
  assert.equal(result.headers['x-frame-options'],'SAMEORIGIN');
  assert.ok(!JSON.stringify(result).includes(f.config.proxySecret));assert.ok(!JSON.stringify(result).includes(f.config.vehicleSecret));
  await request(f.port,{url:'/sop/api/session',headers:forged});
  assert.equal(f.calls.at(-1).path,'/sop/api/session');assert.equal(f.calls.at(-1).headers['x-sop-proxy-key'],f.config.sopSecret);assert.equal(f.calls.at(-1).headers['x-sop-user'],'b64:'+Buffer.from('DEPT\\alice').toString('base64'));
});

test('preview rejects wrong Host, Origin, cross-site requests and duplicate routing headers before forwarding',async t=>{
  const f=await fixture(t),headers={Host:'127.0.0.1:4173'};
  for(const invalid of [
    {...headers,Host:'localhost:4173'}, {...headers,Host:'127.0.0.1:4174'},
    {...headers,Host:'attacker.internal'}, {...headers,Origin:'https://attacker.internal'},
    {...headers,Origin:'null'}, {...headers,Origin:'http://127.0.0.1:4175'},
    {...headers,'Sec-Fetch-Site':'cross-site'}, {...headers,'Sec-Fetch-Site':'cross-site, same-origin'},
    ['Host','127.0.0.1:4173','Host','127.0.0.1:4173'],
    ['Host','127.0.0.1:4173','Origin',LOCAL_PREVIEW_ORIGIN,'Origin',LOCAL_PREVIEW_ORIGIN],
  ])assert.equal((await request(f.port,{url:'/vehicle-config/healthz',headers:invalid})).status,403);
  assert.equal((await request(f.port,{url:'//attacker.internal/vehicle-config/healthz'})).status,403);
  assert.equal(f.calls.length,0);
});

test('the inner portal still requires authenticated headers, and a formal portal remains unchanged',async t=>{
  const f=await fixture(t),inner=f.authenticated.address().port;
  assert.equal((await request(inner)).status,403);
  assert.equal((await request(inner,{headers:{Host:'127.0.0.1:4173','X-PlanHub-Key':'forged','X-PlanHub-User':'DEPT\\mallory'}})).status,403);
  const formal={...f.config};delete formal.preview;
  const server=createContainerPortal(f.directory,{},formal);const port=await listen(server);t.after(()=>close(server));
  assert.equal((await request(port)).status,403);
  assert.equal((await request(port,{headers:{Host:'127.0.0.1:4173','X-PlanHub-Key':formal.proxySecret,'X-PlanHub-User':'DEPT\\alice'}})).status,200);
});

test('closing preview closes its private authenticated listener; failed outer startup leaves no inner listener',async t=>{
  const f=await fixture(t),inner=f.authenticated.address().port;
  await close(f.gateway);assert.equal(f.authenticated.address(),null);
  const blocked=http.createServer((_req,res)=>res.end());const port=await listen(blocked);t.after(()=>close(blocked));
  const portal=createContainerPortal(f.directory,{},f.config);
  await assert.rejects(startLocalPreviewPortal(portal,f.config,{port,host:'127.0.0.1'}),/EADDRINUSE/);
  assert.equal(portal.address(),null);
  const closed=await new Promise(resolve=>{const socket=net.connect({host:'127.0.0.1',port:inner});socket.once('error',()=>resolve(true));socket.once('connect',()=>{socket.destroy();resolve(false);});});
  assert.equal(closed,true,'Private listener remained open');
});
