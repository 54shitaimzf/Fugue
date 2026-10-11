import assert from 'node:assert/strict'
import {test} from 'node:test'
import {openStage} from './stage.ts'
import {reflowTopOf,readWrap,readContentOf} from './read.ts'
import {openSession} from './follow.ts'
import {openTerm} from './term.ts'
import {gateFaceOf} from './gate.ts'
import {KEYMAP,hintLineOf} from './keymap.ts'
import {setGlyphTier,widthOf} from './glyph.ts'
import type {StatusRow} from '../probe/status.ts'
const payload='abcdefghijklmnopqrstuvwxyz'.repeat(12)
const face=gateFaceOf({round:'r1',fingerprint:'reader-reflow',same:[],contracts:Array.from({length:8},(_,i)=>({
 id:'r1.implement.'+i,agent:'agent/r1/'+i,kind:'implement',goal:'ITEM-'+i+' '+payload,
 ownedPaths:['src/'+payload+'/file-'+i+'.ts'],seed:['REFERENCE-'+i+' '+payload],deliverables:[],assertions:[{name:'CHECK-'+i,action:'test'}]
}))} as never,{test:'node tools/test-entry.js fast'})
function rig(w:number,h:number,queued=false){
 const goal=Array.from({length:8},(_,i)=>'RECORD-'+i+' '+payload).join('\n')
 const rows=[{pos:{writer:'round',seq:1},e:{t:'round/state',round:'r1',from:'Idle',to:'Planning'}},{pos:{writer:'round',seq:2},e:{t:'round/intent',round:'r1',body:JSON.stringify({goal})}}] as StatusRow[]
 let width=w,height=h,pending:typeof face|null=null,running=queued,frames=0,idles=0
 const presses:string[]=[],writes:string[]=[]
 const stage=openStage({rows:()=>rows,columns:()=>width,termRows:()=>height,pendingFace:async()=>pending,
  redraw:()=>{},note:()=>{},now:()=>0,abort:()=>{},hint:when=>hintLineOf(KEYMAP,0,when),
  run:()=>({get running(){return running},last:[],argvOf:s=>({words:[s],argv:[s],why:null}),press:s=>{presses.push(s);running=true;return true},stop:()=>{running=false;return true}})})
 stage.setRaw(true);const session=openSession({view:stage.view});session.push(rows)
 const term=openTerm({out:{isTTY:true,get columns(){return width},get rows(){return height},write:s=>writes.push(s)},term:'xterm',heightOf:stage.heightWant,reserveHeightOf:()=>height-1})
 const draw=()=>{writes.length=0;let size={columns:width,height:1};term.draw([],s=>{size=s;return session.panel(s)});frames++
  const p=session.panel(size),input=stage.view().input!;assert.ok(size.height+input.rows.length<=height,'current visible input rows are paid in the actual height')
  assert.ok(p.rows.every(s=>widthOf(s)===width),'every logical row keeps physical column capacity')
  const output=writes.join('');writes.length=0;term.draw([],s=>session.panel(s));assert.equal(writes.join(''),'','settled geometry remains byte quiet');frames++;idles++;return {p,output}
 }
 const type=(s:string)=>{for(const ch of s)stage.onAction({action:'insert',text:ch})}
 const queue=['QUEUE-FIRST '+payload,'QUEUE-SECOND '+payload]
 if(queued){for(const line of queue){type(line);stage.onAction({action:'submit'})}stage.onAction({action:'cancel'});stage.onRunDone({code:0,signal:null,why:null})}
 const seek=(marker:string)=>{const read=stage.view().read!;const at=read.rows.findIndex(s=>s.startsWith(marker));assert.ok(at>0,'fixture reaches a later original logical line '+marker)
  for(let i=read.top;i<at;i++)stage.onAction({action:'historyNewer'});assert.equal(stage.view().read!.rows[stage.view().read!.top],read.rows[at]);return read.rows[at]!}
 return {stage,type,draw,seek,presses,queue,get frames(){return frames},get idles(){return idles},
  resize:(w:number,h:number)=>{width=w;height=h;stage.onResize()},
  gate:async()=>{pending=face;await stage.refreshGate()},stop:()=>{running=false},
  close:()=>{stage.close();term.close()}}
}
test('whole plan reflow preserves the same original task while menu coverage, full draft and FIFO stay safe',async()=>{
 let cases=0,frames=0,idles=0,resizes=0
 try{for(const glyph of ['ascii','box','rich'] as const){setGlyphTier(glyph)
 for(const queued of [false,true])for(const height of [8,24,50]){
  const r=rig(192,height,queued),original='DRAFT '+payload+'\n保留完整内容'
  try{
   r.type(original);r.stage.onAction({action:'left'});const draft=r.stage.view().input;r.draw()
   await r.gate();r.draw();r.stage.onAction({action:'approve',key:'y'});r.stage.onAction({action:'read'})
   const marker='7/8';r.seek(marker);r.draw();r.stage.onAction({action:'help'});r.type('ZZZ');r.draw()
   for(const [w,h] of [[80,24],[24,8],[120,50],[192,height]]){
    r.resize(w!,h!);resizes++;const read=r.stage.view().read!;assert.ok(read.rows[read.top]!.startsWith(marker),'resize must retain original task7 while its plan is covered by help')
    r.draw();assert.deepEqual(r.presses,[]);r.stage.onAction({action:'approve',key:'y'});r.stage.onAction({action:'submit'});assert.deepEqual(r.presses,[])
    if(r.stage.view().menu===undefined){r.stage.onAction({action:'help'});r.type('ZZZ')}
   }
   r.stage.onAction({action:'cancel'});r.draw();assert.ok(r.stage.view().read!.rows[r.stage.view().read!.top]!.startsWith(marker))
   r.stage.onAction({action:'cancel'});r.draw();r.stage.onAction({action:'submit'});assert.deepEqual(r.presses,[],'return must not inherit approval')
   r.stage.onAction({action:'cancel'});r.draw();assert.deepEqual(r.stage.view().input,draft,'same final width preserves exact full draft and nonterminal caret')
   if(queued)for(const line of r.queue){r.stop();assert.equal(r.stage.startNext(),true);assert.equal(r.presses.at(-1),line)}
   r.stop();r.stage.onAction({action:'submit'});assert.equal(r.presses.at(-1),original);cases++;frames+=r.frames;idles+=r.idles
  }finally{r.close()}
 }
 }}finally{setGlyphTier('box')}
 console.log('plan reflow:cases'+cases+';resizes'+resizes+';frames'+frames+';idles'+idles+' bytes0;same task7 through covered-help widths192/80/24/120;full draft/caret/FIFO exact;readonly and stale approval execute0')
})
test('ordinary record retains source content across reflow instead of reusing a physical row number',()=>{
 let cases=0,frames=0,idles=0
 try{for(const glyph of ['ascii','box','rich'] as const){setGlyphTier(glyph)
 for(const height of [8,24,50]){
  const r=rig(192,height)
  try{
   const original='DRAFT '+payload;r.type(original);const draft=r.stage.view().input;r.stage.onAction({action:'read'});r.seek('RECORD-6');r.draw()
   for(const [w,h] of [[80,24],[16,8],[120,50],[192,height]]){
    r.resize(w!,h!);const read=r.stage.view().read!;assert.ok(read.rows[read.top]!.startsWith('RECORD-6'),'ordinary record reflow retains its original logical row, including title moving into/out of body');r.draw()
    r.stage.onAction({action:'approve',key:'y'});assert.deepEqual(r.presses,[])
   }
   r.stage.onAction({action:'cancel'});r.draw();assert.deepEqual(r.stage.view().input,draft);cases++;frames+=r.frames;idles+=r.idles
  }finally{r.close()}

 }
 }}finally{setGlyphTier('box')}
 console.log('record reflow:cases'+cases+';frames'+frames+';idles'+idles+' bytes0;original source line retained;heading moves safely;draft exact;execute0')
})

