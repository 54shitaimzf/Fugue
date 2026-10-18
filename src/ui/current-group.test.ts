import assert from 'node:assert/strict'
import {test} from 'node:test'
import {frameOf} from './frame.ts'
import {taskOf} from './task.ts'
import {statusOf} from '../probe/status.ts'
import type {StatusRow} from '../probe/status.ts'
import {glyphs,setGlyphTier,widthOf} from './glyph.ts'
import {openStage} from './stage.ts'
import {openSession} from './follow.ts'
import {openTerm} from './term.ts'
import {KEYMAP,hintLineOf} from './keymap.ts'
const events=(state='Working')=>[
 {pos:{writer:'round',seq:1},e:{t:'round/state',round:'r1',from:'Idle',to:state}},
 {pos:{writer:'round',seq:2},e:{t:'round/intent',round:'r1',body:'修复登录提示'}},
 {pos:{writer:'holder/r1',seq:1},e:{t:'holder/distill',agent:'holder/r1',body:'保留账号，只调整失败提示。'}},
] as StatusRow[]
const headAt=(f:ReturnType<typeof frameOf>)=>f.lines.findIndex(l=>l.startsWith(glyphs().tl))
function base(rows:StatusRow[],width=120,height=35){return {snapshot:statusOf(rows),task:taskOf(rows),width,height,operationArea:true}}

// 这一份量的是**对话块落在哪儿**：框底贴着提示行与输入行，内容从下往上长，余量留在框上面。
// 旧判据是「标题在第 0 行、余量留在框下面」——那是把面板当仪表盘、从上往下读的形状；对话式界面
// 里人看的是输入上方那一段，余量留在上面才不把内容推离输入。判据变了，容量、角色、正文逐字节
// 这些承诺没有变，仍在下面逐条量。
test('sparse current title and conversation sit above the input; empty input has no task outline; full capacity and input remain fixed',()=>{
 let cases=0
 try{for(const glyph of ['ascii','box','rich'] as const){setGlyphTier(glyph)
  for(const [width,height] of [[192,45],[160,45],[120,35],[80,19],[24,35],[16,24]])for(const rows of [[],events(),events('Aborted'),events('Rebuilding')]){
   const o=base(rows,width,height),f=frameOf(o),at=headAt(f)
   if(rows.length===0){
    assert.equal(at,-1,'empty input has no fictitious task heading');const first=height-(width===16?2:1)
    assert.equal(f.lines.slice(first).map(l=>l.trim()).join(''),'说说你想做什么。')
    assert.ok(f.roles.slice(0,first).every(r=>r==='body'));assert.ok(f.roles.slice(first).every(r=>r==='instruction'))
    assert.equal(f.lines.length,height);assert.ok(f.lines.every(l=>widthOf(l)===width));assert.deepEqual(frameOf(o),f);cases++;continue
   }
   assert.ok(at>0,`${glyph} ${width}x${height} current title hangs above its body`)
   assert.equal(f.roles[at],'border');assert.notEqual(f.lines[at+1]!.slice(1,-1).trim(),'','title directly precedes current body')
   assert.equal(f.lines.length,height);assert.equal(f.roles.length,height);assert.ok(f.lines.every(l=>widthOf(l)===width))
   const old=frameOf({...o,operationArea:false})
   const text=(x:typeof f)=>x.lines.flatMap((l,i)=>!['border','footer'].includes(x.roles[i]!)&&l.slice(1,-1).trim()!==''?[{line:l,role:x.roles[i]}]:[])
   assert.deepEqual(text(f),text(old),'all current nonempty body bytes, roles and order retained')
   assert.ok(f.lines.at(-1)!.startsWith(glyphs().bl),'outline closes at the frame bottom, next to the input')
   assert.equal(f.roles.at(-1),'border','bottom edge carries the border role')
   assert.ok(f.lines.slice(0,at).every(l=>l.trim()===''),'spare capacity stays above the outline')
   assert.ok(f.roles.slice(0,at).every(r=>r==='body'),'spare rows carry no outline role')
   const footer=old.roles.indexOf('footer')
   if(footer>=0)assert.equal(f.lines[footer],old.lines[footer],'footer and input anchor retain their physical row')
   else assert.equal(f.lines.at(-1),`${glyphs().bl}${glyphs().h.repeat(width-2)}${glyphs().br}`,'the bottom edge is always drawn')
   assert.deepEqual(frameOf(o),f);cases++
  }
 }}finally{setGlyphTier('box')}
 console.log(`current group:${cases} first/work/failure/result xdesktop/narrow x3glyph;title above body;spare above outline;body roles/order exact;full geometry/input anchor`)
})

