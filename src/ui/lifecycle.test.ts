import assert from 'node:assert/strict'
import { test } from 'node:test'
import { statusOf } from '../probe/status.ts'
import type { StatusRow } from '../probe/status.ts'
import { chatOf, footerOf, frameOf } from './frame.ts'
import { taskOf } from './task.ts'
import { permanentLinesOf } from './stream.ts'
import { openSession } from './follow.ts'

const row=(e:unknown,writer='round',seq=1)=>({pos:{writer,seq},e} as StatusRow)
const transition=(from:string,to:string)=>row({t:'round/state',round:'r1',from,to})
const write=row({t:'view/write',agent:'agent/r1/1',path:'picture.png',blob:'a'.repeat(40),rev:1,mode:0o100644},'agent/r1/1')
const text=(lines:readonly string[])=>lines.map(l=>l.replace(/[│┌┐└┘─├┤┈]/g,'').trim()).join('')

test('empty face explains review, confirmation and verified writeback before the first task',()=>{
  const f=frameOf({snapshot:statusOf([]),width:40,height:10})
  const shown=text(f.lines)
  for(const word of ['计划','确认','验收','工作区'])assert.ok(shown.includes(word),`a novice must see ${word} without documentation`)
})

test('a write event or an unstopped record is not proof of a running task',()=>{
  const snapshot=statusOf([write])
  assert.equal(footerOf(snapshot),'等待输入')
  assert.ok(!chatOf({snapshot}).some(r=>r.text.includes('正在处理')))
  assert.equal(snapshot.agents.length,1);assert.equal(snapshot.agents[0]!.stopped,null,'machine snapshot is unchanged')
})

test('Committed means verification passed, and does not claim that files have already been written',()=>{
  const snapshot=statusOf([transition('Verifying','Committed')])
  const shown=text(frameOf({snapshot,width:40,height:10}).lines)
  assert.ok(shown.includes('验收通过'));assert.ok(shown.includes('待写回'))
  assert.ok(!shown.includes('已写回'));assert.ok(!shown.includes('任务已完成'))
})

test('the real success transition Rebuilding pins verified writeback above old conversation',()=>{
  const rows=[transition('Working','Collecting'),transition('Collecting','Merging'),transition('Merging','Verifying'),transition('Verifying','Rebuilding')]
  const snapshot=statusOf(rows)
  for(const width of [16,40,80]){
    const f=frameOf({snapshot,width,height:10,conversation:[{text:'很长的旧意图'.repeat(40),role:'body'},{text:'很长的交接说明'.repeat(40),role:'body'}]})
    const shown=text(f.lines)
    assert.ok(shown.includes('结果已写回工作区'),'the current result must survive narrow width and old long summaries')
    assert.ok(!shown.includes('很长的旧意图'),'old intent cannot hide the completed result')
    assert.ok(f.lines[1]!.includes('验收通过'))
    assert.equal(snapshot.rounds.at(-1)!.state,'Rebuilding')
  }
})

test('verification retry and exhausted retry both report that this result was not written',()=>{
  for(const target of ['Working','Aborted']){
    const rows=[transition('Verifying',target)], snapshot=statusOf(rows)
    const session=openSession();session.push(rows)
    const shown=text(session.frame({columns:40,height:10}))
    assert.ok(shown.includes('验收未通过'));assert.ok(shown.includes('本次结果未写回工作区'))
    assert.ok(shown.includes('说一句想怎么改'))
    assert.ok(!shown.includes('工作区已更新'))
    assert.ok(permanentLinesOf(rows)[0]!.includes('本次结果未写回工作区'))
  }
})

test('an abort outside verification never claims that all existing files were unchanged',()=>{
  const rows=[transition('Working','Aborted')]
  const shown=text(frameOf({snapshot:statusOf(rows),width:40,height:10}).lines)
  assert.ok(shown.includes('中止'));assert.ok(shown.includes('部分改动'))
  const withTask=text(frameOf({snapshot:statusOf(rows),task:taskOf(rows),width:40,height:10}).lines)
  assert.ok(withTask.includes('部分改动')&&withTask.includes('以记录为准'),'the task face carries the same partial-change warning')
  assert.ok(!shown.includes('文件未改'));assert.ok(!shown.includes('本次结果未写回'))
})

test('Planning alone does not prove that a plan has been prepared',()=>{
  const shown=chatOf({snapshot:statusOf([transition('Idle','Planning')])}).map(r=>r.text).join('')
  assert.ok(shown.includes('正在准备计划'));assert.ok(!shown.includes('计划已准备'))
})

test('session result frames and permanent history both use the real advance milestone',()=>{
  const session=openSession();session.push([row({t:'round/intent',round:'r1',base:'a'.repeat(40),digest:'goal',body:JSON.stringify({goal:'旧任务目标'.repeat(20)})}),transition('Verifying','Rebuilding')])
  assert.ok(text(session.frame({columns:40,height:10})).includes('结果已写回工作区'))
  assert.ok(session.permanent().some(l=>l.includes('结果已写回工作区')))
  console.log('stage facts: Committed=pass/pending; Rebuilding=written; retry fail=not written; view-only active count=0')
})


test('a transition from another round or an older target cannot invent a verification failure',()=>{
  const snapshot=statusOf([transition('Delegated','Working')])
  for(const cached of [{round:'r0',from:'Verifying',to:'Working'},{round:'r1',from:'Verifying',to:'Aborted'}]){
    const shown=text(frameOf({snapshot,transition:cached,width:40,height:10}).lines)
    assert.ok(!shown.includes('验收未通过'));assert.ok(!shown.includes('未写回'))
    assert.equal(footerOf(snapshot,cached),'正在执行')
  }
})

test('unchanged redraw keeps the last failure edge without changing the machine snapshot',()=>{
  const rows=[transition('Verifying','Working')],snapshot=statusOf(rows)
  const machine=JSON.stringify(snapshot),session=openSession();session.push(rows)
  const first=session.frame({columns:40,height:10})
  session.permanent();session.push([])
  assert.deepEqual(session.frame({columns:40,height:10}),first)
  assert.ok(text(first).includes('本次结果未写回工作区'))
  assert.equal(JSON.stringify(statusOf(session.rows)),machine)
  assert.ok(!Object.keys(snapshot.rounds[0]!).includes('states'),'no machine field was added for UI convenience')
})

test('writeback primary uses the success role and leaves the status line as footer',()=>{
  const f=frameOf({snapshot:statusOf([transition('Verifying','Rebuilding')]),width:40,height:10})
  const main=f.lines.findIndex(l=>l.includes('验收通过'))
  assert.ok(main>0);assert.equal(f.roles[main],'ok')
  assert.equal(f.roles[f.lines.length-2],'footer')
})