test('key explanation resize keeps the original instruction fragment and selected key',()=>{
 let cases=0,frames=0,idles=0
 try{for(const glyph of ['ascii','box','rich'] as const){setGlyphTier(glyph)
 for(const height of [8,24,50]){
  const k=rig(40,height)
  try{
   k.stage.onAction({action:'help'});assert.ok(k.stage.view().menu!.rows[0]!.startsWith('Enter'))
   const selected=k.stage.view().menu!.sel;k.stage.onAction({action:'read'});k.stage.onAction({action:'historyNewer'})
   const before=k.stage.view().read!,text=before.rows[before.top]!;assert.equal(before.top,1);assert.equal(text,'束后依次处理');k.draw()
   k.resize(16,height);const after=k.stage.view().read!;assert.equal(after.rows[after.top],text,'reflow keeps the exact original Enter instruction fragment, not an earlier fragment')
   assert.equal(after.top,3);k.draw();k.stage.onAction({action:'submit'});assert.deepEqual(k.presses,[]);k.stage.onAction({action:'cancel'});assert.equal(k.stage.view().menu!.sel,selected);k.draw()
   cases++;frames+=k.frames;idles+=k.idles
  }finally{k.close()}
 }
 }}finally{setGlyphTier('box')}
 console.log('key reflow:cases'+cases+';frames'+frames+';idles'+idles+' bytes0;physical top1->3 retains exact original Enter fragment;help selection exact;execute0')
})

