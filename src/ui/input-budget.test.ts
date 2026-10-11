import assert from 'node:assert/strict'
import {test} from 'node:test'
import {openStage} from './stage.ts'
import {openSession} from './follow.ts'
import {openTerm} from './term.ts'
import {panelWantOf} from './layout.ts'
import {KEYMAP,hintLineOf} from './keymap.ts'
import {gateFaceOf} from './gate.ts'

const face=gateFaceOf({round:'r1',fingerprint:'capacity',same:[],contracts:[{id:'r1.implement.1',agent:'agent/r1/1',kind:'implement',goal:'检查登录',ownedPaths:['src/login.ts'],seed:[],deliverables:[],assertions:[]}]} as never,{test:'node tools/test-entry.js'})
function rig(width:number,height:number|undefined){
 let pending:typeof face|null=null;const writes:string[]=[],presses:string[]=[]
 const stage=openStage({rows:()=>[],columns:()=>width,termRows:()=>height,pendingFace:async()=>pending,redraw:()=>{},note:()=>{},now:()=>0,abort:()=>{},hint:w=>hintLineOf(KEYMAP,0,w),run:()=>({running:false,last:[],argvOf:()=>({words:[],argv:[],why:null}),press:s=>{presses.push(s);return true},stop:()=>false})})
 stage.setRaw(true);const session=openSession({view:stage.view})
 const draw=()=>{writes.length=0;const t=openTerm({out:{isTTY:true,columns:width,rows:height,write:s=>writes.push(s)},term:'xterm',heightOf:stage.heightWant,reserveHeightOf:()=>panelWantOf(height,true)})
  let frameHeight=0;t.draw([],size=>{frameHeight=size.height;return session.panel(size)});const output=writes.join('');t.close();return {frameHeight,output,frame:session.panel({columns:width,height:frameHeight})}}
 const type=(text:string)=>{for(const ch of text)stage.onAction({action:'insert',text:ch})}
 return {stage,draw,type,presses,resize:(w:number,h:number)=>{width=w;height=h;stage.onResize()},pending:(p:typeof pending)=>{pending=p},close:()=>stage.close()}
}
function rowsWritten(raw:string){return (raw.match(/\x1b\[2K/g)??[]).length}
test('actual interactive frame, wrapped editor and hint together fit every known short window without changing the draft',()=>{
 let cases=0
 for(const width of [3,8,16,24,120])for(const height of [6,7,8,9,10,12,24,40])for(const text of ['','abcdefghi','ABCDEFGHIJKLMN'.repeat(9)]){
  const r=rig(width,height)
  try{r.type(text);const draft=r.stage.view().input!,v=r.draw();assert.ok(v.frameHeight+draft.rows.length<=height,`${width}x${height}: frame${v.frameHeight}+input${draft.rows.length} overflows`)
   assert.ok(rowsWritten(v.output)<=height,`${width}x${height}: frame/input/hint write${rowsWritten(v.output)} overflows`)
   assert.deepEqual(r.stage.view().input,draft,'drawing never edits or drops the retained draft');r.stage.onAction({action:'submit'});assert.deepEqual(r.presses,text===''?[]:[text],'the complete original editor submits once, despite visual cropping');cases++
  }finally{r.close()}
 }
 console.log(`input budget:${cases} cases;5 widths x8 heights x3 drafts;frame+input+hint <= actual rows;complete original submission exact`)
})
test('short-window confirmation, full reading, menu and return preserve the operation slot and draft; stale approval does not execute',async()=>{
 let frames=0
 for(const width of [16,24,120])for(const height of [6,8,10,12,40]){
  const r=rig(width,height)
  try{r.type('保持完整草稿'.repeat(20));const draft=r.stage.view().input!
   const draw=()=>{const v=r.draw();assert.ok(rowsWritten(v.output)<=height,`${width}x${height} total rows`);frames++}
   draw();r.pending(face);await r.stage.refreshGate();draw();r.stage.onAction({action:'read'});draw();r.stage.onAction({action:'cancel'});draw();r.stage.onAction({action:'submit'});assert.deepEqual(r.presses,[])
   r.stage.onAction({action:'cancel'});r.pending(null);await r.stage.refreshGate();draw();assert.deepEqual(r.stage.view().input,draft)
   r.stage.onAction({action:'help'});assert.ok(r.stage.view().menu);draw();r.stage.onAction({action:'cancel'});draw();assert.deepEqual(r.stage.view().input,draft)
  }finally{r.close()}
 }
 console.log(`input budget scenes:frames${frames};15 geometries;confirmation/read/menu/return;draft exact;stale execute0`)
})
test('desktop allocation, unknown rows and noninteractive or unrecognized terminal floors retain their original behavior',()=>{
 for(const height of [24,40,50]){const r=rig(120,height);try{const v=r.draw();assert.equal(v.frameHeight,panelWantOf(height,false));assert.equal(rowsWritten(v.output),v.frameHeight+3);r.type('a'.repeat(126));const n=r.stage.view().input!.rows.length;assert.equal(r.stage.heightWant(),panelWantOf(height,false)-n+1)}finally{r.close()}}
 const r=rig(16,undefined);try{r.type('a'.repeat(126));assert.equal(r.stage.heightWant(),10)}finally{r.close()}
 for(const isTTY of [true,false])for(const term of ['dumb','unknown-host']){let calls=0;const writes:string[]=[];const t=openTerm({out:{isTTY,columns:16,rows:8,write:s=>writes.push(s)},term,heightOf:()=>7});t.draw(['ORIGINAL'],()=>{calls++;return {rows:['UI'],input:{rows:['draft','draft'],caret:{row:1,col:2}}}});t.close();assert.equal(writes.join(''),'ORIGINAL\n');assert.equal(calls,0)}
 console.log('input budget floor:desktop24/40/50 unchanged;unknown10;noninteractive/unknown host permanent bytes exact;renderer0')
})

test('persistent Stage/Session/Term resize and editor sequence stays within the real rows with idle bytes zero and the full draft submitted once',()=>{
 let frames=0,idles=0
 for(const initial of [[120,40],[160,50],[80,24],[24,12]]){
  let width=initial[0]!,height=initial[1]!;const writes:string[]=[],presses:string[]=[]
  const stage=openStage({rows:()=>[],columns:()=>width,termRows:()=>height,pendingFace:async()=>null,redraw:()=>{},note:()=>{},now:()=>0,abort:()=>{},hint:w=>hintLineOf(KEYMAP,3,w),run:()=>({running:false,last:[],argvOf:()=>({words:[],argv:[],why:null}),press:s=>{presses.push(s);return true},stop:()=>false})})
  stage.setRaw(true);const session=openSession({view:stage.view}),term=openTerm({out:{isTTY:true,get columns(){return width},get rows(){return height},write:s=>writes.push(s)},term:'xterm',heightOf:stage.heightWant,reserveHeightOf:()=>panelWantOf(height,true)})
  const draw=()=>{frames++;writes.length=0;let size=0;term.draw([],s=>{size=s.height;return session.panel(s)});assert.ok(size+(stage.view().input?.rows.length??0)<=height);return writes.join('')}
  const idle=()=>{assert.equal(draw(),'');idles++}
  try{draw();idle();const original='ABCDEFGHIJKLMN'.repeat(9);for(const ch of original)stage.onAction({action:'insert',text:ch});draw();idle()
   for(const [w,h] of [[16,8],[24,10],[8,6],[24,12],initial,[16,8],initial]){width=w!;height=h!;stage.onResize();draw();idle()}
   stage.onAction({action:'submit'});draw();idle();assert.deepEqual(presses,[original]);assert.equal(stage.view().input!.rows.length,1)
  }finally{stage.close();term.close()}
 }
 console.log(`input budget sequence:frames${frames};idles${idles} bytes0;28 resizes;4 desktop/narrow starts;complete126-character submission each1`)
})
