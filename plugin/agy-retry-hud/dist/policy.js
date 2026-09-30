export const defaults=Object.freeze({quotaFallbackMs:18000000,resetMarginMs:90000,jitterMs:30000,transientBaseMs:60000,transientCapMs:900000,maxTransientRetries:6,maxQuotaRetries:2,maxJobElapsedMs:86400000,watchdogMs:3600000});

function hints(text,now){
 const at=text.match(/reset(?:s)?\s+(?:at|on)\s+([^\n]+)/i);
 if(at){const iso=at[1].match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})/);if(!iso||!Number.isFinite(Date.parse(iso[0])))return {ambiguous:true};return {resetAt:Date.parse(iso[0])};}
 const relative=text.match(/(?:reset(?:s)?\s+(?:in|after)|retry\s+(?:in|after)|try again in)\s+((?:\d+(?:\.\d+)?\s*(?:days?|hours?|minutes?|seconds?|[dhms])\s*)+)/i);
 if(relative){let ms=0;for(const m of relative[1].matchAll(/(\d+(?:\.\d+)?)\s*(days?|hours?|minutes?|seconds?|[dhms])/gi))ms+=Number(m[1])*({d:86400000,h:3600000,m:60000,s:1000}[m[2][0].toLowerCase()]);if(!Number.isFinite(ms)||ms<=0)return {ambiguous:true};return {resetAt:now+ms,retryAfterMs:ms};}
 return {};
}

export function classify(result,now=Date.now()){
 if(result?.status==='SUCCESS')return {kind:'success'};
 if(['CANCELED','INTERRUPTED'].includes(result?.status))return {kind:'canceled'};
 if(result?.status!=='ERROR')return {kind:'needs_user'};
 const raw=result.error;
 if(raw&&typeof raw==='object'&&Object.values(raw).some(v=>v!==null&&typeof v==='object'))return {kind:'unknown'};
 const text=typeof raw==='string'?raw:raw?.message;
 if(typeof text!=='string'||!text.trim())return {kind:'unknown'};
 const hint=hints(text,now);
 if(/\b(?:401|403)\b|unauthenticated|permission denied|billing|spend cap|prepaid|credits? (?:exhausted|depleted)|invalid (?:api key|model)|context (?:length|window).*exceed/i.test(text))return {kind:'permanent'};
 if(hint.ambiguous)return {kind:'unknown'};
 if(/weekly|daily/i.test(text)&&/quota|limit/i.test(text))return {kind:'long-quota',...hint};
 if(/individual quota|quota (?:reached|exhausted)|5[ -]?hour.*limit/i.test(text))return {kind:'quota',...hint};
 if(raw?.retryable===false)return {kind:'permanent'};
 if(/\b(?:502|503|504)\b|service unavailable|bad gateway|ECONNRESET|ETIMEDOUT|EAI_AGAIN|mid.stream.*interrupt/i.test(text))return {kind:'transient',...hint};
 if(/\b429\b|RESOURCE_EXHAUSTED/i.test(text)&&(hint.retryAfterMs||/per.minute/i.test(text)||raw?.retryable===true))return {kind:'transient',...hint};
 if(/\b500\b/.test(text)&&raw?.retryable===true)return {kind:'transient',...hint};
 return {kind:'unknown'};
}

export function decide(c,b,now,jitter=0,config=defaults){
 const cfg={...defaults,...config};
 if(!Number.isFinite(now)||!Number.isFinite(b.startedAt)||now-b.startedAt>=cfg.maxJobElapsedMs)return {action:'exhausted',reason:'job budget expired'};
 jitter=Math.max(0,Math.min(cfg.jitterMs,jitter));
 let delay,at,action;
 if(['quota','long-quota'].includes(c.kind)){
  if((b.quotaRetries||0)>=cfg.maxQuotaRetries)return {action:'exhausted',reason:'quota retry budget exhausted'};
  if(c.kind==='long-quota'&&!c.resetAt)return {action:'needs_user',reason:'long quota reset unknown'};
  if(c.resetAt&&c.resetAt<=now)return {action:'needs_user',reason:'quota reset passed but still blocked'};
  at=(c.resetAt||now+cfg.quotaFallbackMs)+cfg.resetMarginMs+jitter;action='wait_quota';
 }else if(c.kind==='transient'){
  const n=b.transientRetries||0;if(n>=cfg.maxTransientRetries)return {action:'exhausted',reason:'API retry budget exhausted'};
  delay=Math.max(Math.min(cfg.transientBaseMs*2**n,cfg.transientCapMs),c.retryAfterMs||0,(c.resetAt||now)-now);
  at=now+delay+jitter;action='wait_backoff';
 }else return {action:c.kind==='success'?'success':c.kind==='canceled'?'canceled':'needs_user',reason:c.kind};
 if(!Number.isFinite(at)||at>b.startedAt+cfg.maxJobElapsedMs)return {action:'needs_user',reason:'reset exceeds job budget'};
 return {action,at,reason:c.kind};
}
