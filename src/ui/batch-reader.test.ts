import assert from 'node:assert/strict'
import {test} from 'node:test'
import {openStage} from './stage.ts'
import {openSession} from './follow.ts'
import {openTerm} from './term.ts'
import {gateFaceOf} from './gate.ts'
import {KEYMAP,hintLineOf} from './keymap.ts'
import {setGlyphTier,widthOf} from './glyph.ts'
const commands={test:'node verify-implementation.js COMMAND_ONE_END',resolve:'node verify-conflict.js COMMAND_THREE_END'}
function batch(tag='current'){
 const face=gateFaceOf({round:'r1',fingerprint:tag,same:[],contracts:[
  {id:'r1.implement.1',agent:'agent/r1/1',kind:'implement',goal:tag+' 实现登录提示',ownedPaths:['src/LOGIN_ONE_END.ts'],seed:['src/REFERENCE_ONE_END.ts'],deliverables:[{path:'src/LOGIN_ONE_END.ts',form:'正确提示'}],assertions:[{name:'实现验收',action:'test'}]},
  {id:'r1.investigate.2',agent:'agent/r1/2',kind:'investigate',question:tag+' 查明失败原因',seed:['log/REFERENCE_TWO_END.txt'],evidenceRequired:[{artifact:'evidence/REPORT_TWO_END.md',note:'给出可复现原因 EVIDENCE_TWO_END'}]},
  {id:'r1.resolve.3',agent:'agent/r1/3',kind:'resolve',base:'base',conflictPaths:['src/CONFLICT_THREE_END.ts'],assertions:[{name:'冲突验收',action:'resolve'}]},
 ]} as never,commands)
 const reads=[0,0,0];face.cards.forEach((card,i)=>{const head=card.head;Object.defineProperty(card,'head',{get(){reads[i]++;return head}})})
 return {face,reads}
}
async function rig(width=120,height:number|undefined=40){
 const first=batch();let pending:typeof first.face|null=null,calls=0;const presses:string[]=[],writes:string[]=[],notes:string[]=[]
 const stage=openStage({rows:()=>[],columns:()=>width,termRows:()=>height,pendingFace:async()=>{calls++;return pending},redraw:()=>{},note:s=>notes.push(s),hint:w=>hintLineOf(KEYMAP,3,w),now:()=>0,abort:()=>{},run:()=>({running:false,last:[],argvOf:()=>({words:[],argv:[],why:null}),press:s=>{presses.push(s);return true},stop:()=>false})})
 stage.setRaw(true);const session=openSession({view:stage.view}),term=openTerm({term:'xterm',heightOf:stage.heightWant,out:{isTTY:true,get columns(){return width},get rows(){return height},write:s=>writes.push(s)}})
 let frames=0,idles=0
 const draw=()=>{frames++;writes.length=0;let panel:ReturnType<typeof session.panel>|undefined;term.draw([],size=>{panel=session.panel(size);return panel});return panel!}
 const idle=()=>{draw();assert.equal(writes.join(''),'');idles++}
 stage.onAction({action:'insert',text:'请保留账号和重试按钮'});const draft=stage.view().input
 pending=first.face;await stage.refreshGate()
 return {first,stage,presses,draft,draw,idle,counts:()=>({frames,idles,calls}),pending:(face:typeof pending)=>{pending=face},resize:(w:number,h:number|undefined)=>{width=w;height=h;stage.onResize()},close:()=>{stage.close();term.close()}}
}
const tokens=['实现登录提示','LOGIN_ONE_END.ts','REFERENCE_ONE_END.ts','COMMAND_ONE_END','查明失败原因','REPORT_TWO_END.md','REFERENCE_TWO_END.txt','EVIDENCE_TWO_END','CONFLICT_THREE_END.ts','COMMAND_THREE_END']

