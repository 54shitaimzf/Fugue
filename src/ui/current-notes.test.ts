import assert from 'node:assert/strict'
import {test} from 'node:test'
import {openTui,openSession} from './follow.ts'
import {openStage} from './stage.ts'
import {permanentLinesOf} from './stream.ts'
import {setGlyphTier,widthOf} from './glyph.ts'
import {themeOf} from './theme.ts'
import {openTerm} from './term.ts'
import type {StatusRow} from '../probe/status.ts'
import type {Term} from './term.ts'
const ledger:StatusRow[]=[]
const add=(e:object)=>ledger.push({pos:{writer:'round',seq:ledger.length+1},e} as StatusRow)
add({t:'round/state',round:'old',from:'Committed',to:'Rebuilding'})
add({t:'round/intent',round:'old',body:'已经结束的旧任务',base:'old',digest:'old'})
add({t:'round/state',round:'r1',from:'Idle',to:'Planning'})
add({t:'round/intent',round:'r1',body:'当前修复任务',base:'base',digest:'new'})
add({t:'holder/distill',round:'r1',agent:'round',digest:'draft',body:'模型原文保留\n草案末尾'})
add({t:'round/state',round:'r1',from:'Planning',to:'Working'})
const source=(ac:AbortController)=>({hello:{protocol:'1',product:'',methods:[]},pass:async()=>{ac.abort();return {rows:ledger,resume:'done'}},close:async()=>{}})
const input={rows:['> 草稿'],caret:{row:0,col:4}}

test('interactive Console route consumes historical events without appending old states or command output above current UI; original records remain exact',async()=>{
 const ac=new AbortController(),permanent:string[][]=[],panels:unknown[]=[]
 let tui:ReturnType<typeof openTui>|undefined
 const term={ansi:true,columns:192,rows:50,height:45,draw:(fresh:readonly string[],render:Function)=>{permanent.push([...fresh]);panels.push(render({columns:192,height:45}))},close(){}} as Term
 tui=openTui({source:source(ac) as never,term,emit:()=>assert.fail('panel never emits'),mode:'panel',interactive:true,view:()=>({input}),signal:ac.signal} as never)
 const counts=await tui.counts
 tui.note('r1: go Planning→Working\n完整命令输出尾部')
 tui.redraw();tui.redraw()
 assert.deepEqual(permanent.flat(),[],'interactive owned panel has no appended historical prefix')
 assert.deepEqual(tui.session.rows,ledger)
 assert.deepEqual(tui.session.permanent(),permanentLinesOf(ledger),'ledger history projection stays exact')
 assert.deepEqual(tui.notes,['r1: go Planning→Working\n完整命令输出尾部'],'command record stores the original multiline message')
 assert.equal(counts.permanent,permanentLinesOf(ledger).length);assert.equal(counts.rows,ledger.length)
 const text=JSON.stringify(panels.at(-1));assert.ok(text.includes('当前修复任务'));assert.ok(!text.includes('已经结束的旧任务'));assert.ok(!text.includes('进展：准备计划'))
 const snap=tui.session.panel({columns:192,height:45});tui.note('second raw output');assert.deepEqual(tui.session.panel({columns:192,height:45}),snap,'raw CLI output does not replace event-backed current task')
 assert.deepEqual(tui.notes,['r1: go Planning→Working\n完整命令输出尾部','second raw output'])
})

test('read-only panel and both plain-text modes preserve every original line, ordering, reveal and notes; interactive marker cannot disable their floor',async()=>{
 for(const mode of ['panel','lines-once','lines-follow'] as const)for(const interactive of [undefined,false,true]){
  if(mode==='panel'&&interactive===true)continue
  const ac=new AbortController(),out:string[]=[],fresh:string[]=[],term={ansi:true,columns:80,height:10,draw:(p:readonly string[],render:Function)=>{fresh.push(...p);render({columns:80,height:10})},close(){}} as Term
  const tui=openTui({source:source(ac) as never,term,mode,emit:s=>out.push(s),signal:ac.signal,reveal:3,...(interactive===undefined?{}:{interactive})} as never)
  await tui.counts;tui.note('原始注记\n末尾');tui.redraw()
  assert.deepEqual(mode==='panel'?fresh:out,[...permanentLinesOf(ledger).slice(-3),'原始注记\n末尾'])
  assert.deepEqual(tui.session.permanent(),permanentLinesOf(ledger));assert.ok(!out.join('').includes('\x1b'))
 }
})

