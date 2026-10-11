import assert from 'node:assert/strict'
import {test} from 'node:test'
import {openStage} from './stage.ts'
import {openSession} from './follow.ts'
import {openTerm} from './term.ts'
import {taskOf,issueRowsOf} from './task.ts'
import {setGlyphTier} from './glyph.ts'
import {WORDS} from '../words.ts'
import type {StatusRow} from '../probe/status.ts'

const rows:StatusRow[]=[
 {pos:{writer:'round',seq:1},e:{t:'round/state',round:'r1',from:'Planning',to:'Working'}},
 {pos:{writer:'round',seq:2},e:{t:'round/intent',round:'r1',body:'保留原目标',base:'base',digest:'intent'}},
 {pos:{writer:'round',seq:3},e:{t:'holder/distill',round:'r1',agent:'round',body:'原模型回复',digest:'draft'}},
 {pos:{writer:'round',seq:4},e:{t:'round/state',round:'r1',from:'Working',to:'Merging'}},
 {pos:{writer:'round',seq:5},e:{t:'merge/attempt',round:'r1',conflicts:0}},
] as StatusRow[]
const issue={round:'r1',state:'Merging',text:'执行失败（退出码 7）。'}

test('only matching observed run failure replaces an ongoing caption; completed facts, problems and unknown metadata keep the exact frame',()=>{
 const task=taskOf(rows),shown=issueRowsOf(task,issue)
 assert.equal(shown[0]?.role,'refuse');assert.equal(shown[0]?.text,issue.text)
 assert.equal(shown[1]?.text,WORDS.runWritebackGuide);assert.deepEqual(shown.slice(2),task.rows.slice(1))
 for(const invalid of [undefined,null,{},false,{...issue,round:'other'},{...issue,state:'Working'},{...issue,text:''},{...issue,round:'r1\n'},{...issue,text:'bad\x1b'}]){
  assert.equal(issueRowsOf(task,invalid as never),task.rows)
 }
 for(const first of [{text:'合并遇到 2 处冲突。',role:'refuse'}, {text:'已写回你的项目。',role:'ok'}, {text:'具体问题仍待决定',role:'system'}]){
  const conflict={...task,rows:[first,...task.rows.slice(1)]} as typeof task
  assert.equal(issueRowsOf(conflict,issue),conflict.rows)
 }
 let frames=0
 for(const glyph of ['ascii','box','rich'] as const)for(const width of [24,80,192])for(const height of [8,20,45]){
  setGlyphTier(glyph)
  const panel=(extra:object,withIssue=true)=>{
   const session=openSession({view:()=>({input:{rows:['> 草稿'],caret:{row:0,col:4}},runIssue:withIssue?issue:undefined,...extra})})
   session.push(rows);return session.panel({columns:width,height})
  }
  assert.ok(panel({}).rows.join('\n').includes('执行失败'));frames++
  for(const floor of [{input:undefined},{view:'progress'},{view:'spending'},{focus:'agent/r1/x'},
   {read:{rows:['真实原文'],top:0,heading:'记录',footer:'1/1'}},{menu:{source:'cmd',rows:['候选'],sel:0}},
   {runIssue:{...issue,round:'wrong'}},{runIssue:{...issue,state:'Working'}}]){
   assert.deepEqual(panel(floor),panel(floor,false),'complete unchanged floor');frames++
  }
 }
 setGlyphTier('box');console.log(JSON.stringify({projectionFrames:frames,glyphs:3,widths:3,heights:3}))
})

