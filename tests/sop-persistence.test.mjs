import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile,readFile,realpath,rm,readdir,stat} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {fileURLToPath} from 'node:url';
import {previewOptions,resolvePreviewSettings,runPreview} from '../scripts/dev-sop.mjs';
import {localPreviewArgs} from '../scripts/start-local.mjs';
import {resolveSopPython} from '../scripts/sop-python.mjs';

const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
async function freePort(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const port=s.address().port;await new Promise(r=>s.close(r));return port;}
async function fixture(t){
 const base=await realpath(await mkdtemp(path.join(os.tmpdir(),'sop-persistent-')));
 const root=path.join(base,'portal'),dataRoot=path.join(base,'persistent-business');
 for(const folder of [root,path.join(dataRoot,'data'),path.join(dataRoot,'input_file')])await mkdir(folder,{recursive:true});
 await writeFile(path.join(dataRoot,'data/sales.json'),JSON.stringify({meta:{notes:['portal persistence test']},products:[{id:'persistent-fixture',brand:'Test',model:'Fixture 2026',version:'A'}],sales:[]}));
 const rules=path.join(base,'rules.py');await writeFile(rules,'MERGE_GROUPS = {}\n');
 t.after(async()=>{assert.equal(path.dirname(await realpath(base)),await realpath(os.tmpdir()));assert.ok(path.basename(base).startsWith('sop-persistent-'));await rm(base,{recursive:true,force:true});});
 return {base,root,dataRoot,rules};
}

test('isolated seeds and demo require explicit snapshot mode',()=>{
 assert.equal(previewOptions([]).snapshot,undefined);
 assert.throws(()=>previewOptions(['--seed-from','../old']),/--snapshot/);
 assert.throws(()=>previewOptions(['--demo']),/--snapshot/);
 assert.throws(()=>previewOptions(['--snapshot','--seed-from','a','--data-root','b']),/不能同时/);
 assert.equal(previewOptions(['--snapshot','--demo']).demo,true);
});

