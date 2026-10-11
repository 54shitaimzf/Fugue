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

test('opening actual help/command/path menus expires approval and rejection arms before any return; original selection, full editor and FIFO survive; fresh two-stage confirmation and narrow guard remain',async()=>{
 let cases=0,armedCases=0,floors=0,frames=0,idles=0,queueOriginals=0
 try{for(const glyph of ['ascii','box','rich'] as const){setGlyphTier(glyph)
 for(const width of [192,120,80,24,16])for(const height of [8,12,24,50])for(const queued of [false,true])
 for(const option of ['approve','reject'] as const)for(const flow of ['keys-cancel','keys-enter','cmd-cancel','path-cancel','cmd-clear-cancel','path-erase']){
  const r=rig(width,height,queued),key=(s:string)=>{for(const d of decodeOf(s,r.km))r.stage.onAction(d)}
  try{
   const original='FULL-ORIGINAL-'+('xyz'.repeat(60))+'中文';r.type(original);r.draw();const draft=r.stage.view().input
   await r.showGate();r.stage.onAction({action:'historyNewer'});r.draw();const before=r.stage.view().bottom
   assert.ok(before,'the current confirmation exists');if(width>=80)assert.ok(before.rows.some(s=>s.includes('2/3')||s.includes('TASK-1')),'nonfirst preview is the original selection at readable width')
   key(option==='approve'?'y':'n');r.draw()
   const armed=r.stage.view().bottom!.rows.join('\n').includes('Enter')
   if(armed)armedCases++;else floors++
   const source=flow.startsWith('keys')?'keys':flow.startsWith('cmd')?'cmd':'path'
   if(source==='keys')key('\x1bh');else r.stage.onAction({action:source==='cmd'?'menu':'mention'})
   r.draw();assert.equal(r.stage.view().menu!.source,source)
   if(flow==='cmd-clear-cancel'){key('\x1bu');r.draw();assert.equal(r.stage.view().menu!.source,'cmd','command clear restores its original full candidate list');key('\x1be');r.draw();assert.equal(r.stage.view().menu,undefined)}
   else if(flow.endsWith('erase')){key('\x1bu');r.draw();assert.equal(r.stage.view().menu,undefined,'deleting the original marker closes its existing menu')}
   else if(flow.endsWith('enter')){r.type('ZZZ-NO-MATCH');r.draw();assert.equal(r.stage.view().menu!.rows.length,0);key('\r');r.draw();assert.equal(r.stage.view().menu,undefined,'actual key menu Enter only returns')}
   else{key('\x1be');r.draw();assert.equal(r.stage.view().menu,undefined)}
   assert.deepEqual(r.stage.view().bottom,before,'menu return restores the same preview and cannot retain either old arm')
   key('\r');r.draw();assert.deepEqual(r.presses,[],'return Enter cannot dispatch an inherited confirmation or covered FIFO')
   assert.deepEqual(r.stage.view().bottom,before,'return Enter cannot apply an inherited rejection')
   key(option==='approve'?'y':'n');r.draw();key('\r');r.draw()
   if(armed&&option==='approve')assert.deepEqual(r.presses,['round go'],'a new first key followed by Enter approves exactly once')
   else assert.deepEqual(r.presses,[],'rejection or too-small confirmation never dispatches')
   if(armed&&option==='reject')assert.ok(r.notes.some(s=>s.includes('本次选择没有启动执行')))
   if(!armed||option==='reject'){key('\x1be');r.draw()}
   assert.deepEqual(r.stage.view().input,draft,'the complete original editor and physical caret return')
   if(queued)for(const s of r.queueNames){r.stop();assert.equal(r.stage.startNext(),true);assert.equal(r.presses.at(-1),s);queueOriginals++}
   r.stop();key('\r');r.draw();assert.equal(r.presses.at(-1),original);assert.equal(r.presses.filter(s=>s===original).length,1)
   cases++;frames+=r.frames;idles+=r.idles
  }finally{r.close()}
 }
 }}finally{setGlyphTier('box')}
 console.log('menu confirmation return:cases'+cases+';armed'+armedCases+';smallFloors'+floors+';frames'+frames+';idles'+idles+' bytes0;queueOriginals'+queueOriginals+';3glyph/5width/4height/FIFO/approve+reject/6closeFlows;nonfirst selection exact;original full editor/caret/FIFO;fresh arm0 then1;wrap0/scroll0;owned close0')
})
