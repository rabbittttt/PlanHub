import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {stopPortal} from './portal-instance.mjs';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 try{
  const {values}=parseArgs({options:{port:{type:'string'}},strict:true,allowPositionals:false});
  const port=Number(values.port??4173);if(!Number.isInteger(port)||port<1||port>65535)throw new Error('端口必须为 1–65535 整数。');
  console.log('正在停止本地门户及其启动的后端，请等待完成。');
  await stopPortal(ROOT,port);
  console.log('本地门户及其启动的后端已停止，可重新打开“启动本地门户.cmd”。');
 }catch(error){console.error('未停止门户：'+error.message);process.exitCode=1;}
}
