import assert from 'node:assert/strict'
import {test} from 'node:test'
import {openTerm} from './term.ts'
import {openStage} from './stage.ts'
import {openSession} from './follow.ts'
import {clustersOf} from './glyph.ts'
import {KEYMAP,hintLineOf} from './keymap.ts'

// A hard-line VT consumes the actual renderer bytes. Cursor assertions locate
// the drawn input text, rather than repeating the renderer's row arithmetic.
function screen(columns:number,rows:number){
 let cells=Array.from({length:rows},()=>Array(columns).fill('')),x=0,y=0,pending=false,scrolls=0
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
    if(pending){down();x=0}
    if(g.width>columns-x&&x>0){down();x=0}
    assert.ok(g.width<=columns,'fixture must fit each glyph')
    cells[y]![x]=g.text;for(let k=1;k<g.width;k++)cells[y]![x+k]=''
    if(x+g.width===columns){x=columns-1;pending=true}else x+=g.width
   }
   i=end
  }
 }}
 return {put,get lines(){return cells.map(a=>a.join('').trimEnd())},get caret(){return {row:y,col:x}},get scrolls(){return scrolls}}
}
function cursorAt(vt:ReturnType<typeof screen>,input:{rows:readonly string[];caret:{row:number;col:number}}){
 const text=input.rows[input.caret.row]!.trimEnd(),matches=vt.lines.map((line,n)=>line===text?n:-1).filter(n=>n>=0)
 assert.equal(matches.length,1,'the declared input row is visibly present exactly once')
 assert.deepEqual(vt.caret,{row:matches[0],col:input.caret.col},'physical caret must sit on the displayed editor row and column')
}

test('declared first, middle and last input caret rows control the actual terminal cursor without moving the input rectangle',()=>{
 const vt=screen(40,24),writes:string[]=[]
 const term=openTerm({out:{isTTY:true,columns:40,rows:24,write:s=>{writes.push(s);vt.put(s)}},term:'xterm',heightOf:()=>4,reserveHeightOf:()=>23})
 const rows=['FIRST-INPUT-ABCDEFGHIJK','MIDDLE-INPUT-0123456789','LAST-INPUT-uvwxyz']
 let initial:readonly string[]|null=null,frames=0
 try{
  for(const [row,col] of [[0,8],[1,14],[2,4],[0,2],[2,7],[1,2]]){
   const input={rows,caret:{row:row!,col:col!}};const panel={rows:['FRAME0','FRAME1','FRAME2','FRAME3'],input}
   term.draw([],()=>panel);cursorAt(vt,input);frames++
   if(initial===null)initial=vt.lines;else assert.deepEqual(vt.lines,initial,'cursor-only moves keep the entire rectangle at the same rows')
   writes.length=0;term.draw([],()=>panel);assert.equal(writes.join(''),'');cursorAt(vt,input)
  }
  assert.equal(vt.scrolls,0,'initial reserve and cursor-only movement do not overflow the known physical capacity')
 }finally{term.close()}
 assert.ok(vt.lines.every(s=>!s.includes('INPUT')&&!s.includes('FRAME')),'close removes exactly the owned rectangle from the real cursor row')
 console.log('input caret rectangle:6 positions/6 idle bytes0;known24 rows;scroll0;complete owned close')
})

test('actual Stage/Session/Term keeps Home, edits and End on the retained multiline draft, including six-row windows',()=>{
 let frames=0,idles=0
 const original='INPUT-0123456789abcdefghijklmnopqrstuvwxyz-ABCDEFGHIJKLMNOPQRSTUVWXYZ-END'
 for(const width of [8,16,24,80,160,192])for(const height of [6,7,8,12,24,40,50]){
  const vt=screen(width,height),writes:string[]=[],presses:string[]=[]
  const stage=openStage({rows:()=>[],columns:()=>width,termRows:()=>height,pendingFace:async()=>null,redraw:()=>{},note:()=>{},now:()=>0,abort:()=>{},hint:w=>hintLineOf(KEYMAP,0,w),run:()=>({running:false,last:[],argvOf:()=>({words:[],argv:[],why:null}),press:s=>{presses.push(s);return true},stop:()=>false})})
  stage.setRaw(true);const session=openSession({view:stage.view}),term=openTerm({out:{isTTY:true,columns:width,rows:height,write:s=>{writes.push(s);vt.put(s)}},term:'xterm',heightOf:stage.heightWant,reserveHeightOf:()=>height-1})
  const draw=()=>{term.draw([],size=>session.panel(size));frames++;cursorAt(vt,stage.view().input!)}
  const idle=()=>{writes.length=0;draw();assert.equal(writes.join(''),'');idles++}
  try{
   for(const ch of original)stage.onAction({action:'insert',text:ch})
   draw();idle();const beforeScroll=vt.scrolls
   stage.onAction({action:'home'});draw();idle()
   stage.onAction({action:'right'});draw();idle()
   stage.onAction({action:'insert',text:'!'});draw();idle()
   stage.onAction({action:'backspace'});draw();idle()
   stage.onAction({action:'end'});draw();idle()
   assert.equal(vt.scrolls,beforeScroll,'same input extent does not spend reserve or scroll when only the real caret changes')
   stage.onAction({action:'submit'});assert.deepEqual(presses,[original],'complete original draft submits once after editing another visible row')
  }finally{stage.close();term.close()}
 }
 console.log('actual multiline caret:42 geometries;frames'+frames+';idles'+idles+' bytes0;Home/right/edit/backspace/End;full original submission42/42')
})

test('last-row and invalid row metadata retain identical bytes; short, headless and unknown terminal floors do not render input',()=>{
 const bytes=(row:number)=>{const writes:string[]=[];const t=openTerm({out:{isTTY:true,columns:40,rows:24,write:s=>writes.push(s)},term:'xterm',height:4})
  const panel={rows:['FRAME'],input:{rows:['INPUT0','INPUT1','INPUT2'],caret:{row,col:2}}}
  t.draw([],()=>panel);t.draw([],()=>panel);t.close();return writes.join('')}
 const last=bytes(2)
 for(const row of [-1,3,NaN,Infinity,0.5])assert.equal(bytes(row),last,'invalid row metadata retains the previous last-row floor')
 for(const isTTY of [true,false])for(const host of ['dumb','unknown-host'])for(const rows of [1,2,5,24]){
  let renders=0;const writes:string[]=[];const t=openTerm({out:{isTTY:true===isTTY,columns:40,rows,write:s=>writes.push(s)},term:host,height:4})
  t.draw(['ORIGINAL'],()=>{renders++;return {rows:['UI'],input:{rows:['draft'],caret:{row:0,col:0}}}});t.close();assert.equal(renders,0);assert.equal(writes.join(''),'ORIGINAL\n')
 }
 for(const rows of [1,2,3,4,5]){let renders=0;const writes:string[]=[];const t=openTerm({out:{isTTY:true,columns:40,rows,write:s=>writes.push(s)},term:'xterm',height:4})
  t.draw(['ORIGINAL'],()=>{renders++;return {rows:['UI']}});t.close();assert.equal(renders,0);assert.equal(writes.join(''),'ORIGINAL\n')}
 console.log('input caret floor:invalid row5 byte-equal;last-row preserved;headless/unknown/short original pure text exact')
})
