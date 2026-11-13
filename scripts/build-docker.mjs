import path from 'node:path';
import crypto from 'node:crypto';
import {readFile,writeFile,mkdir,cp,rename,access,mkdtemp} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {readRelease} from './release-validation.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const modules=['container-runtime.mjs','release-validation.mjs','dev-server.mjs','app-integrations.mjs','proxy-request.mjs','portal-instance.mjs'];
const templates=['deploy.ps1','start.cmd','stop.cmd','runtime.example.json'];
const json=async file=>JSON.parse((await readFile(file,'utf8')).replace(/^\uFEFF/,''));
const putJson=(file,value)=>writeFile(file,JSON.stringify(value,null,2)+'\n');
const digest=value=>crypto.createHash('sha256').update(value).digest('hex');
export async function hashFile(file){const hash=crypto.createHash('sha256');for await(const chunk of createReadStream(file))hash.update(chunk);return hash.digest('hex');}
export function docker(args,{capture=false,env=process.env,allowMissing=false}={}){
  const result=spawnSync('docker',args,{encoding:'utf8',stdio:capture?'pipe':'inherit',windowsHide:true,env});
  if(allowMissing&&result.status!==0)return null;
  if(result.error||result.status!==0)throw new Error('Docker failed: '+args.slice(0,3).join(' ')+'\n'+(result.error?.message??result.stderr??'See output above.'));
  return result.stdout?.trim()??'';
}
export async function buildDockerPackage(releasePaths,destination,{complete=false,root=ROOT,execute=docker}={}){
  destination=path.resolve(destination);
  try{await access(destination);throw new Error('Destination already exists; choose a new version directory.');}catch(error){if(error.code!=='ENOENT')throw error;}
  const releases={};
  for(const source of releasePaths){
    const manifest=await json(path.join(source,'app-release.json')),id=manifest.appId;
    if(!/^[a-z][a-z0-9-]{0,39}$/.test(id)||releases[id])throw new Error('Invalid or duplicate application ID');
    releases[id]=await readRelease(path.resolve(source),id);
    const relative=path.relative(path.resolve(source),destination);
    if(!relative||(!relative.startsWith('..')&&!path.isAbsolute(relative)))throw new Error('Destination must be outside the input release');
  }
  if(!Object.keys(releases).length)throw new Error('No releases supplied');
  if(complete){
    if(!releases.planhub)throw new Error('Complete delivery requires planhub');
    const registry=await json(path.join(releases.planhub.payload,'config/apps.json'));
    const expected=['planhub',...registry.groups.flatMap(g=>g.apps).filter(a=>a.enabled).map(a=>a.id)].sort();
    if(new Set(expected).size!==expected.length||expected.join('|')!==Object.keys(releases).sort().join('|'))throw new Error('Incomplete delivery: releases must exactly match enabled portal applications');
  }
  const bindings=await json(path.join(root,'deploy/docker/bindings.json')),ports=new Set();
  for(const [id,binding] of Object.entries(bindings)){
    if(!Number.isInteger(binding.port)||binding.port<1024||binding.port>65535||ports.has(binding.port))throw new Error('Invalid or duplicate container port: '+id);
    ports.add(binding.port);
  }
  for(const [id,release] of Object.entries(releases)){
    if(!bindings[id]||bindings[id].type!==release.manifest.type)throw new Error('Configure the Docker runtime binding for '+id);
    const health=id==='sop'?'/sop'+release.manifest.healthPath.replace(/^\/sop/,''):release.manifest.healthPath;
    if(bindings[id].healthPath!==health)throw new Error('Health path differs from Docker binding: '+id);
  }
  const engine=execute(['info','--format','{{.OSType}}/{{.Architecture}}'],{capture:true});
  if(!/^linux\/(x86_64|amd64)$/.test(engine))throw new Error('Use Docker Linux containers on x86_64/amd64. Check docker info.');
  const composeVersion=execute(['compose','version','--short'],{capture:true}).match(/^v?(\d+)\.(\d+)\./);
  if(!composeVersion||Number(composeVersion[1])<2||(Number(composeVersion[1])===2&&Number(composeVersion[2])<20))throw new Error('Docker Compose 2.20 or newer is required.');
  const buildRoot=path.join(root,'staging/docker');await mkdir(buildRoot,{recursive:true});
  const work=await mkdtemp(path.join(buildRoot,'build-'));
  await mkdir(path.dirname(destination),{recursive:true});
  const output=await mkdtemp(path.join(path.dirname(destination),'.planhub-partial-'));
  const moduleBytes=await Promise.all(modules.map(async name=>[name,await readFile(path.join(root,'scripts',name))]));
  const runtimeHash=digest(Buffer.concat([Buffer.from(JSON.stringify(bindings)),...moduleBytes.map(([,bytes])=>bytes)]));
  const networkSource='FROM node:22-bookworm-slim\nCMD ["node","-e","setInterval(()=>{}, 3600000)"]\n';
  const networkTag='planhub/network:'+digest(networkSource).slice(0,16);
  const images={};
  async function buildImage(id,tag,context,fingerprint){
    const existing=execute(['image','inspect',tag],{capture:true,allowMissing:true});
    if(existing){
      const image=JSON.parse(existing)[0];
      if(image.Config.Labels?.['planhub.fingerprint']!==fingerprint)throw new Error('Immutable image tag already exists with different content: '+tag);
    }else execute(['build','--platform','linux/amd64','--label','planhub.fingerprint='+fingerprint,'--tag',tag,context]);
    const image=JSON.parse(execute(['image','inspect',tag],{capture:true}))[0];
    if(image.Os!=='linux'||image.Architecture!=='amd64')throw new Error('Unexpected image platform: '+tag);
    images[id]={tag,id:image.Id};
  }
  const networkContext=path.join(work,'network');await mkdir(networkContext);await writeFile(path.join(networkContext,'Dockerfile'),networkSource);
  await buildImage('network',networkTag,networkContext,digest(networkSource));
  const services={network:{image:networkTag,pull_policy:'never',platform:'linux/amd64',restart:'unless-stopped',read_only:true,ports:[{target:bindings.planhub.port,published:'${PLANHUB_PORT}',host_ip:'${PLANHUB_BIND}'}],labels:{'planhub.runtime':'${PLANHUB_RUNTIME}'}}};
  for(const [id,release] of Object.entries(releases)){
    const context=path.join(work,id);await mkdir(path.join(context,'launcher'),{recursive:true});
    await cp(release.root,path.join(context,'release'),{recursive:true});await readRelease(path.join(context,'release'),id);
    for(const [name,bytes] of moduleBytes)await writeFile(path.join(context,'launcher',name),bytes);
    await putJson(path.join(context,'bindings.json'),bindings);
    let dockerfile='FROM node:22-bookworm-slim AS node\n';
    if(release.manifest.type==='service'){
      await access(path.join(release.payload,'requirements.txt'));
      dockerfile+='FROM python:3.12-slim-bookworm\nCOPY --from=node /usr/local/bin/node /usr/local/bin/node\nRUN apt-get update && apt-get install -y --no-install-recommends libstdc++6 && rm -rf /var/lib/apt/lists/*\nCOPY release/payload/requirements.txt /tmp/requirements.txt\nRUN python -m pip install --no-cache-dir -r /tmp/requirements.txt\n';
    }
    dockerfile+='ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1\nWORKDIR /app\nCOPY release ./release\nCOPY launcher ./launcher\nCOPY bindings.json ./bindings.json\nCMD '+JSON.stringify(['node','/app/launcher/container-runtime.mjs','serve',id])+'\n';
    await writeFile(path.join(context,'Dockerfile'),dockerfile);
    const fingerprint=digest(JSON.stringify(release.manifest)+runtimeHash+dockerfile);
    const tag=`planhub/${id}:${fingerprint.slice(0,32)}`;
    await buildImage(id,tag,context,fingerprint);
    services[id]={image:tag,pull_policy:'never',platform:'linux/amd64',init:true,restart:'unless-stopped',read_only:true,tmpfs:['/tmp'],network_mode:'service:network',depends_on:{network:{condition:'service_started'}},labels:{'planhub.runtime':'${PLANHUB_RUNTIME}'},volumes:[{type:'bind',source:'${PLANHUB_RUNTIME}',target:'/runtime',bind:{create_host_path:false}}],stop_grace_period:'45s',healthcheck:{test:['CMD','node','/app/launcher/container-runtime.mjs','check',id],interval:'10s',timeout:'5s',retries:12,start_period:'30s'},logging:{driver:'json-file',options:{'max-size':'10m','max-file':'3'}}};
  }
  await putJson(path.join(output,'compose.json'),{name:'planhub',services});
  execute(['compose','--project-name','planhub','--file',path.join(output,'compose.json'),'config','--quiet'],{env:{...process.env,PLANHUB_RUNTIME:work.replaceAll('\\','/'),PLANHUB_PORT:'4173',PLANHUB_BIND:'127.0.0.1'}});
  execute(['image','save','--output',path.join(output,'images.tar'),...Object.values(images).map(image=>image.tag)]);
  for(const name of templates)await cp(path.join(root,'deploy/docker',name),path.join(output,name));
  await cp(path.join(root,'docs/deployment.md'),path.join(output,'README.md'));
  const files={};for(const name of ['compose.json','images.tar','README.md',...templates])files[name]=await hashFile(path.join(output,name));
  await putJson(path.join(output,'delivery.json'),{schemaVersion:1,complete,platform:'linux/amd64',contractHash:digest(JSON.stringify(bindings)),applications:Object.keys(releases),images,files,versions:Object.fromEntries(Object.entries(releases).map(([id,release])=>[id,release.manifest.version]))});
  await mkdir(path.dirname(destination),{recursive:true});await rename(output,destination);
  console.log('Docker delivery ready (not deployed): '+destination);
  return {destination,images};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  try{const args=process.argv.slice(2),complete=args[0]==='--complete';if(complete)args.shift();const destination=args.shift();if(!destination)throw new Error('Provide destination and release paths');await buildDockerPackage(args,destination,{complete});}
  catch(error){console.error(error.message);process.exitCode=1;}
}
