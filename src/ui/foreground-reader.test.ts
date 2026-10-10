import assert from 'node:assert/strict'
import {test} from 'node:test'
import {frameOf} from './frame.ts'
import {statusOf} from '../probe/status.ts'
import {openStage} from './stage.ts'
import {openSession} from './follow.ts'
import {openTerm} from './term.ts'
import {gateFaceOf} from './gate.ts'
import {KEYMAP,keymapOf,hintLineForWidth} from './keymap.ts'
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
 const km=keymapOf({help:'Alt-H',cancel:'Alt-E',read:'Alt-T',historyNewer:'Alt-J'})
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
 return {stage,vt,presses,notes,queueNames,type,draw,get frames(){return frames},get idles(){return idles},showGate:async()=>{pending=face;await stage.refreshGate()},stop:()=>{running=false},close:()=>{stage.close();term.close();assert.ok(vt.lines.every(s=>s===''),'whole fixed owned rectangle closes blank')}}
}
const flat=(s:readonly string[])=>s.map(x=>x.trim()).join('')
test('trusted actual help retains its own foreground, empty-match count and body even over a reader or queue; unknown and ordinary menus keep exact old frames',()=>{
 let cases=0,frames=0
 try{for(const glyph of ['ascii','box','rich'] as const){setGlyphTier(glyph)
 for(const width of [8,16,24,80,120,192])for(const height of [6,8,19,35,45]){
  const base={snapshot:statusOf([]),width,height,read:{rows:['UNDERLYING-PLAN-ROW'],top:0,heading:'计划全文',footer:'1/1 行 · 只读'},bottom:{rows:['COVERED-QUEUE'],keep:1},menu:{rows:['Enter CURRENT-ACTION'],sel:0}}
  const legacy=frameOf(base),active=frameOf({...base,menu:{...base.menu,help:true}});frames+=2;cases++
  assert.equal(active.roles[0],'readHeading');if(width>=16)assert.ok(active.lines[0]!.includes('按键帮助'),'current help identity survives without a fitting selected detail')
  assert.ok(!active.roles.includes('read'));assert.ok(!flat(active.lines).includes('UNDERLYING')&&!flat(active.lines).includes('COVERED'))
  assert.ok(active.roles.includes('overlay'));assert.ok(active.footer.includes('1/1'))
  const none=frameOf({...base,menu:{rows:[],sel:0,help:true}});frames++
  if(width>=16)assert.ok(none.lines[0]!.includes('按键帮助'));assert.ok(none.footer.includes('0/0'));assert.ok(!none.footer.includes('1/0'))
  assert.ok(!none.roles.includes('read'));assert.ok(none.lines.every(s=>widthOf(s)===width));assert.equal(none.height,height)
  for(const help of [undefined,false,null,0,'true'] as const){assert.deepEqual(frameOf({...base,menu:{...base.menu,help} as never}),legacy,'unknown help source keeps the exact old mixed-menu/read frame');frames++}
  const focused={...base,menu:{...base.menu,detail:['KEY']}}
  if(width>=16){assert.deepEqual(frameOf({...focused,menu:{...focused.menu,help:true}}),frameOf(focused),'a fitting existing focused explanation and footer remain exact');frames+=2}
  for(const detail of [[],['x'.repeat(width+1)],Array(height+1).fill('DETAIL')]){
   const f=frameOf({...base,menu:{...base.menu,help:true,detail}});frames++
   if(width>=16)assert.ok(f.lines[0]!.includes('按键帮助'));assert.ok(!f.roles.includes('read'));assert.ok(f.roles.includes('overlay'));assert.equal(f.height,height)
  }
 }
 }}finally{setGlyphTier('box')}
 console.log('help foreground:cases'+cases+';frames'+frames+';3glyph/6width/5height;current heading+empty0/0;read/queue hidden;unknown/ordinary/fitting-focused full frames exact')
})
test('actual help filtering over full-plan reading keeps current identity and frozen reading position through navigation and empty matches; configured return and the full draft stay',async()=>{
 let cases=0,frames=0,idles=0
 try{for(const glyph of ['ascii','box','rich'] as const){setGlyphTier(glyph)
 for(const width of [16,24,80,120,192])for(const height of [8,12,24,50]){
  const r=rig(width,height),original='FULL-ORIGINAL-'+('abc'.repeat(60))+'中文'
  try{
   r.type(original);const draft=r.stage.view().input;r.draw();await r.showGate();r.draw()
   r.stage.onAction({action:'historyNewer'});r.stage.onAction({action:'approve',key:'y'});assert.deepEqual(r.presses,[])
   r.stage.onAction({action:'read'});r.stage.onAction({action:'historyNewer'});r.draw();const read=r.stage.view().read!,input=r.stage.view().input
   assert.ok(read.heading?.startsWith('计划全文'));assert.ok(read.top>0)
   r.stage.onAction({action:'help'});let f=r.draw();assert.ok(f.rows[0]!.includes('按键帮助'));assert.ok(!f.roles!.includes('read'));assert.ok(!f.roles!.includes('waiting'));assert.ok(r.stage.view().hint!.includes('Alt-E'))
   r.stage.onAction({action:'historyNewer'});r.draw();assert.deepEqual(r.stage.view().read,read,'help selection never advances the covered plan')
   r.type('ZZZ');assert.equal(r.stage.view().menu!.rows.length,0);f=r.draw()
   assert.ok(f.rows[0]!.includes('按键帮助'),'empty help query must not revive the underlying plan title')
   assert.ok(f.rows.some(s=>s.includes('0/0')),'empty help results have a real zero count')
   assert.ok(!f.roles!.includes('read'));assert.ok(!flat(f.rows).includes('计划全文'));assert.deepEqual(r.stage.view().read,read)
   r.stage.onAction({action:'home'});r.draw();assert.deepEqual(r.stage.view().read,read)
   r.stage.onAction({action:'cancel'});r.draw();assert.equal(r.stage.view().menu,undefined);assert.deepEqual(r.stage.view().read,read);assert.deepEqual(r.stage.view().input,input)
   r.stage.onAction({action:'help'});r.type('ZZZ');r.draw();r.stage.onAction({action:'submit'});assert.deepEqual(r.presses,[],'an empty help filter cannot dispatch')
   r.draw();assert.equal(r.stage.view().menu,undefined,'existing Enter returns from an empty help filter');assert.deepEqual(r.stage.view().read,read);assert.deepEqual(r.stage.view().input,input)
   r.stage.onAction({action:'cancel'});r.draw();r.stage.onAction({action:'submit'});assert.deepEqual(r.presses,[],'return cannot inherit old approval')
   r.stage.onAction({action:'cancel'});r.draw();assert.deepEqual(r.stage.view().input,draft);r.stop();r.stage.onAction({action:'submit'});assert.deepEqual(r.presses,[original])
   frames+=r.frames;idles+=r.idles;cases++
  }finally{r.close()}
 }
 }}finally{setGlyphTier('box')}
 console.log('help over plan:cases'+cases+';frames'+frames+';idles'+idles+' bytes0;current heading/zero matches/configured Alt-E;covered read exact;wrap0/scroll0;input/caret/original exact;old approval0')
})
test('actual queued readers devote their capacity to original content and physical position; returning restores the whole FIFO and confirmation before any dispatch',async()=>{
 let cases=0,frames=0,idles=0,reachable=0
 try{for(const glyph of ['ascii','box','rich'] as const){setGlyphTier(glyph)
 for(const [width,height] of [[16,8],[24,8],[80,8],[120,8],[192,50]]){
  const r=rig(width,height,true),original='FULL-ORIGINAL-'+('xyz'.repeat(60))+'中文'
  try{
   r.type(original);const draft=r.stage.view().input;await r.showGate();r.draw();r.stage.onAction({action:'read'})
   const all=[...r.stage.view().read!.rows]
   assert.equal(r.stage.view().bottom,undefined,'covered queued drafts do not spend the current reader capacity')
   for(let i=0;i<all.length;i++){
    const read=r.stage.view().read!;assert.equal(read.top,i);const f=r.draw()
    assert.ok(f.rows[0]!.includes('计划全文'));assert.ok(f.rows.some((s,n)=>f.roles![n]==='footer'&&s.includes((i+1)+'/'+all.length)),'the actual reader position stays physically visible with a covered queue')
    if(all[i]!.trim()!==''){assert.ok(f.rows.some((s,n)=>f.roles![n]==='read'&&s.includes(all[i]!.trim())),'every physical original reader row is reachable');reachable++}
    assert.ok(!flat(f.rows).includes('排队'));r.stage.onAction({action:'approve',key:'y'});r.stage.onAction({action:'submit'});assert.deepEqual(r.presses,[])
    if(i<all.length-1)r.stage.onAction({action:'historyNewer'})
   }
   const read=r.stage.view().read;r.stage.onAction({action:'help'});r.type('ZZZ');r.draw();r.stage.onAction({action:'cancel'});r.draw();assert.deepEqual(r.stage.view().read,read)
   r.stage.onAction({action:'cancel'});r.draw();assert.ok(r.stage.view().bottom);r.stage.onAction({action:'submit'});assert.deepEqual(r.presses,[])
   r.stage.onAction({action:'cancel'});r.draw();assert.deepEqual(r.stage.view().input,draft);assert.ok(r.stage.view().bottom?.rows.some(s=>s.includes('排队 2 条')),'queue preview returns outside the covered reader')
   for(const s of r.queueNames){r.stop();assert.equal(r.stage.startNext(),true);assert.equal(r.presses.at(-1),s)}
   r.stop();r.stage.onAction({action:'submit'});assert.equal(r.presses.at(-1),original)
   frames+=r.frames;idles+=r.idles;cases++
  }finally{r.close()}
 }
 }}finally{setGlyphTier('box')}
 console.log('queued foreground read:cases'+cases+';reachable physical rows'+reachable+';frames'+frames+';idles'+idles+' bytes0;position/content before covered queue;return restores full FIFO/draft;readonly and unarmed execute0;wrap0/scroll0;owned close0')
})
