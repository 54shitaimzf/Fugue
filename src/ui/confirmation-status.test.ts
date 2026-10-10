import assert from 'node:assert/strict'
import {test} from 'node:test'
import {frameOf,innerOf} from './frame.ts'
import type {BottomInput} from './frame.ts'
import {gateFaceOf,gateLayoutOf} from './gate.ts'
import {taskOf} from './task.ts'
import {statusOf} from '../probe/status.ts'
import type {StatusRow} from '../probe/status.ts'
import {setGlyphTier,widthOf} from './glyph.ts'
import {openStage} from './stage.ts'
import {openSession} from './follow.ts'
import {openTerm} from './term.ts'
import {KEYMAP,hintLineOf} from './keymap.ts'
const ready='等待你确认整批任务。',preparing='正在准备计划。'
const rows=[{pos:{writer:'round',seq:1},e:{t:'round/state',round:'r1',from:'Idle',to:'Planning'}},{pos:{writer:'round',seq:2},e:{t:'round/intent',round:'r1',body:JSON.stringify({goal:'修复登录失败提示，保留账号。'})}},{pos:{writer:'round',seq:3},e:{t:'holder/distill',agent:'round',body:'原始模型说明：正在准备计划。'}}] as StatusRow[]
const face=gateFaceOf({round:'r1',fingerprint:'status-batch',same:[],contracts:[1,2].map(n=>({id:`r1.implement.${n}`,agent:`agent/r1/${n}`,kind:'implement',goal:`修复第${n}项提示`,ownedPaths:[`src/login${n}.ts`],assertions:[{name:'登录行为',action:'test'}],seed:[],deliverables:[]}))} as never,{test:'node tools/test-entry.js fast src/login.test.ts'})
const task=taskOf(rows),snapshot=statusOf(rows),shown=(f:ReturnType<typeof frameOf>)=>f.lines.join('\n')
const metadata=(b:BottomInput,round:unknown)=>({...b,confirmationRound:round}) as BottomInput

test('valid current approval replaces only the preparation status; source state, messages, card and frame capacity stay exact',()=>{
 const original=JSON.stringify({snapshot,task});let checked=0
 try{for(const glyph of ['ascii','box','rich'] as const){setGlyphTier(glyph)
  for(const width of [160,120,108,80])for(const height of [45,35,19])for(const armed of [null,'approve','reject'] as const){
   const bottom=gateLayoutOf({face,view:{at:1,armed},columns:innerOf(width),height}),legacy=frameOf({snapshot,task,width,height,bottom:metadata(bottom,undefined)}),f=frameOf({snapshot,task,width,height,bottom:metadata(bottom,'r1')})
   assert.ok(shown(f).includes(ready));assert.equal(f.roles[1],'waiting');assert.ok(!f.lines[1]!.includes(preparing))
   assert.ok(shown(f).includes('原始模型说明：正在准备计划。'),'never rewrite original model words')
   assert.deepEqual(f.lines.slice(2),legacy.lines.slice(2));assert.deepEqual(f.roles.slice(2),legacy.roles.slice(2))
   assert.deepEqual(f.columns,legacy.columns);assert.equal(f.footer,legacy.footer);assert.equal(f.lines.length,height);assert.ok(f.lines.every(l=>widthOf(l)===width));checked++
  }
 }}finally{setGlyphTier('box')}
 assert.equal(JSON.stringify({snapshot,task}),original)
 console.log(`approval status: ${checked} frames; ascii/box/rich x160/120/108/80 x45/35/19 x3 choices; first status only; exact source/message/card/capacity`)
})

