import assert from 'node:assert/strict'
import {test} from 'node:test'
import {frameOf} from './frame.ts'
import {statusOf} from '../probe/status.ts'
import {openStage} from './stage.ts'
import {openSession} from './follow.ts'
import {openTerm} from './term.ts'
import {gateFaceOf} from './gate.ts'
import {keymapOf,hintLineForWidth,decodeOf} from './keymap.ts'
import {setGlyphTier,widthOf,clustersOf} from './glyph.ts'
import type {StatusRow} from '../probe/status.ts'
function screen(columns:number,rows:number){
 let cells=Array.from({length:rows},()=>Array(columns).fill('')),x=0,y=0,pending=false,wraps=0,scrolls=0
 const down=()=>{pending=false;if(++y===rows){cells.shift();cells.push(Array(columns).fill(''));y--;scrolls++}}
 const put=(raw:string)=>{for(let i=0;i<raw.length;){
  const c=raw[i]!
  if(c==='\x1b'){
   const m=/^\x1b\[([\d;]*)([A-Za-z])/.exec(raw.slice(i));assert.ok(m,'unhandled terminal control');i+=m[0].length
   const n=Number(m[1])||1;pending=false
   if(m[2]==='A')y=Math.max(0,y-n);else if(m[2]==='B')y=Math.min(rows-1,y+n)
   else if(m[2]==='C')x=Math.min(columns-1,x+n);else if(m[2]==='D')x=Math.max(0,x-n)
   else if(m[2]==='K')cells[y]=Array(columns).fill('')
   else if(m[2]==='M'){cells.splice(y,n);while(cells.length<rows)cells.push(Array(columns).fill(''))}
   else assert.fail('unhandled CSI '+m[2])
  }else if(c==='\r'){x=0;pending=false;i++}
  else if(c==='\n'){down();i++}
  else {
   const stop=raw.slice(i).search(/[\x1b\r\n]/),end=stop<0?raw.length:i+stop
   for(const g of clustersOf(raw.slice(i,end))){
    if(pending){down();x=0;wraps++}
    if(g.width>columns-x&&x>0){down();x=0;wraps++}
    assert.ok(g.width<=columns,'each fixture glyph fits the host')
    cells[y]![x]=g.text;for(let k=1;k<g.width;k++)cells[y]![x+k]=''
    if(x+g.width===columns){x=columns-1;pending=true}else x+=g.width
   }
   i=end
  }
 }}
 return {put,get lines(){return cells.map(a=>a.join('').trimEnd())},get caret(){return {row:y,col:x}},get wraps(){return wraps},get scrolls(){return scrolls}}
}
const face=gateFaceOf({round:'r1',fingerprint:'foreground-reader',same:[],contracts:Array.from({length:3},(_,i)=>({id:'r1.implement.'+i,agent:'agent/r1/'+i,kind:'implement',goal:'TASK-'+i+' actual changes',ownedPaths:['src/'+('nested/').repeat(3)+'file-'+i+'.ts'],seed:['REFERENCE-'+i],deliverables:[],assertions:[{name:'CHECK-'+i,action:'test'}]}))} as never,{test:'node checks.js --complete'})
const events=[{pos:{writer:'round',seq:1},e:{t:'round/state',round:'r1',from:'Idle',to:'Planning'}},{pos:{writer:'round',seq:2},e:{t:'round/intent',round:'r1',body:'Review three current changes'}}] as StatusRow[]
function rig(width:number,height:number,queued=false){
 const vt=screen(width,height),writes:string[]=[],presses:string[]=[],notes:string[]=[]
 const km=keymapOf({help:'Alt-H',cancel:'Alt-E',read:'Alt-T',historyNewer:'Alt-J',killToStart:'Alt-U'})
 let running=queued,pending:typeof face|null=null,frames=0,idles=0
 const stage=openStage({rows:()=>events,columns:()=>width,termRows:()=>height,keymap:()=>km,pendingFace:async()=>pending,redraw:()=>{},note:s=>notes.push(s),notes:()=>notes,now:()=>0,abort:()=>{},hint:w=>hintLineForWidth(width,km,w),run:()=>({get running(){return running},last:[],argvOf:s=>({words:[s],argv:[s],why:null}),press:s=>{presses.push(s);running=true;return true},stop:()=>{running=false;return true}})})
 stage.setRaw(true);const session=openSession({view:stage.view});session.push(events)
 const term=openTerm({out:{isTTY:true,columns:width,rows:height,write:s=>{writes.push(s);vt.put(s)}},term:'xterm',heightOf:stage.heightWant,reserveHeightOf:()=>height-1})
 const draw=()=>{
  let panel:ReturnType<typeof session.panel>|undefined
  term.draw([],size=>{panel=session.panel(size);return panel});frames++
  const input=stage.view().input!;assert.equal(vt.wraps,0);assert.equal(vt.scrolls,0)
  assert.deepEqual(vt.caret,{row:height-input.rows.length+input.caret.row,col:input.caret.col});assert.deepEqual(vt.lines.slice(height-input.rows.length),input.rows.map(s=>s.trimEnd()))
  const at=writes.length;term.draw([],size=>session.panel(size));frames++;idles++;assert.equal(writes.slice(at).join(''),'','same foreground is byte quiet')
  return panel!
 }
 const type=(s:string)=>{for(const ch of s)stage.onAction({action:'insert',text:ch})}
 const queueNames=['QUEUE-FIRST-'+('a'.repeat(80)),'QUEUE-SECOND-'+('b'.repeat(80))]
 if(queued){for(const s of queueNames){type(s);stage.onAction({action:'submit'})}stage.onAction({action:'cancel'});stage.onRunDone({code:0,signal:null,why:null})}
 return {stage,vt,presses,notes,queueNames,km,type,draw,get frames(){return frames},get idles(){return idles},showGate:async()=>{pending=face;await stage.refreshGate()},stop:()=>{running=false},close:()=>{stage.close();term.close();assert.ok(vt.lines.every(s=>s===''),'whole fixed owned rectangle closes blank')}}
}


test('ordinary menu Enter over a pending batch returns an editable visible selection or query, preserves original draft undo/caret and FIFO, and never submits during acceptance',async()=>{
 let cases=0,frames=0,idles=0,queueOriginals=0
 try{for(const glyph of ['ascii','box','rich'] as const){setGlyphTier(glyph)
 for(const width of [192,120,80,24,16])for(const height of [8,12,24,50])for(const queued of [false,true])
 for(const source of ['cmd','path'] as const)for(const match of [true,false])for(const arm of ['none','approve','reject']){
  const r=rig(width,height,queued),key=(s:string)=>{for(const d of decodeOf(s,r.km))r.stage.onAction(d)}
  try{
   const original='FULL-ORIGINAL-'+('xyz'.repeat(60))+'中文';r.type(original);key('\x1b[D\x1b[D\x1b[D\x1b[D\x1b[D');r.draw();const draft=r.stage.view().input
   await r.showGate();r.stage.onAction({action:'historyNewer'});r.draw()
   if(arm!=='none'){key(arm==='approve'?'y':'n');r.draw()}
   r.stage.onAction({action:source==='cmd'?'menu':'mention'});r.type(match?(source==='cmd'?'status':'AGENTS.md'):'ZZZ-NO-MATCH');r.draw()
   assert.equal(r.stage.view().menu!.rows.length===0,!match)
   key('\r');r.draw()
   assert.equal(r.stage.view().menu,undefined);assert.deepEqual(r.presses,[],'menu acceptance only fills the existing editor and never starts a covered queue')
   const selected=source==='cmd'?(match?'/status ':'/ZZZ-NO-MATCH'):(match?'@AGENTS.md':'@ZZZ-NO-MATCH')
   assert.ok(r.stage.view().input!.rows.join('').includes(match?(source==='cmd'?'status':'@AGENTS.md'):'ZZZ'),'the selected or unmatched query is visible before any submission')
   assert.equal(r.stage.view().bottom?.confirmationRound,undefined,'the current editor has no conflicting confirmation card')
   assert.equal(r.stage.view().hint,hintLineForWidth(width,r.km,'typing'),'the current instruction belongs to actual typing')
   const accepted=r.stage.view().input
   key('\x1a');r.draw();assert.deepEqual(r.stage.view().input,draft,'one original Undo restores the complete saved draft and physical caret')
   r.stage.onAction({action:'redo'});r.draw();assert.deepEqual(r.stage.view().input,accepted,'redo restores the visible selection exactly')
   if(queued)for(const s of r.queueNames){r.stop();assert.equal(r.stage.startNext(),true);assert.equal(r.presses.at(-1),s);queueOriginals++}
   r.stop();key('\r');r.draw();assert.equal(r.presses.at(-1),selected,'explicit submission sends the exact visible selection or query')
   assert.equal(r.presses.filter(s=>s===selected).length,1);assert.ok(!r.presses.includes('round go'),'accepting, undoing, redoing or submitting the visible query never approves the covered batch')
   cases++;frames+=r.frames;idles+=r.idles
  }finally{r.close()}
 }
 }}finally{setGlyphTier('box')}
 console.log('ordinary acceptance:cases'+cases+';frames'+frames+';idles'+idles+' bytes0;queueOriginals'+queueOriginals+';3glyph/5width/4height/FIFO/2sources/matched+unmatched/3priorArms;firstEnter0;actual visible text+typing instruction;original full draft/caret undo exact;redo exact;explicit chosen input once;no approval;wrap0/scroll0;owned close0')
})
