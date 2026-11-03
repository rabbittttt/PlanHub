// Start the independently maintained SOP project using isolated, writable snapshots.
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {resolvePreviewSettings,runPreview} from './dev-sop.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');

export async function localPreviewArgs(args=process.argv.slice(2),root=ROOT,env=process.env) {
  const settings=await resolvePreviewSettings(args,{root,env,requireData:true});
  if(settings===null)return null;
  return ['--sop-source',settings.sourceRoot,'--seed-from',settings.dataRoot,
    '--shared-config',settings.sharedConfig,'--port',String(settings.port),'--backend-port',String(settings.backendPort)];
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if(Number(process.versions.node.split('.')[0])<20)throw new Error('请安装 Node.js 20 或更高版本。');
    const args=await localPreviewArgs();
    if(args===null)console.log('npm start [-- --sop-source <独立SOP项目> --seed-from <数据来源> --shared-config <规则文件> --port 4173 --backend-port 8877]\n源码优先级：--sop-source > SOP_SOURCE_ROOT > config.local/sop.json > 同级 ../计划看板。\n--seed-from 只选择隔离快照的数据来源，不选择运行代码；操作仅保存到隔离快照，重启后创建新快照，不回写原项目。');
    else await runPreview(args);
  } catch(error) {console.error(`本地门户未启动：${error.message}`);process.exitCode=1;}
}