function rig(){
 const notes:string[]=[],ac=new AbortController(),writes:string[]=[]
 let rows=ledger.slice(),tui:ReturnType<typeof openTui>|undefined,running=false,redraws=0
 const run={get running(){return running},last:['node','missing.ts'],argvOf:(line:string)=>({words:[line],argv:[line],why:line==='bad'?'invalid command':null}),press:()=>true,stop:()=>true}
 const stage=openStage({note:s=>{notes.push(s);tui?.note(s)},notes:()=>tui?.notes??notes,hint:()=>'',redraw:()=>{redraws++;tui?.redraw()},columns:()=>192,termRows:()=>50,rows:()=>rows,pendingFace:async()=>null,run:()=>run,now:()=>0,abort:()=>ac.abort()} as never)
 stage.setRaw(true)
 const term=openTerm({out:{isTTY:true,columns:192,rows:50,write:(s:string)=>writes.push(s)},term:'xterm-256color',heightOf:stage.heightWant,theme:themeOf({term:'xterm-256color',colorFgBg:'0;15'})})
 tui=openTui({source:source(ac) as never,term,mode:'panel',interactive:true,emit:()=>assert.fail(),view:stage.view,signal:ac.signal,onAdvance:stage.onAdvance} as never)
 return {stage,tui,notes,writes,rows:(v:StatusRow[])=>{rows=v},running:(v:boolean)=>{running=v},term,redraws:()=>redraws}
}
test('necessary current feedback has its own role, persists while merely redrawing, clears on next action and remains available with full history in existing details',async()=>{
 const r=rig();await r.tui.counts
 r.tui.note('r1: go Planning→Working\nCLI原文结束')
 r.stage.onRunDone({code:7,why:null})
 const panel=r.tui.session.panel({columns:192,height:45}),text=panel.rows.join('\n')
 assert.match(text,/执行失败（退出码 7）/);assert.match(text,/文件是否已写回/);assert.ok(panel.roles!.includes('instruction'))
 const pending=r.stage.view().feedback;assert.ok(pending?.length)
 r.tui.redraw();assert.deepEqual(r.stage.view().feedback,pending,'painting does not silently consume feedback')
 r.stage.onAction({action:'read'})
 let detail=''
 for(let i=0;i<5;i++){const v=r.stage.view();if(v.read?.heading?.includes('详情')){detail=v.read.rows.join('\n');break}r.stage.onAction({action:'complete'})}
 assert.match(detail,/历史进展/);assert.match(detail,/已经结束的旧任务/);assert.match(detail,/进展：准备计划/)
 assert.match(detail,/命令记录/);assert.match(detail,/CLI原文结束/);assert.match(detail,/执行失败（退出码 7）/)
 r.stage.onAction({action:'cancel'});assert.ok(!r.stage.view().feedback?.length)
 assert.ok(!r.tui.session.panel({columns:192,height:45}).rows.join('\n').includes('执行失败（退出码 7）'),'old feedback leaves main after another action')
 assert.ok(r.tui.notes.some(s=>s.includes('执行失败（退出码 7）')),'raw note persists in secondary record')
 r.stage.notify('键位不能配置：原始原因')
 assert.match(r.tui.session.panel({columns:192,height:45}).rows.join('\n'),/键位不能配置：原始原因/)
 const prior=r.redraws();r.stage.close();r.stage.notify('closed');assert.equal(r.redraws(),prior);r.term.close()
})

test('feedback keeps complete input anchor and role/text floors across 3 glyphs and 6 themes; state advance clears stale feedback and component idle bytes stay zero',async()=>{
 const styles=[themeOf({noStyle:true}),themeOf({noColor:'1'}),themeOf({term:'dumb'}),themeOf({term:'linux'}),themeOf({term:'xterm-256color',colorFgBg:'0;15'}),themeOf({term:'xterm-256color',colorFgBg:'15;0'})]
 let paints=0,idles=0
 for(const glyph of ['ascii','box','rich'] as const)for(const theme of styles){
  setGlyphTier(glyph)
  const r=rig();await r.tui.counts
  r.stage.onAction({action:'insert',text:'完整草稿'});const before=r.stage.view().input
  r.stage.onRunDone({code:null,why:'spawn ENOENT'})
  assert.deepEqual(r.stage.view().input,before)
  const view=r.stage.view(),session=openSession({view:()=>view});session.push(ledger)
  const p=session.panel({columns:192,height:45});assert.ok(p.rows.some(s=>s.includes('spawn ENOENT')));assert.ok(p.rows.some(s=>s.includes('missing.ts')))
  for(const s of p.rows)assert.equal(widthOf(s),192)
  const bytes:string[]=[],term=openTerm({out:{isTTY:true,columns:192,rows:50,write:(s:string)=>bytes.push(s)},term:'xterm-256color',theme,height:45})
  term.draw([],()=>p);paints++;const n=bytes.join('').length;term.draw([],()=>p);paints++;assert.equal(bytes.join('').length,n);idles++
  r.stage.onAction({action:'insert',text:'继续'});assert.ok(!r.stage.view().feedback?.length)
  r.stage.onRunDone({code:8,why:null});r.stage.onAdvance([{pos:{writer:'round',seq:77},e:{t:'round/state',round:'r1',from:'Working',to:'Verifying'}}] as never);assert.ok(!r.stage.view().feedback?.length)
  term.close();r.stage.close();r.term.close()
 }
 setGlyphTier('box')
 console.log(JSON.stringify({componentPaints:paints,idleSamples:idles,idleBytes:0,glyphs:3,themes:6}))
})

test('only a fresh same-round failed verification from this launch replaces generic exit feedback; old results, unrelated rounds and other exit codes do not',async()=>{
 for(const kind of ['fresh','old','other-round','different-code']){
  const r=rig();await r.tui.counts
  const failure={pos:{writer:'round',seq:ledger.length+1},e:{t:'round/state',round:kind==='other-round'?'another':'r1',from:'Verifying',to:'Working'}} as StatusRow
  if(kind==='old'){r.rows([...ledger,failure]);r.tui.session.push([failure])}
  r.stage.onAction({action:'insert',text:'/round work'});r.stage.onAction({action:'submit'})
  if(kind!=='old'){r.rows([...ledger,failure]);r.tui.session.push([failure])}
  r.stage.onRunDone({code:kind==='different-code'?7:1,why:null})
  assert.ok(r.tui.notes.at(-1)!.includes('执行失败'),'original exit remains in command record')
  assert.equal(!!r.stage.view().feedback?.length,kind!=='fresh','only the current event-backed failure owns the result')
  r.stage.close();r.term.close()
 }
})