function rig(){
 let ledger=rows.slice(0,3),running=false,width=192,height=50
 const notes:string[]=[],presses:string[]=[],bytes:string[]=[]
 const run={get running(){return running},last:[],argvOf:(line:string)=>({words:line.replace(/^\//,'').split(' '),argv:[line],why:null}),press:(line:string)=>{presses.push(line);running=true;return true},stop:()=>true}
 const stage=openStage({rows:()=>ledger,notes:()=>notes,note:s=>notes.push(s),redraw:()=>{},columns:()=>width,termRows:()=>height,pendingFace:async()=>null,run:()=>run,now:()=>0,abort:()=>{},hint:()=>''})
 stage.setRaw(true)
 const session=openSession({view:stage.view});session.push(ledger)
 const term=openTerm({out:{isTTY:true,get columns(){return width},get rows(){return height},write:s=>bytes.push(s)},term:'xterm',heightOf:stage.heightWant})
 const draw=()=>{const frame=session.panel({columns:width,height:stage.heightWant()});term.draw([],()=>frame);const n=bytes.join('').length;term.draw([],()=>frame);assert.equal(bytes.join('').length,n);return frame}
 const add=(e:object)=>{const row={pos:{writer:'round',seq:ledger.length+1},e} as StatusRow;ledger=[...ledger,row];session.push([row]);stage.onAdvance([row])}
 const launch=(line='/round work')=>{stage.onAction({action:'insert',text:line});stage.onAction({action:'submit'})}
 const done=(code:number|null,why:string|null=null)=>{running=false;stage.onRunDone({code,why})}
 return {stage,session,notes,presses,draw,add,launch,done,resize:(w:number,h:number)=>{width=w;height=h},close:()=>{stage.close();term.close()}}
}

test('run outcome persists through editing, readonly FIFO, read/menu and resize, expires on fresh progress; source log and complete draft stay unchanged',()=>{
 let frames=0,idles=0
 for(const code of [7,null])for(const glyph of ['ascii','box','rich'] as const){
  setGlyphTier(glyph);const r=rig();r.launch()
  r.add({t:'round/state',round:'r1',from:'Working',to:'Merging'});r.add({t:'merge/attempt',round:'r1',conflicts:0})
  r.done(code);const original=r.session.rows.slice()
  const check=()=>{const p=r.draw();frames+=2;idles++;const text=p.rows.join('\n');assert.ok(text.includes(code===null?'执行因信号结束':'执行失败'));assert.ok(!text.includes('正在合并结果'));assert.equal(text.split(code===null?'执行因信号结束':'执行失败').length,2);assert.ok(text.includes('原模型回复'));return p}
  check()
  r.stage.onAction({action:'insert',text:'完整草稿'});r.stage.onAction({action:'left'});const draft=r.stage.view().input;check()
  r.stage.onAction({action:'help'});r.draw();frames+=2;idles++;r.stage.onAction({action:'cancel'});assert.deepEqual(r.stage.view().input,draft);check()
  r.stage.onAction({action:'read'});r.draw();frames+=2;idles++;r.stage.onAction({action:'cancel'});assert.deepEqual(r.stage.view().input,draft);check()
  for(const [w,h] of [[80,24],[120,40],[192,50]]){r.resize(w!,h!);check()}
  assert.deepEqual(r.session.rows,original,'pure view state never appends failure or phase events')
  r.stage.onAction({action:'killToStart'});r.stage.onAction({action:'killToEnd'});r.launch('/status');r.done(0);check()
  r.stage.onAction({action:'killToStart'});r.stage.onAction({action:'killToEnd'});r.launch('/round work');assert.equal(r.stage.view().runIssue,undefined)
  r.add({t:'round/state',round:'r1',from:'Merging',to:'Working'});r.draw();frames+=2;idles++
  assert.ok(r.notes.some(s=>s.includes(code===null?'执行因信号结束':'执行失败')),'raw outcome remains in record')
  r.close()
 }
 setGlyphTier('box');console.log(JSON.stringify({sequenceFrames:frames,idleSamples:idles,idleBytes:0,runs:6,resizeRequests:18}))
})

test('success, spawn errors, stale or foreign observations and readonly failures cannot relabel task; a fresh recorded phase expires issue',()=>{
 for(const kind of ['success','spawn','stale','foreign','readonly','verify','phase','action']){
  const r=rig();r.launch(kind==='readonly'?'/status':'/round work')
  if(kind!=='stale')r.add({t:'merge/attempt',round:kind==='foreign'?'other':'r1',conflicts:0})
  if(kind==='verify'){r.add({t:'round/state',round:'r1',from:'Working',to:'Verifying'});r.add({t:'round/state',round:'r1',from:'Verifying',to:'Working'})}
  r.done(kind==='success'?0:kind==='spawn'?null:kind==='verify'?1:7,kind==='spawn'?'spawn ENOENT':null)
  if(kind==='phase'||kind==='action'){
   assert.ok(r.stage.view().runIssue)
   r.add(kind==='phase'?{t:'round/state',round:'r1',from:'Working',to:'Collecting'}:{t:'run/start',agent:'round',argv0:'new-command',argv:['new-command'],run:'next-action'})
   assert.equal(r.stage.view().runIssue,undefined,'new source action expires old run issue')
   assert.ok(!r.draw().rows.join('\n').includes('执行失败'),'expired matching feedback also leaves current main; original note remains')
   r.add({t:'merge/attempt',round:'r1',conflicts:0});assert.equal(r.stage.view().runIssue,undefined,'old failure cannot return when a later action has the same caption')
  }else assert.equal(r.stage.view().runIssue,undefined,kind)
  r.close()
 }
})

test('a subsequent readonly failure with the same exit code keeps its own feedback and original note',()=>{
 const r=rig();r.launch();r.add({t:'merge/attempt',round:'r1',conflicts:0});r.done(7)
 assert.equal(r.draw().rows.join('\n').split('执行失败').length,2,'same process has one visible failure')
 r.launch('/status');r.done(7)
 assert.equal(r.draw().rows.join('\n').split('执行失败').length,3,'task issue and subsequent readonly failure are separate sources')
 assert.equal(r.notes.filter(s=>s.includes('执行失败')).length,2,'both original outcomes remain in records')
 r.close()
})
