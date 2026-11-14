// Compare only portal-owned startup contracts; never execute an old release.
import path from 'node:path';
import crypto from 'node:crypto';
import {readdir,lstat} from 'node:fs/promises';
import {validateDelivery,readJson,noLinks,hashFile,runtimeContract,snapshotContractHash,validateBindings,DELIVERY_SCHEMA,DELIVERY_PLATFORM} from './delivery-validation.mjs';

const formalHash=bindings=>crypto.createHash('sha256').update(JSON.stringify(runtimeContract(bindings))).digest('hex');
export async function checkSnapshotCompatibility(packageRoot,runtimeRoot,oldContractHash){
  const delivery=await validateDelivery(packageRoot,{requireComplete:true});
  runtimeRoot=path.resolve(runtimeRoot);
  await noLinks(runtimeRoot);
  if(path.dirname(runtimeRoot)!==path.join(path.dirname(delivery.root),'planhub-preview')||!/^snapshot-[a-f0-9]{32}$/.test(path.basename(runtimeRoot)))throw new Error('Use the existing snapshot created by preview.cmd.');
  if(!(await lstat(runtimeRoot)).isDirectory())throw new Error('The existing snapshot is not a directory.');
  if(!/^[a-f0-9]{64}$/.test(oldContractHash??''))throw new Error('Invalid previous snapshot contract.');
  const currentHash=snapshotContractHash(delivery.bindings);
  if(oldContractHash===delivery.manifest.contractHash)return {compatible:true,snapshotContractHash:currentHash,reason:'The startup contract is unchanged.'};
  const parent=path.dirname(delivery.root),ids=[...delivery.manifest.applications].sort().join('|');
  for(const name of (await readdir(parent)).filter(name=>/^planhub-[a-zA-Z0-9-]+$/.test(name)).sort().reverse()){
    const previous=path.join(parent,name);if(previous===delivery.root)continue;
    try{
      await noLinks(previous);if(!(await lstat(previous)).isDirectory())continue;
      const file=path.join(previous,'delivery.json');await noLinks(file);
      const manifest=await readJson(file);
      if(manifest.schemaVersion!==DELIVERY_SCHEMA||manifest.platform!==DELIVERY_PLATFORM||manifest.complete!==true||manifest.contractHash!==oldContractHash||!Array.isArray(manifest.applications)||[...manifest.applications].sort().join('|')!==ids)continue;
      const bindingFile=path.join(previous,'bindings.json');await noLinks(bindingFile);
      if(!/^[a-f0-9]{64}$/.test(manifest.files?.['bindings.json']??'')||await hashFile(bindingFile)!==manifest.files['bindings.json'])continue;
      const bindings=await readJson(bindingFile);validateBindings(bindings,{});
      if(formalHash(bindings)!==oldContractHash)continue;
      if(snapshotContractHash(bindings)!==currentHash)throw new Error('The service startup contract changed beyond ports. Choose option 2 to create a new snapshot after preparing its source data/configuration.');
      return {compatible:true,snapshotContractHash:currentHash,reason:'Verified the previous delivery: only service ports or JSON ordering changed.'};
    }catch(error){
      if(error.message.startsWith('The service startup contract changed'))throw error;
      // Missing, linked or damaged neighbors are not evidence of compatibility.
    }
  }
  throw new Error('Cannot verify the previous snapshot contract. Keep its original full delivery folder alongside the new package, or explicitly choose option 2 to create a new snapshot.');
}
