import {spawn,spawnSync} from 'node:child_process';
import {mkdirSync,openSync,closeSync} from 'node:fs';
import path from 'node:path';

// Direct file descriptors, not inherited console handles or unread pipes.
// Windows console text selection must never pause a backend response logger.
export function spawnService(command,args,{logDirectory,...options}) {
  mkdirSync(logDirectory,{recursive:true});
  const stdoutPath=path.join(logDirectory,'stdout.log'),stderrPath=path.join(logDirectory,'stderr.log');
  const descriptors=[];
  try {
    descriptors.push(openSync(stdoutPath,'a'));
    descriptors.push(openSync(stderrPath,'a'));
    const child=spawn(command,args,{...options,windowsHide:true,stdio:['ignore',...descriptors]});
    child.serviceLogs={stdout:stdoutPath,stderr:stderrPath};
    return child;
  } finally {for(const descriptor of descriptors)closeSync(descriptor);}
}

export function stopService(child) {
  if(!child?.pid||child.exitCode!==null||child.signalCode!==null)return;
  if(process.platform==='win32') {
    // A Windows venv launcher can own a second Python process. Stop only this
    // child tree created by the portal; never target unrelated/reused services.
    const command=path.join(process.env.SystemRoot,'System32','taskkill.exe');
    const result=spawnSync(command,['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore',timeout:10000});
    if(!result.error&&result.status===0)return;
  }
  child.kill();
}
