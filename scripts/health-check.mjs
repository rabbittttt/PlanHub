// Lightweight, read-only readiness checks. Never expose response contents in diagnostics.
export async function probeServiceHealth(app,{fetcher=fetch}={}){
  try{
    const response=await fetcher(new URL(app.healthPath,app.target),{redirect:'manual',signal:AbortSignal.timeout(app.healthTimeoutMs??1500)});
    if(!response.ok){await response.arrayBuffer();return {ok:false,status:response.status,reason:'HTTP_ERROR'};}
    if(app.healthKeys?.length){
      let body;try{body=await response.json();}catch(error){if(['TimeoutError','AbortError'].includes(error.name))throw error;return {ok:false,status:response.status,reason:'NOT_JSON'};}
      const missing=app.healthKeys.filter(key=>!body||!Object.hasOwn(body,key));
      return {ok:missing.length===0,status:response.status,...(missing.length?{reason:'MISSING_HEALTH_KEYS',missing}:{})};
    }
    const html=await response.text();
    return html.includes(app.healthText)?{ok:true,status:response.status}:{ok:false,status:response.status,reason:'SERVICE_IDENTITY_MISMATCH'};
  }catch(error){return {ok:false,reason:['TimeoutError','AbortError'].includes(error.name)?'TIMEOUT':error.cause?.code||error.code||'CONNECTION_FAILED'};}
}
