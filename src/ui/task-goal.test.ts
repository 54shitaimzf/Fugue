import assert from 'node:assert/strict'
import {test} from 'node:test'
import {frameOf} from './frame.ts'
import {taskOf} from './task.ts'
import {statusOf} from '../probe/status.ts'
import type {StatusRow} from '../probe/status.ts'
import {glyphs,setGlyphTier,widthOf} from './glyph.ts'
import {openSession} from './follow.ts'
import {openStage} from './stage.ts'
import {openTerm} from './term.ts'
import {KEYMAP,hintLineOf} from './keymap.ts'
const goal='修复登录提示。'
const reply=Array.from({length:60},(_,i)=>`模型原文 ${i} 检查登录错误与重试行为`).join('\n')
function events():StatusRow[]{return [
 {pos:{writer:'round',seq:1},e:{t:'round/state',round:'r1',from:'Delegated',to:'Working'}},
 {pos:{writer:'round',seq:2},e:{t:'round/intent',round:'r1',body:JSON.stringify({goal})}},
 {pos:{writer:'round',seq:3},e:{t:'holder/distill',agent:'holder/r1',body:'先看失败路径，再改提示。'}},
 {pos:{writer:'agent/r1/1',seq:1},e:{t:'agent/handoff',agent:'agent/r1/1',body:reply}},
 {pos:{writer:'agent/r1/1',seq:2},e:{t:'run/start',agent:'agent/r1/1',argv0:'node',argv:['node','tools/test-entry.js']}},
] as StatusRow[]}
const text=(f:ReturnType<typeof frameOf>)=>f.lines.join('\n')

// 框名从「当前任务 · 目标」改回「当前任务」之后，目标不再靠框名承担：它就在正文那块 `> ` 里。
// 这一份量的是**目标任何时候都看得见**——长回复截断、确认块打开、最新意图替换、下一轮开始；
// 以及框名不再变化（追加消息不重印标题）。
test('当前目标在主区正文里可见；长回复、确认与窗口变化都不把它挤出屏幕',()=>{
 const rows=events(),snapshot=statusOf(rows),task=taskOf(rows)
 for(const glyph of ['ascii','box','rich'] as const){setGlyphTier(glyph)
  for(const width of [160,120,80,40,24,16])for(const height of [35,19,12,8]){
   const f=frameOf({snapshot,task,width,height})
   assert.ok(f.lines.some(l=>l.includes('当前任务')),`${glyph} ${width}x${height} 框名在`)
   assert.equal(f.lines.length,height);assert.ok(f.lines.every(l=>widthOf(l)===width))
   if(width>=40&&height>=12)assert.ok(text(f).includes('> '+goal),`${glyph} ${width}x${height} 目标在正文里`)
   assert.ok(!text(f).includes('当前任务 · '),'框名不再重复目标')
  }
 }
 setGlyphTier('box')
 const approved=frameOf({snapshot,task,width:120,height:35,bottom:{rows:['待确认 1 项','y 执行整批'],keep:2,waitingAt:1,waitingCount:1}})
 assert.ok(text(approved).includes('> '+goal));assert.ok(approved.roles.includes('waiting'))
 const multi={...task,rows:[{text:'> 检查 👩‍💻 é 登录。\n保持草稿。',role:'user' as const},...task.rows.filter(r=>r.role!=='user')]}
 const mf=frameOf({snapshot,task:multi,width:120,height:35})
 assert.ok(text(mf).includes('> 检查 👩‍💻 é 登录。')&&text(mf).includes('保持草稿。'));assert.equal(widthOf(mf.lines[0]!),120)
 for(const bad of [{...task,rows:[]},{...task,round:'other'},{...task,state:null},{...task,state:'Planning'}]){
  const f=frameOf({snapshot,task:bad,width:120,height:35})
  assert.ok(f.lines[0]!.includes('当前任务'))
  if(bad.rows.length===0)assert.ok(!text(f).includes('> '+goal),'坏投影不制造内容')
 }
 rows.push({pos:{writer:'round',seq:4},e:{t:'round/intent',round:'r1',body:JSON.stringify({goal:'只修改登录提示，账号保持现状。'})}} as StatusRow)
 const latest=frameOf({snapshot:statusOf(rows),task:taskOf(rows),width:120,height:35})
 assert.ok(text(latest).includes('> 只修改登录提示，账号保持现状。'),'最新目标在正文里')
 rows.push({pos:{writer:'round',seq:5},e:{t:'round/state',round:'r2',from:'Idle',to:'Planning'}},{pos:{writer:'round',seq:6},e:{t:'round/intent',round:'r2',body:JSON.stringify({goal:'检查退出登录后的页面。'})}} as StatusRow)
 const next=frameOf({snapshot:statusOf(rows),task:taskOf(rows),width:120,height:35})
 assert.ok(text(next).includes('> 检查退出登录后的页面。'));assert.ok(!text(next).includes(goal),'下一轮不再展开旧目标')
 assert.ok(taskOf(rows,null,true).rows.some(r=>r.text===`> 检查退出登录后的页面。`),'原文阅读保留目标原句')
 console.log('task goal: 3glyph x160/120/80/40/24/16 x35/19/12/8; goal in body; title stable; confirmation/multiline/bad projection; latest and next round replace the goal')
})

