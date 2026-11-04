// Select one local interpreter for both SQLite snapshots and the SOP backend.
import {existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import path from 'node:path';

const PROBE = "import sys,json; sys.version_info >= (3,10) or sys.exit('Python 3.10+ is required'); import openpyxl; print(json.dumps({'executable':sys.executable}))";

export function resolveSopPython({root,env=process.env,platform=process.platform,exists=existsSync,run=spawnSync}={}) {
  root=path.resolve(root);
  const check=(candidate,label)=>{
    const result=run(candidate,['-B','-c',PROBE],{cwd:root,env:{...env,PYTHONIOENCODING:'utf-8',PYTHONDONTWRITEBYTECODE:'1'},encoding:'utf8',timeout:15000,windowsHide:true});
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
  let workspace=root;
  while(path.basename(workspace).toLowerCase()!=='project') {
    const parent=path.dirname(workspace);
    if(parent===workspace)throw new Error('找不到 Project 工作区。请将门户放在 Project 目录下，并初始化 Project/.venv。');
    workspace=parent;
  }
  const candidate=path.join(workspace,'.venv',...(platform==='win32'?['Scripts','python.exe']:['bin','python']));
  if(!exists(candidate))throw new Error(`找不到 Project 共享 Python：${candidate}。请初始化 Project/.venv 并安装 SOP requirements.txt。`);
  return check(candidate,'Project 共享环境 ');
}
