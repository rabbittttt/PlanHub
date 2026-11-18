import {spawn,spawnSync} from 'node:child_process';
import {mkdirSync,openSync,closeSync,statSync,renameSync,writeSync,createWriteStream} from 'node:fs';
import path from 'node:path';

// The child keeps its own file descriptors while it is running. Rotate on launch.
function openLog(filename) {
  try {
    if(statSync(filename).size>=10*1024*1024)renameSync(filename,filename+'.1');
  } catch(error) {
    // Another launch may still hold a file on Windows. Continue appending.
    if(!['ENOENT','EBUSY','EPERM','EACCES'].includes(error.code))throw error;
  }
  return openSync(filename,'a');
}

// Docker keeps its normal console stream and an operator-readable copy on the runtime mount.
export function mirrorContainerLog(source,consoleStream,filename) {
  mkdirSync(path.dirname(filename),{recursive:true});
  const file=createWriteStream(filename,{fd:openLog(filename)});
  file.on('error',error=>console.error('Cannot write '+filename+': '+error.message));
  file.write('\n['+new Date().toISOString()+'] Starting process\n');
  source.pipe(file);
  source.pipe(consoleStream,{end:false});
  return file;
}

// Direct file descriptors, not inherited console handles or unread pipes.
// Windows console text selection must never pause a backend response logger.
export function spawnService(command,args,{logDirectory,ipc=false,...options}) {
  mkdirSync(logDirectory,{recursive:true});
  const stdoutPath=path.join(logDirectory,'stdout.log'),stderrPath=path.join(logDirectory,'stderr.log');
  const descriptors=[];
  try {
    descriptors.push(openLog(stdoutPath));
    descriptors.push(openLog(stderrPath));
    const marker='\n['+new Date().toISOString()+'] Starting process\n';
    for(const fd of descriptors)writeSync(fd,marker);
    const stdio=['ignore',...descriptors];
    if(ipc)stdio.push('ipc');
    const child=spawn(command,args,{...options,windowsHide:true,stdio});
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
