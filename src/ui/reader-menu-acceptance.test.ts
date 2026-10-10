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


test('accepting an ordinary choice leaves either reader for the existing editor; cancelling and unmatched ordinary record queries preserve exact reading position',async()=>{
 let cases=0,frames=0,idles=0,returns=0,unmatchedFloors=0,queueOriginals=0
 try{for(const glyph of ['ascii','box','rich'] as const){setGlyphTier(glyph)
 for(const width of [192,120,80,24,16])for(const height of [8,12,24,50])for(const queued of [false,true])
 for(const pending of [false,true])for(const source of ['cmd','path'] as const)for(const match of [true,false]){
  const r=rig(width,height,queued),key=(s:string)=>{for(const d of decodeOf(s,r.km))r.stage.onAction(d)}
  try{
   const original='FULL-ORIGINAL-'+Array.from({length:30},(_,i)=>'line-'+i+' 中文').join('\n')
   if(pending)r.stage.onAction({action:'paste',text:original})
   key('\x1b[D\x1b[D\x1b[D');r.draw();const draft=r.stage.view().input
   if(pending)await r.showGate()
   r.stage.onAction({action:'read'});r.stage.onAction({action:'historyNewer'});r.draw();const read=r.stage.view().read
   assert.equal(read!.top,1)
   const open=()=>{r.stage.onAction({action:source==='cmd'?'menu':'mention'});r.type(match?(source==='cmd'?'status':'AGENTS.md'):'ZZZ-NO-MATCH');r.draw()}
   open();key('\x1be');r.draw();assert.deepEqual(r.stage.view().read,read,'cancellation returns to the same original reader and position');assert.deepEqual(r.presses,[])
   r.stage.onAction({action:'killToStart'});open();const query=r.stage.view().input
   assert.equal(r.stage.view().menu!.rows.length===0,!match)
   key('\r');r.draw();assert.equal(r.stage.view().menu,undefined);assert.deepEqual(r.presses,[],'first Enter only accepts, never submits or starts FIFO')
   if(match||pending){
    assert.equal(r.stage.view().read,undefined,'an accepted ordinary input owns the foreground instead of retaining either reader')
    assert.equal(r.stage.view().bottom?.confirmationRound,undefined)
    assert.equal(r.stage.view().hint,hintLineForWidth(width,r.km,'typing'),'the instruction describes the current editable input')
    const accepted=r.stage.view().input
    key('\x1a');r.draw();assert.deepEqual(r.stage.view().input,pending?draft:query,'one Undo restores the full folded draft/caret or original menu query')
    r.stage.onAction({action:'redo'});r.draw();assert.deepEqual(r.stage.view().input,accepted,'redo restores the exact accepted editor');returns++
   }else{
    assert.deepEqual(r.stage.view().read,read,'without a selected item or suspended draft, an unmatched query retains the original reader')
    assert.deepEqual(r.stage.view().input,query);assert.equal(r.stage.view().hint,hintLineForWidth(width,r.km,'read'))
    key('\x1be');r.draw();assert.equal(r.stage.view().read,undefined);unmatchedFloors++
   }
   const selected=source==='cmd'?(match?'/status ':'/ZZZ-NO-MATCH'):(match?'@AGENTS.md':'@ZZZ-NO-MATCH')
   if(queued)for(const s of r.queueNames){r.stop();assert.equal(r.stage.startNext(),true);assert.equal(r.presses.at(-1),s);queueOriginals++}
   r.stop();key('\r');r.draw();assert.equal(r.presses.at(-1),selected,'a later explicit submission sends the current original text exactly once')
   assert.equal(r.presses.filter(s=>s===selected).length,1);assert.ok(!r.presses.includes('round go'),'neither returning nor submission approves the held batch')
   cases++;frames+=r.frames;idles+=r.idles
  }finally{r.close()}
 }
 }}finally{setGlyphTier('box')}
 console.log('reader acceptance:cases'+cases+';returns'+returns+';unmatchedFloors'+unmatchedFloors+';frames'+frames+';idles'+idles+' bytes0;queueOriginals'+queueOriginals+';3glyph/5width/4height/FIFO/2readers/2sources/2matches;cancel read/top exact;firstEnter0;folded full draft/caret Undo exact;redo exact;visible text once;approve0;wrap0/scroll0;owned close0')
})

test('a reader menu accepted over reverse search preserves the original search query, history position, draft and physical caret through Undo',async()=>{
 let cases=0,frames=0,idles=0,originalSearches=0
 try{for(const glyph of ['ascii','box','rich'] as const){setGlyphTier(glyph)
 for(const width of [192,120,80,24,16])for(const height of [8,12,24,50])for(const source of ['cmd','path'] as const)for(const match of [true,false]){
  const r=rig(width,height),key=(s:string)=>{for(const d of decodeOf(s,r.km))r.stage.onAction(d)}
  try{
   const older='HISTORY-OLDER-'+('a'.repeat(40)),newer='HISTORY-NEWER-'+('b'.repeat(40))
   const historyInputs=[]
   for(const line of [older,newer]){r.type(line);r.draw();historyInputs.push(r.stage.view().input);key('\r');r.stop();r.stage.onRunDone({code:0,signal:null,why:null})}
   r.type('HISTORY-');r.stage.onAction({action:'search'});key('\x1b[D\x1b[D\x1b[D');r.draw();const draft=r.stage.view().input
   await r.showGate();r.stage.onAction({action:'read'});r.draw()
   r.stage.onAction({action:source==='cmd'?'menu':'mention'});r.type(match?(source==='cmd'?'status':'AGENTS.md'):'ZZZ-NO-MATCH');r.draw();key('\r');r.draw()
   assert.equal(r.stage.view().read,undefined);assert.equal(r.stage.view().hint,hintLineForWidth(width,r.km,'search'),'the saved editor search keeps its existing context')
   assert.deepEqual(r.presses,[older,newer],'menu acceptance adds no dispatch or approval')
   const accepted=r.stage.view().input;key('\x1a');r.draw();assert.deepEqual(r.stage.view().input,draft)
   r.stage.onAction({action:'redo'});r.draw();assert.deepEqual(r.stage.view().input,accepted)
   key('\x1a');r.draw();r.stage.onAction({action:'search'});r.draw()
   assert.deepEqual(r.stage.view().input,historyInputs[0],'reverse search continues the original query at the older original history item and physical end caret');originalSearches++
   r.stop();key('\r');r.draw();assert.equal(r.presses.at(-1),older);assert.equal(r.presses.filter(s=>s===older).length,2)
   cases++;frames+=r.frames;idles+=r.idles
  }finally{r.close()}
 }
 }}finally{setGlyphTier('box')}
 console.log('reader reverse search:cases'+cases+';originalSearches'+originalSearches+';frames'+frames+';idles'+idles+' bytes0;original query/history position/full draft/caret Undo+redo exact;matched+unmatched ordinary acceptance only;later original visible text once;approve0;wrap0/scroll0;owned close0')
})