test('实际舞台追加、阅读往返与窗口变化保住目标与草稿；停留零输出',()=>{
 const rows=events(),writes:string[]=[],presses:string[]=[];let width=120,height=40
 const stage=openStage({rows:()=>rows,columns:()=>width,termRows:()=>height,pendingFace:async()=>null,note:()=>{},redraw:()=>{},now:()=>0,abort:()=>{},hint:w=>hintLineOf(KEYMAP,3,w),run:()=>({running:false,last:[],argvOf:()=>({words:[],argv:[],why:null}),press:s=>{presses.push(s);return true},stop:()=>false})})
 stage.setRaw(true);stage.onAdvance(rows);const session=openSession({view:stage.view});session.push(rows)
 const term=openTerm({term:'xterm',heightOf:stage.heightWant,out:{isTTY:true,get columns(){return width},get rows(){return height},write:s=>writes.push(s)}})
 let frames=0,idles=0
 const draw=()=>{let p:ReturnType<typeof session.panel>|undefined;writes.length=0;term.draw([],size=>{p=session.panel(size);return p});frames++;return p!}
 const idle=()=>{draw();assert.equal(writes.join(''),'');idles++}
 try{
  stage.onAction({action:'insert',text:'再检查重试'});const draft=stage.view().input
  assert.ok(draw().rows.some(l=>l.includes('> '+goal)));idle()
  const add={pos:{writer:'agent/r1/1',seq:3},e:{t:'agent/handoff',agent:'agent/r1/1',body:reply+'\n最新结果'}} as StatusRow
  rows.push(add);stage.onAdvance([add]);session.push([add]);assert.ok(draw().rows.some(l=>l.includes('> '+goal)));assert.ok(!writes.join('').includes('当前任务'),'追加消息不重印未变的框名');idle()
  stage.onAction({action:'read'});draw();stage.onAction({action:'pageDown'});draw();stage.onAction({action:'panel'});draw();stage.onAction({action:'cancel'});draw();stage.onAction({action:'cancel'});assert.ok(draw().rows.some(l=>l.includes('> '+goal)));idle()
  for(const [w,h] of [[80,24],[24,12],[120,40]]){width=w;height=h;stage.onResize();const p=draw();assert.ok(p.rows.some(l=>l.includes('> '+goal)),`${w}x${h} 目标仍在`);idle()}
  const revised={pos:{writer:'round',seq:4},e:{t:'round/intent',round:'r1',body:JSON.stringify({goal:'只修提示并验证重试。'})}} as StatusRow
  rows.push(revised);stage.onAdvance([revised]);session.push([revised]);assert.ok(draw().rows.some(l=>l.includes('> 只修提示并验证重试。')));idle()
  assert.deepEqual(stage.view().input,draft);assert.deepEqual(presses,[])
  console.log(`task goal sequence: frames${frames}; idles${idles} bytes0; goal kept on append/read/resize; title not reprinted; updated intent visible; draft kept; execute0`)
 }finally{stage.close();term.close()}
})
