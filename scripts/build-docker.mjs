// Generate immutable Linux build materials; Docker runs later on the deployment computer.
import path from 'node:path';
import crypto from 'node:crypto';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
export {hashFile} from './delivery-validation.mjs';
const digest=value=>crypto.createHash('sha256').update(value).digest('hex');

export async function createDockerMaterials(releases,output,{bindings,moduleNames}={}){
  const launcherBytes=await Promise.all(moduleNames.map(name=>readFile(path.join(output,'launcher',name))));
  const runtimeHash=digest(Buffer.concat([Buffer.from(JSON.stringify(bindings)),...launcherBytes]));
  const images={},dockerDirectory=path.join(output,'docker');await mkdir(dockerDirectory);
  const networkSource='FROM node:22-bookworm-slim\nCMD ["node","-e","setInterval(()=>{}, 3600000)"]\n';
  const networkFingerprint=digest(networkSource),networkTag='planhub/network:'+networkFingerprint.slice(0,32);
  images.network={tag:networkTag,fingerprint:networkFingerprint,dockerfile:'docker/network.Dockerfile'};
  await writeFile(path.join(output,images.network.dockerfile),networkSource);
  const services={network:{image:networkTag,pull_policy:'never',platform:'linux/amd64',restart:'unless-stopped',read_only:true,ports:[{target:bindings.planhub.port,published:'${PLANHUB_PORT}',host_ip:'${PLANHUB_BIND}'}],labels:{'planhub.runtime':'${PLANHUB_RUNTIME}'}}};
  const launcherCopy=moduleNames.map(name=>`COPY launcher/${name} ./launcher/${name}\n`).join('');
  for(const [id,release] of Object.entries(releases)){
    let source='FROM node:22-bookworm-slim AS node\n';
    if(release.manifest.type==='service'){
      await readFile(path.join(release.payload,'requirements.txt'));
      source+='FROM python:3.12-slim-bookworm\nCOPY --from=node /usr/local/bin/node /usr/local/bin/node\nRUN apt-get update && apt-get install -y --no-install-recommends libstdc++6 && rm -rf /var/lib/apt/lists/*\n';
      source+=`COPY releases/${id}/payload/requirements.txt /tmp/requirements.txt\nRUN python -m pip install --no-cache-dir -r /tmp/requirements.txt\n`;
    }
    source+='ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1\nWORKDIR /app\n';
    source+=`COPY releases/${id} ./release\n`+launcherCopy+'COPY bindings.json ./bindings.json\nCMD '+JSON.stringify(['node','/app/launcher/container-runtime.mjs','serve',id])+'\n';
    const fingerprint=digest(JSON.stringify(release.manifest)+runtimeHash+source),tag=`planhub/${id}:${fingerprint.slice(0,32)}`;
    images[id]={tag,fingerprint,dockerfile:`docker/${id}.Dockerfile`};await writeFile(path.join(output,images[id].dockerfile),source);
    services[id]={image:tag,pull_policy:'never',platform:'linux/amd64',init:true,restart:'unless-stopped',read_only:true,tmpfs:['/tmp'],network_mode:'service:network',depends_on:{network:{condition:'service_started'}},labels:{'planhub.runtime':'${PLANHUB_RUNTIME}'},volumes:[{type:'bind',source:'${PLANHUB_RUNTIME}',target:'/runtime',bind:{create_host_path:false}}],stop_grace_period:'45s',healthcheck:{test:['CMD','node','/app/launcher/container-runtime.mjs','check',id],interval:'10s',timeout:'5s',retries:12,start_period:'30s'},logging:{driver:'json-file',options:{'max-size':'10m','max-file':'3'}}};
  }
  await writeFile(path.join(output,'compose.json'),JSON.stringify({name:'planhub',services},null,2)+'\n');
  // Only verified release payloads and Linux launcher modules enter a build context.
  await writeFile(path.join(output,'.dockerignore'),'**\n!releases/\n!releases/**\n!launcher/\n!launcher/**\n!bindings.json\n!docker/\n!docker/**\n');
  return images;
}
