import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,realpath} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {localPreviewArgs} from '../scripts/start-local.mjs';
import {configureSopRules} from '../scripts/configure-sop-rules.mjs';
import {resolvePreviewSettings,runPreview} from '../scripts/dev-sop.mjs';
import {resolveSopPython} from '../scripts/sop-python.mjs';
import {fileURLToPath} from 'node:url';

async function source(directory,{gateway=true}={}) {
  await mkdir(path.join(directory,'web'),{recursive:true});
  await writeFile(path.join(directory,'server.py'),'# independent SOP fixture\n');
  if(gateway) {
    await mkdir(path.join(directory,'sop'),{recursive:true});
    await writeFile(path.join(directory,'sop','__init__.py'),'');
    await writeFile(path.join(directory,'sop','gateway.py'),'# gateway fixture\n');
  }
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
  const original=await source(path.join(base,'SOP维护'));
  await data(original,'original');
  const rules=path.join(base,'订单分析','scripts','config','shared_config.py');
  await mkdir(path.dirname(rules),{recursive:true});await writeFile(rules,'MERGE_GROUPS = {}\n');
  const seed=await data(path.join(base,'separate-data'),'seed');
  const settings=await resolvePreviewSettings(['--snapshot','--seed-from',seed],{root,env:{},requireData:true});
  assert.equal(settings.sourceRoot,original);
  assert.equal(settings.dataRoot,seed);
  assert.equal(settings.sharedConfig,rules);
  const forwarded=await localPreviewArgs(['--snapshot','--seed-from',seed],root,{});
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

test('relative CLI paths and the default template resolve against the portal root',async t=>{
  const {base,root}=await fixture(t);
  const original=await source(path.join(base,'SOP维护'));await data(original);
  const seed=await data(path.join(base,'historical-data'));
  const rules=path.join(base,'订单分析','scripts','config','shared_config.py');
  await mkdir(path.dirname(rules),{recursive:true});await writeFile(rules,'MERGE_GROUPS = {}\n');
  const shared=path.join(base,'共享数据','订单汇总');await mkdir(shared,{recursive:true});
  // The test process cwd is outside this disposable portal tree.
  assert.notEqual(path.resolve(process.cwd()),root);
  const settings=await resolvePreviewSettings(['--sop-source','../SOP维护','--snapshot','--seed-from','../historical-data',
    '--shared-config','../订单分析/scripts/config/shared_config.py'],{root,env:{},requireData:true});
  assert.equal(settings.sourceRoot,original);assert.equal(settings.dataRoot,seed);assert.equal(settings.sharedConfig,rules);
  await mkdir(path.join(root,'config.local'));
  await writeFile(path.join(root,'config.local','sop.json'),await readFile(new URL('../integration/sop.example.json',import.meta.url)));
  const defaults=await resolvePreviewSettings([],{root,env:{},requireData:true});
  assert.equal(defaults.dataRootExplicit,false);assert.equal(defaults.salesSourceDir,shared);
  assert.equal(defaults.planSourceFile,path.join(base,'共享数据','SOP计划','SOP计划维护.xlsx'));
});

test('missing gateway and the removed portal copy are rejected instead of silently selecting other code',async t=>{
  const {base,root}=await fixture(t);
  const unadapted=await source(path.join(base,'unadapted'),{gateway:false});
  await assert.rejects(resolvePreviewSettings(['--sop-source',unadapted],{root,env:{}}),/gateway 适配/);
  const legacy=await source(path.join(root,'services','sop'));
  await assert.rejects(resolvePreviewSettings(['--sop-source',legacy],{root,env:{}}),/不再支持门户 services\/sop/);
});

test('shared sales inputs are selected independently from project state without stale fallback',async t=>{
  const {base,root}=await fixture(t);
  const original=await source(path.join(base,'SOP维护'));
  await data(original);
  const rules=path.join(base,'rules.py');await writeFile(rules,'MERGE_GROUPS = {}\n');
  const args=['--shared-config',rules];
  const resolve=env=>resolvePreviewSettings(args,{root,env,requireData:true});
  assert.equal((await resolve({})).salesSourceDir,path.join(original,'input_file'));
  const shared=path.join(base,'共享数据');await mkdir(shared);
  await assert.rejects(resolve({}),/SOP 销售来源目录不存在/);
  const orders=path.join(shared,'订单汇总');await mkdir(orders);
  assert.equal((await resolve({})).salesSourceDir,orders);
  const customShared=path.join(base,'custom-shared');
  await assert.rejects(resolve({SHARED_DATA_ROOT:customShared}),/SOP 销售来源目录不存在/);
  await mkdir(path.join(customShared,'订单汇总'),{recursive:true});
  assert.equal((await resolve({SHARED_DATA_ROOT:customShared})).salesSourceDir,path.join(customShared,'订单汇总'));
  const explicit=path.join(base,'explicit-sales');await mkdir(explicit);
  assert.equal((await resolve({SHARED_DATA_ROOT:customShared,SOP_SOURCE_DIR:explicit})).salesSourceDir,explicit);
});

test('explicit seed and local dataRoot keep their sales inputs when default shared inputs coexist',async t=>{
  const {base,root}=await fixture(t);
  const original=await source(path.join(base,'SOP维护'));await data(original);
  const seed=await data(path.join(base,'historical-data'));
  const shared=path.join(base,'共享数据');const orders=path.join(shared,'订单汇总');
  await mkdir(orders,{recursive:true});
  const rules=path.join(base,'rules.py');await writeFile(rules,'MERGE_GROUPS = {}\n');
  const args=['--shared-config',rules];
  const resolve=(values,env={})=>resolvePreviewSettings(values,{root,env,requireData:true});
  const defaultArgs=await localPreviewArgs(args,root,{});
  assert.equal(defaultArgs.includes('--seed-from'),false);
  assert.equal((await resolve(defaultArgs)).salesSourceDir,orders);
  assert.equal((await resolve(defaultArgs)).planSourceFile,path.join(shared,'SOP计划','SOP计划维护.xlsx'));
  const seedArgs=[...args,'--snapshot','--seed-from',seed];
  assert.equal((await resolve(seedArgs)).salesSourceDir,path.join(seed,'input_file'));
  assert.equal((await resolve(seedArgs)).planSourceFile,path.join(seed,'input_file','SOP计划维护.xlsx'));
  const forwarded=await localPreviewArgs(seedArgs,root,{});
  assert.equal((await resolve(forwarded)).salesSourceDir,path.join(seed,'input_file'));
  assert.equal((await resolve(seedArgs,{SHARED_DATA_ROOT:shared})).salesSourceDir,orders);
  assert.equal((await resolve(seedArgs,{SHARED_DATA_ROOT:shared})).planSourceFile,path.join(seed,'input_file','SOP计划维护.xlsx'));
  const explicit=path.join(base,'explicit-input');await mkdir(explicit);
  assert.equal((await resolve(seedArgs,{SHARED_DATA_ROOT:shared,SOP_SOURCE_DIR:explicit})).salesSourceDir,explicit);
  assert.equal((await resolve(seedArgs,{SOP_PLAN_DIR:explicit})).planSourceFile,path.join(explicit,'SOP计划维护.xlsx'));
  await mkdir(path.join(root,'config.local'));
  await writeFile(path.join(root,'config.local','sop.json'),JSON.stringify({dataRoot:seed}));
  assert.equal((await resolve(args)).salesSourceDir,path.join(seed,'input_file'));
  const configuredArgs=await localPreviewArgs(args,root,{});
  assert.equal((await resolve(configuredArgs)).salesSourceDir,path.join(seed,'input_file'));
  assert.equal((await resolve(configuredArgs)).planSourceFile,path.join(seed,'input_file','SOP计划维护.xlsx'));
});

async function freePort() {
  const server=net.createServer();
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port=server.address().port;
  await new Promise(resolve=>server.close(resolve));
  return port;
}

test('preview executes independent source with a separate writable snapshot without mutating source data',async t=>{
  const projectRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
  let python;
  try {python=resolveSopPython({root:projectRoot,sourceRoot:path.resolve(projectRoot,'..','SOP维护')});}
  catch(error){t.skip(`Python with SOP dependencies is required: ${error.message}`);return;}
  const {base,root}=await fixture(t);
  const original=await source(path.join(base,'original-source'));
  await data(original,'code-project-data-must-not-be-used');
  const seed=await data(path.join(base,'seed-only-project'),'selected-seed');
  const seedDb=path.join(seed,'data','sop.sqlite3');
  const prepared=spawnSync(python,['-B','-c',"import sqlite3,sys; db=sqlite3.connect(sys.argv[1]); db.execute('CREATE TABLE marker (value TEXT)'); db.execute(\"INSERT INTO marker VALUES ('original-db')\"); db.commit(); db.close()",seedDb],{encoding:'utf8'});
  assert.equal(prepared.status,0,prepared.stderr||prepared.error?.message);
  const seedDbBefore=await readFile(seedDb);
  const shared=path.join(base,'共享数据','订单汇总');await mkdir(shared,{recursive:true});
  const sharedPlan=path.join(base,'共享数据','SOP计划','SOP计划维护.xlsx');
  await mkdir(path.dirname(sharedPlan));await writeFile(sharedPlan,'formal shared plan');
  await writeFile(path.join(shared,'current-sales.xlsx'),'shared sales');
  await writeFile(path.join(shared,'SOP计划维护.xlsx'),'shared plan must not be used');
  await writeFile(path.join(seed,'input_file','old-sales.xlsx'),'stale local sales');
  await writeFile(path.join(seed,'input_file','SOP计划维护.xlsx'),'selected project plan');
  const rules=path.join(base,'business-rules.py');await writeFile(rules,'MERGE_GROUPS = {}\n');
  const serverFile=path.join(original,'server.py');
  await writeFile(serverFile,`import argparse,base64,json,os,sys
from pathlib import Path
from http.server import BaseHTTPRequestHandler,HTTPServer
p=argparse.ArgumentParser();p.add_argument('--port',type=int);p.add_argument('--gateway-config');a=p.parse_args()
config=json.loads(Path(a.gateway_config).read_text(encoding='utf-8'))
class Handler(BaseHTTPRequestHandler):
 probe_identity=None
 def log_message(self,*args):pass
 def send(self,status,body):
  raw=json.dumps(body).encode();self.send_response(status);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(raw)));self.end_headers();self.wfile.write(raw)
 def do_GET(self):
  if self.headers.get('X-SOP-Proxy-Key')!=os.environ[config['proxy_secret_env']]:return self.send(403,{'error':'key'})
  if self.path=='/sop/api/session':
   header=self.headers.get('X-SOP-User','')
   if not header.startswith('b64:'):return self.send(400,{'error':'expected encoded identity'})
   identity=base64.b64decode(header[4:],validate=True).decode('utf-8')
   if Handler.probe_identity is None:Handler.probe_identity=identity
   if Handler.probe_identity!=identity:return self.send(400,{'error':'identity changed after readiness probe'})
   return self.send(200,{'mode':'gateway','user':identity,'canWrite':config['allow_writes']})
  return self.send(200,{'codeRoot':str(Path(__file__).parent),'cwd':os.getcwd(),'executable':sys.executable,'configuredPython':os.environ.get('SOP_PYTHON_PATH'),'pathFirst':os.environ['PATH'].split(os.pathsep)[0],'virtualEnv':os.environ.get('VIRTUAL_ENV'),'sourceData':json.loads((Path(config['data_dir'])/'sales.json').read_text()),'dataPath':config['data_dir'],'inputPath':config['source_dir'],'planPath':config['plan_file'],'readonly':not config['allow_writes'],'bytecodeDisabled':os.environ.get('PYTHONDONTWRITEBYTECODE')=='1'})
 def do_POST(self):
  if not config['allow_writes']:return self.send(403,{'error':'paused'})
  (Path(config['data_dir'])/'sales.json').write_text(json.dumps({'marker':'preview-edit'}))
  self.send(200,{'ok':True})
HTTPServer(('127.0.0.1',a.port),Handler).serve_forever()
`);
  const sourceBefore=await readFile(serverFile);
  const seedBefore=await readFile(path.join(seed,'data','sales.json'));
  const port=await freePort();let backendPort=await freePort();while(backendPort===port)backendPort=await freePort();
  const server=await runPreview(['--sop-source',original,'--snapshot','--seed-from',seed,'--shared-config',rules,'--port',String(port),'--backend-port',String(backendPort)],{root,env:{SOP_PYTHON_PATH:python,SOP_PYTHON:'obsolete-python-command',SHARED_DATA_ROOT:path.dirname(shared)}});
  try {
    const sessionResponse=await fetch(`http://127.0.0.1:${port}/sop/api/session`,{headers:{'X-SOP-User':'FORGED\\browser'}});
    assert.equal(sessionResponse.status,200);
    const session=await sessionResponse.json();
    assert.match(session.user,/^[^\\@]+\\[^\\@]+$/u);
    assert.notEqual(session.user,'DEV\\local-preview');
    assert.notEqual(session.user,'FORGED\\browser');
    const result=await fetch(`http://127.0.0.1:${port}/sop/api/provenance`).then(r=>r.json());
    assert.equal(result.codeRoot,original);assert.equal(result.cwd,original);
    assert.equal(path.normalize(result.executable),python);assert.equal(result.configuredPython,python);
    assert.equal(path.normalize(result.pathFirst),path.dirname(python));
    const expectedEnvironment=path.dirname(path.dirname(python));
    assert.equal(result.virtualEnv,existsSync(path.join(expectedEnvironment,'pyvenv.cfg'))?expectedEnvironment:null);
    assert.equal(result.sourceData.marker,'selected-seed');
    const snapshot=spawnSync(python,['-B','-c',"import json,pathlib,sqlite3,sys; db=sqlite3.connect(pathlib.Path(sys.argv[1]).as_uri()+'?mode=ro',uri=True); print(json.dumps(db.execute('SELECT value FROM marker').fetchall())); db.close()",path.join(result.dataPath,'sop.sqlite3')],{encoding:'utf8'});
    assert.equal(snapshot.status,0,snapshot.stderr||snapshot.error?.message);
    assert.deepEqual(JSON.parse(snapshot.stdout),[['original-db']]);
    assert.ok(result.dataPath.startsWith(path.join(root,'artifacts')));
    assert.ok(result.inputPath.startsWith(path.join(root,'artifacts')));
    assert.equal(await readFile(path.join(result.inputPath,'current-sales.xlsx'),'utf8'),'shared sales');
    await assert.rejects(readFile(path.join(result.inputPath,'old-sales.xlsx')),error=>error.code==='ENOENT');
    assert.equal(await readFile(result.planPath,'utf8'),'selected project plan');
    await writeFile(path.join(result.inputPath,'current-sales.xlsx'),'snapshot sales edit');
    await writeFile(result.planPath,'snapshot plan edit');
    assert.equal(result.readonly,false);assert.equal(result.bytecodeDisabled,true);
    const saved=await fetch(`http://127.0.0.1:${port}/sop/api/plans`,{method:'POST',headers:{'Content-Type':'application/json',Origin:`http://127.0.0.1:${port}`},body:'{}'});
    assert.equal(saved.status,200);await saved.text();
    assert.equal(JSON.parse(await readFile(path.join(result.dataPath,'sales.json'),'utf8')).marker,'preview-edit');
  } finally {await new Promise(resolve=>server.close(resolve));}
  const defaultPort=await freePort();let defaultBackend=await freePort();while(defaultBackend===defaultPort)defaultBackend=await freePort();
  const defaultServer=await runPreview(['--snapshot','--sop-source',original,'--shared-config',rules,'--port',String(defaultPort),'--backend-port',String(defaultBackend)],{root,env:{SOP_PYTHON_PATH:python},requireData:true});
  try {
    const result=await fetch(`http://127.0.0.1:${defaultPort}/sop/api/provenance`).then(r=>r.json());
    assert.ok(result.planPath.startsWith(path.join(root,'artifacts')));
    assert.equal(await readFile(result.planPath,'utf8'),'formal shared plan');
    await writeFile(result.planPath,'edit only the default preview snapshot');
  } finally {await new Promise(resolve=>defaultServer.close(resolve));}
  assert.deepEqual(await readFile(serverFile),sourceBefore);
  assert.deepEqual(await readFile(path.join(seed,'data','sales.json')),seedBefore);
  assert.deepEqual(await readFile(seedDb),seedDbBefore);
  assert.equal(await readFile(path.join(shared,'current-sales.xlsx'),'utf8'),'shared sales');
  assert.equal(await readFile(path.join(shared,'SOP计划维护.xlsx'),'utf8'),'shared plan must not be used');
  assert.equal(await readFile(path.join(seed,'input_file','SOP计划维护.xlsx'),'utf8'),'selected project plan');
  assert.equal(await readFile(sharedPlan,'utf8'),'formal shared plan');
});


test('missing private shared rules explain the Git omission and the available configuration entry', async t => {
  const {base, root} = await fixture(t);
  const original = await source(path.join(base, 'SOP维护'));
  await data(original);
  await assert.rejects(resolvePreviewSettings([], {root, env: {}}), error => {
    assert.match(error.message, /共享业务规则不存在/);
    assert.match(error.message, /\nSOP 需要/);
    assert.match(error.message, /不随 Git 下载/);
    assert.match(error.message, /配置SOP规则\.bat/);
    assert.match(error.message, /--shared-config/);
    return true;
  });
});

test('SOP rules configuration preserves existing settings and rule bytes and keeps explicit precedence', async t => {
  const {base, root} = await fixture(t);
  const original = await source(path.join(base, 'SOP维护'));
  await data(original);
  const rules = path.join(base, '共享数据', '业务规则', 'shared_config.py');
  const content = 'MERGE_GROUPS = {"fixture": ["member"]}\n';
  await mkdir(path.dirname(rules), {recursive: true});
  await writeFile(rules, content);
  await mkdir(path.join(root, 'config.local'));
  const configFile = path.join(root, 'config.local', 'sop.json');
  const before = JSON.stringify({sourceRoot: '../SOP维护', dataRoot: '../SOP维护', sharedConfig: '../old-rules.py'});
  await writeFile(configFile, before);
  const result = await configureSopRules(root, rules);
  const configured = JSON.parse(await readFile(configFile, 'utf8'));
  assert.equal(configured.sharedConfig, '../共享数据/业务规则/shared_config.py');
  assert.equal(configured.sourceRoot, '../SOP维护');
  assert.equal(configured.dataRoot, '../SOP维护');
  assert.equal(await readFile(result.backup, 'utf8'), before);
  assert.equal(await readFile(rules, 'utf8'), content);
  assert.equal((await resolvePreviewSettings([], {root, env: {}})).sharedConfig, rules);
  const second = await configureSopRules(root, rules);
  assert.equal(second.backup, null, 'Selecting the same path must be idempotent');
  const activeConfig = await readFile(configFile, 'utf8');
  await assert.rejects(configureSopRules(root, path.join(base, 'absent-rules.py')), {code: 'ENOENT'});
  assert.equal(await readFile(configFile, 'utf8'), activeConfig);
  const missingExplicit = path.join(base, 'explicit-but-missing.py');
  await assert.rejects(resolvePreviewSettings(['--shared-config', missingExplicit], {root, env: {}}), /explicit-but-missing\.py/);
  await assert.rejects(resolvePreviewSettings([], {root, env: {SOP_SHARED_CONFIG: missingExplicit}}), /explicit-but-missing\.py/);
  await writeFile(configFile, '{ malformed');
  await assert.rejects(configureSopRules(root, rules), SyntaxError);
  assert.equal(await readFile(configFile, 'utf8'), '{ malformed');
  assert.equal(await readFile(rules, 'utf8'), content);
});
