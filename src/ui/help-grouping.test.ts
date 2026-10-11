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
import {screen} from '../../test/helpers/vt-screen.ts'
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

test('sparse actual help keeps all content and roles beside input, uses all dense capacity, and leaves legacy metadata byte exact',()=>{
 let cases=0,moved=0,dense=0,floors=0
 try{for(const glyph of ['ascii','box','rich'] as const){setGlyphTier(glyph)
 for(const width of [8,16,24,80,120,192])for(const height of [5,6,8,12,24,45,50])for(const base of [
  {rows:[]},{rows:['MATCHED']},{rows:Array.from({length:80},(_,i)=>'ITEM-'+i)},
  {rows:['MATCHED'],detail:['KEY','SAY']},
  {rows:Array.from({length:80},(_,i)=>'ITEM-'+i),detail:['KEY','SAY']},
  {rows:['MATCHED'],detail:Array(80).fill('KEY'),detailMore:['ALL']},
 ]){
  const rows=base.rows,menu={...base,sel:rows.length?Math.floor(rows.length/2):0,help:true}
  const input={snapshot:statusOf([]),width,height,menu,operationArea:true,read:{rows:['COVERED-READER'],top:0,heading:'Original reader'},bottom:{rows:['COVERED-QUEUE'],keep:1}}
  const legacy=frameOf({...input,operationArea:undefined})
  const current=frameOf(input)
  assert.equal(current.height,height);assert.equal(current.lines.length,legacy.lines.length)
  assert.deepEqual(current.columns,legacy.columns);assert.equal(current.footer,legacy.footer)
  assert.ok(!current.lines.some(s=>s.includes('COVERED-')),'foreground help still owns its content')
  const pad=legacy.roles.map((role,i)=>role==='body'?i:-1).filter(i=>i>=0)
  const hasTitle=legacy.roles.includes('readHeading')
  if(hasTitle&&pad.length){
   assert.ok(pad.every(i=>legacy.lines[i]!.replace(/[│|]/g,'').trim()===''),'only old blank body padding can move')
   const block=legacy.lines.filter((_,i)=>!pad.includes(i)),roles=legacy.roles.filter((_,i)=>!pad.includes(i))
   const expected=[...Array(pad.length).fill(' '.repeat(width)),...block]
   assert.deepEqual(current.lines,expected,'all available whitespace moves outside the full original help block, adjacent to the fixed input')
   assert.deepEqual(current.roles,[...Array(pad.length).fill('body'),...roles],'readHeading and all original selected/body/footer roles move with their lines')
   moved++
  }else{assert.deepEqual(current,legacy,'dense and too-small frames retain every byte');dense++}
  for(const bad of [undefined,false,'true',1,null]){
   const unknown={...input,menu:{...menu,help:bad} as never}
   assert.deepEqual(frameOf(unknown),frameOf({...unknown,operationArea:undefined}),'unknown help identity keeps exact old path');floors++
  }
  assert.deepEqual(frameOf({...input,operationArea:false}),legacy,'noninteractive operation keeps exact old path')
  cases++
 }
 }}finally{setGlyphTier('box')}
 console.log('help grouping:pure'+cases+';moved'+moved+';dense'+dense+';metadataFloors'+floors+';all original lines/roles/count/width/capacity;covered reader+queue hidden')
})
test('actual help filter/clear/undo/return groups complete content above input and preserves reader, drafts, FIFO, keys and unarmed approval',async()=>{
 let cases=0,frames=0,idles=0,grouped=0,queueOriginals=0
 try{for(const glyph of ['ascii','box','rich'] as const){setGlyphTier(glyph)
 for(const width of [192,120,80,24,16])for(const height of [8,12,24,50])for(const queued of [false,true]){
  const r=rig(width,height,queued),original='GROUP-FULL-ORIGINAL-'+('xyz'.repeat(60))+'中文'
  const key=(s:string)=>{for(const d of decodeOf(s,r.km))r.stage.onAction(d)}
  const help=()=>{
   const f=r.draw(),at=f.roles!.indexOf('readHeading')
   assert.ok(at>=0);assert.ok(f.rows[at]!.includes('按键帮助'));assert.equal(f.rows.length,f.roles!.length)
   assert.ok(f.rows.slice(0,at).every(s=>s.trim()===''),'spare lines have no giant help frame')
   const last=f.roles!.findLastIndex(role=>role==='overlay'||role==='overlayBody')
   const footer=f.roles!.indexOf('footer')
   assert.ok(last>at,'visible current content stays')
   if(footer>=0)assert.equal(last,footer-2,'the entire help body directly precedes the footer separator, without inserted padding')
   assert.ok(!f.roles!.includes('read')&&!f.roles!.includes('waiting'),'covered reader and approval stay off current help')
   if(r.stage.view().menu!.rows.length===0&&height>=12)assert.ok(at>0,'sparse help is physically grouped above the fixed operation');grouped+=Number(at>0)
  }
  try{
   r.type(original);const draft=r.stage.view().input;r.draw();await r.showGate();r.draw()
   r.stage.onAction({action:'historyNewer'});r.stage.onAction({action:'approve',key:'y'});r.stage.onAction({action:'read'});r.stage.onAction({action:'historyNewer'});r.draw()
   const frozen=r.stage.view().read;assert.ok(frozen!.top>0)
   key('\x1bh');help()
   r.type('ZZZ');help();assert.deepEqual(r.stage.view().read,frozen)
   key('\x1bu');help();assert.ok(r.stage.view().menu!.rows.length>0)
   r.stage.onAction({action:'undo'});help();assert.equal(r.stage.view().menu!.rows.length,0)
   key('\x1be');r.draw();assert.deepEqual(r.stage.view().read,frozen)
   key('\x1bh');r.type('Alt-E');help();assert.ok(r.stage.view().menu!.rows.length>0,'a current matching configured key retains its selected detail')
   key('\x1bu');help();r.type('ZZZ\nQQQ');help()
   key('\x1b[D\x1b[D\x1b[D');r.draw();key('\x1bu');help();assert.ok(r.stage.view().input!.rows.join('').includes('QQQ'))
   r.stage.onAction({action:'undo'});help()
   key('\r');r.draw();assert.equal(r.stage.view().menu,undefined);assert.deepEqual(r.stage.view().read,frozen)
   key('\x1be');r.draw();key('\r');assert.deepEqual(r.presses,[],'return cannot inherit approval or dispatch help filtering')
   key('\x1be');r.draw();assert.deepEqual(r.stage.view().input,draft)
   if(queued)for(const s of r.queueNames){r.stop();assert.equal(r.stage.startNext(),true);assert.equal(r.presses.at(-1),s);queueOriginals++}
   r.stop();key('\r');assert.equal(r.presses.at(-1),original);assert.equal(r.presses.filter(s=>s===original).length,1)
   cases++;frames+=r.frames;idles+=r.idles
  }finally{r.close()}
 }
 }}finally{setGlyphTier('box')}
 console.log('help grouping:actual'+cases+';frames'+frames+';byteIdles'+idles+'=0;grouped'+grouped+';queueOriginals'+queueOriginals+';whole input/caret/read top/drafts/FIFO exact;unarmed0;wrap0/scroll0;owned close0')
})
