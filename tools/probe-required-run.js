#!/usr/bin/env node
// Mechanism proof only: manually proved mandatory prefix; no regex parser/source edit.
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {mkdtempSync,readFileSync,readdirSync,rmSync} from 'node:fs'
import {join,resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import {withCohortBenchmarkHandles} from './cohort-benchmark-owned.js'
import {settleBenchmarkCleanups} from './benchmark-cleanup.js'
const root=resolve(import.meta.dirname,'..'),hash=b=>createHash('sha256').update(b).digest('hex'),api={}
const prior=JSON.parse(readFileSync(join(root,'docs/info-batch-investigation/raw.json'),'utf8')),baseline=prior.profiles.find(p=>p.profile==='code').results.find(r=>r.name==='quantifiedFallback'),modules=Object.keys(prior.backends['256'].sourceHashes)
for(const p of modules){assert.equal(hash(readFileSync(join(root,p))),prior.backends['256'].sourceHashes[p]);Object.assign(api,await import(pathToFileURL(join(root,p)).href))}
assert.equal(api.requiredLiteralTrigrams('rare(_hit)?',''),null,'current parser remains unsupported')
const grams=api.requiredLiteralTrigrams('rare','');assert.deepEqual(grams,['are','rar'])
const made=[],temp=prefix=>{const p=mkdtempSync(join(root,prefix));made.push(p);return p},delta=(a,b)=>Object.fromEntries(Object.keys(b).filter(k=>typeof b[k]==='number').map(k=>[k,b[k]-(a?.[k]??0)]))
let outcome={failed:false}
try{
 const home=temp('.required-run-home-'),repo=temp('.required-run-corpus-'),env={PATH:process.env.PATH,HOME:home,LC_ALL:'C',GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_SYSTEM:'/dev/null',GIT_AUTHOR_NAME:'fugue',GIT_AUTHOR_EMAIL:'fugue@localhost',GIT_COMMITTER_NAME:'fugue',GIT_COMMITTER_EMAIL:'fugue@localhost'},digest=createHash('sha256'),bodies=[]
 for(let file=0;file<512;file++){const body=Buffer.alloc(32768);for(let line=0;line<256;line++){const at=line*128;body.fill(0x78,at,at+127);Buffer.from(`dense_hit f${String(file).padStart(3,'0')} l${String(line).padStart(3,'0')} const value = 42; `).copy(body,at);body[at+127]=10}if(file===511)Buffer.from(' rare_hit ').copy(body,body.length-11);const path=`corpus/file-${String(file).padStart(3,'0')}`;digest.update(path+'\0');digest.update(body);bodies.push({path,body})}
 const corpusSha256=digest.digest('hex');assert.equal(corpusSha256,prior.profiles.find(p=>p.profile==='code').corpusSha256)
 execFileSync('git',['init','-q','--object-format=sha1',repo],{env});let base
 {const truth=api.openTruth(repo);try{const entries=[];for(const {path,body}of bodies)entries.push({name:path,mode:0o100644,id:await truth.putBlob(body)});base=await truth.commit(await truth.putTree(entries),[],'generated mandatory-run mechanism proof')}finally{await truth.close()}}
 async function session(run){return withCohortBenchmarkHandles(async owned=>{const truth=owned.truth=api.openTruth(repo),log=owned.log=api.openLog(repo,{write:'bench',sync:'never'}),view=await api.loadView(log,'bench',{lower:api.lowerAt(truth,base)}),roots=api.createRoots(repo),scan=api.createToolHost(view,roots),store=owned.store=api.createCohortIndexStore(repo),index=owned.index=api.createViewCohortLookup(view,()=>scan.walk(),store),host=api.createToolHost(view,roots,{actions:{writer:'bench',log,truth,head:await api.refHeadOf(log,'bench',base)},cohortIndex:index});return{truth,view,index,store,host}},run)}
 const preparation=await session(async({truth,index})=>{const start=performance.now(),before=index.stats();assert.equal(await index.prepare(id=>truth.getBlob(id),{prefetchBlobs:ids=>truth.prefetchBlobs(ids)}),true);return{ms:performance.now()-start,indexDelta:delta(before,index.stats())}})
 const dir=join(repo,'.fugue','idx','v1','cohorts'),files=readdirSync(dir).filter(n=>n.endsWith('.bin'));assert.equal(files.length,1);const artifact=readFileSync(join(dir,files[0]));assert.equal(hash(artifact),prior.profiles.find(p=>p.profile==='code').artifacts[0].sha256)
 const proof=await session(async({truth,view,index,store,host})=>{
  const mark={base:view.base,rev:view.rev},current=()=>view.base===mark.base&&view.rev===mark.rev,originalWalk=host.walkDetailed,originalRead=host.readBytes,originalPrefetch=host.prefetch
  const beforeWalk=truth.stats(),walked=await originalWalk();assert.equal(walked.paths.length,512);assert.equal(walked.truncated,false);const walkDelta=delta(beforeWalk,truth.stats())
  const beforeFilter={truth:truth.stats(),index:index.stats(),store:store.stats()},survivors=[]
  for(let at=0;at<walked.paths.length;at+=128){assert.ok(current());survivors.push(...await index.filterCandidates(walked.paths.slice(at,at+128),grams));assert.ok(current())}
  assert.deepEqual(survivors,['corpus/file-511']);const filterDelta={truth:delta(beforeFilter.truth,truth.stats()),index:delta(beforeFilter.index,index.stats()),store:delta(beforeFilter.store,store.stats())}
  // Explicit fixture: prove negatives first, then expose only surviving paths to unchanged tool/regex.
  // This is not a production authority seam or a parser implementation.
  host.walkDetailed=async()=>{assert.ok(current());return{...walked,paths:[...survivors]}}
  try{const before={truth:truth.stats(),verification:api.grepVerificationStats(host)},receipt=await api.faceOf('grep')({pattern:'rare(_hit)?'},host,{agent:'bench',step:0,cwd:'',holder:false});assert.ok(current());assert.equal(host.readBytes,originalRead);assert.equal(host.prefetch,originalPrefetch);assert.equal(receipt.ok,true);const receiptSha256=hash(JSON.stringify(receipt));assert.equal(receiptSha256,baseline.reference.receiptSha256);for(const trial of baseline.trials)for(const pair of Object.values(trial.pair))assert.equal(pair[0].receiptSha256,receiptSha256);const verificationDelta=delta(before.verification,api.grepVerificationStats(host));assert.equal(verificationDelta.sourceReads,1);return{walkDelta,filterDelta,survivors,unchangedRegexResult:receipt,receiptSha256,queryDelta:{truth:delta(before.truth,truth.stats()),verification:verificationDelta}}}
  finally{host.walkDetailed=originalWalk}
 })
 console.log(JSON.stringify({schema:1,recordedHead:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),equivalentProductSource:prior.backends['256'].commit,sourceHashes:prior.backends['256'].sourceHashes,scriptSha256:hash(readFileSync(import.meta.filename)),priorRawSha256:hash(readFileSync(join(root,'docs/info-batch-investigation/raw.json'))),corpusSha256,files:512,bytes:16777216,pattern:'rare(_hit)?',manuallyProvedMandatoryLiteral:'rare',requiredGrams:grams,preparation,artifact:{bytes:artifact.length,sha256:hash(artifact)},recordedNativeBaseline:{sourceReads:baseline.trials[0].pair['256'][0].verificationDelta.sourceReads,ms:baseline.trials[0].pair['256'][0].ms,receiptSha256:baseline.reference.receiptSha256},proof,boundary:'Single native bounded cohort admission mechanism proof on exact2a product bytes, linked to already-recorded native512-source quantified baseline. No baseline rerun, parser edit, new AST or production elision. Manual mandatory prefix is mathematically required by exact optional-suffix pattern. Counterfactual fixture changes only walkDetailed after original native eager enumeration and actual controlled cohort negatives; original regex/reader/prefetch stays unchanged. One survivor source reproduces complete baseline FaceResult. Setup/preparation/filtering separately observable; no end-to-end optimization timing or grammar-general safety certificate, default activation or cold50ms claim.'},null,2))
}catch(error){outcome={failed:true,error}}
finally{await settleBenchmarkCleanups(made.reverse().map(p=>()=>rmSync(p,{recursive:true,force:true})),outcome)}
