// Select one local interpreter for both SQLite snapshots and the SOP backend.
import {existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import path from 'node:path';

const PROBE = "import sys,json; sys.version_info >= (3,10) or sys.exit('Python 3.10+ is required'); import openpyxl; print(json.dumps({'executable':sys.executable}))";

export function resolveSopPython({root,sourceRoot,env=process.env,platform=process.platform,exists=existsSync,run=spawnSync}={}) {
  root=path.resolve(root);
  const check=(candidate,label,allowMissing=false)=>{
    const result=run(candidate,['-B','-c',PROBE],{cwd:root,env:{...env,PYTHONIOENCODING:'utf-8',PYTHONDONTWRITEBYTECODE:'1'},encoding:'utf8',timeout:15000,windowsHide:true});
    if(allowMissing&&result.error?.code==='ENOENT')return null;
    let executable;
    if(!result.error&&result.status===0) {
      try {executable=JSON.parse(result.stdout.trim()).executable;} catch {}
    }
    if(executable&&typeof executable==='string'&&path.isAbsolute(executable))return path.normalize(executable);
    const detail=result.error?.message||result.stderr?.trim()||'Python 未返回有效的解释器路径。';
    throw new Error(`${label}无法用于 SOP：${candidate}\n需要可运行的 Python 3.10+ 和原 SOP requirements.txt 中的依赖（含 openpyxl）。请修复该环境或显式设置 SOP_PYTHON_PATH。\n${detail.slice(0,1200)}`);
  };
  const explicit=env.SOP_PYTHON_PATH?.trim();
  if(explicit)return check(path.resolve(root,explicit),'SOP_PYTHON_PATH ');
  const legacy=env.SOP_PYTHON?.trim();
  if(legacy) {
    const candidate=path.isAbsolute(legacy)||/[\\/]/.test(legacy)?path.resolve(root,legacy):legacy;
    return check(candidate,'SOP_PYTHON ');
  }
  const bases=[sourceRoot,root,path.dirname(root)].filter(Boolean);
  for(const base of new Set(bases.map(value=>path.resolve(value)))) {
    const venv=path.join(base,'.venv');
    const candidate=path.join(venv,...(platform==='win32'?['Scripts','python.exe']:['bin','python']));
    // An existing but broken environment is actionable; do not silently switch runtimes.
    if(exists(venv)||exists(candidate))return check(candidate,'虚拟环境 ');
  }
  for(const command of ['python','python3']) {
    // Only a command that is absent from PATH may fall through to the next name.
    const result=check(command,'PATH 中的 Python ',true);
    if(result)return result;
  }
  throw new Error('找不到 Python。请在 SOP 项目或工作区创建 .venv 并安装原 SOP requirements.txt，或设置 SOP_PYTHON_PATH。');
}
