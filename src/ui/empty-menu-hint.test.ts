import assert from 'node:assert/strict'
import {test} from 'node:test'
import {frameOf} from './frame.ts'
import {statusOf} from '../probe/status.ts'
import {openStage} from './stage.ts'
import {openSession} from './follow.ts'
import {openTerm} from './term.ts'
import {gateFaceOf} from './gate.ts'
import {KEYMAP,keymapOf,hintLineForWidth,hintPicksOf,hintLineOf,HINT_WHEN,decodeOf,keyLabelOf} from './keymap.ts'
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

test('command and path zero candidates show only actual return and line-edit keys through navigation, editing, accept and cancel; preserve draft, reader and FIFO',()=>{
 let cases=0,frames=0,idles=0,queueOriginals=0
 try{for(const glyph of ['ascii','box','rich'] as const){setGlyphTier(glyph)
 for(const width of [192,120,80,24,16])for(const height of [8,12,24,50])for(const queued of [false,true])for(const source of ['cmd','path'] as const)for(const reading of [false,true]){
  const r=rig(width,height,queued),key=(s:string)=>{for(const d of decodeOf(s,r.km))r.stage.onAction(d)}
  const empty=()=>{
   const v=r.stage.view();assert.equal(v.menu!.rows.length,0)
   assert.equal(v.menu!.help,undefined,'ordinary menus stay ordinary')
   assert.equal(v.hint,hintLineForWidth(width,r.km,'menuEmpty'),'zero candidates derive the current empty-menu context')
   assert.ok(!/下一项|上一项|选择|看全/.test(v.hint!),'selection and navigation do not occupy current empty-result hint')
   const f=r.draw();assert.ok(!f.rows.some(s=>s.includes('按键帮助')),'ordinary source does not acquire help identity')
   if(height>=12)assert.ok(r.vt.lines.includes(v.hint!.trimEnd()),'complete current hint is physically visible within original capacity')
  }
  try{
   if(reading){key('\x1bt');r.draw()}
   const frozen=r.stage.view().read
   if(source==='path')r.type('CURRENT-中文 ')
   r.stage.onAction({action:source==='cmd'?'menu':'mention'});r.draw()
   assert.ok(r.stage.view().menu!.rows.length>0);assert.equal(r.stage.view().hint,hintLineForWidth(width,r.km,'menu'))
   r.type('ZZZ-UNMATCHABLE');empty()
   const original=r.stage.view().input
   for(const action of ['historyOlder','historyNewer','pageUp','pageDown','jumpFirst','jumpLast'] as const){
    r.stage.onAction({action});empty();assert.deepEqual(r.stage.view().input,original);assert.deepEqual(r.stage.view().read,frozen);assert.equal(r.stage.view().menu!.sel,0)
   }
   key('\x1b[H');r.draw();const homeDraft=r.stage.view().input;key('\x1bu');r.draw()
   if(source==='cmd'){assert.ok(r.stage.view().menu!.rows.length>0);assert.equal(r.stage.view().hint,hintLineForWidth(width,r.km,'menu'))}
   else assert.equal(r.stage.view().menu,undefined,'removing the path marker closes the original panel')
   r.stage.onAction({action:'undo'});r.draw();assert.deepEqual(r.stage.view().input,homeDraft,'undo restores the exact pre-clear text and Home caret');key('\x1b[F');r.draw();assert.deepEqual(r.stage.view().input,original)
   if(source==='cmd')empty()
   else{
    assert.equal(r.stage.view().menu,undefined,'undo does not invent a reopening state')
    r.stage.onAction({action:'mention'});r.draw();assert.ok(r.stage.view().menu!.rows.length>0)
    r.type('ZZZ-UNMATCHABLE');empty()
   }
   const cancelDraft=r.stage.view().input
   key('\x1be');r.draw();assert.equal(r.stage.view().menu,undefined);assert.deepEqual(r.stage.view().input,cancelDraft);assert.deepEqual(r.stage.view().read,frozen);assert.deepEqual(r.presses,[])
   r.stage.onAction({action:source==='cmd'?'panel':'mention'});r.draw()
   if(source==='path')r.type('ZZZ-UNMATCHABLE')
   empty();const acceptDraft=r.stage.view().input
   key('\r');r.draw();assert.equal(r.stage.view().menu,undefined);assert.deepEqual(r.stage.view().input,acceptDraft,'empty Enter returns without changing or dispatching the real draft');assert.deepEqual(r.stage.view().read,frozen);assert.deepEqual(r.presses,[])
   const final=source==='cmd'?'/ZZZ-UNMATCHABLE':'FINAL-中文 @ZZZ-UNMATCHABLE'
   if(reading){key('\x1be');r.draw();assert.equal(r.stage.view().read,undefined)}
   key('\x1bu');r.draw();r.type(final);r.draw()
   if(queued)for(const s of r.queueNames){r.stop();assert.equal(r.stage.startNext(),true);assert.equal(r.presses.at(-1),s);queueOriginals++}
   r.stop();key('\r');r.draw();assert.equal(r.presses.at(-1),final);assert.equal(r.presses.filter(s=>s===final).length,1)
   cases++;frames+=r.frames;idles+=r.idles
  }finally{r.close()}
 }
 }}finally{setGlyphTier('box')}
 console.log('empty ordinary menus:cases'+cases+';frames'+frames+';idles'+idles+' bytes0;queueOriginals'+queueOriginals+';2sources/3glyph/5width/4height/reader+FIFO;current keys;no-op navigation;clear/undo marker semantics;Enter+Esc preserve draft;mock dispatch once;caret/input exact;wrap0/scroll0;owned close0')
})
