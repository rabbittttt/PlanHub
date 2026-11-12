import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rename,rm,lstat} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {planRegistration,applyRegistration} from '../scripts/register-app.mjs';
import {loadAppIntegrations} from '../scripts/app-integrations.mjs';
import {createServer} from '../scripts/dev-server.mjs';
const json=value=>JSON.stringify(value,null,2)+'\n';
async function fixture(t){
  const base=await mkdtemp(path.join(os.tmpdir(),'registration-test-'));
  t.after(()=>{assert.equal(path.dirname(base),os.tmpdir());return rm(base,{recursive:true,force:true});});
  const root=path.join(base,'workspace','portal');
  for(const name of ['portal/config','config.local','integration','deploy'])await mkdir(path.join(root,name),{recursive:true});
  const release=path.join(root,'../sample/dist');await mkdir(path.join(release,'assets'),{recursive:true});
  await writeFile(path.join(release,'report.html'),'<script src="./assets/app.js"></script>');
  await writeFile(path.join(release,'assets/app.js'),'window.report="unchanged";');
  await writeFile(path.join(root,'../runtime.exe'),'not executed');
  const registry={platform:{name:'test'},groups:[{id:'operations',name:'existing',apps:[{id:'old',name:'保留',url:'/old/',icon:'users',enabled:true,status:'pending',order:10}]}]};
  await writeFile(path.join(root,'portal/config/apps.json'),json(registry));
  await writeFile(path.join(root,'integration/apps.json'),json({applications:{}}));
  await writeFile(path.join(root,'config.local/apps.json'),json({applications:{old:{type:'static',root:'../old',entry:'index.html',publicPaths:['index.html']}}}));
  await writeFile(path.join(root,'deploy/config.example.json'),json({SiteName:'original',StaticApplications:[{Name:'old',Enabled:false}]}));
  return {base,root,release,registry};
}
const input={id:'sample',name:'测试网页',type:'static',root:'../sample/dist',entry:'report.html',publicPaths:['report.html','assets/']};
const dynamic={id:'sample',name:'动态网页',type:'proxy',port:9881,stripPrefix:true,healthPath:'/healthz',healthKeys:['ok'],start:{cwd:'../sample',command:'../runtime.exe',args:['server.py'],env:{PUBLIC_PREFIX:'/sample/'}}};
async function readJson(root,file){return JSON.parse(await readFile(path.join(root,file),'utf8'));}

test('one registration updates all three configs, retains unrelated entries and backs up originals',async t=>{
  const f=await fixture(t),before=await readFile(path.join(f.root,'portal/config/apps.json'),'utf8');
  const childBefore=await readFile(path.join(f.release,'report.html'));
  const plan=await planRegistration(f.root,input);
  assert.equal(await readFile(path.join(f.root,'portal/config/apps.json'),'utf8'),before,'planning is read-only');
  const result=await applyRegistration(plan);
  const registry=await readJson(f.root,'portal/config/apps.json');
  assert.deepEqual(registry.groups[0].apps[0],f.registry.groups[0].apps[0]);
  assert.equal(registry.groups[0].apps[1].status,'ready');
  const local=await readJson(f.root,'config.local/apps.json');
  assert.equal(local.applications.old.root,'../old');assert.equal(local.applications.sample.root,'../sample/dist');
  const deployment=await readJson(f.root,'deploy/config.local.json');
  assert.equal(deployment.SiteName,'original');assert.deepEqual(deployment.StaticApplications,[{Name:'old',Enabled:false},{Name:'sample',Enabled:true}]);
  assert.equal(await readFile(path.join(f.root,result.backup,'0.before.json'),'utf8'),before);
  assert.equal((await readJson(f.root,result.backup+'/transaction.json')).files[2].existed,false);
  assert.deepEqual(await readFile(path.join(f.release,'report.html')),childBefore);
  await assert.rejects(lstat(path.join(f.root,'config.local/register-app.lock')),/ENOENT/);
});

test('registered static page survives moving the workspace and serves original bytes only',async t=>{
  const f=await fixture(t);await applyRegistration(await planRegistration(f.root,input));
  const moved=path.join(f.base,'moved workspace');await rename(path.dirname(f.root),moved);
  const root=path.join(moved,'portal'),applications=await loadAppIntegrations(root);
  assert.equal(applications.sample.root,path.join(moved,'sample/dist'));
  const server=createServer({root,applications});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
  const origin='http://127.0.0.1:'+server.address().port;
  assert.equal(await(await fetch(origin+'/sample/')).text(),'<script src="./assets/app.js"></script>');
  assert.equal(await(await fetch(origin+'/sample/assets/app.js')).text(),'window.report="unchanged";');
  assert.equal((await fetch(origin+'/sample/private.xlsx')).status,404);
});

test('invalid and private static assets never alter the current configuration',async t=>{
  const f=await fixture(t),before=await readFile(path.join(f.root,'portal/config/apps.json'),'utf8');
  await writeFile(path.join(f.release,'private.xlsx'),'business data');
  for(const invalid of [{...input,entry:'../outside.html'},{...input,publicPaths:['report.html','private.xlsx']},{...input,publicPaths:['assets']},{...input,entry:'missing.html',publicPaths:['missing.html']},{...input,id:'api'}])await assert.rejects(planRegistration(f.root,invalid));
  assert.equal(await readFile(path.join(f.root,'portal/config/apps.json'),'utf8'),before);
  await assert.rejects(lstat(path.join(f.root,'deploy/config.local.json')),/ENOENT/);
});

