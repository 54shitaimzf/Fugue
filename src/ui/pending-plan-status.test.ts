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
 return {stage,vt,presses,notes,queueNames,km,type,draw,get frames(){return frames},get idles(){return idles},showGate:async()=>{pending=face;await stage.refreshGate()},clearGate:async()=>{pending=null;await stage.refreshGate()},stop:()=>{running=false},close:()=>{stage.close();term.close();assert.ok(vt.lines.every(s=>s===''),'whole fixed owned rectangle closes blank')}}
}


import {readingsOf} from '../probe/status.ts'
import {taskOf} from './task.ts'
import {WORDS} from '../words.ts'
import {screen} from '../../test/helpers/vt-screen.ts'

test('a valid pending batch remains waiting for confirmation after the operation area returns to typing; missing and conflicting evidence preserve the full old frame',()=>{
 let ready=0,floors=0
 const task=taskOf(events),readings=readingsOf(events)
 try {for(const glyph of ['ascii','box','rich'] as const){setGlyphTier(glyph)
 for(const width of [192,120,80,24,16])for(const height of [8,12,24,50]){
  const base={...readings,task,operationArea:true,width,height}
  const legacy=frameOf(base)
  const expected=frameOf({...base,task:{...task,rows:task.rows.map((r,i)=>i===0?{...r,text:WORDS.gateReview,role:'waiting' as const}:r)}})
  assert.deepEqual(frameOf({...base,pendingRound:'r1'}),expected,'only the standard current Planning status changes to waiting')
  ready++
  for(const pendingRound of [undefined,null,false,true,0,{},[],'',' ','r2','r1\x00']){
   assert.deepEqual(frameOf({...base,pendingRound} as never),legacy,'unknown, bad or foreign pending identity cannot infer readiness');floors++
  }
  for(const invalidRound of ['', ' ', 'r1\x00']){
   const invalid={...base,task:{...task,round:invalidRound},snapshot:{...readings.snapshot,current:invalidRound,rounds:readings.snapshot.rounds.map(r=>({...r,round:invalidRound}))}}
   assert.deepEqual(frameOf({...invalid,pendingRound:invalidRound}),frameOf(invalid),'an empty or control-containing identity is not readiness evidence even when both adapters repeat it');floors++
  }
  for(const part of [
   {operationArea:undefined},{operationArea:false},{operationArea:'true'},
   {task:{...task,round:'r2'}},{task:{...task,state:'Working'}},
   {task:{...task,rows:task.rows.map((r,i)=>i===0?{...r,text:'A specific current problem'}:r)}},
   {task:{...task,rows:task.rows.map((r,i)=>i===0?{...r,role:'body'}:r)}},
   {view:'progress'},{view:'spending'},
   {read:{rows:['FULL READER ORIGINAL'],top:0,heading:'Current record'}},
   {menu:{source:'cmd',rows:['/status'],sel:0}},
   {menu:{help:true,source:'keys',rows:['Alt-E Return'],sel:0}},
  ]){
   assert.deepEqual(frameOf({...base,...part,pendingRound:'r1'} as never),frameOf({...base,...part} as never),'unsupported or foreground contexts retain the complete frame');floors++
  }
 }
 }}finally{setGlyphTier('box')}
 console.log('pending status:pureReady'+ready+';legacyFloors'+floors+';all full frames exact;3glyph/5width/4height;foreign/bad/missing/readonly/wrongState/customStatus/reader/menu/progress/spending')
})

test('actual Stage/Session/Term keeps the known batch waiting through hide, input, ordinary selection, return and raw changes; direct text cannot mutate the covered draft',async()=>{
 let cases=0,frames=0,idles=0,wideWaiting=0,queueOriginals=0
 try{for(const glyph of ['ascii','box','rich'] as const){setGlyphTier(glyph)
 for(const width of [192,120,80,24,16])for(const height of [8,12,24,50])for(const queued of [false,true]){
  const r=rig(width,height,queued),key=(s:string)=>{for(const d of decodeOf(s,r.km))r.stage.onAction(d)}
  const check=()=>{
   r.draw();assert.equal(r.stage.view().pendingRound,'r1','actual pending identity reaches the session')
   if(width>=80&&height>=24){assert.ok(r.vt.lines.some(s=>s.includes(WORDS.gateReview)));assert.ok(!r.vt.lines.some(s=>s.includes(WORDS.planPreparing)));wideWaiting++}
  }
  try{
   r.type('FULL-ORIGINAL-'+('xyz'.repeat(50))+'中文');const original=r.stage.view().input
   await r.showGate();const covered=r.stage.view().input
   r.type('DIRECT TEXT');r.stage.onAction({action:'paste',text:'PASTED TEXT'})
   assert.deepEqual(r.stage.view().input,covered,'typing and paste do not edit a covered confirmation draft');assert.deepEqual(r.presses,[])
   r.stage.onAction({action:'cancel'});check();assert.deepEqual(r.stage.view().input,original,'explicit return restores the full original editor')
   r.stage.onAction({action:'go'});r.draw();r.stage.onAction({action:'cancel'});check()
   key('\x1bU');r.draw();assert.equal(r.stage.view().input!.rows.join('').trim(),'>')
   for(const source of ['cmd','path'] as const){
    r.stage.onAction({action:'go'});r.draw();r.stage.onAction({action:source==='cmd'?'menu':'mention'});r.type(source==='cmd'?'status':'AGENTS.md');r.draw();key('\r');check()
    key('\x1a');check()
   }
   r.stage.setRaw(false);assert.equal(r.stage.view().pendingRound,undefined,'read-only stage never supplies interactive pending evidence')
   r.stage.setRaw(true);check()
   await r.clearGate();r.draw();assert.equal(r.stage.view().pendingRound,undefined,'a removed batch stops asserting readiness')
   if(width>=80&&height>=24)assert.ok(r.vt.lines.some(s=>s.includes(WORDS.planPreparing)),'Planning alone keeps the factual preparing floor')
   assert.deepEqual(r.presses,[],'status, ignored text, selection and return never dispatch')
   if(queued)for(const s of r.queueNames){r.stop();assert.equal(r.stage.startNext(),true);assert.equal(r.presses.at(-1),s);queueOriginals++}
   cases++;frames+=r.frames;idles+=r.idles
  }finally{r.close()}
 }
 }}finally{setGlyphTier('box')}
 console.log('pending status:actualCases'+cases+';frames'+frames+';idles'+idles+' bytes0;wideWaiting'+wideWaiting+';queueOriginals'+queueOriginals+';raw false/true;batch removed;direct text+paste ignored;full draft exact;no dispatch;wrap0/scroll0;owned close0')
})
