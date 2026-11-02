// Launch the real local SOP snapshot and portal together, without changing source data.
import {stat} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {runPreview} from './dev-sop.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');

async function requirePath(filename,label,directory=false) {
  try {
    const item=await stat(filename);
    if(directory?item.isDirectory():item.isFile())return;
  } catch(error) {if(!['ENOENT','ENOTDIR'].includes(error.code))throw error;}
  throw new Error(`${label}不存在：${filename}`);
}

export async function localPreviewArgs(args=process.argv.slice(2),root=ROOT) {
  const {values}=parseArgs({args,options:{
    'seed-from':{type:'string'},'shared-config':{type:'string'},
    port:{type:'string'},'backend-port':{type:'string'},help:{type:'boolean'}
  },strict:true,allowPositionals:false});
  if(values.help)return null;
  const seed=path.resolve(values['seed-from']||path.join(root,'..','PythonProject','计划看板'));
  try {
    await requirePath(path.join(seed,'server.py'),'SOP 项目入口');
    await requirePath(path.join(seed,'data','sales.json'),'SOP 数据快照');
    await requirePath(path.join(seed,'input_file'),'SOP 原始文件目录',true);
  } catch(error) {
    throw new Error(`${error.message}\n请指定实际项目：npm start -- --seed-from "D:\\实际路径\\SOP项目" --shared-config "D:\\实际路径\\shared_config.py"。不会自动改用演示数据。`);
  }
  const rules=path.resolve(values['shared-config']||path.join(seed,'..','订单分析','scripts','config','shared_config.py'));
  try {await requirePath(rules,'共享业务规则');}
  catch(error) {throw new Error(`${error.message}\n请通过 --shared-config 指定实际共享规则文件。`);}
  const forwarded=['--seed-from',seed,'--shared-config',rules];
  for(const name of ['port','backend-port'])if(values[name]!==undefined)forwarded.push('--'+name,values[name]);
  return forwarded;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if(Number(process.versions.node.split('.')[0])<20)throw new Error('请安装 Node.js 20 或更高版本。');
    const args=await localPreviewArgs();
    if(args===null)console.log('npm start [-- --seed-from <SOP项目目录> --shared-config <共享规则文件> --port 4173 --backend-port 8877]\n默认查找同级 PythonProject/计划看板，使用隔离的真实数据快照；全部写入关闭。');
    else await runPreview(args);
  } catch(error) {console.error(`本地门户未启动：${error.message}`);process.exitCode=1;}
}
