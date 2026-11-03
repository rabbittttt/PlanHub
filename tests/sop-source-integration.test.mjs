import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,realpath} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {localPreviewArgs} from '../scripts/start-local.mjs';
import {resolvePreviewSettings,runPreview} from '../scripts/dev-sop.mjs';

async function source(directory,{gateway=true}={}) {
  await mkdir(path.join(directory,'web'),{recursive:true});
  await writeFile(path.join(directory,'server.py'),'# independent SOP fixture\n');
  if(gateway)await writeFile(path.join(directory,'sop_gateway.py'),'# gateway fixture\n');
  await writeFile(path.join(directory,'web','index.html'),'external SOP');
  return directory;
}

async function data(directory,marker='fixture') {
  await mkdir(path.join(directory,'data'),{recursive:true});
  await mkdir(path.join(directory,'input_file'),{recursive:true});
  await writeFile(path.join(directory,'data','sales.json'),JSON.stringify({marker,meta:{},products:[],sales:[]}));
  return directory;
}

async function fixture(t) {
  const tempRoot=await realpath(os.tmpdir());
  const base=await realpath(await mkdtemp(path.join(os.tmpdir(),'portal-single-sop-')));
  t.after(async()=>{
    const resolved=await realpath(base);
    assert.equal(path.dirname(resolved),tempRoot,'Fixture cleanup must stay directly in the system temp directory');
    assert.ok(path.basename(resolved).startsWith('portal-single-sop-'),'Unexpected fixture cleanup target');
    await rm(resolved,{recursive:true,force:true});
  });
  const root=path.join(base,'portal');
  await mkdir(root);
  return {base,root};
}

test('the original sibling project is the default source and seed-from changes only data',async t=>{
  const {base,root}=await fixture(t);
  const original=await source(path.join(base,'PythonProject','计划看板'));
  await data(original,'original');
  const rules=path.join(base,'PythonProject','订单分析','scripts','config','shared_config.py');
  await mkdir(path.dirname(rules),{recursive:true});await writeFile(rules,'MERGE_GROUPS = {}\n');
  const seed=await data(path.join(base,'separate-data'),'seed');
  const settings=await resolvePreviewSettings(['--seed-from',seed],{root,env:{},requireData:true});
  assert.equal(settings.sourceRoot,original);
  assert.equal(settings.dataRoot,seed);
  assert.equal(settings.sharedConfig,rules);
  const forwarded=await localPreviewArgs(['--seed-from',seed],root,{});
  assert.equal(forwarded[forwarded.indexOf('--sop-source')+1],original);
  assert.equal(forwarded[forwarded.indexOf('--seed-from')+1],seed);
});

test('source configuration precedence is explicit CLI, environment, local config, then default',async t=>{
  const {base,root}=await fixture(t);
  const configured=await source(path.join(base,'configured-source'));
  const environment=await source(path.join(base,'environment-source'));
  const explicit=await source(path.join(base,'explicit-source'));
  const seed=await data(path.join(base,'independent-data'));
  const rules=path.join(base,'configured-rules.py');await writeFile(rules,'MERGE_GROUPS = {}\n');
  const envRules=path.join(base,'environment-rules.py');await writeFile(envRules,'MERGE_GROUPS = {}\n');
  const explicitRules=path.join(base,'explicit-rules.py');await writeFile(explicitRules,'MERGE_GROUPS = {}\n');
  await mkdir(path.join(root,'config.local'));
  await writeFile(path.join(root,'config.local','sop.json'),JSON.stringify({sourceRoot:configured,dataRoot:seed,sharedConfig:rules}));
  assert.equal((await resolvePreviewSettings([],{root,env:{}})).sourceRoot,configured);
  const env={SOP_SOURCE_ROOT:environment,SOP_SHARED_CONFIG:envRules};
  const envConfig=await resolvePreviewSettings([],{root,env});
  assert.equal(envConfig.sourceRoot,environment);assert.equal(envConfig.sharedConfig,envRules);
  const explicitConfig=await resolvePreviewSettings(['--sop-source',explicit,'--shared-config',explicitRules],{root,env});
  assert.equal(explicitConfig.sourceRoot,explicit);assert.equal(explicitConfig.sharedConfig,explicitRules);
  assert.equal(explicitConfig.dataRoot,seed);
});

