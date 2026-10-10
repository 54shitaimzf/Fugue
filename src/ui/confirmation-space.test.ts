import assert from 'node:assert/strict'
import {test} from 'node:test'
import {frameOf,innerOf} from './frame.ts'
import {gateFaceOf,gateLayoutOf} from './gate.ts'
import {taskOf} from './task.ts'
import {statusOf} from '../probe/status.ts'
import type {StatusRow} from '../probe/status.ts'
import {setGlyphTier,widthOf,glyphs} from './glyph.ts'
import {openSession} from './follow.ts'
import {openStage} from './stage.ts'
import {openTerm} from './term.ts'
import {KEYMAP,hintLineOf} from './keymap.ts'
const goal='修复失败提示，保留已输入的账号。'
const path='src/'+ 'login_scope_'.repeat(6)+'PATH_END.ts'
const command='node tools/test-entry.js --work='+ 'x'.repeat(42)+' --required=COMMAND_END'
const rows=[{pos:{writer:'round',seq:1},e:{t:'round/state',round:'r1',from:'Idle',to:'Planning'}},{pos:{writer:'round',seq:2},e:{t:'round/intent',round:'r1',body:JSON.stringify({goal})}},{pos:{writer:'holder/r1',seq:1},e:{t:'holder/todos',agent:'holder/r1',body:JSON.stringify({todos:[{content:'核对提示分支',status:'in_progress'},{content:'验证账号保留',status:'pending'}]})}},{pos:{writer:'holder/r1',seq:2},e:{t:'holder/reply',agent:'holder/r1',body:'我会保留现有账号，只调整失败提示并验证重试。'}}] as StatusRow[]
const face=gateFaceOf({round:'r1',fingerprint:'confirmation-space',same:[],contracts:[1,2].map(n=>({id:`r1.implement.${n}`,agent:`agent/r1/${n}`,kind:'implement',goal:`修复第${n}项失败提示`,ownedPaths:[path],seed:[],deliverables:[],assertions:[{name:'提示行为',action:'test'}]}))} as never,{test:command})
const snapshot=statusOf(rows),task=taskOf(rows)
const cardText=(f:ReturnType<typeof frameOf>)=>f.lines.flatMap((line,i)=>['overlay','overlayBody','waiting'].includes(f.roles[i]!)?[line.slice(1,-1).trim()]:[])

test('确认独占实际窗口宽度，侧栏不裁掉命令和路径；收起后辅助计划恢复',()=>{
 for(const width of [108,120,160])for(const height of [19,35,45])for(const armed of [null,'approve','reject'] as const){
  const base={snapshot,task,width,height},plain=frameOf(base)
  assert.ok(plain.columns.right>0,'输入场景保留有效辅助计划')
  const bottom=gateLayoutOf({face,view:{at:1,armed},columns:innerOf(width),height})
  const f=frameOf({...base,bottom})
  assert.equal(f.columns.right,0,'确认优先使用完整宽度')
  assert.deepEqual(cardText(f),bottom.rows.map(l=>l.trim()),'已折行卡片逐行完整显示，不能二次裁切')
  assert.ok(f.lines.join('').includes('PATH_END.ts'));assert.ok(f.lines.join('').includes('COMMAND_END'))
  assert.equal(f.lines.length,height);assert.ok(f.lines.every(l=>widthOf(l)===width))
  assert.deepEqual(frameOf(base),plain,'返回输入后侧栏与原主区完全恢复')
 }
 console.log('confirmation space: 108/120/160 x19/35/45 x3 choices; sidebar yields; command/path tails and every card row exact; height stable; input sidebar restores')
})