test('整批只读包含三种任务的未选中影响范围与命令，每条物理行可达，返回同一选中项',async()=>{
 for(const glyph of ['ascii','box','rich'] as const)for(const [width,height] of [[160,50],[120,40],[80,24],[40,24],[24,12],[16,12],[8,8]] as const){
  setGlyphTier(glyph);const r=await rig(width,height)
  try{
   r.stage.onAction({action:'historyNewer'});r.stage.onAction({action:'approve',key:'y'});r.stage.onAction({action:'read'})
   const read=r.stage.view().read!;assert.ok(read);assert.equal(r.stage.view().bottom,undefined)
   const text=[read.heading,...read.rows].join('').replace(/\s/g,'')
   for(const token of tokens)assert.ok(text.includes(token.replace(/\s/g,'')),`整批包含未选中范围: ${token}`)
   assert.ok(text.includes('计划全文'));assert.ok(text.includes('3项任务'),'固定标题或窄窗正文说明整批数量')
   assert.ok(text.indexOf('实现登录提示')<text.indexOf('查明失败原因'));assert.ok(text.indexOf('查明失败原因')<text.indexOf('CONFLICT_THREE_END.ts'))
   const seen=new Set<string>();for(let i=0;i<=read.rows.length;i++){
    const panel=r.draw();assert.ok(panel.rows.every(line=>widthOf(line)<=width));panel.rows.forEach((line,n)=>{if(panel.roles?.[n]==='read')seen.add(line.slice(1,-1).trim())});r.stage.onAction({action:'historyNewer'})
   }
   for(const line of read.rows)assert.ok(seen.has(line.trim()),`完整物理行可达: ${line}`)
   r.stage.onAction({action:'approve',key:'y'});r.stage.onAction({action:'submit'});r.stage.onAction({action:'reject',key:'n'});r.stage.onAction({action:'submit'});assert.deepEqual(r.presses,[])
   r.stage.onAction({action:'cancel'});assert.ok(r.stage.view().bottom!.rows.join(' ').includes('当前 2/3')||width<=16)
   r.stage.onAction({action:'submit'});assert.deepEqual(r.presses,[],'整批阅读返回不继承批准')
   r.stage.onAction({action:'cancel'});assert.deepEqual(r.stage.view().input,r.draft);assert.equal(r.counts().calls,1)
  }finally{r.close()}
 }
 setGlyphTier('box')
 console.log('batch reader: ascii/box/rich x160x50/120x40/80x24/40x24/24x12/16x12/8x8; implement/investigate/resolve and unselected command/path/evidence complete; every physical row reachable; readonly/old execute0; draft exact; selected2/3 restored; source fetch1')
})

test('整批按脸与列宽只排一次，选择和高度变化复用，换批次/缺失读源清除旧全文',async()=>{
 const r=await rig()
 try{
  r.first.reads.fill(0);r.stage.onAction({action:'read'});const initial=r.stage.view().read!
  assert.deepEqual(r.first.reads,[1,1,1],'整批每项正文只读一次')
  r.first.reads.fill(0)
  for(let n=0;n<12;n++){r.stage.onAction({action:'pageDown'});r.draw();r.idle()}
  r.stage.onAction({action:'panel'});const before=r.stage.view().read;r.stage.onAction({action:'historyNewer'});assert.deepEqual(r.stage.view().read,before);r.stage.onAction({action:'cancel'})
  r.resize(120,24);r.draw();r.resize(120,undefined);r.draw();assert.deepEqual(r.stage.view().read!.rows,initial.rows);assert.deepEqual(r.first.reads,[0,0,0])
  r.stage.onAction({action:'cancel'});r.stage.onAction({action:'historyNewer'});r.stage.onAction({action:'read'});assert.deepEqual(r.stage.view().read!.rows,initial.rows);assert.deepEqual(r.first.reads,[0,0,0],'选中任务不改变整批阅读内容或排版')
  r.resize(40,24);r.stage.view();assert.deepEqual(r.first.reads,[1,1,1]);r.resize(120,40);r.stage.view();assert.deepEqual(r.first.reads,[2,2,2])
  const second=batch('next');r.pending(second.face);await r.stage.refreshGate();assert.equal(r.stage.view().read,undefined);r.stage.onAction({action:'read'});const replaced=r.stage.view().read!;assert.ok(replaced.rows.join('').includes('next'));assert.ok(!replaced.rows.join('').includes('current'))
  r.pending(null);await r.stage.refreshGate();assert.equal(r.stage.view().read,undefined);r.stage.onAction({action:'read'});assert.equal(r.stage.view().read!.heading,'事件流');assert.deepEqual(r.stage.view().read!.rows,['暂无记录']);assert.deepEqual(r.presses,[])
  console.log(`batch reader cache: initial sourceReads1/1/1; 12 pages/menu/height/selection reuse0; 120->40->120 reflow1/1/1 each; new/missing batch clears; frames${r.counts().frames}; idles${r.counts().idles} bytes0; execute0`)
 }finally{r.close()}
})
