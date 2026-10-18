import assert from 'node:assert/strict'
import {test} from 'node:test'
import {frameOf,innerOf} from './frame.ts'
import {statusOf} from '../probe/status.ts'
import type {StatusRow} from '../probe/status.ts'
import {taskOf} from './task.ts'
import {gateFaceOf,gateLayoutOf} from './gate.ts'
import {glyphs,setGlyphTier,widthOf} from './glyph.ts'
import {openStage} from './stage.ts'
import {openSession} from './follow.ts'
import {openTerm} from './term.ts'
import {KEYMAP,hintLineOf} from './keymap.ts'
const make=(state='Working')=>[
 {pos:{writer:'round',seq:1},e:{t:'round/state',round:'r1',from:'Idle',to:state}},
 {pos:{writer:'round',seq:2},e:{t:'round/intent',round:'r1',body:'修复登录提示'}},
 {pos:{writer:'holder/r1',seq:1},e:{t:'holder/distill',agent:'holder/r1',body:'保留账号，只调整失败提示。'}},
 ...(state==='Rebuilding'?[{pos:{writer:'round',seq:3},e:{t:'merge/accept',round:'r1',commit:'result',assertions:[{assertion:'登录',verdict:'pass'}]}}]:[]),
] as StatusRow[]
const at=(f:ReturnType<typeof frameOf>,s:string)=>f.lines.findIndex(l=>l.includes(s))
const meaningful=(f:ReturnType<typeof frameOf>)=>f.lines.flatMap((l,i)=>i>0&&!['border','footer'].includes(f.roles[i]!)&&l.slice(1,-1).trim()!==''?[i]:[])
const trailing=(f:ReturnType<typeof frameOf>)=>{const last=meaningful(f).at(-1)!;let n=0;for(let i=last+1;i<f.lines.length&&!['border','footer'].includes(f.roles[i]!);i++)n++;return n}
function base(rows:StatusRow[],width=120,height=35){return {snapshot:statusOf(rows),task:taskOf(rows),width,height,operationArea:true}}

test('current sparse conversation hangs above the input and first-open invitation stays near input without reducing capacity',()=>{
 let cases=0
 try{for(const glyph of ['ascii','box','rich'] as const){setGlyphTier(glyph)
  for(const [width,height] of [[120,35],[160,45],[80,35],[24,35]])for(const rows of [[],make(),make('Aborted'),make('Rebuilding')]){
   const o=base(rows,width,height),f=frameOf(o),positions=meaningful(f)
   const head=f.lines.findIndex(l=>l.startsWith(glyphs().tl))
   assert.equal(trailing(f),0,'no unused rows between current content and its footer/frame bottom')
   assert.equal(positions[0],rows.length===0?height-1:head+1,'task body follows its title; empty invitation stays next to input')
   assert.equal(f.lines.length,height);assert.equal(f.roles.length,height);for(const l of f.lines)assert.equal(widthOf(l),width)
   assert.deepEqual(frameOf(o),f,'pure render retains exact idle frame')
   if(rows.length&&o.task.state!=='Rebuilding'){assert.ok(at(f,'你')<at(f,'保留账号'));assert.ok(f.roles.includes('user')&&f.roles.includes('model'))}
   cases++
  }
 }}finally{setGlyphTier('box')}
 console.log(`nearby content: ${cases} cases; first/work/failure/written;3 glyphs x4 desktop/narrow sizes;trailing blank0;full geometry/order/pure idle exact`)
})

