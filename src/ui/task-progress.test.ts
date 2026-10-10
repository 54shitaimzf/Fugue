import assert from 'node:assert/strict'
import {test} from 'node:test'
import {taskOf} from './task.ts'
import {openSession} from './follow.ts'
import {openTerm} from './term.ts'
import {statusOf} from '../probe/status.ts'
import type {StatusRow} from '../probe/status.ts'
import {setGlyphTier,widthOf} from './glyph.ts'
let sequence=0
const row=(e:object)=>({pos:{writer:'agent' in e ? String(e.agent) : 'round',seq:++sequence},e} as StatusRow)
const state=(from:string,to:string)=>row({t:'round/state',round:'r1',from,to})
const issue=row({t:'contract/issue',round:'r1',owner:'agent/r1/1',contract:'r1.implement.1',paths:['a.txt'],body:'{}'})
const base=[state('Idle','Planning'),row({t:'round/intent',round:'r1',body:JSON.stringify({goal:'核查后改动两个文件'})}),row({t:'holder/distill',round:'r1',agent:'round',body:'原模型理解必须保留'}),issue,state('Delegated','Working')]
const run=row({t:'run/start',agent:'agent/r1/1',argv0:'node',argv:['node','check.js']})
const merge=row({t:'merge/attempt',round:'r1',branches:[],conflicts:0})
const texts=(rows:readonly StatusRow[])=>taskOf(rows).rows.map(r=>r.text)
test('issued contracts do not prove execution; only observed action supplies a current command',()=>{
 const t=texts(base);assert.equal(t[0],'这批任务已确认，结果尚未写回。');assert.ok(!t.some(s=>s.includes('正在处理')||s==='正在执行'))
 assert.equal(texts([...base,run])[0],'正在执行：node check.js')
 for(const to of ['Collecting','Merging','Verifying','Aborted'])assert.ok(!texts([...base,run,state('Working',to)]).some(s=>s.includes('node check.js')),'a new phase invalidates the previous action')
 assert.equal(texts([...base,run,state('Working','Working')])[0],'正在执行：node check.js','same-phase event does not pretend an observed action ended')
 assert.ok(t.includes('你\n核查后改动两个文件'));assert.ok(t.includes('模型 · 当前理解\n原模型理解必须保留'))
})
test('verification outcome never retains the prior merging caption, including full record projection',()=>{
 const merging=[...base,merge]
 assert.ok(texts(merging).some(s=>s.includes('正在合并结果')))
 for(const to of ['Working','Aborted','Committed','Rebuilding']){
  const v=[...merging,state('Merging','Verifying'),state('Verifying',to)]
  for(const full of [false,true]){
   const t=taskOf(v,null,full).rows.map(r=>r.text)
   assert.ok(!t.some(s=>s.includes('正在合并结果')),'old merging text is no longer a current action')
   assert.ok(t[0]!.includes(to==='Working'||to==='Aborted'?'未写回':to==='Committed'?'待写回':'已写回'))
  }
 }
 const retry=[...merging,state('Merging','Verifying'),state('Verifying','Working'),run]
 assert.ok(texts(retry).includes('正在执行：node check.js'),'new observed retry action is still visible under last failure outcome')
})
test('missing ownership/state metadata keeps the original status floor and original problems/messages',()=>{
 assert.deepEqual(taskOf([]),{round:null,state:null,rows:[],plan:[]})
 assert.equal(texts([state('Delegated','Working')])[0],'正在执行','no issued-contract evidence keeps the existing floor')
 const bad=[...base,run,row({t:'run/end',agent:'agent/r1/1',exit:7}),state('Working','Collecting')]
 assert.equal(texts(bad).filter(s=>s==='命令失败（退出码 7）。').length,1,'problem stays once after prior action is cleared')
 const unknown=[...base,run,state('Working','future-state')]
 assert.ok(!texts(unknown).some(s=>s.includes('node check.js')));assert.ok(texts(unknown).includes('模型 · 当前理解\n原模型理解必须保留'))
 const machine=statusOf(base);taskOf(base);assert.deepEqual(statusOf(base),machine,'read-only human projection leaves machine snapshot exact')
})
test('multi-frame task progress, retries and narrow geometry keep idle bytes zero and permanent history unchanged',()=>{
 let frames=0,idles=0
 const additions=[base,[run],[state('Working','Collecting')],[state('Collecting','Merging'),merge],[state('Merging','Verifying')],[state('Verifying','Working')],[run],[state('Working','Collecting')],[state('Collecting','Merging'),merge],[state('Merging','Verifying')],[state('Verifying','Committed')],[state('Committed','Rebuilding')]]
 try{for(const glyph of ['ascii','box','rich'] as const)for(const [cols,rows] of [[192,45],[80,19],[24,7]]){
  setGlyphTier(glyph);const session=openSession(),written:string[]=[];const term=openTerm({term:'xterm',height:rows,out:{isTTY:true,columns:cols,rows:rows+5,write:s=>written.push(s)}})
  const all:StatusRow[]=[]
  try{for(const fresh of additions){
   all.push(...fresh);session.push(fresh);const p=session.panel({columns:cols,height:rows});assert.equal(p.rows.length,rows);assert.ok(p.rows.every(s=>widthOf(s)===cols));if(cols>=80){const shown=p.rows.join('\n');if(fresh===base)assert.ok(shown.includes('这批任务已确认，结果尚未写回。'));if(fresh.some(r=>r.e.t==='round/state'&&r.e.from==='Verifying'&&r.e.to==='Working')){assert.ok(shown.includes('验收未通过'));assert.ok(!shown.includes('正在合并结果，尚待验收与写回。'))}}
   assert.deepEqual(session.permanent(),openSessionWith(all).permanent(),'progress does not rewrite permanent history')
   written.length=0;term.draw([],()=>p);frames++;written.length=0;term.draw([],()=>session.panel({columns:cols,height:rows}));frames++;assert.equal(written.join(''),'');idles++
  }}finally{term.close()}
 }}finally{setGlyphTier('box')}
 assert.equal(frames,216);assert.equal(idles,108)
 console.log('task progress:12 event steps x3 glyphs x3 sizes;216 frames;108 idle bytes0;phase actions expire;real retry action retained;permanent stream exact')
})
function openSessionWith(rows:readonly StatusRow[]){const s=openSession();s.push(rows);return s}

