import http from 'node:http';

function headersWithoutHop(headers) {
  const result={...headers};
  const hop=['connection','keep-alive','proxy-authenticate','proxy-authorization','te','trailer','transfer-encoding','upgrade',...(headers.connection||'').split(',').map(s=>s.trim().toLowerCase())];
  for(const key of hop)delete result[key];
  return result;
}
export function proxyRequest(request,response,app,upstreamPath,send) {
  const target=new URL(app.target);
  const headers=headersWithoutHop(request.headers);
  // Keep public Host + Origin paired: the original application's same-origin check remains effective.
  for(const key of Object.keys(headers))if(key.startsWith('x-sop-')||key.startsWith('x-forwarded-')||key==='forwarded')delete headers[key];
  const upstream=http.request({hostname:target.hostname,port:target.port||80,path:upstreamPath,method:request.method,headers},incoming=>{
    response.writeHead(incoming.statusCode,headersWithoutHop(incoming.headers));
    incoming.on('error',()=>response.destroy());
    incoming.pipe(response);
  });
  upstream.setTimeout(120000,()=>upstream.destroy(new Error('Independent service timeout')));
  upstream.on('error',()=>{if(!response.headersSent)send(502,'Independent application unavailable; start its service or check integration configuration');else response.destroy();});
  request.on('aborted',()=>upstream.destroy());
  response.on('close',()=>{if(!response.writableEnded)upstream.destroy();});
  request.pipe(upstream);
}