test('gate layout carries its own round; absent/foreign/bad metadata, unknown state, readers, menus and secondary views retain original frames',()=>{
 const width=120,height=35,b=gateLayoutOf({face,view:{at:0,armed:null},columns:innerOf(width),height}),base={snapshot,task,width,height}
 assert.equal((b as BottomInput & {confirmationRound?:unknown}).confirmationRound,'r1')
 const blocked=gateLayoutOf({face,view:{at:0,armed:null},columns:innerOf(16),height:7})
 assert.equal((blocked as BottomInput & {confirmationRound?:unknown}).confirmationRound,'r1')
 const empty=gateLayoutOf({face:{...face,cards:[]},view:{at:0,armed:null},columns:innerOf(width),height});assert.equal(empty.confirmationRound,undefined);assert.ok(shown(frameOf({...base,bottom:empty})).includes(preparing))
 const legacy=frameOf({...base,bottom:metadata(b,undefined)})
 for(const value of [undefined,null,'','r0',7,{},'r1\x1b'])assert.deepEqual(frameOf({...base,bottom:metadata(b,value)}),legacy)
 for(const bad of [{...b,waitingAt:-1},{...b,waitingCount:0},{...b,keep:0},{...b,waitingAt:b.rows.length},{...b,rows:b.rows.map((s,i)=>i===b.waitingAt?'':s)}])assert.deepEqual(frameOf({...base,bottom:metadata(bad,'r1')}),frameOf({...base,bottom:metadata(bad,undefined)}))
 for(const changed of [{...task,round:'r0'},{...task,state:null},{...task,rows:[]},{...task,rows:[{text:preparing,role:'user' as const}]},{...task,rows:[{text:'未知系统状态',role:'system' as const}]},...['Working','Committed','Rebuilding','Aborted'].map(state=>({...task,state}))])assert.deepEqual(frameOf({...base,task:changed,bottom:metadata(b,'r1')}),frameOf({...base,task:changed,bottom:metadata(b,undefined)}))
 for(const view of ['progress','spending'] as const)assert.deepEqual(frameOf({...base,view,bottom:metadata(b,'r1')}),frameOf({...base,view,bottom:metadata(b,undefined)}))
 for(const extra of [{read:{rows:['原文正在准备计划。'],top:0}},{menu:{rows:['候选'],sel:0}},{snapshot:{...snapshot,current:'r0'}}])assert.deepEqual(frameOf({...base,...extra,bottom:metadata(b,'r1')}),frameOf({...base,...extra,bottom:metadata(b,undefined)}))
 for(const w of [40,24,16,8,3])for(const h of [19,7,5]){const bottom=gateLayoutOf({face,view:{at:0,armed:null},columns:innerOf(w),height:h}),f=frameOf({...base,width:w,height:h,bottom});assert.equal(f.lines.length,h);assert.ok(f.lines.every(l=>widthOf(l)===w))}
 console.log('approval status floor: blocked round retained; missing/foreign/bad metadata and waiting range exact; noncurrent/unknown/messages unchanged; read/menu/views exact; 40/24/16/8/3 x19/7/5 geometry')
})

test('actual Stage/Session/Term keeps known pending readiness when confirmation is folded; readonly, draft, resize, batch refresh and fresh two-step approval stay intact',async()=>{
 let pending:typeof face|null=null,width=120,height=40;const writes:string[]=[],launches:string[]=[]
 const stage=openStage({rows:()=>rows,columns:()=>width,termRows:()=>height,pendingFace:async()=>pending,note:()=>{},redraw:()=>{},now:()=>0,abort:()=>{},hint:w=>hintLineOf(KEYMAP,3,w),run:()=>({running:false,last:[],argvOf:()=>({words:[],argv:[],why:null}),press:s=>{launches.push(s);return true},stop:()=>false})})
 stage.setRaw(true);stage.onAdvance(rows);const session=openSession({view:stage.view});session.push(rows)
 const term=openTerm({term:'xterm',heightOf:stage.heightWant,out:{isTTY:true,get columns(){return width},get rows(){return height},write:s=>writes.push(s)}})
 let frames=0,idles=0;const draw=()=>{frames++;writes.length=0;let body='';term.draw([],size=>{const f=session.panel(size);body=f.rows.join('\n');return f});return body},idle=()=>{draw();assert.equal(writes.join(''),'');idles++}
 try{
  stage.onAction({action:'insert',text:'保留下一步草稿'});const draft=stage.view().input;assert.ok(draw().includes(preparing));idle()
  pending=face;await stage.refreshGate();assert.ok(draw().includes(ready));idle()
  stage.onAction({action:'approve',key:'y'});assert.ok(draw().includes(ready));stage.onAction({action:'read'});const read=draw();assert.ok(read.includes('计划全文'));assert.ok(!read.includes(ready));stage.onAction({action:'submit'});stage.onAction({action:'approve',key:'y'});assert.deepEqual(launches,[]);idle()
  stage.onAction({action:'cancel'});assert.ok(draw().includes(ready));stage.onAction({action:'submit'});draw();assert.deepEqual(launches,[])
  width=16;height=8;stage.onResize();draw();stage.onAction({action:'submit'});draw();assert.deepEqual(launches,[])
  width=120;height=40;stage.onResize();assert.ok(draw().includes(ready));idle();stage.onAction({action:'cancel'});const hidden=draw();assert.ok(hidden.includes(ready));assert.ok(hidden.includes('原始模型说明：正在准备计划。'),'original model words stay');assert.equal(stage.view().bottom?.confirmationRound,undefined);assert.equal(stage.view().pendingRound,'r1');assert.deepEqual(stage.view().input,draft);idle()
  pending=null;await stage.refreshGate();assert.ok(draw().includes(preparing));pending={...face,fingerprint:'status-next'};await stage.refreshGate();assert.ok(draw().includes(ready));stage.onAction({action:'approve',key:'y'});draw();stage.onAction({action:'submit'});draw();assert.deepEqual(launches,['round go']);assert.deepEqual(stage.view().input,draft);idle()
  console.log(`approval status sequence: frames${frames}; idles${idles} bytes0; no pending=preparing; current pending/hidden=waiting; readonly/old/short execute0; fresh second1; draft exact`)
 }finally{stage.close();term.close()}
})
