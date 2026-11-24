// Start the independent SOP service with its persistent business data by default.
import path from 'node:path';
import {collectDiagnostics} from './diagnose.mjs';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {previewOptions,resolvePreviewSettings,runPreview} from './dev-sop.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');

export async function localPreviewArgs(args=process.argv.slice(2),root=ROOT,env=process.env) {
  const settings=await resolvePreviewSettings(args,{root,env});
  if(settings===null)return null;
  return ['--sop-source',settings.sourceRoot,...(settings.snapshot?['--snapshot']:[]),...(settings.demo?['--demo']:[]),...(settings.dataRootExplicit?[settings.snapshot?'--seed-from':'--data-root',settings.dataRoot]:[]),
    '--shared-config',settings.sharedConfig,'--port',String(settings.port),'--backend-port',String(settings.backendPort)];
}

export async function startLocal(args=process.argv.slice(2),options={}) {
  if(Number(process.versions.node.split('.')[0])<20)throw new Error('请安装 Node.js 20 或更高版本。');
  if(previewOptions(args,{root:options.root??ROOT}).help){const defaults=previewOptions([],{root:options.root??ROOT});console.log(`npm start [-- --sop-source <独立SOP项目> --data-root <持久数据项目> --shared-config <规则文件> --port ${defaults.port} --backend-port ${defaults.backendPort}]\n源码优先级：--sop-source > SOP_SOURCE_ROOT > config.local/sop.json > 同级 ../SOP维护。\n默认使用原项目持久数据库，维护立即保存且重启保留；Excel 经业务页面导入导出。仅显式 --snapshot 进行隔离测试；--seed-from 必须配合 --snapshot。`);return null;}
  const server=await runPreview(args,options);
  if(server?.startupWarnings.length){
    try{
      const report=await collectDiagnostics({root:options.root??ROOT,port:server.address().port,appIds:server.unavailableAppIds()});
      for(const app of report.applications){
        const status=probe=>probe?.reason||probe?.status||'未探测';
        const data=app.dataChecks?.map(probe=>probe.name+' '+status(probe)).join('、');
        const summary=`${app.name}：页面 ${status(app.page)}；后端 ${status(app.backend)}；数据 ${data||'未探测'}`+
          (app.latestLog?'；最近日志 '+app.latestLog.path:'');
        console.warn(summary);server.startupWarnings.push(summary);
      }
    }catch(error){console.warn('诊断未完成：'+error.message);}
  }
  return server;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    await startLocal();
  } catch(error) {console.error(`本地门户未启动：${error.message}`);process.exitCode=1;}
}
