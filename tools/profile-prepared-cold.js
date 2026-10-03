#!/usr/bin/env node
// Developer-only exact current-source profile; no source edits or host reader replacement.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import fsp from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { Session } from 'node:inspector'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { withCohortBenchmarkHandles } from './cohort-benchmark-owned.js'
import { cleanupProfileBenchmark } from './profile-benchmark-cleanup.js'
const root = resolve(import.meta.dirname, '..'), hash = b => createHash('sha256').update(b).digest('hex')
const api = {}
const modules = ['src/tools/execute.ts','src/tools/host.ts','src/tools/grep-verifier.ts','src/tools/prefetch-plan.ts','src/search/view-cohort.ts','src/search/cohort-store.ts','src/search/cohort-format.ts','src/search/index-format.ts','src/search/regex-literal.ts','src/truth/truth.ts','src/truth/git.ts','src/view/view.ts','src/view/lower.ts','src/log/log.ts','src/round/head.ts','src/roots/roots.ts']
for (const path of modules) Object.assign(api, await import(pathToFileURL(join(root,path)).href))
const commit = execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim()
const made = [], temp = prefix => { const path=mkdtempSync(join(root,prefix)); made.push(path); return path }
const delta=(a,b)=>b==null?null:Object.fromEntries(Object.keys(b).filter(k=>typeof b[k]==='number').map(k=>[k,b[k]-(a?.[k]??0)]))
const originalOpen = fsp.open
let artifactIO = {}
let outcome={failed:false}
try {
fsp.open = async (...args) => {
 const handle = await originalOpen(...args)
 if (typeof args[0] === 'string' && args[0].endsWith('.bin')) {
  const read = handle.read.bind(handle)
  handle.read = async (...args) => { const start=performance.now(); try { const result=await read(...args); artifactIO.readCalls=(artifactIO.readCalls??0)+1; artifactIO.bytes=(artifactIO.bytes??0)+result.bytesRead; return result } finally { artifactIO.readMs=(artifactIO.readMs??0)+performance.now()-start } }
 }
 return handle
}
syncBuiltinESMExports()
 const home=temp('.profile-home-'), env={PATH:process.env.PATH, HOME:home,LC_ALL:'C',GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_SYSTEM:'/dev/null',GIT_AUTHOR_NAME:'fugue',GIT_AUTHOR_EMAIL:'fugue@localhost',GIT_COMMITTER_NAME:'fugue',GIT_COMMITTER_EMAIL:'fugue@localhost'}
 const profiles=[]
 for (const profile of ['code','mixed','entropy']) {
  const digest=createHash('sha256'), bodies=[];let seed=0x541ea
  const random=()=>{seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return seed&255}
  for(let file=0;file<512;file++) {
   const body=Buffer.alloc(32768)
   for(let line=0;line<256;line++) {
    const offset=line*128
    if(profile==='entropy')for(let at=0;at<127;at++)body[offset+at]=random();else body.fill(0x78,offset,offset+127)
    const marker=Buffer.from(`dense_hit f${String(file).padStart(3,'0')} l${String(line).padStart(3,'0')} `+(profile==='mixed'?'const 变量 = "😀 e\u0301";\0 ':'const value = 42; '))
    marker.copy(body,offset);body[offset+127]=10
   }
   if(file===511)Buffer.from(' rare_hit ').copy(body,body.length-11)
   const path=`corpus/file-${String(file).padStart(3,'0')}`;bodies.push({path,body});digest.update(path+'\0');digest.update(body)
  }
  const repo=temp('.prepared-profile-');execFileSync('git',['init','-q','--object-format=sha1',repo],{env})
  const seedStart=performance.now()
  let base,ids=[]
  {const truth=api.openTruth(repo);try{const entries=[];for(const {path,body}of bodies){const id=await truth.putBlob(body);ids.push(id);entries.push({name:path,mode:0o100644,id})}base=await truth.commit(await truth.putTree(entries),[],'generated prepared cold profile')}finally{await truth.close()}}
  const seedMs=performance.now()-seedStart
  const cases=[['sparse',{pattern:'rare_hit'}],['miss',{pattern:'absent_needle'}],['dense',{pattern:'dense_hit'}],['unsupported',{pattern:'rare(?:_hit)'}],['capture',{pattern:'rare(_hit)'}]]
  async function session(indexed,run) {
   return withCohortBenchmarkHandles(async owned=>{
    const setupStart=performance.now()
    const truth=owned.truth=api.openTruth(repo),log=owned.log=api.openLog(repo,{write:'bench',sync:'never'})
    const view=await api.loadView(log,'bench',{lower:api.lowerAt(truth,base)}),head=await api.refHeadOf(log,'bench',base)
    let gauges={};const record=async(kind,fn)=>{const start=performance.now();try{return await fn()}finally{gauges[kind+'Calls']=(gauges[kind+'Calls']??0)+1;gauges[kind+'Ms']=(gauges[kind+'Ms']??0)+performance.now()-start}}
    const read=view.read.bind(view),stat=view.stat.bind(view),prefetch=truth.prefetchBlobs.bind(truth)
    view.read=path=>record('viewRead',()=>read(path));view.stat=path=>record('viewStat',()=>stat(path))
    truth.prefetchBlobs=ids=>{gauges.prefetchedIds=(gauges.prefetchedIds??0)+ids.length;return record('truthPrefetch',()=>prefetch(ids))}
    const roots=api.createRoots(repo),scan=api.createToolHost(view,roots);let index,store
    if(indexed){store=owned.store=api.createCohortIndexStore(repo);const read=store.read.bind(store);store.read=ids=>record('artifactStoreRead',()=>read(ids));index=owned.index=api.createViewCohortLookup(view,()=>scan.walk(),store);const filter=index.filterCandidates.bind(index);index.filterCandidates=(paths,grams)=>record('filter',()=>filter(paths,grams))}
    const host=api.createToolHost(view,roots,{actions:{writer:'bench',log,truth,head},...(index?{cohortIndex:index}:{})}),readBytes=host.readBytes,prefetchHost=host.prefetch
    const walk=host.walk.bind(host);host.walk=(...args)=>record('walk',()=>walk(...args))
    const detailed=host.walkDetailed.bind(host);host.walkDetailed=()=>record('walkDetailed',()=>detailed())
    const setupMs=performance.now()-setupStart
    async function measure(name,args,prepare=false){gauges={};artifactIO={};const prior={truth:truth.stats(),index:index?.stats(),store:store?.stats(),verify:api.grepVerificationStats(host)},cpu=process.cpuUsage(),start=performance.now();const result=prepare?await index.prepare(id=>truth.getBlob(id),{prefetchBlobs:ids=>truth.prefetchBlobs(ids)}):await api.faceOf('grep')(args,host,{agent:'bench',step:0,cwd:'',holder:false});const used=process.cpuUsage(cpu);assert.equal(host.readBytes,readBytes);assert.equal(host.prefetch,prefetchHost);if(!prepare)assert.equal(result.ok,true);return{name,args,setupMs,ms:performance.now()-start,cpuUserMs:used.user/1000,cpuSystemMs:used.system/1000,gauges:{...gauges},artifactIO:{...artifactIO},truthDelta:delta(prior.truth,truth.stats()),indexDelta:delta(prior.index,index?.stats()),storeDelta:delta(prior.store,store?.stats()),verificationDelta:delta(prior.verify,api.grepVerificationStats(host)),result}}
    return{measure}
   },run)
  }
  const preparation=await session(true,s=>s.measure('preparation',null,true)),results=[]
  // Query-cold means fresh Truth/View/adapter/verifier handles. OS cache stays uncontrolled.
  for(const [name,args]of (profile==='entropy'?cases.filter(([n])=>n==='sparse'||n==='unsupported'):cases)){const reference=await session(false,s=>s.measure(name,args)),trials=[];for(let run=0;run<(profile==='entropy'?1:2);run++){const pair=await session(true,async s=>[await s.measure(name,args),await s.measure(name+'Repeat',args)]);for(const got of pair)assert.deepEqual(got.result,reference.result,`${profile}/${name} full FaceResult`);trials.push(pair)}results.push({name,args,reference,trials})}
  const artifactDir=join(repo,'.fugue','idx','v1','cohorts')
  const artifacts=existsSync(artifactDir)?readdirSync(artifactDir).filter(n=>n.endsWith('.bin')):[]
  let decodeReplay=null
  if(artifacts.length){assert.equal(artifacts.length,1);const bytes=readFileSync(join(repo,'.fugue','idx','v1','cohorts',artifacts[0]));const samples=[];for(let at=0;at<5;at++){const cpu=process.cpuUsage(),start=performance.now(),index=api.decodeCohortIndex(bytes,ids);const used=process.cpuUsage(cpu);assert.ok(index);samples.push({ms:performance.now()-start,cpuUserMs:used.user/1000,cpuSystemMs:used.system/1000})}decodeReplay={artifactBytes:bytes.length,artifactSha256:hash(bytes),gramCount:api.decodeCohortIndex(bytes,ids).gramCount,postingCount:api.decodeCohortIndex(bytes,ids).postingCount,samples}}
  for(const item of results)for(const got of [item.reference,...item.trials.flat()]){got.receiptSha256=hash(JSON.stringify(got.result));got.outputBytes=Buffer.byteLength(got.result.output);got.truncated=got.result.output.includes('Search stopped at the receipt budget');delete got.result}
  const cpuProfiles=[]
  if(profile==='code')for(const [name,args]of cases.filter(([n])=>n==='sparse'||n==='unsupported')){const inspector=new Session();inspector.connect();const post=(method,params={})=>new Promise((resolve,reject)=>inspector.post(method,params,(e,r)=>e?reject(e):resolve(r)));try{await post('Profiler.enable');await post('Profiler.setSamplingInterval',{interval:250});const got=await session(true,async s=>{await post('Profiler.start');const startUs=Number(process.hrtime.bigint()/1000n),measurement=await s.measure(name+'CpuProfile',args),endUs=Number(process.hrtime.bigint()/1000n);const {profile:cpu}=await post('Profiler.stop');return{measurement,profile:cpu,queryBoundsHrtimeUs:{startUs,endUs}}});assert.deepEqual(got.measurement.result,await session(false,async s=>(await s.measure(name,args)).result));got.measurement.receiptSha256=hash(JSON.stringify(got.measurement.result));delete got.measurement.result;cpuProfiles.push({name,...got})}finally{inspector.disconnect()}}
  for(const name of ['unsupported','capture']){const candidate=results.find(r=>r.name===name);if(candidate)assert.equal(candidate.reference.receiptSha256,results.find(r=>r.name==='sparse').reference.receiptSha256,'literal/group equivalence')}
  console.error(JSON.stringify({profile,preparationMs:preparation.ms,prepared:preparation.result,results:results.map(r=>({name:r.name,plain:r.reference.ms,first:r.trials[0][0].ms,reads:r.trials[0][0].gauges.viewReadCalls??0,store:r.trials[0][0].gauges.artifactStoreReadMs??0}))}))
  profiles.push({profile,files:512,bytes:16777216,corpusSha256:digest.digest('hex'),seedMs,preparation,decodeReplay,results,cpuProfiles})
 }
 console.log(JSON.stringify({schema:1,node:process.version,commit,sourceHashes:Object.fromEntries(modules.map(p=>[p,hash(readFileSync(join(root,p)))])),scriptSha256:hash(readFileSync(import.meta.filename)),fullFaceResultEquality:true,profiles,boundary:'Fresh handles, same process fixed scenario order, OS/JIT/page-cache effects uncontrolled; no physical-cold certificate. Real actions/Truth prefetch; host reader/prefetch identity retained. View stat/read, filter, artifact store and Truth prefetch timers are INCLUSIVE and overlap, never additive. SetupMs records fresh handle/factory admission outside the query; seedMs separately charges generated Git seeding (not corpus byte generation). Inspector profiles are diagnostic extra fresh queries with setup before profiler start and recorded monotonic query bounds; profiler overhead and sampling remain. Decode replay uses exact artifact and codec independently after measured queries; not direct query decode attribution. Preparation charged including optional prefetch. Code/mixed/entropy match historical 512x32KiB generated corpus. Plain references unbound/default; complete bounded FaceResults including truncation compared. No provider, product edit, default activation or RSS/cold50ms claim.'},null,2))
}catch(error){outcome={failed:true,error}}
finally{await cleanupProfileBenchmark(()=>{fsp.open=originalOpen;syncBuiltinESMExports()},made.reverse().map(path=>()=>rmSync(path,{recursive:true,force:true})),outcome)}
