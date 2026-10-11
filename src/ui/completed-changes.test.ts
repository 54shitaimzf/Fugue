import assert from 'node:assert/strict'
import { test } from 'node:test'
import { openStage } from './stage.ts'
import { openSession } from './follow.ts'
import { openTerm } from './term.ts'
import { taskOf } from './task.ts'
import { setGlyphTier, widthOf } from './glyph.ts'
import { themeOf } from './theme.ts'
import type { StatusRow } from '../probe/status.ts'
import type { CommitChanges } from '../serve/commit-source.ts'
const base = 'a'.repeat(40), commit = 'b'.repeat(40)
const rows: StatusRow[] = [
 { pos: {writer:'round',seq:1}, e: {t:'round/intent',round:'r1',base,body:'核对现状并更新文件'} },
 { pos: {writer:'round',seq:2}, e: {t:'holder/distill',round:'r1',agent:'round',body:'原模型原文'} },
 { pos: {writer:'round',seq:3}, e: {t:'contract/issue',round:'r1',owner:'agent/r1/1',paths:['unused.txt'],body:'{}'} },
 { pos: {writer:'round',seq:4}, e: {t:'round/state',round:'r1',from:'Verifying',to:'Rebuilding'} },
 { pos: {writer:'round',seq:5}, e: {t:'merge/accept',round:'r1',commit,assertions:[{assertion:'检查',verdict:'pass'}]} },
] as StatusRow[]
const changes: CommitChanges = {round:'r1',base,commit,files:[
 {kind:'A',path:'actual.txt'},{kind:'M',path:'src/main.ts'},{kind:'D',path:'removed.txt'},
 {kind:'A',path:'strange\n name\t\x1b.txt'},{kind:'T',path:'link.txt'},
]}
const messages = (r: readonly StatusRow[], c?: CommitChanges, full=false) => taskOf(r,null,full,c).rows.map(x=>x.text).join('\n')
test('accepted recorded commits supply a short actual change summary and complete readable paths; contract coverage is never a changed-file list',()=>{
 assert.deepEqual(taskOf(rows).completion,{round:'r1',base,commit})
 const short=messages(rows,changes),full=messages(rows,changes,true)
 assert.match(short,/提交改动（5）/);assert.match(short,/actual.txt · src\/main.ts · removed.txt · …/)
 assert.doesNotMatch(short,/unused\.txt|strange/);assert.match(full,/原模型原文/);assert.match(full,/新增：actual\.txt/)
 assert.ok(full.indexOf('本次提交改动')<full.indexOf('你\n'),'completion read opens with current result before long prior discussion')
 assert.match(full,/删除：removed\.txt/);assert.match(full,/类型变更：link\.txt/)
 assert.ok(full.includes(JSON.stringify(changes.files[3]!.path)),'control/whitespace filename stays one escaped readable path')
 assert.ok(!full.includes('\x1b'),'filename cannot issue terminal controls')
 assert.doesNotMatch(messages(rows,{...changes,files:[]}),/actual\.txt/);assert.match(messages(rows,{...changes,files:[]}),/没有文件改动/)
 assert.deepEqual(taskOf(rows,null,false,null as never),taskOf(rows),'missing packet keeps original projection')
 for(const c of [{...changes,round:'old'},{...changes,base:'c'.repeat(40)},{...changes,commit:'d'.repeat(40)},{...changes,files:[{kind:'R',path:'guessed'}]}]){
  assert.deepEqual(taskOf(rows,null,false,c as never),taskOf(rows),'foreign/incomplete changes keep original task exactly')
 }
 for(const phase of ['Committed','Working','Verifying','Aborted','future']){
  const r=rows.map(x=>x.e.t==='round/state'?{...x,e:{...x.e,to:phase}}:x) as StatusRow[]
  assert.equal(taskOf(r).completion,undefined);assert.deepEqual(taskOf(r,null,false,changes),taskOf(r))
 }
 for(const r of [rows.filter(x=>x.e.t!=='merge/accept'),rows.map(x=>x.e.t==='round/intent'?{...x,e:{...x.e,base:''}}:x),rows.map(x=>x.e.t==='merge/accept'?{...x,e:{...x.e,assertions:[{verdict:'fail'}]}}:x)]){
  assert.equal(taskOf(r as StatusRow[]).completion,undefined)
 }
 // 对象 id 的**算法是仓库的性质**：sha1 四十位、sha256 六十四位。这一层只问"记下了没有"，
 // 不问字长——按四十位筛会在 sha256 库里把正常输入判死（提交改动摘要整个消失，一声不响）。
 const sha256='c'.repeat(64),sha256Rows=rows.map(x=>x.e.t==='round/intent'?{...x,e:{...x.e,base:sha256}}
  :x.e.t==='merge/accept'?{...x,e:{...x.e,commit:sha256}}:x) as StatusRow[]
 assert.deepEqual(taskOf(sha256Rows).completion,{round:'r1',base:sha256,commit:sha256},
  'sha256 库的六十四位对象 id 被当成坏输入，提交改动摘要整个没了')
 assert.ok(messages(sha256Rows,{round:'r1',base:sha256,commit:sha256,files:changes.files}).includes('提交改动（5）'),
  'sha256 库下改动摘要该照常出得来')
 assert.deepEqual(taskOf(rows,'agent/r1/1',false,changes),taskOf(rows,'agent/r1/1'),'focus does not pretend to own whole completed commit')
})
const tick = async()=>{await Promise.resolve();await Promise.resolve()}
function rig(readCommit: Function){
 let current: readonly StatusRow[] = rows, redrawn=0
 const stage=openStage({rows:()=>current,columns:()=>192,termRows:()=>50,pendingFace:async()=>null,note:()=>{},
  redraw:()=>{redrawn++},run:()=>null,now:()=>0,abort:()=>{},hint:()=>'',readCommit:readCommit as never})
 stage.setRaw(true)
 return {stage,set:(r:readonly StatusRow[])=>{current=r;stage.onAdvance(r)},redrawn:()=>redrawn}
}
test('one read per exact recorded commit; arrivals update the existing task/read route, later task and close abort stale requests',async()=>{
 const jobs:{request:unknown,signal:AbortSignal,resolve:Function}[]=[]
 const r=rig((request:unknown,signal:AbortSignal)=>new Promise(resolve=>jobs.push({request,signal,resolve})))
 r.stage.onAdvance(rows);r.stage.onAdvance([]);assert.equal(jobs.length,1)
 r.stage.onAction({action:'insert',text:'保留的输入草稿'})
 r.stage.onAction({action:'read'});assert.ok(!r.stage.view().read!.rows.join('\n').includes('actual.txt'))
 jobs[0]!.resolve(changes);await tick()
 assert.ok(r.stage.view().read!.rows.join('\n').includes('类型变更：link.txt'),'already-open complete record updates')
 assert.deepEqual(r.stage.view().completedChanges,changes)
 r.stage.onAction({action:'escape'});assert.ok(r.stage.view().input!.rows.join('\n').includes('保留的输入草稿'))
 const next=[...rows,{pos:{writer:'round',seq:6},e:{t:'round/intent',round:'r2',base,body:'下一任务'}}] as StatusRow[]
 r.set(next);assert.ok(jobs[0]!.signal.aborted);assert.equal(r.stage.view().completedChanges,undefined)
 r.set(rows);assert.equal(jobs.length,2);r.stage.close();assert.ok(jobs[1]!.signal.aborted)
 const count=r.redrawn();jobs[1]!.resolve(changes);await tick();assert.equal(r.redrawn(),count,'closed stage does not redraw')
 const pending=rig((request:unknown,signal:AbortSignal)=>new Promise(resolve=>jobs.push({request,signal,resolve})))
 pending.stage.onAdvance(rows);pending.set(next);jobs[2]!.resolve(changes);await tick()
 assert.equal(pending.stage.view().completedChanges,undefined,'late old completion cannot relabel next task');pending.stage.close()
 const unavailable=rig(async()=>null);unavailable.stage.onAdvance(rows);await tick();assert.equal(unavailable.stage.view().completedChanges,undefined);unavailable.stage.close()
})
test('new commit evidence invalidates only task cache; completed/main/read/resize remain bounded, idle zero and source history unchanged',async()=>{
 let frames=0,idles=0
 try{for(const glyph of ['ascii','box','rich'] as const)for(const background of ['dark','light'] as const){
  setGlyphTier(glyph);const r=rig(async()=>changes);const session=openSession({view:r.stage.view});session.push(rows)
  const original=session.permanent();let cols=192,height=45
  const output:string[]=[];const theme=themeOf({term:'xterm-256color',colorFgBg:background==='light'?'0;15':'15;0'})
  const term=openTerm({out:{isTTY:true,get columns(){return cols},get rows(){return height+5},write:s=>output.push(s)},term:'xterm-256color',theme,height})
  const paint=()=>{const p=session.panel({columns:cols,height});assert.equal(p.rows.length,height);assert.ok(p.rows.every(s=>widthOf(s)===cols));term.draw([],()=>p);frames++;output.length=0;term.draw([],()=>session.panel({columns:cols,height}));frames++;assert.equal(output.join(''),'');idles++;return p.rows.join('\n')}
  paint();r.stage.onAdvance(rows);await tick();assert.ok(paint().includes('提交改动'),'cache notices transient evidence without new events')
  r.stage.onAction({action:'read'});assert.ok(r.stage.view().read!.rows.join('\n').includes('link.txt'));paint()
  for(const [c,h] of [[80,19],[24,7],[120,35],[192,45]]){cols=c!;height=h!;r.stage.onResize();paint()}
  r.stage.onAction({action:'escape'});paint();assert.deepEqual(session.permanent(),original);assert.deepEqual(session.rows,rows)
  term.close();r.stage.close()
 }}finally{setGlyphTier('box')}
 assert.equal(frames,96);assert.equal(idles,48);console.log(JSON.stringify({frames,idleSamples:idles,idleBytes:0,themes:2,glyphs:3,resizes:24}))
})
