// Portal-owned loopback preview bridge. The authenticated portal stays intact.
import http from 'node:http';

export const LOCAL_PREVIEW_ORIGIN='http://127.0.0.1:4174';

export function validatePreviewConfig(config){
  const preview=config?.preview;
  if(!preview||typeof preview!=='object'||Array.isArray(preview)||preview.schemaVersion!==1||config.publicOrigin!==LOCAL_PREVIEW_ORIGIN||config.port!==4174||config.listenAddress!=='127.0.0.1')throw new Error('Local preview requires schema 1 and http://127.0.0.1:4174 bound to 127.0.0.1.');
  if(typeof preview.user!=='string'||preview.user.length>100||!/^([A-Za-z0-9_.-]+\\[A-Za-z0-9_.-]+|[A-Za-z0-9_.+-]+@[A-Za-z0-9.-]+)$/.test(preview.user))throw new Error('Local preview requires the launching Windows account or its SID identity.');
  if(typeof preview.sourceDirectory!=='string'||!preview.sourceDirectory.trim()||/[\x00-\x1f\x7f]/.test(preview.sourceDirectory)||typeof preview.createdAt!=='string'||!Number.isFinite(Date.parse(preview.createdAt)))throw new Error('Local preview requires snapshot source metadata.');
  if(typeof config.proxySecret!=='string'||!/^[A-Za-z0-9_-]{32,}$/.test(config.proxySecret))throw new Error('Local preview requires its own server-side proxy secret.');
  return preview;
}

function withoutTransportIdentity(headers){
  const result={...headers};
  for(const name of ['connection','keep-alive','proxy-authenticate','proxy-authorization','te','trailer','transfer-encoding','upgrade',...(headers.connection??'').split(',').map(value=>value.trim().toLowerCase())])delete result[name];
  for(const name of Object.keys(result))if(name.startsWith('x-planhub-')||name.startsWith('x-config-')||name.startsWith('x-sop-')||name.startsWith('x-forwarded-')||name==='forwarded')delete result[name];
  return result;
}

function permitted(request,config){
  const names=request.rawHeaders.filter((_,index)=>index%2===0).map(name=>name.toLowerCase());
  if(names.filter(name=>name==='host').length!==1||['origin','sec-fetch-site'].some(key=>names.filter(name=>name===key).length>1))return false;
  if(request.headers.host!=='127.0.0.1:4174')return false;
  if(request.headers.origin!==undefined&&request.headers.origin!==config.publicOrigin)return false;
  if(request.headers['sec-fetch-site']!==undefined&&!['none','same-origin','same-site'].includes(request.headers['sec-fetch-site']))return false;
  return typeof request.url==='string'&&request.url.startsWith('/')&&!request.url.startsWith('//');
}

export function createLocalPreviewGateway({config,targetPort}){
  const preview=validatePreviewConfig(config);
  if(!Number.isInteger(targetPort)||targetPort<1||targetPort>65535)throw new Error('Invalid authenticated preview portal port.');
  const active=new Set();
  const server=http.createServer((request,response)=>{
    const send=(status,message)=>{
      if(response.headersSent){response.destroy();return;}
      response.writeHead(status,{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','X-Frame-Options':'SAMEORIGIN'});
      response.end(request.method==='HEAD'?undefined:message);
    };
    if(!permitted(request,config)){request.resume();send(403,'Use the local preview address on this computer.');return;}
    const headers=withoutTransportIdentity(request.headers);
    headers.host='127.0.0.1:4174';
    headers['x-planhub-key']=config.proxySecret;
    headers['x-planhub-user']=preview.user;
    const upstream=http.request({hostname:'127.0.0.1',port:targetPort,path:request.url,method:request.method,headers},incoming=>{
      response.writeHead(incoming.statusCode,withoutTransportIdentity(incoming.headers));
      incoming.on('error',()=>response.destroy());
      incoming.pipe(response);
    });
    active.add(upstream);upstream.once('close',()=>active.delete(upstream));
    upstream.setTimeout(120000,()=>upstream.destroy(new Error('Local preview request timed out')));
    upstream.on('error',()=>send(502,'Local preview portal unavailable.'));
    request.on('aborted',()=>upstream.destroy());
    response.on('close',()=>{if(!response.writableEnded)upstream.destroy();});
    request.pipe(upstream);
  });
  server.on('upgrade',(_request,socket)=>socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'));
  server.on('connect',(_request,socket)=>socket.end('HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'));
  server.once('close',()=>{for(const upstream of active)upstream.destroy();});
  return server;
}

function listen(server,port,host){return new Promise((resolve,reject)=>{const fail=error=>{server.removeListener('listening',ready);reject(error);};const ready=()=>{server.removeListener('error',fail);resolve();};server.once('error',fail);server.once('listening',ready);server.listen(port,host);});}

export async function startLocalPreviewPortal(portal,config,{port=4173,host='0.0.0.0'}={}){
  validatePreviewConfig(config);
  await listen(portal,0,'127.0.0.1');
  const server=createLocalPreviewGateway({config,targetPort:portal.address().port});
  const stopPortal=()=>{portal.close();portal.closeAllConnections?.();};
  server.once('close',stopPortal);
  portal.once('close',()=>{server.close();server.closeAllConnections?.();});
  try{
    await listen(server,port,host);
    // This is a server-side diagnostic handle, never serialized to a browser.
    server.authenticatedPortal=portal;
    return server;
  }catch(error){stopPortal();throw error;}
}