test('source anchors preserve duplicate and blank logical rows, escaped text and Unicode clusters across known widths; unsupported metadata keeps original top',()=>{
 const lines=['', 'duplicate', 'duplicate', '字符 e\u0301 👩‍💻 '+payload, '\tCONTROL\n'+payload, '', 'LAST '+payload]
 let contexts=0,floors=0
 const projection=(width:number,title:string)=>{
  const physical=readContentOf(title,lines,width-4,width).rows
  const raw=widthOf(title)+5<=width?lines:[title,...lines]
  const parts:{line:number,from:number,to:number,text:string}[]=[]
  for(const [line,text] of raw.entries()){let offset=0
   for(const row of readWrap(text,width-4)){parts.push({line:line-(raw===lines?0:1),from:offset,to:offset+row.length,text:row});offset+=row.length}
  }
  assert.deepEqual(parts.map(p=>p.text),physical,'anchor oracle includes the exact complete display projection')
  return parts
 }
 for(const title of ['记录','LONG TITLE '+payload])for(const before of [192,120,80,40,16,8])for(const after of [192,120,80,40,16,8]){
  const old=projection(before,title),next=projection(after,title)
  for(const [top,anchor] of old.entries()){
   const changed=reflowTopOf({lines,title,top,before:{width:before,columns:before-4},after:{width:after,columns:after-4}})
   assert.ok(changed>=0&&changed<next.length,'reflow target is a real current original row')
   if(anchor.line===-1&&widthOf(title)+5<=after)assert.equal(changed,0,'a title now present in the fixed heading returns to the first body row')
   else {
    const found=next[changed]!
    assert.equal(found.line,anchor.line,'duplicate and blank source rows retain their original identity')
    assert.ok(found.from<=anchor.from&&(found.to>anchor.from||(found.from===found.to&&anchor.from===found.from)),'current row contains the original leading character at a cluster boundary')
   }
   assert.equal(reflowTopOf({lines,title,top,before:{width:before,columns:before-4},after:{width:before,columns:before-4}}),top,'same geometry retains every original top exactly');contexts++
  }
 }
 for(const top of [2,7,-1,0.5,NaN,Infinity,99999])for(const bad of [0,-1,NaN,Infinity,0.5]){
  const o={lines,top,before:{width:192,columns:188},after:{width:80,columns:76}}
  for(const side of ['before','after'] as const)for(const field of ['width','columns'] as const){assert.equal(reflowTopOf({...o,[side]:{...o[side],[field]:bad}}),top);floors++}
 }
 console.log('source reflow:contexts'+contexts+';invalidMetadataFloors'+floors+';duplicate/blank/control/CJK/combining/emoji source row+leading character retained;known same-width tops exact;unsupported top/width unchanged')
})