test('missing gateway and the removed portal copy are rejected instead of silently selecting other code',async t=>{
  const {base,root}=await fixture(t);
  const unadapted=await source(path.join(base,'unadapted'),{gateway:false});
  await assert.rejects(resolvePreviewSettings(['--sop-source',unadapted],{root,env:{}}),/gateway 适配/);
  const legacy=await source(path.join(root,'services','sop'));
  await assert.rejects(resolvePreviewSettings(['--sop-source',legacy],{root,env:{}}),/不再支持门户 services\/sop/);
});

async function freePort() {
  const server=net.createServer();
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port=server.address().port;
  await new Promise(resolve=>server.close(resolve));
  return port;
}

test('preview executes independent source with a separate writable snapshot without mutating source data',async t=>{
  const python=process.env.SOP_PYTHON||'python';
  if(spawnSync(python,['--version'],{encoding:'utf8'}).status!==0){t.skip('Python is required for the external-service integration test');return;}
  const {base,root}=await fixture(t);
  const original=await source(path.join(base,'original-source'));
  await data(original,'code-project-data-must-not-be-used');
  const seed=await data(path.join(base,'seed-only-project'),'selected-seed');
  const rules=path.join(base,'business-rules.py');await writeFile(rules,'MERGE_GROUPS = {}\n');
  const serverFile=path.join(original,'server.py');
  await writeFile(serverFile,`import argparse,json,os
from pathlib import Path
from http.server import BaseHTTPRequestHandler,HTTPServer
p=argparse.ArgumentParser();p.add_argument('--port',type=int);p.add_argument('--gateway-config');a=p.parse_args()
config=json.loads(Path(a.gateway_config).read_text(encoding='utf-8'))
class Handler(BaseHTTPRequestHandler):
 def log_message(self,*args):pass
 def send(self,status,body):
  raw=json.dumps(body).encode();self.send_response(status);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(raw)));self.end_headers();self.wfile.write(raw)
 def do_GET(self):
  if self.headers.get('X-SOP-Proxy-Key')!=os.environ[config['proxy_secret_env']]:return self.send(403,{'error':'key'})
  if self.path=='/sop/api/session':return self.send(200,{'mode':'gateway','user':self.headers.get('X-SOP-User'),'canWrite':config['allow_writes']})
  return self.send(200,{'codeRoot':str(Path(__file__).parent),'cwd':os.getcwd(),'sourceData':json.loads((Path(config['data_dir'])/'sales.json').read_text()),'dataPath':config['data_dir'],'readonly':not config['allow_writes'],'bytecodeDisabled':os.environ.get('PYTHONDONTWRITEBYTECODE')=='1'})
 def do_POST(self):
  if not config['allow_writes']:return self.send(403,{'error':'paused'})
  (Path(config['data_dir'])/'sales.json').write_text(json.dumps({'marker':'preview-edit'}))
  self.send(200,{'ok':True})
HTTPServer(('127.0.0.1',a.port),Handler).serve_forever()
`);
  const sourceBefore=await readFile(serverFile);
  const seedBefore=await readFile(path.join(seed,'data','sales.json'));
  const port=await freePort();let backendPort=await freePort();while(backendPort===port)backendPort=await freePort();
  const server=await runPreview(['--sop-source',original,'--seed-from',seed,'--shared-config',rules,'--port',String(port),'--backend-port',String(backendPort)],{root,env:{SOP_PYTHON:python}});
  try {
    const result=await fetch(`http://127.0.0.1:${port}/sop/api/provenance`).then(r=>r.json());
    assert.equal(result.codeRoot,original);assert.equal(result.cwd,original);
    assert.equal(result.sourceData.marker,'selected-seed');
    assert.ok(result.dataPath.startsWith(path.join(root,'artifacts')));
    assert.equal(result.readonly,false);assert.equal(result.bytecodeDisabled,true);
    const saved=await fetch(`http://127.0.0.1:${port}/sop/api/plans`,{method:'POST',headers:{'Content-Type':'application/json',Origin:`http://127.0.0.1:${port}`},body:'{}'});
    assert.equal(saved.status,200);await saved.text();
    assert.equal(JSON.parse(await readFile(path.join(result.dataPath,'sales.json'),'utf8')).marker,'preview-edit');
  } finally {await new Promise(resolve=>server.close(resolve));}
  assert.deepEqual(await readFile(serverFile),sourceBefore);
  assert.deepEqual(await readFile(path.join(seed,'data','sales.json')),seedBefore);
});
