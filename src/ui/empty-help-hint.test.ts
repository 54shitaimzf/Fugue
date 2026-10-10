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
const flat=(s:readonly string[])=>s.map(x=>x.trim()).join('')

test('empty-help hints name only current return and line editing, retain configured physical keys, and use existing exact width floors',()=>{
 let cases=0
 assert.deepEqual(HINT_WHEN.helpEmpty,['cancel','killToStart'],'an empty help result has no selection, navigation or full-read affordance')
 try{for(const glyph of ['ascii','box','rich'] as const){setGlyphTier(glyph)
 for(const km of [KEYMAP,keymapOf({cancel:'Alt-E',killToStart:'Alt-U'}),keymapOf({cancel:'Alt-Enter',killToStart:'Alt-U'})]){
  const named=hintPicksOf(km,'helpEmpty');assert.deepEqual(named.map(b=>b.action),['cancel','killToStart'])
  assert.deepEqual(named.map(b=>b.keys),['cancel','killToStart'].map(action=>km.rows.find(b=>b.action===action)!.keys),'actual configured physical keys are authoritative')
  const full='按键 '+keyLabelOf(named[0]!)+' 返回 · '+keyLabelOf(named[1]!)+' 清行'
  assert.equal(hintLineOf(km,0,'helpEmpty'),full)
  assert.ok(!/下一项|上一项|选择|看全/.test(full))
  for(let width=1;width<=240;width++){
   const line=hintLineForWidth(width,km,'helpEmpty'),first=hintLineOf(km,1,'helpEmpty')
   if(width>=widthOf(full))assert.equal(line,full)
   if(width>=widthOf(first))assert.ok(widthOf(line)<=width)
   const compact=keyLabelOf({...named[0]!,keys:named[0]!.keys.slice(0,1)})+' 返回'
   if(width<widthOf(first)&&width>=widthOf(compact))assert.equal(line,compact)
   if(width<widthOf(compact))assert.equal(line,first,'host too narrow for one full key/action retains original overflow floor')
   assert.ok(!line.endsWith(' · '));assert.ok(line.includes(named[0]!.keys[0]!));cases++
  }
  assert.equal(hintLineForWidth(NaN,km,'helpEmpty'),full)
  assert.equal(hintLineForWidth(0,km,'helpEmpty'),hintLineOf(km,1,'helpEmpty'),'zero-width retains the original first-entry floor')
  assert.deepEqual(hintPicksOf(km,'menu').map(b=>b.action),['cancel','historyNewer','historyOlder','submit','read'],'normal menu hint is unchanged')
 }
 }}finally{setGlyphTier('box')}
 console.log('empty help hints:cases'+cases+';3glyph/3keymaps/240widths;only return+line edit;configured keys/whole-entry widths/unknown-size and too-narrow floors')
})
test('actual empty help changes only its current hint through clear/undo, multiline line editing and Enter/Esc return over full plan; original reader, drafts and queue stay',async()=>{
 let cases=0,frames=0,idles=0,queueOriginals=0
 try{for(const glyph of ['ascii','box','rich'] as const){setGlyphTier(glyph)
 for(const width of [192,120,80,24,16])for(const height of [8,12,24,50])for(const queued of [false,true]){
  const r=rig(width,height,queued),original='FULL-ORIGINAL-'+('xyz'.repeat(60))+'中文'
  const key=(s:string)=>{for(const d of decodeOf(s,r.km))r.stage.onAction(d)}
  const empty=()=>{
   assert.equal(r.stage.view().menu!.rows.length,0)
   assert.ok(!/下一项|上一项|选择|看全/.test(r.stage.view().hint!),'unavailable actions do not occupy the current hint')
   assert.equal(r.stage.view().hint,hintLineForWidth(width,r.km,'helpEmpty'))
   const f=r.draw();assert.ok(f.rows[0]!.includes('按键帮助'));assert.ok(!f.roles!.includes('read'))
   if(height>=12)assert.ok(r.vt.lines.includes(r.stage.view().hint!.trimEnd()),'current complete hint is physically visible whenever the existing operation capacity admits it')
  }
  try{
   r.type(original);const draft=r.stage.view().input;r.draw();await r.showGate();r.draw()
   r.stage.onAction({action:'historyNewer'});r.stage.onAction({action:'approve',key:'y'});r.stage.onAction({action:'read'});r.stage.onAction({action:'historyNewer'});r.draw()
   const frozen=r.stage.view().read;assert.ok(frozen?.heading?.startsWith('计划全文'));assert.ok(frozen!.top>0)
   key('\x1bh');r.draw();assert.equal(r.stage.view().hint,hintLineForWidth(width,r.km,'menu'))
   r.type('ZZZ');empty();assert.deepEqual(r.stage.view().read,frozen)
   key('\x1bu');r.draw();assert.ok(r.stage.view().menu!.rows.length>0);assert.equal(r.stage.view().hint,hintLineForWidth(width,r.km,'menu'))
   r.stage.onAction({action:'undo'});empty();assert.deepEqual(r.stage.view().read,frozen)
   key('\x1be');r.draw();assert.equal(r.stage.view().menu,undefined);assert.deepEqual(r.stage.view().read,frozen)
   key('\x1bh');r.stage.onAction({action:'insert',text:'ZZZ\nQQQ'});empty()
   key('\x1b[D\x1b[D\x1b[D');r.draw();key('\x1bu');empty();assert.ok(r.stage.view().input!.rows.join('').includes('QQQ'),'clear-to-start retains the suffix after the physical caret');assert.ok(!r.stage.view().input!.rows.join('').includes('ZZZ'))
   r.stage.onAction({action:'undo'});empty();assert.ok(r.stage.view().input!.rows.join('').includes('QQQ'),'undo retains original multiline filter')
   key('\r');r.draw();assert.equal(r.stage.view().menu,undefined);assert.deepEqual(r.stage.view().read,frozen);assert.deepEqual(r.presses,[])
   key('\x1be');r.draw();key('\r');assert.deepEqual(r.presses,[],'return cannot inherit approval or dispatch the filter')
   key('\x1be');r.draw();assert.deepEqual(r.stage.view().input,draft)
   if(queued)for(const s of r.queueNames){r.stop();assert.equal(r.stage.startNext(),true);assert.equal(r.presses.at(-1),s);queueOriginals++}
   r.stop();key('\r');assert.equal(r.presses.at(-1),original);assert.equal(r.presses.filter(s=>s===original).length,1)
   cases++;frames+=r.frames;idles+=r.idles
  }finally{r.close()}
 }
 }}finally{setGlyphTier('box')}
 console.log('empty help sequence:cases'+cases+';frames'+frames+';idles'+idles+' bytes0;queueOriginals'+queueOriginals+';clear/undo/multiline/Enter+Esc;old approval0;full drafts/read top/FIFO/input/caret exact;wrap0/scroll0;owned close0')
})
