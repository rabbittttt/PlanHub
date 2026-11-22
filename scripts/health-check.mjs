// Lightweight, read-only readiness checks. Never expose response contents in diagnostics.
export async function probeServiceHealth(app,{fetcher=fetch,maxBytes=64*1024}={}){
  // Count delivered bytes, including decompressed or chunked response bodies.
  try{
    const response=await fetcher(new URL(app.healthPath,app.target),{redirect:'manual',signal:AbortSignal.timeout(app.healthTimeoutMs??1500)});
    if(!response.ok){await response.body?.cancel();return {ok:false,status:response.status,reason:'HTTP_ERROR'};}
    const chunks=[];
    let size=0;
    for await(const chunk of response.body??[]){
      size+=chunk.byteLength;
      if(size>maxBytes)return {ok:false,status:response.status,reason:'RESPONSE_TOO_LARGE'};
      chunks.push(chunk);
    }
    const text=Buffer.concat(chunks,size).toString('utf8').replace(/^\uFEFF/,'');
    if(app.healthKeys?.length){
      let body;try{body=JSON.parse(text);}catch{return {ok:false,status:response.status,reason:'NOT_JSON'};}
      const missing=app.healthKeys.filter(key=>!body||!Object.hasOwn(body,key));
      if(missing.length)return {ok:false,status:response.status,reason:'MISSING_HEALTH_KEYS',missing};
      const matches=Object.entries(app.healthExpected??{}).every(([key,value])=>Object.hasOwn(body,key)&&Object.is(body[key],value));
      return matches?{ok:true,status:response.status}:{ok:false,status:response.status,reason:'SERVICE_IDENTITY_MISMATCH'};
    }
    return text.includes(app.healthText)?{ok:true,status:response.status}:{ok:false,status:response.status,reason:'SERVICE_IDENTITY_MISMATCH'};
  }catch(error){return {ok:false,reason:['TimeoutError','AbortError'].includes(error.name)?'TIMEOUT':error.cause?.code||error.code||'CONNECTION_FAILED'};}
}
