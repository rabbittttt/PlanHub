import path from 'node:path';
import crypto from 'node:crypto';
import {writeFile,mkdir,cp,rename,access,mkdtemp,rm} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {readRelease} from './release-validation.mjs';
import {DELIVERY_SCHEMA,DELIVERY_PLATFORM,runtimeContract,readJson,hashFile,noLinks,deliveryFiles,validateReleases,validateBindings,validateDelivery} from './delivery-validation.mjs';
import {createDockerMaterials} from './build-docker.mjs';
import {resolveNodeLicense} from './node-runtime-license.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const modules=['native-preview.mjs','service-process.mjs','delivery-validation.mjs','container-runtime.mjs','local-preview-gateway.mjs','release-validation.mjs','dev-server.mjs','app-integrations.mjs','proxy-request.mjs','portal-instance.mjs'];
const containerModules=['container-runtime.mjs','local-preview-gateway.mjs','release-validation.mjs','dev-server.mjs','app-integrations.mjs','proxy-request.mjs','portal-instance.mjs'];
const json=(file,value)=>writeFile(file,JSON.stringify(value,null,2)+'\n');
function run(command,args,options={}){
  const result=spawnSync(command,args,{windowsHide:true,stdio:'inherit',...options});
  if(result.error||result.status!==0)throw new Error(result.error?.message??'Runtime collection failed. Check Python and installed application dependencies on A.');
  return result.stdout;
}
export async function collectWindowsRuntime(output,{python,requirements,root=ROOT}={}){
  if(process.platform!=='win32'||process.arch!=='x64')throw new Error('Create the Windows preview delivery on Windows x64.');
  const license=await resolveNodeLicense({licenseDirectory:path.join(root,'deploy/licenses/node')});
  await mkdir(path.join(output,'node'),{recursive:true});
  await cp(process.execPath,path.join(output,'node/node.exe'));
  await writeFile(path.join(output,'node',license.fileName),license.bytes);
  run(path.join(output,'node/node.exe'),['--version'],{stdio:'pipe'});
  if(requirements.length){
    if(!python)throw new Error('Set runtimePython in config.local/publish.json to the working Python executable on A.');
    run(python,['-I','-B',path.join(root,'scripts/package-windows-runtime.py'),'--output',path.join(output,'python'),...requirements.flatMap(file=>['--requirements',file])]);
  }
}
export async function buildDelivery(releasePaths,destination,{complete=false,root=ROOT,python=path.resolve(ROOT,'../.venv/Scripts/python.exe'),collectRuntime=collectWindowsRuntime}={}){
  destination=path.resolve(destination);
  await noLinks(destination);
  try{await access(destination);throw new Error('Destination already exists; choose a new version directory.');}catch(error){if(error.code!=='ENOENT')throw error;}
  const releases={};
  for(const sourceValue of releasePaths){
    const source=path.resolve(sourceValue),id=(await readJson(path.join(source,'app-release.json'))).appId;
    if(!/^[a-z][a-z0-9-]{0,39}$/.test(id)||releases[id])throw new Error('Invalid or duplicate application ID');
    releases[id]=await readRelease(source,id);
    const relative=path.relative(source,destination);
    if(!relative||(!relative.startsWith('..')&&!path.isAbsolute(relative)))throw new Error('Destination must be outside the input release');
  }
  await validateReleases(releases,{complete});
  const bindings=await readJson(path.join(root,'deploy/docker/bindings.json'));validateBindings(bindings,releases);
  await mkdir(path.dirname(destination),{recursive:true});
  const output=await mkdtemp(path.join(path.dirname(destination),'.planhub-partial-'));
  try{
    await mkdir(path.join(output,'launcher'));await mkdir(path.join(output,'releases'));
    for(const [id,release] of Object.entries(releases)){await cp(release.root,path.join(output,'releases',id),{recursive:true});await readRelease(path.join(output,'releases',id),id);}
    for(const name of modules)await cp(path.join(root,'scripts',name),path.join(output,'launcher',name));
    await json(path.join(output,'bindings.json'),bindings);
    for(const name of ['deploy.ps1','delivery-common.ps1','start.cmd','stop.cmd','runtime.example.json','build-docker.ps1','build-docker.cmd','prepare.cmd'])await cp(path.join(root,'deploy/docker',name),path.join(output,name));
    for(const name of ['preview.ps1','preview.cmd','stop-preview.cmd'])await cp(path.join(root,'deploy/windows',name),path.join(output,name));
    await cp(path.join(root,'docs/deployment.md'),path.join(output,'README.md'));
    const requirements=Object.values(releases).filter(release=>release.manifest.type==='service').map(release=>path.join(release.payload,'requirements.txt'));
    await collectRuntime(path.join(output,'runtime'),{python,requirements,root});
    const images=await createDockerMaterials(releases,output,{bindings,moduleNames:containerModules});
    const files={};for(const name of await deliveryFiles(output))files[name]=await hashFile(path.join(output,name));
    await json(path.join(output,'delivery.json'),{schemaVersion:DELIVERY_SCHEMA,complete,platform:DELIVERY_PLATFORM,contractHash:crypto.createHash('sha256').update(JSON.stringify(runtimeContract(bindings))).digest('hex'),applications:Object.keys(releases),images,files,versions:Object.fromEntries(Object.entries(releases).map(([id,release])=>[id,release.manifest.version]))});
    await validateDelivery(output);
    await rename(output,destination);
  }catch(error){await rm(output,{recursive:true,force:true});throw error;}
  console.log('Delivery ready (Docker not required; not deployed): '+destination);
  return {destination};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  try{
    if(process.argv[2]==='--check-node-runtime'){
      const license=await resolveNodeLicense();console.log(`Node.js ${license.version}: full license ready (${license.source}); no network required.`);
    }else{
      const args=process.argv.slice(2),complete=args[0]==='--complete';if(complete)args.shift();
      let python;const pythonIndex=args.indexOf('--python');if(pythonIndex>=0){python=args[pythonIndex+1];args.splice(pythonIndex,2);if(!python)throw new Error('Missing Python executable');}
      const destination=args.shift();if(!destination)throw new Error('Provide destination and release paths');await buildDelivery(args,destination,{complete,python});
    }
  }catch(error){console.error(error.message);process.exitCode=1;}
}
