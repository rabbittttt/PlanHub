// Portal-owned default ports. Generated releases contain concrete bindings.
import {readFileSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);

export function readServicePorts(root=ROOT,{optional=false}={}) {
  const filename=path.join(root,'integration','ports.json');
  let ports;
  try {ports=JSON.parse(readFileSync(filename,'utf8').replace(/^\uFEFF/,''));}
  catch(error) {
    if(optional&&error.code==='ENOENT')return null;
    throw new Error(`Invalid service port registry ${filename}: ${error.message}`);
  }
  if(!object(ports)||ports.schemaVersion!==1||!object(ports.applications))throw new Error(`Invalid service port registry ${filename}: expected schemaVersion 1, portal and applications.`);
  if(Object.hasOwn(ports.applications,'planhub'))throw new Error('Invalid service port registry application ID: planhub');
  const used=new Map();
  for(const [id,port] of [['planhub',ports.portal],...Object.entries(ports.applications)]) {
    if(!/^[a-z][a-z0-9-]*$/.test(id))throw new Error(`Invalid service port registry application ID: ${id}`);
    if(!Number.isInteger(port)||port<1||port>65535)throw new Error(`Invalid service port for ${id}: expected a 1–65535 integer.`);
    if(used.has(port))throw new Error(`Duplicate service port ${port}: ${used.get(port)} and ${id}.`);
    used.set(port,id);
  }
  return ports;
}

export async function loadRuntimeBindings(root=ROOT) {
  const ports=readServicePorts(root);
  const filename=path.join(root,'deploy','docker','bindings.json');
  const templates=JSON.parse((await readFile(filename,'utf8')).replace(/^\uFEFF/,''));
  if(!object(templates))throw new Error(`Invalid runtime binding templates: ${filename}`);
  const result={};
  for(const [id,template] of Object.entries(templates)) {
    if(!object(template)||Object.hasOwn(template,'port'))throw new Error(`Runtime binding ${id} must keep its default port only in integration/ports.json.`);
    const port=id==='planhub'?ports.portal:Object.hasOwn(ports.applications,id)?ports.applications[id]:undefined;
    if(port===undefined)throw new Error(`Runtime binding ${id} has no default port in integration/ports.json.`);
    result[id]={...template,port};
  }
  return result;
}
