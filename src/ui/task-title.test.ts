import assert from 'node:assert/strict'
import {test} from 'node:test'
import {frameOf} from './frame.ts'
import {taskOf} from './task.ts'
import {statusOf} from '../probe/status.ts'
import type {StatusRow} from '../probe/status.ts'
import {setGlyphTier,widthOf} from './glyph.ts'
import {openSession} from './follow.ts'
import {openStage} from './stage.ts'
import {openTerm} from './term.ts'
import {KEYMAP,hintLineOf} from './keymap.ts'
const goal='修复登录失败时的提示，保留已输入的账号。'
const reply=Array.from({length:60},(_,i)=>`模型原文 ${i} 检查登录错误与重试行为`).join('\n')
function events():StatusRow[]{return [
 {pos:{writer:'round',seq:1},e:{t:'round/state',round:'r1',from:'Delegated',to:'Working'}},
 {pos:{writer:'round',seq:2},e:{t:'round/intent',round:'r1',body:JSON.stringify({goal})}},
 {pos:{writer:'holder/r1',seq:1},e:{t:'holder/todos',agent:'holder/r1',body:JSON.stringify({todos:[{content:'检查登录行为',status:'in_progress'},{content:'验证重试',status:'pending'}]})}},
 {pos:{writer:'agent/r1/1',seq:1},e:{t:'agent/handoff',agent:'agent/r1/1',body:reply}},
 {pos:{writer:'agent/r1/1',seq:2},e:{t:'run/start',agent:'agent/r1/1',argv0:'node',argv:['node','tools/test-entry.js']}},
] as StatusRow[]}

test('长回复和确认均保住主区当前目标，不占正文预算；最新目标与下一任务替换旧框名',()=>{
 const rows=events(),snapshot=statusOf(rows),task=taskOf(rows)
 for(const width of [120,160,80])for(const height of [35,45,19,7]){
  const base={snapshot,task,width,height},f=frameOf(base)
  assert.ok(f.lines[0]!.includes(goal),`${width}x${height} 应立即知道在推进哪件任务`)
  const legacy=frameOf({...base,task:{...task,rows:task.rows.filter(r=>r.role!=='user')}})
  assert.equal(f.lines.length,legacy.lines.length);assert.equal(f.roles.filter(r=>r==='model').length,legacy.roles.filter(r=>r==='model').length,'目标框名不消费正文行')
  assert.ok(f.lines.every(l=>widthOf(l)===width));assert.equal(f.lines.length,height)
 }
 const focused=openSession({view:()=>({focus:'agent/r1/1'})});focused.push(rows)
 assert.ok(focused.panel({columns:120,height:35}).rows[0]!.includes(goal),'子任务主面仍识别当前轮目标')
 const approved=frameOf({snapshot,task,width:120,height:35,bottom:{rows:['待确认 1 项','y 执行整批'],keep:2,waitingAt:1,waitingCount:1}})
 assert.ok(approved.lines[0]!.includes(goal));assert.ok(approved.roles.includes('waiting'))
 rows.push({pos:{writer:'round',seq:3},e:{t:'round/intent',round:'r1',body:JSON.stringify({goal:'只修改登录提示，账号保持现状。'})}} as StatusRow)
 let f=frameOf({snapshot:statusOf(rows),task:taskOf(rows),width:120,height:35})
 assert.match(f.lines[0]!,/只修改登录提示/);assert.ok(!f.lines[0]!.includes(goal))
 rows.push({pos:{writer:'round',seq:4},e:{t:'round/state',round:'r2',from:'Idle',to:'Planning'}},{pos:{writer:'round',seq:5},e:{t:'round/intent',round:'r2',body:JSON.stringify({goal:'检查退出登录后的页面。'})}} as StatusRow)
 f=frameOf({snapshot:statusOf(rows),task:taskOf(rows),width:120,height:35})
 assert.match(f.lines[0]!,/检查退出登录后的页面/);assert.ok(!f.lines.join('\n').includes(goal))
 console.log('task title: 120/160/80 x35/45/19/7 goal visible; body budget unchanged; confirmation goal visible; latest intent and next round replace old title')
})