test('sparse current explanation hangs above the input and the unchanged complete confirmation sits right below it; dense content keeps all original capacity',()=>{
 const rows=make('Planning'),face=gateFaceOf({round:'r1',fingerprint:'nearby',same:[],contracts:[{id:'r1.implement.1',agent:'agent/r1/1',kind:'implement',goal:'修复登录提示',ownedPaths:['src/login.ts'],seed:[],deliverables:[],assertions:[{name:'登录行为',action:'test'}]}]} as never,{test:'node tools/test-entry.js'})
 for(const height of [35,45]){
  const o=base(rows,120,height),bottom=gateLayoutOf({face,view:{at:0,armed:null},columns:innerOf(120),height}),f=frameOf({...o,bottom})
  const firstCard=f.lines.length-bottom.rows.length-1,lastModel=at(f,'保留账号')
  const head=f.lines.findIndex(l=>l.startsWith(glyphs().tl))
  assert.ok(head>0,'the conversation box hangs above the input')
  assert.equal(lastModel+4,firstCard,'one blank row and a drawn top edge, then the decision rows')
  assert.equal(f.roles[lastModel+1],'border','current content has a closing outline')
  assert.equal(f.lines[lastModel+2]!.trim(),'','the only row between the boxes is blank')
  assert.equal(f.roles[lastModel+3],'border','the decision box has its own top edge')
  assert.ok(f.lines.slice(0,head).every(l=>l.trim()===''),'spare capacity stays above both boxes')
  assert.ok(f.roles.slice(0,head).every(r=>r==='body'),'spare rows above the box carry no outline role')
  assert.equal(f.roles[firstCard-1],'border');assert.equal(f.lines.length,height)
  assert.deepEqual(f.lines.slice(firstCard,-1).map(l=>l.slice(1,-1).trim()),bottom.rows.map(l=>l.trim()))
  const dense=frameOf({...o,bottom,task:{...o.task,rows:[...o.task.rows,{text:'模型\n'+Array.from({length:80},(_,i)=>`进展${i}`).join('\n'),role:'model'}]}})
  assert.equal(dense.lines.length,height);assert.equal(dense.roles[1],f.roles[meaningful(f)[0]!]);assert.ok(dense.lines.join('').includes('行未展开'))
  assert.deepEqual(dense.lines.slice(-bottom.rows.length-1,-1).map(l=>l.slice(1,-1).trim()),bottom.rows.map(l=>l.trim()))
 }
 console.log('bottom confirmation:35/45rows;two adjacent boxes above input;complete card rows exact;spare above;dense original body/omission/actions capacity')
})

test('legacy, unmatched or bad task metadata, unknown operations, readers, menus and secondary views keep top-led layout; full or short current content spends no extra rows',()=>{
 const o=base(make()),bad={...o.task,round:'other'}
 for(const change of [
  {operationArea:undefined},{operationArea:false},{task:undefined},{task:bad},{task:{...o.task,rows:[{text:'unknown source',role:'body' as const}]}},
  {bottom:{rows:['unknown action'],keep:1}},
  {read:{rows:['read first','read last'],top:0}},{menu:{rows:['menu action'],sel:0}},
  {menu:{rows:['menu action'],sel:0,detail:['help first','help last']}},
  {view:'progress' as const},{view:'spending' as const},
 ]){const f=frameOf({...o,...change});assert.equal(meaningful(f)[0],1,'unproven context and other views keep original first row');assert.equal(f.lines.length,35)}
 for(const width of [120,24,16,8,3])for(const height of [19,7,5]){
  const f=frameOf({...o,width,height,task:{...o.task,rows:[{text:'正在处理任务',role:'system'},{text:'模型\n'+Array.from({length:80},(_,i)=>`原文${i}`).join('\n'),role:'model'}]}})
  assert.equal(f.lines.length,height);assert.ok(f.lines.every(l=>widthOf(l)===width));assert.equal(meaningful(f)[0],1,'dense/short content has no spare capacity to move')
 }
 console.log('nearby floor:11 readonly/legacy/unknown/read/menu/secondary contexts top-led;120/24/16/8/3 x19/7/5 dense geometry/capacity exact')
})

