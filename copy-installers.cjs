'use strict';
const fs=require('node:fs'), crypto=require('node:crypto');
const {pipeline}=require('node:stream/promises'),{Readable}=require('node:stream');
const spec=JSON.parse(JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH)).inputs.transfer);
async function run(){
  if(!/^\d+\.\d+\.\d+$/.test(spec.version)||spec.files.length!==8)throw Error('Invalid release.');
  const names=new Set(['manager-windows','windows','manager-macos-intel','macos-intel','teacher-android','manager-android','student-android','it-android'].map(t=>'noring-'+t+'-'+spec.version+(t.includes('windows')?'.exe':t.includes('macos')?'.dmg':'.apk')));
  const api='https://api.github.com/repos/'+process.env.GITHUB_REPOSITORY;
  const headers={Authorization:'Bearer '+process.env.GH_TOKEN,'User-Agent':'Noring-publisher',Accept:'application/vnd.github+json'};
  const r=await fetch(api+'/releases/'+Number(spec.draft),{headers});
  const draft=await r.json();if(!r.ok||draft.tag_name!=='v'+spec.version||!draft.draft)throw Error('Expected draft release.');
  for(const f of spec.files){
    const source=new URL(f.url);
    if(!names.delete(f.name)||source.origin!=='https://release-assets.githubusercontent.com'||!/^sha256:[0-9a-f]{64}$/.test(f.digest)||!Number.isSafeInteger(f.size)||f.size<1||f.size>250000000)throw Error('Unexpected file.');
    console.log('::add-mask::'+f.url);
    const existing=draft.assets.find(x=>x.name===f.name);
    if(existing){if(existing.digest!==f.digest)throw Error('Conflicting release asset.');continue}
    const download=await fetch(source,{redirect:'error'});if(!download.ok)throw Error('Download failed.');
    await pipeline(Readable.fromWeb(download.body),fs.createWriteStream(f.name,{flags:'wx'}));
    const hash=crypto.createHash('sha256');for await(const b of fs.createReadStream(f.name))hash.update(b);
    if('sha256:'+hash.digest('hex')!==f.digest||fs.statSync(f.name).size!==f.size)throw Error('Transfer integrity check failed.');
    const upload=new URL(draft.upload_url.split('{')[0]);upload.searchParams.set('name',f.name);
    const up=await fetch(upload,{method:'POST',headers:{...headers,'Content-Type':'application/octet-stream','Content-Length':String(f.size)},body:fs.createReadStream(f.name),duplex:'half'});
    if(!up.ok||(await up.json()).digest!==f.digest)throw Error('Staging failed.');
    fs.unlinkSync(f.name);console.log('Verified '+f.name)
  }
}
run().catch(e=>{console.error(e.message);process.exitCode=1})