test('updating a registered app requires explicit replace and removes obsolete static deployment',async t=>{
  const f=await fixture(t);await applyRegistration(await planRegistration(f.root,input));
  await assert.rejects(planRegistration(f.root,dynamic),/replace/);
  await applyRegistration(await planRegistration(f.root,{...dynamic,replace:true}));
  const registry=await readJson(f.root,'portal/config/apps.json');
  assert.equal(registry.groups[0].apps.filter(a=>a.id==='sample').length,1);
  assert.equal(registry.groups[0].apps.find(a=>a.id==='sample').status,'pending');
  assert.deepEqual((await readJson(f.root,'deploy/config.local.json')).StaticApplications,[{Name:'old',Enabled:false}]);
  const app=(await loadAppIntegrations(f.root)).sample;
  assert.equal(app.type,'proxy');assert.equal(app.target,'http://127.0.0.1:9881');assert.deepEqual(app.rootRoutes,[]);
  assert.equal(app.start.env.PUBLIC_PREFIX,'/sample/');
});

test('dynamic registration validates health path, arguments, env and conflicting ports without starting a process',async t=>{
  const f=await fixture(t);
  await applyRegistration(await planRegistration(f.root,dynamic));
  await assert.rejects(planRegistration(f.root,{...dynamic,id:'another'}),/端口/);
  for(const invalid of [{...dynamic,id:'other',port:0},{...dynamic,id:'other',port:9882,healthPath:'/../private'},{...dynamic,id:'other',port:9882,start:{...dynamic.start,args:'server.py'}},{...dynamic,id:'other',port:9882,start:{...dynamic.start,env:{PATH:55}}}])await assert.rejects(planRegistration(f.root,invalid));
});

test('concurrent configuration edits are preserved instead of overwritten',async t=>{
  const f=await fixture(t),plan=await planRegistration(f.root,input);
  const filename=path.join(f.root,'config.local/apps.json'),changed=json({applications:{},another:'concurrent edit'});
  await writeFile(filename,changed);
  await assert.rejects(applyRegistration(plan),/其他操作/);
  assert.equal(await readFile(filename,'utf8'),changed);
  assert.equal((await readJson(f.root,'portal/config/apps.json')).groups[0].apps.length,1);
  await assert.rejects(lstat(path.join(f.root,'config.local/register-app.lock')),/ENOENT/);
});

test('leads integration uses its unchanged standalone placeholder and orderiq stays dynamic',async()=>{
  const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
  const registry=await readJson(root,'portal/config/apps.json'),defaults=await readJson(root,'integration/apps.json');
  const leads=registry.groups.flatMap(g=>g.apps).find(a=>a.id==='leads');
  assert.equal(leads.name,'线索声量');assert.equal(leads.status,'ready');
  assert.deepEqual(defaults.applications.leads,{type:'static',root:'../线索声量',entry:'lead-dashboard.html',publicPaths:['lead-dashboard.html']});
  assert.equal(defaults.applications.orderiq.type,'proxy');
  assert.equal((await readJson(root,'deploy/config.example.json')).StaticApplications.some(a=>a.Name==='orderiq'),false);
});

test('dynamic registration stores a single portal port and expands public prefix identity after a target override',async t=>{
  const f=await fixture(t);
  const supplied={...dynamic,start:{...dynamic.start,args:['server.py','--port','9881','--public-prefix','{basePath}'],env:{PUBLIC_PREFIX:'{basePath}',OTHER_VALUE:'{businessValue}'}},healthExpected:{prefix:'{basePath}'}};
  const beforeArgs=[...supplied.start.args];
  await applyRegistration(await planRegistration(f.root,supplied));
  const local=await readJson(f.root,'config.local/apps.json');
  assert.deepEqual(local.applications.sample.start.args,['server.py','--port','{port}','--public-prefix','{basePath}']);
  assert.equal(local.applications.sample.start.env.PUBLIC_PREFIX,'{basePath}');
  assert.deepEqual(supplied.start.args,beforeArgs,'Registration must not rewrite caller data');
  local.applications.sample.target='http://127.0.0.1:9883';
  await writeFile(path.join(f.root,'config.local/apps.json'),json(local));
  const effective=(await loadAppIntegrations(f.root)).sample;
  assert.deepEqual(effective.start.args,['server.py','--port','9883','--public-prefix','/sample/']);
  assert.equal(effective.start.env.PUBLIC_PREFIX,'/sample/');
  assert.equal(effective.start.env.OTHER_VALUE,'{businessValue}');
  assert.deepEqual(effective.healthExpected,{prefix:'/sample/'});
});

test('registration normalizes known port flags, rejects conflicting ports and leaves custom CLI arguments alone',async t=>{
  const f=await fixture(t);
  for(const [args,expected] of [
    [['server.py','--port=9881'],['server.py','--port={port}']],
    [['server.py','--port','{port}'],['server.py','--port','{port}']],
    [['custom.exe','-listen','9881','--custom','{businessValue}'],['custom.exe','-listen','9881','--custom','{businessValue}']],
  ]){
    const plan=await planRegistration(f.root,{...dynamic,start:{...dynamic.start,args}});
    const saved=JSON.parse(plan.files.find(item=>item.file==='config.local/apps.json').content);
    assert.deepEqual(saved.applications.sample.start.args,expected);
  }
  for(const args of [['server.py','--port','9882'],['server.py','--port=9882'],['server.py','--port']]){
    await assert.rejects(planRegistration(f.root,{...dynamic,start:{...dynamic.start,args}}),/门户端口/);
  }
});