test('readers, menus, unknown sources, dense content and long auxiliary plans retain capacity and their original floor',()=>{
 const o=base(events()),plan=[{text:'检查登录',status:'in_progress' as const},{text:'验证重试',status:'pending' as const}]
 const f=frameOf({...o,task:{...o.task,plan}}),at=headAt(f)
 assert.ok(at>0);assert.notEqual(f.segments![at+1]![0]!.text.slice(1,-1).trim(),'','primary body starts below the top title')
 assert.equal(f.segments!.findIndex(s=>s[2]!.text.trim()==='计划'),at,'both titles share one row')
 const many=Array.from({length:50},(_,i)=>({text:`完整步骤${i}`,status:'pending' as const}))
 const long=frameOf({...o,task:{...o.task,plan:many}})
 assert.equal(long.segments![0]![2]!.text.trim(),'计划');assert.ok(long.lines.some(l=>l.includes('还有计划未展开')));assert.equal(long.lines.length,35)
 for(const change of [{operationArea:false},{operationArea:undefined},{task:undefined},{task:{...o.task,round:'other'}},{bottom:{rows:['unknown'],keep:1}},{read:{rows:['完整原文'],top:0}},{menu:{rows:['菜单'],sel:0}},{view:'progress' as const},{view:'spending' as const}]){
  const input={...o,...change};assert.deepEqual(frameOf(input),frameOf({...input,operationArea:false}),'unproven or secondary context stays byte exact')
  assert.equal(headAt(frameOf(input)),0)
 }
 for(const [width,height] of [[192,45],[120,35],[24,12],[16,8],[8,5]]){
  const dense={...o,width,height,task:{...o.task,rows:[...o.task.rows,{text:'模型\n'+Array.from({length:120},(_,i)=>`原文${i}`).join('\n'),role:'model' as const}]}}
  assert.deepEqual(frameOf(dense),frameOf({...dense,operationArea:false}));assert.equal(headAt(frameOf(dense)),0)
 }
 console.log('current group floor:9 contexts/dense5 sizes byte exact;short plan shared title;50-step plan full capacity/omission')
})

test('actual Stage/Session/Term streaming expands the group without moving the input; idle writes zero and original drafts/read returns survive',()=>{
 let rows=events(),width=120,height=40,frames=0,idles=0;const writes:string[]=[],bottoms:number[]=[],heads:number[]=[]
 const stage=openStage({rows:()=>rows,columns:()=>width,termRows:()=>height,pendingFace:async()=>null,redraw:()=>{},note:()=>{},now:()=>0,abort:()=>{},hint:w=>hintLineOf(KEYMAP,3,w),run:()=>({running:false,last:[],argvOf:()=>({words:[],argv:[],why:null}),press:()=>true,stop:()=>false})})
 stage.setRaw(true);stage.onAdvance(rows);const session=openSession({view:stage.view});session.push(rows)
 const term=openTerm({term:'xterm',heightOf:stage.heightWant,out:{isTTY:true,get columns(){return width},get rows(){return height},write:s=>writes.push(s)}})
 const draw=()=>{writes.length=0;let p:ReturnType<typeof session.panel>|undefined;term.draw([],s=>{p=session.panel(s);return p});frames++;return p!}
 const idle=()=>{draw();assert.equal(writes.join(''),'');idles++}
 try{
  stage.onAction({action:'insert',text:'当前草稿原样保留'});const draft=stage.view().input
  for(const n of [1,3,8,20,50,1]){
   const next=heads.length===5
   const batch=next?[{pos:{writer:'round',seq:20},e:{t:'round/state',round:'r2',from:'Idle',to:'Working'}},{pos:{writer:'round',seq:21},e:{t:'round/intent',round:'r2',body:'检查重试'}}] as StatusRow[]:[{pos:{writer:'holder/r1',seq:n+20},e:{t:'holder/distill',agent:'holder/r1',body:Array.from({length:n},(_,i)=>`进展${i}`).join('\n')}}] as StatusRow[]
   rows=[...rows,...batch];stage.onAdvance(batch);session.push(batch);const p=draw();heads.push(p.rows.findIndex(l=>l.startsWith(glyphs().tl)));bottoms.push(p.rows.length);idle()
  }
  assert.ok(heads[0]!>0,'sparse content leaves the box low, next to the input')
  assert.equal(heads[4],0,'dense content fills the frame and reaches the top edge')
  assert.ok(heads[5]!>0,'a fresh sparse round returns the box to the bottom')
  assert.ok(bottoms.every(n=>n===bottoms[0]),'input anchor remains fixed')
  stage.onAction({action:'read'});const read=draw();assert.ok(read.rows[0]!.includes('记录'));stage.onAction({action:'cancel'});draw();idle()
  for(const [w,h] of [[192,50],[160,50],[80,24],[24,12],[16,8],[120,40]]){width=w!;height=h!;stage.onResize();draw();idle()}
  assert.deepEqual(stage.view().input,draft)
  console.log(`current group sequence:frames${frames};idles${idles} bytes0;6 growths/sizes;fixed input/read return/draft exact`)
 }finally{stage.close();term.close()}
})