test('default portal saves through the original SOP service and survives a full process restart',async t=>{
 const sourceRoot=path.resolve(project,process.env.SOP_SOURCE_ROOT||'../SOP维护');
 let python;
 try{await stat(path.join(sourceRoot,'sop/store.py'));python=resolveSopPython({root:project});}
 catch(error){t.skip('Independent SOP and Python dependencies required: '+error.message);return;}
 const {root,dataRoot,rules}=await fixture(t);
 const env={SOP_PYTHON_PATH:python,SOP_DATA_DIR:'',SOP_SOURCE_DIR:'',SOP_PLAN_DIR:'',SHARED_DATA_ROOT:''};
 const workbook=path.join(dataRoot,'input_file','SOP计划维护.xlsx');
 const initialized=spawnSync(python,['-B','-c',"import sys,pathlib; sys.path.insert(0,sys.argv[1]); from sop.store import SOPStore; from sop.workbook import WorkbookSync; p=pathlib.Path(sys.argv[2]); store=SOPStore(p/'data/sop.sqlite3',p/'data/sales.json'); result=WorkbookSync(store,sys.argv[3]).sync(force_export=True); store.close(); assert result['status']=='synced',result",sourceRoot,dataRoot,workbook],{env:{...process.env,PYTHONDONTWRITEBYTECODE:'1',SOP_EXCEL_ENGINE:'python'},encoding:'utf8',windowsHide:true});
 assert.equal(initialized.status,0,initialized.stderr);
 // Current SOP keeps server-side maintenance workbooks as archives; plans persist in SQLite.
 const archivedWorkbook=await readFile(workbook);
 const configured=['--sop-source',sourceRoot,'--data-root',dataRoot,'--shared-config',rules];
 const settings=await resolvePreviewSettings(configured,{root,env});
 assert.equal(settings.snapshot,false);assert.equal(settings.dataDirectory,path.join(dataRoot,'data'));
 assert.equal(settings.planSourceFile,path.join(dataRoot,'input_file','SOP计划维护.xlsx'));
 const args=await localPreviewArgs(configured,root,env);
 assert.equal(args.includes('--snapshot'),false);assert.equal(args.includes('--seed-from'),false);assert.ok(args.includes('--data-root'));
 async function start(){
  const port=await freePort();let backend=await freePort();while(backend===port)backend=await freePort();
  const server=await runPreview([...configured,'--port',String(port),'--backend-port',String(backend)],{root,env});
  return {server,port,backend,origin:'http://127.0.0.1:'+port};
 }
 async function close(server){server.closeAllConnections();await new Promise(r=>server.close(r));await new Promise(r=>setTimeout(r,300));}
 let instance=await start(),month;
 try{
  const state=await fetch(instance.origin+'/sop/api/state').then(r=>r.json());month=state.current_month;
  const response=await fetch(instance.origin+'/sop/api/plans',{method:'POST',headers:{Origin:instance.origin,'Content-Type':'application/json'},body:JSON.stringify({owner:'fixture',reason:'Persistent restart verification',changes:[{product_id:'persistent-fixture',month,forecast:null,sop:246,revision:0}]})});
  const saved=await response.json();assert.equal(response.status,200,JSON.stringify(saved));
  const readback=await fetch(instance.origin+'/sop/api/state').then(r=>r.json());
  assert.equal(readback.plans.find(p=>p.product_id==='persistent-fixture'&&p.month===month)?.sop,246);
  const reused=await runPreview([...configured,'--port',String(instance.port),'--backend-port',String(instance.backend)],{root,env});
  assert.equal(reused,null,'Repeat launch must reuse the live service');
  await assert.rejects(runPreview([...configured,'--snapshot','--port',String(instance.port),'--backend-port',String(instance.backend)],{root,env}),/不同代码版本或配置/);
  const differentBackend=await freePort();
  await assert.rejects(runPreview([...configured,'--port',String(instance.port),'--backend-port',String(differentBackend)],{root,env}),/不同代码版本或配置/);
  assert.equal((await readdir(path.join(root,'artifacts'))).filter(name=>name.startsWith('sop-runtime-')).length,1);
 }finally{await close(instance.server);}
 const db=path.join(dataRoot,'data/sop.sqlite3');
 assert.ok((await stat(db)).size>0);assert.ok((await stat(workbook)).size>0);
 const check=spawnSync(python,['-B','-c',"import sqlite3,pathlib,sys,json; db=sqlite3.connect(pathlib.Path(sys.argv[1]).as_uri()+'?mode=ro',uri=True); value=db.execute('select sop from plans where product_id=? and month=?',('persistent-fixture',sys.argv[2])).fetchone()[0]; db.close(); print(json.dumps(value))",db,month],{encoding:'utf8',windowsHide:true});
 assert.equal(check.status,0,check.stderr);assert.equal(JSON.parse(check.stdout),246);
 assert.deepEqual(await readFile(workbook),archivedWorkbook,'Saving plans must not overwrite the archived workbook');
 instance=await start();
 try{
  const state=await fetch(instance.origin+'/sop/api/state').then(r=>r.json());
  assert.equal(state.plans.find(p=>p.product_id==='persistent-fixture'&&p.month===month)?.sop,246);
  assert.deepEqual(await readFile(workbook),archivedWorkbook,'Restart must not rewrite the archived workbook');
  for(const folder of (await readdir(path.join(root,'artifacts'))).filter(name=>name!=='portal-instances')){
   assert.ok(folder.startsWith('sop-runtime-'),'Default mode must not create data snapshots');
   const gateway=JSON.parse(await readFile(path.join(root,'artifacts',folder,'config/gateway.json'),'utf8'));
   assert.equal(gateway.data_dir,path.join(dataRoot,'data'));assert.equal(gateway.plan_file,workbook);
   assert.deepEqual((await readdir(path.join(root,'artifacts',folder))).sort(),['config','logs']);
  }
 }finally{await close(instance.server);}
});