test('目标框名按主区真实宽度裁切；多行、字形、缺失、坏投影与阅读层各守边界',()=>{
 const rows=events(),snapshot=statusOf(rows),task=taskOf(rows)
 for(const glyph of ['ascii','box','rich'] as const){
  setGlyphTier(glyph)
  for(const width of [160,120,80,40,24,16,8,3])for(const height of [35,7,5]){
   const f=frameOf({snapshot,task,width,height});assert.equal(f.lines.length,height);assert.ok(f.lines.every(l=>widthOf(l)===width),`${glyph} ${width} exact width`)
   if(width===24){assert.ok(f.lines[0]!.includes('修复'));assert.ok(f.lines[0]!.includes(glyph==='ascii'?'...':glyph==='rich'?'…':'…'))}
  }
  const multi={...task,rows:[{text:`你\n检查 👩‍💻 é 登录。\n保持草稿。`,role:'user' as const},...task.rows.filter(r=>r.role!=='user')]}
  const f=frameOf({snapshot,task:multi,width:120,height:35});assert.match(f.lines[0]!,/检查 👩‍💻 é 登录。 保持草稿。/);assert.equal(widthOf(f.lines[0]!),120)
  for(const bad of [{...task,rows:[]},{...task,round:'other'},{...task,state:null},{...task,state:'Planning'},{...task,rows:[{text:'没有原目标标记\n正文',role:'user' as const}]},{...task,rows:[{text:'你\n   ',role:'user' as const}]}]){
   const f=frameOf({snapshot,task:bad,width:120,height:35});assert.ok(f.lines[0]!.includes('当前任务'));assert.ok(!f.lines[0]!.includes(goal),'坏目标不制造内容')
  }
  for(const view of ['progress','spending'] as const){const base={snapshot,width:120,height:35,view};assert.deepEqual(frameOf({...base,task}),frameOf(base))}
  const read={rows:['任务完整原文'],top:0,heading:'当前任务记录',footer:'1/1 行 · 只读'}
  const base={snapshot,width:120,height:35,read};assert.deepEqual(frameOf({...base,task}),frameOf(base))
 }
 setGlyphTier('box')
 const stale={...task,rows:[...task.rows,{text:'不带目标身份的末条用户消息',role:'user' as const}]}
 assert.ok(!frameOf({snapshot,task:stale,width:120,height:35}).lines[0]!.includes(goal),'末条来源无目标时不回退到旧目标')
 const controlled={...task,rows:[{text:'你\n\x1b[2J伪目标',role:'user' as const}]}
 assert.ok(!frameOf({snapshot,task:controlled,width:120,height:35}).lines[0]!.includes('伪目标'),'框名不接受原始终端控制')
 const done=[...rows,{pos:{writer:'round',seq:3},e:{t:'round/state',round:'r1',from:'Committed',to:'Rebuilding'}}] as StatusRow[]
 const f=frameOf({snapshot:statusOf(done),task:taskOf(done),width:120,height:35});assert.ok(!f.lines.join('\n').includes(goal),'完成简报不重新展开旧目标')
 assert.ok(taskOf(rows,null,true).rows.some(r=>r.text===`你\n${goal}`));assert.ok(taskOf(rows,null,true).rows.some(r=>r.text===`模型 · 交接说明\n${reply}`))
 console.log('task title floor: ascii/box/rich x160/120/80/40/24/16/8/3 x35/7/5; explicit crop; multiline and graphemes; bad/missing source fallback; secondary/reader unchanged; completed brief kept; original messages exact')
})

test('实际舞台追加、阅读往返与目标更新只重画必要行；草稿和停留保持',()=>{
 const rows=events(),writes:string[]=[],presses:string[]=[];let width=120,height=40
 const stage=openStage({rows:()=>rows,columns:()=>width,termRows:()=>height,pendingFace:async()=>null,note:()=>{},redraw:()=>{},now:()=>0,abort:()=>{},hint:w=>hintLineOf(KEYMAP,3,w),run:()=>({running:false,last:[],argvOf:()=>({words:[],argv:[],why:null}),press:s=>{presses.push(s);return true},stop:()=>false})})
 stage.setRaw(true);stage.onAdvance(rows);const session=openSession({view:stage.view});session.push(rows)
 const term=openTerm({term:'xterm',heightOf:stage.heightWant,out:{isTTY:true,get columns(){return width},get rows(){return height},write:s=>writes.push(s)}})
 let frames=0,idles=0
 const draw=()=>{let p:ReturnType<typeof session.panel>|undefined;writes.length=0;term.draw([],size=>{p=session.panel(size);return p});frames++;return p!}
 const idle=()=>{draw();assert.equal(writes.join(''),'');idles++}
 try{
  stage.onAction({action:'insert',text:'再检查重试'});const draft=stage.view().input
  assert.ok(draw().rows[0]!.includes(goal));idle()
  const add={pos:{writer:'agent/r1/1',seq:3},e:{t:'agent/handoff',agent:'agent/r1/1',body:reply+'\n最新结果'}} as StatusRow
  rows.push(add);stage.onAdvance([add]);session.push([add]);assert.ok(draw().rows[0]!.includes(goal));assert.ok(!writes.join('').includes('当前任务'),'追加消息不重印未变框名');idle()
  stage.onAction({action:'read'});draw();stage.onAction({action:'pageDown'});draw();stage.onAction({action:'panel'});draw();stage.onAction({action:'cancel'});draw();stage.onAction({action:'cancel'});assert.ok(draw().rows[0]!.includes(goal));idle()
  for(const [w,h] of [[80,24],[24,12],[120,40]]){width=w;height=h;stage.onResize();const p=draw();assert.ok(p.rows[0]!.includes(w===24?'修复':goal));idle()}
  const revised={pos:{writer:'round',seq:3},e:{t:'round/intent',round:'r1',body:JSON.stringify({goal:'只修提示并验证重试。'})}} as StatusRow
  rows.push(revised);stage.onAdvance([revised]);session.push([revised]);assert.ok(draw().rows[0]!.includes('只修提示并验证重试。'));idle()
  assert.deepEqual(stage.view().input,draft);assert.deepEqual(presses,[])
  console.log(`task title sequence: frames${frames}; idles${idles} bytes0; unchanged title not rewritten on model append; updated intent visible; draft kept; execute0`)
 }finally{stage.close();term.close()}
})
