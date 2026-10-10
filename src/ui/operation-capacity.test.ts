import assert from 'node:assert/strict'
import {test} from 'node:test'
import {openStage} from './stage.ts'
import {openSession} from './follow.ts'
import {openTerm} from './term.ts'
import {gateFaceOf} from './gate.ts'
import {KEYMAP,hintLineOf} from './keymap.ts'
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

const face=gateFaceOf({round:'r1',fingerprint:'operation-capacity',same:[],contracts:Array.from({length:3},(_,i)=>({id:'r1.implement.'+i,agent:'agent/r1/'+i,kind:'implement',goal:'TASK-'+i+' actual changes',ownedPaths:['src/'+('nested/').repeat(3)+'file-'+i+'.ts'],seed:['REFERENCE-'+i],deliverables:[],assertions:[{name:'CHECK-'+i,action:'test'}]}))} as never,{test:'node checks.js --complete'})
const rows=[{pos:{writer:'round',seq:1},e:{t:'round/state',round:'r1',from:'Idle',to:'Planning'}},{pos:{writer:'round',seq:2},e:{t:'round/intent',round:'r1',body:'Review three current changes'}}] as StatusRow[]
function rig(width:number,height:number,queued=true){
 const vt=screen(width,height),writes:string[]=[],presses:string[]=[],notes:string[]=[]
 let running=queued,pending:typeof face|null=null
 const stage=openStage({rows:()=>rows,columns:()=>width,termRows:()=>height,pendingFace:async()=>pending,redraw:()=>{},note:s=>notes.push(s),now:()=>0,abort:()=>{},hint:w=>hintLineOf(KEYMAP,0,w),run:()=>({get running(){return running},last:[],argvOf:s=>({words:[s],argv:[s],why:null}),press:s=>{presses.push(s);running=true;return true},stop:()=>{running=false;return true}})})
 stage.setRaw(true);const session=openSession({view:stage.view});session.push(rows)
 const term=openTerm({out:{isTTY:true,columns:width,rows:height,write:s=>{writes.push(s);vt.put(s)}},term:'xterm',heightOf:stage.heightWant,reserveHeightOf:()=>height-1})
 const draw=()=>{term.draw([],s=>session.panel(s));assert.equal(vt.wraps,0,'logical rows never implicitly wrap');assert.equal(vt.scrolls,0,'fixed geometry never overflows the owned capacity')
  const input=stage.view().input!;assert.ok(input.rows.every(s=>widthOf(s)<=width))
  assert.deepEqual(vt.caret,{row:height-input.rows.length+input.caret.row,col:input.caret.col},'physical caret stays at the real visible editor cell')
  assert.deepEqual(vt.lines.slice(height-input.rows.length),input.rows.map(s=>s.trimEnd()),'every visible input row is really present, complete and ordered')
 }
 const idle=()=>{writes.length=0;draw();assert.equal(writes.join(''),'','unchanged operation is byte quiet')}
 const type=(s:string)=>{for(const ch of s)stage.onAction({action:'insert',text:ch})}
 const queueNames=['QUEUE-FIRST-'+('a'.repeat(80)),'QUEUE-SECOND-'+('b'.repeat(80))]
 if(queued){for(const s of queueNames){type(s);stage.onAction({action:'submit'})}stage.onAction({action:'cancel'});stage.onRunDone({code:0,signal:null,why:null})}
 return {stage,vt,presses,queueNames,type,draw,idle,showGate:async()=>{pending=face;await stage.refreshGate()},stop:()=>{running=false},close:()=>{stage.close();term.close();assert.ok(vt.lines.every(s=>s===''),'fixed-size close removes the whole owned rectangle')}}
}
const visible=(r:ReturnType<typeof rig>,text:string)=>r.vt.lines.some(s=>s.includes(text.trim()))
test('queued drafts cannot hide any live confirmation scope or armed option before a second press starts execution',async()=>{
 let frames=0
 try{setGlyphTier('ascii')
 for(const [width,height] of [[80,6],[80,7],[120,6],[192,50]]){
  const r=rig(width,height)
  try{
   const original='ORIGINAL-DRAFT-'+('xyz'.repeat(60));r.type(original);const draft=r.stage.view().input
   r.draw();r.idle();frames+=2;await r.showGate();r.draw();r.idle();frames+=2
   r.stage.onAction({action:'approve',key:'y'});assert.deepEqual(r.presses,[]);r.draw();r.idle();frames+=2
   const b=r.stage.view().bottom!,required=[...b.rows.slice(b.headingAt!,b.headingAt!+b.headingCount!),...b.rows.slice(b.waitingAt!,b.waitingAt!+b.waitingCount!)]
   assert.ok(required.some(s=>s.includes('再按')),'this geometry genuinely arms the batch')
   for(const line of required)assert.ok(visible(r,line),width+'x'+height+' must show whole confirmation scope and next action: '+line)
   if(height===50)assert.ok(visible(r,'排队 2 条'),'ample capacity still shows the queue summary')
   r.stage.onAction({action:'submit'});assert.deepEqual(r.presses,['round go']);r.draw();r.idle();frames+=2
   assert.deepEqual(r.stage.view().input,draft,'confirmation restores the full original editor')
   for(const line of r.queueNames){r.stop();assert.equal(r.stage.startNext(),true);assert.equal(r.presses.at(-1),line,'FIFO full originals remain despite temporary display cropping')}
   r.stop();r.stage.onAction({action:'submit'});assert.equal(r.presses.at(-1),original,'the complete restored draft still submits')
  }finally{r.close()}
 }
 }finally{setGlyphTier('box')}
 console.log('operation confirmation:4 geometries;frames'+frames+';16 idle bytes0;all scope/options visible;2-stage go once;FIFO originals and restored draft exact')
})
test('one-row full plan reading displays every original line rather than only a below-count, with queues and menu return safe',async()=>{
 let frames=0,lines=0
 try{setGlyphTier('ascii')
 for(const queued of [false,true]){
  const r=rig(120,6,queued)
  try{
   r.type('RETAIN-ORIGINAL');const draft=r.stage.view().input;await r.showGate()
   r.stage.onAction({action:'read'});assert.ok(r.stage.view().read?.heading?.startsWith('计划全文'));const all=[...r.stage.view().read!.rows]
   for(let i=0;i<all.length;i++){
    assert.equal(r.stage.view().read!.top,i)
    r.draw();r.idle();frames+=2
    if(!queued)assert.ok(visible(r,r.stage.view().read!.footer!),'single-row reading still has its real position footer')
    if(all[i]!.trim()!==''){assert.ok(visible(r,all[i]!), 'actual plan row '+i+' remains readable: '+all[i]);lines++}
    r.stage.onAction({action:'approve',key:'y'});r.stage.onAction({action:'submit'});assert.deepEqual(r.presses,[],'read-only navigation cannot execute or start queued drafts')
    if(i<all.length-1)r.stage.onAction({action:'historyNewer'})
   }
   const end=r.stage.view().read!.top;r.stage.onAction({action:'help'});r.draw();r.idle();frames+=2
   r.stage.onAction({action:'cancel'});assert.equal(r.stage.view().read!.top,end);r.draw();r.idle();frames+=2
   r.stage.onAction({action:'cancel'});r.stage.onAction({action:'submit'});assert.deepEqual(r.presses,[],'return never inherits approval')
   r.stage.onAction({action:'cancel'});assert.deepEqual(r.stage.view().input,draft)
  }finally{r.close()}
 }
 }finally{setGlyphTier('box')}
 console.log('operation read:every original plan line'+lines+';frames'+frames+';idle0;queued/unqueued;menu returns same last line;execute0;draft exact')
})
test('typing a help filter over suspended confirmation pays for every visible input row and preserves the original draft and gate',async()=>{
 let frames=0
 try{setGlyphTier('ascii')
 for(const [width,height] of [[8,6],[16,6],[24,8],[80,6],[192,50]]){
  const r=rig(width,height)
  try{
   r.type('RETAINED-FULL-DRAFT');const original=r.stage.view().input;await r.showGate();r.draw();r.idle();frames+=2
   r.stage.onAction({action:'help'});r.type('a'.repeat(600));assert.equal(r.stage.view().input!.rows.length,3)
   assert.ok(r.stage.heightWant()+3<=height,width+'x'+height+' suspended original does not make current filter input free')
   r.draw();r.idle();frames+=2
   r.stage.onAction({action:'home'});r.draw();r.idle();frames+=2
   r.stage.onAction({action:'cancel'});assert.equal(r.stage.view().menu,undefined);r.draw();r.idle();frames+=2
   r.stage.onAction({action:'cancel'});assert.deepEqual(r.stage.view().input,original,'temporary menu query never replaces suspended original')
   assert.deepEqual(r.presses,[]);r.draw();r.idle();frames+=2
  }finally{r.close()}
 }
 }finally{setGlyphTier('box')}
 console.log('operation filter:5 geometries;frames'+frames+';idle0;visible rows paid;Home/return;full original/gate exact;execute0')
})

