import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';import path from 'node:path';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {loadPersistentDataRoot,loadAppIntegrations} from '../scripts/app-integrations.mjs';
import {containerSpec} from '../scripts/container-runtime.mjs';
test('one development data root reaches every managed service',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'central-root-'));
 try{
  await mkdir(path.join(root,'integration'));
  await writeFile(path.join(root,'integration/apps.json'),JSON.stringify({dataRoot:'../state',applications:{example:{type:'proxy',target:'http://127.0.0.1:9999',stripPrefix:true,rootRoutes:[],healthPath:'/health',healthKeys:['ok'],start:{cwd:'.',command:'python.exe',args:[]}}}}));
  const apps=await loadAppIntegrations(root,{env:{}});
  assert.equal(apps.example.start.env.PLANHUB_DATA_ROOT,path.resolve(root,'../state'));
  assert.equal(await loadPersistentDataRoot(root,{env:{PLANHUB_DATA_ROOT:'../override'}}),path.resolve(root,'../override'));
 }finally{await rm(root,{recursive:true,force:true});}
});
test('new native and container stores are central; legacy runtime remains explicit',()=>{
 const binding={arguments:['{data}','{shared}'],sharedDataDirectory:'车型配置'};
 const config={sharedDirectory:'shared',databaseDirectory:'database',publicOrigin:'http://localhost'};
 assert.equal(containerSpec('vehicle-config',binding,config).data,'/runtime/database/vehicle-config');
 assert.equal(containerSpec('vehicle-config',binding,{...config,databaseDirectory:undefined}).data,'/runtime/shared/车型配置');
 assert.throws(()=>containerSpec('sop',{}, {...config,databaseDirectory:'../escape'}));
});