test('多余留白中的分隔承担识别，不挤正文或选项；三字形、满容量与坏来源守住原布局',()=>{
 for(const glyph of ['ascii','box','rich'] as const){
  setGlyphTier(glyph)
  const width=120,height=35,bottom=gateLayoutOf({face,view:{at:0,armed:null},columns:innerOf(width),height})
  const base={snapshot,task,width,height,bottom},f=frameOf(base)
  const at=f.roles.findIndex(role=>role==='overlayBody')
  assert.ok(at>1);assert.equal(f.roles[at-1],'border','确认预览前有低权重分隔')
  assert.ok(f.lines[at-1]!.includes(glyphs().div.repeat(innerOf(width))))
  assert.deepEqual(cardText(f),bottom.rows.map(l=>l.trim()));assert.equal(f.roles.filter(r=>r==='waiting').length,bottom.waitingCount)
  const filled={...task,rows:[...task.rows,{text:'模型\n'+Array.from({length:80},(_,i)=>`原始进展${i}`).join('\n'),role:'model' as const}]}
  const dense=frameOf({...base,task:filled})
  assert.deepEqual(cardText(dense),bottom.rows.map(l=>l.trim()),'没有空白时不添加分隔，不挤确认正文')
  const firstCard=dense.roles.findIndex(role=>role==='overlayBody');assert.notEqual(dense.roles[firstCard-1],'border')
  for(const count of [0,-1,Number.NaN]){
   const bad={...bottom,waitingCount:count},invalid=frameOf({...base,bottom:bad})
   assert.ok(invalid.columns.right>0,'未知操作元数据不重排主区')
   assert.deepEqual(invalid,frameOf({...base,bottom:{...bad,waitingAt:undefined}}),'坏操作数据保留原候选排版')
  }
  const noMeta={...bottom,waitingAt:undefined,waitingCount:undefined};assert.ok(frameOf({...base,bottom:noMeta}).columns.right>0)
  const read={rows:['完整只读计划'],top:0,heading:'计划全文'}
  const reading=frameOf({...base,bottom:undefined,read});assert.equal(reading.columns.right,0);assert.ok(reading.lines[0]!.includes('计划全文'));assert.equal(reading.roles.filter(r=>r==='read').length,1,'实际舞台的计划全文保持完整阅读区')
  for(const w of [80,40,16,8,3])for(const h of [19,7,5]){
   const b=gateLayoutOf({face,view:{at:0,armed:null},columns:innerOf(w),height:h}),x=frameOf({snapshot,task,width:w,height:h,bottom:b})
   assert.equal(x.lines.length,h);assert.ok(x.lines.every(l=>widthOf(l)===w));assert.equal(x.columns.right,0)
  }
 }
 setGlyphTier('box')
 console.log('confirmation space floor: ascii/box/rich; spare row separator only; full card/actions retained; dense no new row; bad/missing context legacy; reader unaffected; 80/40/16/8/3 x19/7/5 geometry')
})

test('实际舞台确认、只读、缩高与返回维持草稿和二段确认，停留零输出',async()=>{
 let width=120,height=40,pending:typeof face|null=null;const writes:string[]=[],launches:string[]=[],notes:string[]=[]
 const stage=openStage({rows:()=>rows,columns:()=>width,termRows:()=>height,pendingFace:async()=>pending,note:s=>notes.push(s),redraw:()=>{},now:()=>0,abort:()=>{},hint:w=>hintLineOf(KEYMAP,3,w),run:()=>({running:false,last:[],argvOf:()=>({words:[],argv:[],why:null}),press:s=>{launches.push(s);return true},stop:()=>false})})
 stage.setRaw(true);stage.onAdvance(rows);const session=openSession({view:stage.view});session.push(rows)
 const term=openTerm({term:'xterm',heightOf:stage.heightWant,out:{isTTY:true,get columns(){return width},get rows(){return height},write:s=>writes.push(s)}})
 let frames=0,idles=0
 const draw=()=>{frames++;writes.length=0;let f:ReturnType<typeof session.panel>|undefined;term.draw([],size=>{f=session.panel(size);return f});return f!},idle=()=>{draw();assert.equal(writes.join(''),'');idles++}
 try{
  stage.onAction({action:'insert',text:'请保留重试按钮'});const draft=stage.view().input;draw();idle()
  pending=face;await stage.refreshGate();const gated=draw();assert.ok(gated.rows.join('').includes('PATH_END.ts'));assert.ok(!gated.segments?.some(s=>s.some(p=>p.role==='plan')));idle()
  stage.onAction({action:'approve',key:'y'});draw();idle();stage.onAction({action:'read'});draw();stage.onAction({action:'approve',key:'y'});stage.onAction({action:'submit'});draw();assert.deepEqual(launches,[])
  stage.onAction({action:'cancel'});draw();stage.onAction({action:'submit'});draw();assert.deepEqual(launches,[],'阅读往返不继承旧选择')
  stage.onAction({action:'approve',key:'y'});draw();width=16;height=8;stage.onResize();draw();stage.onAction({action:'submit'});draw();assert.deepEqual(launches,[],'缩高清除选择并阻止不可见确认')
  width=120;height=40;stage.onResize();draw();stage.onAction({action:'submit'});draw();assert.deepEqual(launches,[]);idle()
  stage.onAction({action:'cancel'});const returned=draw();assert.deepEqual(stage.view().input,draft);assert.ok(returned.segments?.some(s=>s.some(p=>p.role==='plan')));idle()
  pending={...face,fingerprint:'confirmation-space-next'};await stage.refreshGate();draw();stage.onAction({action:'approve',key:'y'});draw();stage.onAction({action:'submit'});draw();assert.deepEqual(launches,['round go']);assert.deepEqual(stage.view().input,draft);idle()
  assert.equal(notes.filter(s=>s.includes('这一轮打算开')).length,2)
  console.log(`confirmation space sequence: frames${frames}; idles${idles} bytes0; readonly/old/short execute0; fresh second1; draft exact; sidebar returns; one note per batch`)
 }finally{stage.close();term.close()}
})
