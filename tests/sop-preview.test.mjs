import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createServer} from '../scripts/dev-server.mjs';

async function listen(server) { await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve)); return server.address().port; }
async function close(server) { await new Promise(resolve=>server.close(resolve)); }
test('opt-in SOP preview preserves prefix and replaces untrusted proxy identity on POST',async()=>{
  const secret='local-preview-key-'.repeat(3);
  const account='测试域\\计划员';
  const user='b64:'+Buffer.from(account,'utf8').toString('base64');
  let observed;
  const backend=http.createServer(async(req,res)=>{
    let body='';for await(const chunk of req)body+=chunk;
    observed={url:req.url,method:req.method,headers:req.headers,body};
    res.writeHead(200,{'Content-Type':'application/json'});res.end('{"ok":true}');
  });
  const backendPort=await listen(backend);
  const proxy=createServer({sopProxy:{port:backendPort,secret,user}});
  const proxyPort=await listen(proxy);
  try{
    const res=await fetch(`http://127.0.0.1:${proxyPort}/sop/api/plans?q=1`,{method:'POST',headers:{'Content-Type':'application/json','X-SOP-User':'forged','X-SOP-Proxy-Key':'forged','X-SOP-Admin':'yes'},body:'{}'});
    assert.equal(res.status,200);await res.text();
    assert.equal(observed.url,'/sop/api/plans?q=1');assert.equal(observed.method,'POST');
    assert.equal(observed.headers['x-sop-user'],user);assert.equal(observed.headers['x-sop-proxy-key'],secret);
    assert.equal(observed.headers['x-sop-admin'],undefined);assert.equal(observed.body,'{}');
    assert.equal((await fetch(`http://127.0.0.1:${proxyPort}/api/plans`)).status,404);
    assert.equal((await fetch(`http://127.0.0.1:${proxyPort}/sop`,{redirect:'manual'})).status,308);
  }finally{await close(proxy);await close(backend);}
});