test('whole operation sequence fits physical windows in both glyph floors; queue originals and drafting survive every cover/return',async()=>{
 let frames=0,idles=0,cases=0
 try{for(const glyph of ['ascii','box'] as const){setGlyphTier(glyph)
 for(const width of [6,8,16,24,80,120,192])for(const height of [6,8,12,24,50])for(const queued of [false,true]){
  const r=rig(width,height,queued),draw=()=>{r.draw();frames++;r.idle();frames++;idles++}
  try{
   const original='FULL-ORIGINAL-'+('abcdef'.repeat(22))+'中文';r.type(original);const draft=r.stage.view().input
   draw();await r.showGate();draw();r.stage.onAction({action:'approve',key:'y'});draw();assert.deepEqual(r.presses,[])
   r.stage.onAction({action:'read'});draw();r.stage.onAction({action:'pageDown'});draw()
   r.stage.onAction({action:'help'});r.type('a'.repeat(600));draw();r.stage.onAction({action:'home'});draw()
   r.stage.onAction({action:'cancel'});draw();r.stage.onAction({action:'cancel'});draw()
   r.stage.onAction({action:'submit'});assert.deepEqual(r.presses,[],'current unarmed confirmation never starts covered queue')
   r.stage.onAction({action:'cancel'});draw();assert.deepEqual(r.stage.view().input,draft)
   if(queued)for(const s of r.queueNames){r.stop();assert.equal(r.stage.startNext(),true);assert.equal(r.presses.at(-1),s)}
   r.stop();r.stage.onAction({action:'submit'});assert.equal(r.presses.at(-1),original);cases++
  }finally{r.close()}
 }
 }}finally{setGlyphTier('box')}
 console.log('operation full sequence:'+cases+' cases;frames'+frames+';idles'+idles+' bytes0;7 widths/5 heights/2 queue states/ASCII+box;wrap0/scroll0;whole input/caret and original FIFO exact;owned close0')
})
