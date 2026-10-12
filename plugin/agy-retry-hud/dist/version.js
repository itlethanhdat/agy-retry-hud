export const MIN_AGY_VERSION='1.1.15';
export const RECOMMENDED_AGY_VERSION='1.2.13';
// Single source of truth for this package's own version. Keep in sync with
// package.json on release; daemon.js, cli.js and retryctl.js read it from here.
export const PKG_VERSION='0.5.1';

export function parseSemver(text){
 const m=String(text??'').match(/(?:^|\s|v)(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?(?:\s|$)/);
 if(!m)return null;
 return m.slice(1,4).map(Number);
}

export function compareSemver(a,b){
 for(let i=0;i<3;i++){const d=a[i]-b[i];if(d)return d<0?-1:1;}return 0;
}

export function versionAtLeast(text,minimum=MIN_AGY_VERSION){
 const actual=parseSemver(text),required=parseSemver(minimum);
 return Boolean(actual&&required&&compareSemver(actual,required)>=0);
}
