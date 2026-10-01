#!/usr/bin/env node
// 同一份下层 blob 语料：旧整树预取/扫描 vs 32候选分批+回执早停。
// dense/sparse/miss 各量冷/热；验证结果与请求/读取数，不作速度断言，不碰模型或凭据。
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { openTruth } from '../src/truth/truth.ts'
import { openLog } from '../src/log/log.ts'
import { loadView } from '../src/view/view.ts'
import { lowerAt } from '../src/view/lower.ts'
import { createRoots } from '../src/roots/roots.ts'
import { createToolHost } from '../src/tools/host.ts'
import { refHeadOf } from '../src/round/head.ts'
import { faceOf } from '../src/tools/execute.ts'
import { capReceipt } from '../src/tools/receipt.ts'

const at = process.argv.indexOf('--runs')
const runs = at === -1 ? 3 : Number(process.argv[at+1])
if (!Number.isSafeInteger(runs) || runs < 1 || runs > 20) throw new Error('--runs must be an integer from1to20')
const env = { ...process.env,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_SYSTEM:'/dev/null',GIT_AUTHOR_NAME:'fugue',GIT_AUTHOR_EMAIL:'fugue@localhost',GIT_COMMITTER_NAME:'fugue',GIT_COMMITTER_EMAIL:'fugue@localhost' }
const ctx = { agent:'bench',step:0,cwd:'',holder:false }
const grep = faceOf('grep')
const referenceAt = process.argv.indexOf('--reference-root')
const referenceRoot = referenceAt === -1 ? null : process.argv[referenceAt + 1]
if (referenceAt !== -1 && (!referenceRoot || referenceRoot.startsWith('--'))) {
  throw new Error('--reference-root requires a checkout path')
}
// 参数/模块失败必须在分配临时工作区之前发生。
const referenceGrep = referenceRoot === null ? null
  : (await import(pathToFileURL(join(resolve(referenceRoot), 'src/tools/execute.ts')).href)).faceOf('grep')
if (referenceRoot !== null && typeof referenceGrep !== 'function') throw new Error('reference has no grep implementation')
const root = mkdtempSync(join(tmpdir(),'fugue-search-stop-'))
let totalBytes = 0

async function build() {
  execFileSync('git',['init','-q',root],{ env })
  const truth = openTruth(root)
  try {
    const entries = []
    for (let file=0;file<256;file++) {
      const body = Array.from({ length:64 },(_,line) => `dense_hit file${file} row${line} `+'x'.repeat(96)+(file%64===0 && line===63 ? ' rare_hit' : '')).join('\n')+'\n'
      const bytes = Buffer.from(body)
      totalBytes += bytes.length
      entries.push({ name:`corpus/file-${String(file).padStart(3,'0')}.txt`,mode:0o100644,id:await truth.putBlob(bytes) })
    }
    return await truth.commit(await truth.putTree(entries),[],'fixed search corpus')
  } finally { await truth.close() }
}

async function baseline(pattern,host) {
  const paths = await host.walk()
  if (host.prefetch) await host.prefetch(paths)
  const re = new RegExp(pattern)
  const hits = []
  for (const path of paths) {
    const got = await host.readBytes(path)
    if (!got) continue
    Buffer.from(got.bytes).toString('utf8').split('\n').forEach((line,index) => {
      if (re.test(line)) hits.push(`${path}:${index+1}:${line}`)
    })
  }
  return capReceipt(hits.length===0 ? `no line matches ${pattern}.` : `${hits.length} lines:\n${hits.join('\n')}`)
}

async function pair(base,pattern,reference) {
  const truth = openTruth(root)
  const log = openLog(root,{ write:'bench',sync:'never' })
  try {
    const view = await loadView(log,'bench',{ lower:lowerAt(truth,base) })
    const product = createToolHost(view,createRoots(root),{ actions:{ writer:'bench',log,truth,head:await refHeadOf(log,'bench',base) } })
    let reads = 0
    let prefetchPaths = 0
    const host = { ...product,
      readBytes:async path => { reads++; return product.readBytes(path) },
      prefetch:async paths => { prefetchPaths += paths.length; return product.prefetch(paths) },
    }
    const invoke = () => reference
      ? referenceGrep ? referenceGrep({ pattern }, host, ctx).then(result => capReceipt(result.output)) : baseline(pattern,host)
      : grep({ pattern },host,ctx).then(result => capReceipt(result.output))
    const phases = []
    const outputs = []
    for (const phase of ['cold','hot']) {
      reads=0;prefetchPaths=0
      const before = truth.stats().gitRequests
      const start = performance.now()
      const output = await invoke()
      phases.push({ phase,ms:performance.now()-start,requests:truth.stats().gitRequests-before,reads,prefetchPaths })
      outputs.push(output)
    }
    assert.equal(outputs[0],outputs[1],'same-target cold/hot receipts differ')
    return { phases,output:outputs[0] }
  } finally { await log.close();await truth.close() }
}

const median = xs => [...xs].sort((a,b) => a-b)[Math.floor(xs.length/2)]
const summarize = results => Object.fromEntries(['cold','hot'].map(phase => {
  const values = results.flatMap(result => result.phases.filter(value => value.phase===phase))
  return [phase,{ medianMs:Number(median(values.map(value=>value.ms)).toFixed(3)),requests:values.map(value=>value.requests),reads:values.map(value=>value.reads),prefetchPaths:values.map(value=>value.prefetchPaths) }]
}))
try {
  const base = await build()
  const cases = {}
  for (const [name,pattern] of [['dense','dense_hit'],['sparse','rare_hit'],['miss','not_in_this_corpus']]) {
    const before=[];const after=[]
    for (let run=0;run<runs;run++) {
      before.push(await pair(base,pattern,true));after.push(await pair(base,pattern,false))
    }
    if (referenceGrep) assert.equal(after[0].output, before[0].output, 'batch strategy changed receipt semantics')
    else if (name==='dense') {
      assert.match(after[0].output,/Search stopped/)
      assert.ok(after[0].phases[0].reads < before[0].phases[0].reads)
      assert.ok(after[0].phases[0].prefetchPaths < before[0].phases[0].prefetchPaths)
    } else assert.equal(after[0].output,before[0].output,'complete sparse/miss result differs')
    cases[name]={ pattern,baseline:summarize(before),bounded:summarize(after) }
  }
  console.log(JSON.stringify({ files:256,linesPerFile:64,bytes:totalBytes,runs,cases,comparison:referenceGrep ? 'prior bounded fixed-batch source' : 'legacy full-prefetch/scanning on current cache',boundary:'cloud trend only; same immutable lower corpus; full blobs are still retrieved for scanned files' },null,2))
} finally { rmSync(root,{ recursive:true,force:true }) }
