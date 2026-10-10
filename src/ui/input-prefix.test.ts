import assert from 'node:assert/strict'
import {test} from 'node:test'
import {emptyEditor,applyIntent,inputFrameOf,submitOf,displayOf} from './input.ts'
import {clustersOf,widthOf} from './glyph.ts'
import {openStage} from './stage.ts'
import {openSession} from './follow.ts'
import {openTerm} from './term.ts'
import {KEYMAP,hintLineOf} from './keymap.ts'

test('a scrolled editor never adds a prefix column when its prompt has no reserved cells',()=>{
 let frames=0
 for(const width of [1,2,3,4,7])for(const prompt of ['', '> ', 'LONG-PROMPT', '>'])for(const text of ['ABCDEFGHIJKLMNO','中文天地世界abc']){
  const lead=widthOf(prompt)<width?widthOf(prompt):0,avail=width-lead
  // An indivisible two-cell glyph in one cell is a separate, still unresolved floor.
  if(clustersOf(text).some(c=>c.width>avail))continue
  const initial=applyIntent(emptyEditor(),{t:'insert',text}),display=displayOf(initial.draft)
  for(let caret=0;caret<=text.length;caret++)for(const rows of [1,2,3]){
   const e={...initial,draft:{...initial.draft,caret}},before=JSON.stringify(e),f=inputFrameOf({e,prompt,width,rows})
   assert.ok(f.rows.every(s=>widthOf(s)<=width),'every shown input row fits the actual allocated cells')
   assert.ok(f.caret.row>=0&&f.caret.row<f.rows.length&&f.caret.col>=0&&f.caret.col<width,'the caret stays in the allocated rectangle')
   if(lead===0){assert.ok(!f.rows.some(s=>s.startsWith('…')),'an omitted prompt has no cell reserved for a scroll prefix')}
   else if(f.hidden.above>0)assert.ok(f.rows[0]!.startsWith('…'),'a reserved prompt cell still signals hidden lines')
   assert.equal(JSON.stringify(e),before,'layout does not alter retained text or editor position')
   assert.equal(submitOf(e),text,'submission is the full original, irrespective of the visual viewport')
   const full=inputFrameOf({e,prompt:'',width:avail,rows:display.length+2})
   assert.equal(full.rows.join(''),display,'all original display clusters are still available')
   frames++
  }
 }
 console.log('promptless input capacity:frames'+frames+';5 widths/4 prompts/ASCII and fitting CJK;caret/viewport/complete original exact')
})

// Consume renderer bytes with deferred-wrap VT semantics, rather than counting
// logical rows. All glyphs in this assertion are one cell and physically fit.
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
test('actual one-to-three-column Stage/Session/Term input occupies real rows without hidden wraps or caret drift',()=>{
 let frames=0,idles=0
 const original='ABCDEFGHIJKLMNO'
 for(const width of [1,2,3])for(const height of [6,8,24]){
  const vt=screen(width,height),writes:string[]=[],presses:string[]=[]
  const stage=openStage({rows:()=>[],columns:()=>width,termRows:()=>height,pendingFace:async()=>null,redraw:()=>{},note:()=>{},now:()=>0,abort:()=>{},hint:w=>hintLineOf(KEYMAP,0,w),run:()=>({running:false,last:[],argvOf:()=>({words:[],argv:[],why:null}),press:s=>{presses.push(s);return true},stop:()=>false})})
  stage.setRaw(true);const session=openSession({view:stage.view}),term=openTerm({out:{isTTY:true,columns:width,rows:height,write:s=>{writes.push(s);vt.put(s)}},term:'xterm',heightOf:stage.heightWant,reserveHeightOf:()=>height-1})
  const draw=()=>{
   term.draw([],s=>session.panel(s));frames++;const input=stage.view().input!,lines=vt.lines
   const matches=lines.map((_,i)=>input.rows.every((s,k)=>lines[i+k]===s.trimEnd())?i:-1).filter(i=>i>=0)
   assert.equal(matches.length,1,'the complete visible input block is present exactly once')
   assert.deepEqual(vt.caret,{row:matches[0]!+input.caret.row,col:input.caret.col},'hardware cursor matches the displayed editor cell')
   assert.equal(vt.wraps,0,'unallocated prefixes never introduce an implicit physical line')
   assert.equal(vt.scrolls,0,'the fixed-size owned rectangle stays inside the actual window')
  }
  const idle=()=>{writes.length=0;draw();assert.equal(writes.join(''),'');idles++}
  try{
   for(const ch of original)stage.onAction({action:'insert',text:ch})
   draw();idle()
   for(const action of ['home','right','end','left','home','end'] as const){stage.onAction({action});draw();idle()}
   stage.onAction({action:'submit'});assert.deepEqual(presses,[original],'full original submits exactly once at every geometry')
  }finally{stage.close();term.close()}
  assert.ok(vt.lines.every(s=>s===''),'unchanged geometry closes the exact owned area without residue')
 }
 console.log('actual promptless narrow input:9 geometries;frames'+frames+';idles'+idles+' bytes0;implicit wraps0/scroll0;original submission9/9;owned close exact')
})
