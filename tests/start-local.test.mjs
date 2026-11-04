import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
async function listener() {
  const server=net.createServer();
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  return server;
}
async function close(server){await new Promise(resolve=>server.close(resolve));}

test('occupied portal or SOP ports fail before snapshot reads or Python startup',async()=>{
  const occupied=await listener();
  const available=await listener();
  const busy=occupied.address().port,free=available.address().port;
  await close(available);
  try {
    for(const [port,backend] of [[busy,free],[free,busy]]) {
      const result=spawnSync(process.execPath,[path.join(root,'scripts','dev-sop.mjs'),
        '--port',String(port),'--backend-port',String(backend),
        '--snapshot','--seed-from',path.join(root,'artifacts','nonexistent-preflight-seed')],
      {cwd:root,encoding:'utf8',timeout:5000});
      assert.equal(result.error,undefined);
      assert.equal(result.status,1);
      assert.match(result.stderr,new RegExp(`端口 ${busy} 已被占用`));
      assert.match(result.stderr,/npm run dev/);
      assert.doesNotMatch(result.stdout,/SOP计划工作台已就绪|SOP 门户预览/);
      assert.doesNotMatch(result.stderr,/ENOENT|sales\.json/);
    }
  } finally {await close(occupied);}
});