test('actual Stage/Session/Term advance, streaming growth, input wrapping, confirmation/read returns and resizes keep idle writes zero and the draft intact',async()=>{
 let rows:StatusRow[]=[],width=120,height=40,pending:ReturnType<typeof gateFaceOf>|null=null,frames=0,idles=0;const writes:string[]=[],launches:string[]=[]
 const stage=openStage({rows:()=>rows,columns:()=>width,termRows:()=>height,pendingFace:async()=>pending,redraw:()=>{},note:()=>{},now:()=>0,abort:()=>{},hint:w=>hintLineOf(KEYMAP,3,w),run:()=>({running:false,last:[],argvOf:()=>({words:[],argv:[],why:null}),press:s=>{launches.push(s);return true},stop:()=>false})})
 stage.setRaw(true);const session=openSession({view:stage.view});const term=openTerm({term:'xterm',heightOf:stage.heightWant,out:{isTTY:true,get columns(){return width},get rows(){return height},write:s=>writes.push(s)}})
 const draw=()=>{frames++;writes.length=0;term.draw([],size=>session.panel(size));return writes.join('')},idle=()=>{assert.equal(draw(),'');idles++},advance=()=>{stage.onAdvance(rows);session.push(rows.slice(session.rows.length))}
 try{
  draw();idle();rows=make('Planning');advance();draw();idle()
  stage.onAction({action:'insert',text:'保留当前草稿'});draw();const draft=stage.view().input
  pending=gateFaceOf({round:'r1',fingerprint:'nearby',same:[],contracts:[{id:'r1.implement.1',agent:'agent/r1/1',kind:'implement',goal:'修复提示',ownedPaths:['src/login.ts'],seed:[],deliverables:[],assertions:[]}]} as never,{test:'node tools/test-entry.js'});await stage.refreshGate();draw();idle()
  stage.onAction({action:'approve',key:'y'});draw();stage.onAction({action:'read'});draw();stage.onAction({action:'cancel'});draw();stage.onAction({action:'submit'});draw();assert.deepEqual(launches,[]);stage.onAction({action:'cancel'});pending=null;await stage.refreshGate();draw();assert.deepEqual(stage.view().input,draft);idle()
  for(const [w,h] of [[120,40],[160,50],[80,24],[24,12],[16,8],[120,40]]){
   width=w!;height=h!;stage.onResize();draw();idle()
   for(const n of [1,4,12,40]){rows.push({pos:{writer:'holder/r1',seq:rows.length+1},e:{t:'holder/distill',agent:'holder/r1',body:Array.from({length:n},(_,i)=>`实际增长${i}`).join('\n')}} as StatusRow);advance();draw();idle()}
  }
  assert.deepEqual(stage.view().input,draft);assert.deepEqual(launches,[])
  console.log(`nearby sequence:frames${frames};idles${idles} bytes0;6 sizes;24 source growths;read/old approval execute0;draft exact`)
 }finally{stage.close();term.close()}
})


test('a short auxiliary plan aligns with current content; long plans retain all screen capacity and narrow or read-only layouts retain their original floor',()=>{
 const o=base(make()),plan=[{text:'核对登录行为',status:'in_progress' as const},{text:'检查账户保留',status:'pending' as const}]
 const f=frameOf({...o,task:{...o.task,plan}})
 const planAt=(x:ReturnType<typeof frameOf>)=>x.segments!.findIndex(s=>s[2]!.text.trim()==='计划')
 const firstMain=f.lines.findIndex((_,i)=>i>0&&f.roles[i]==='system')
 assert.equal(planAt(f),firstMain-1,'short auxiliary plan title aligns with the adjacent current task title')
 assert.ok(f.lines.join('').includes('核对登录行为')&&f.lines.join('').includes('检查账户保留'))
 const many=Array.from({length:40},(_,i)=>({text:`第${i}项待做任务`,status:'pending' as const}))
 const tall=frameOf({...o,task:{...o.task,plan:many}});assert.equal(planAt(tall),0);assert.ok(tall.lines.at(-1)!.includes('还有计划未展开'));assert.equal(tall.lines.length,35)
 const legacy=frameOf({...o,operationArea:undefined,task:{...o.task,plan}});assert.equal(planAt(legacy),0)
 const narrow=frameOf({...o,width:80,task:{...o.task,plan}});assert.equal(narrow.columns.right,0);assert.ok(!narrow.lines.join('').includes('核对登录行为'))
 console.log('nearby plan:short route aligns primary content;40 tasks keep full35-row capacity and omission;readonly top0;narrow sidebar0')
})
