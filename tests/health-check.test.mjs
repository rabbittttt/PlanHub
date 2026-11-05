import test from 'node:test';
import assert from 'node:assert/strict';
import {probeServiceHealth} from '../scripts/health-check.mjs';
const jsonProbe={target:'http://127.0.0.1:8765',healthPath:'/api/catalog',healthKeys:['tables','status']};
const pageProbe={...jsonProbe,healthPath:'/',healthKeys:[],healthText:'<title>数据速查</title>',healthTimeoutMs:5000};

test('lightweight page identity succeeds while a scanning catalog exceeds its deadline',async()=>{
 const fetcher=async(url,{signal})=>{
  if(new URL(url).pathname==='/')return new Response('<title>数据速查</title>');
  return new Promise((resolve,reject)=>{const active=setTimeout(()=>resolve(new Response('{}')),3000);signal.addEventListener('abort',()=>{clearTimeout(active);reject(signal.reason);},{once:true});});
 };
 const slow=await probeServiceHealth({...jsonProbe,healthTimeoutMs:1000},{fetcher});assert.equal(slow.reason,'TIMEOUT');
 assert.deepEqual(await probeServiceHealth(pageProbe,{fetcher}),{ok:true,status:200});
});

test('wrong HTML identity, HTTP failure and legacy JSON probes remain distinguishable',async()=>{
 assert.equal((await probeServiceHealth(pageProbe,{fetcher:async()=>new Response('<title>Other service</title>')})).reason,'SERVICE_IDENTITY_MISMATCH');
 assert.equal((await probeServiceHealth(pageProbe,{fetcher:async()=>new Response('not-ready',{status:503})})).status,503);
 assert.deepEqual(await probeServiceHealth(jsonProbe,{fetcher:async()=>new Response(JSON.stringify({tables:[],status:{}}))}),{ok:true,status:200});
 assert.equal((await probeServiceHealth(jsonProbe,{fetcher:async()=>new Response('{}')})).reason,'MISSING_HEALTH_KEYS');
 assert.equal((await probeServiceHealth(jsonProbe,{fetcher:async()=>new Response('<html>wrong format</html>')})).reason,'NOT_JSON');
});
