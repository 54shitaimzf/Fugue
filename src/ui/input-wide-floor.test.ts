import assert from 'node:assert/strict'
import {test} from 'node:test'
import {openStage} from './stage.ts'
import {openSession} from './follow.ts'
import {openTerm} from './term.ts'
import {inputFrameOf,emptyEditor,applyIntent} from './input.ts'
import {innerOf} from './frame.ts'
import {clustersOf,widthOf} from './glyph.ts'
import {KEYMAP,hintLineOf} from './keymap.ts'
import {screen} from '../../test/helpers/vt-screen.ts'


function rig(initialWidth:number,height:number){
 let width=initialWidth;const presses:string[]=[],writes:string[]=[],vt=screen(width,height)
 const stage=openStage({rows:()=>[],columns:()=>width,termRows:()=>height,pendingFace:async()=>null,redraw:()=>{},note:()=>{},now:()=>0,abort:()=>{},hint:w=>hintLineOf(KEYMAP,0,w),run:()=>({running:false,last:[],argvOf:()=>({words:[],argv:[],why:null}),press:s=>{presses.push(s);return true},stop:()=>false})})
 stage.setRaw(true);const session=openSession({view:stage.view}),term=openTerm({out:{isTTY:true,get columns(){return width},rows:height,write:s=>{writes.push(s);vt.put(s)}},term:'xterm',heightOf:stage.heightWant,reserveHeightOf:()=>height-1})
 const draw=()=>{
  term.draw([],s=>session.panel(s));const input=stage.view().input!,lines=vt.lines
  assert.ok(input.rows.every(s=>widthOf(s)<=width),'the live editor respects its real physical input capacity')
  const starts=lines.map((_,i)=>input.rows.every((s,k)=>lines[i+k]===s.trimEnd())?i:-1).filter(i=>i>=0)
  assert.equal(starts.length,1,'the complete visible editor block is really present exactly once')
  assert.deepEqual(vt.caret,{row:starts[0]!+input.caret.row,col:input.caret.col},'hardware caret is on the displayed editor cell')
  assert.equal(vt.wraps,0,'a display marker never causes an implicit physical row')
  assert.equal(vt.scrolls,0,'unchanged geometry never overflows the owned rectangle')
 }
 const idle=()=>{writes.length=0;draw();assert.equal(writes.join(''),'','an unchanged marked draft is quiet')}
 return {stage,vt,draw,idle,presses,widen:()=>{width=80;stage.onResize()},close:()=>{stage.close();term.close()}}
}
test('indivisible wide clusters in one-column live input has a one-cell marker, natural caret and exact original editing/submission',()=>{
 let frames=0,idles=0
 for(const glyph of ['中','👨‍👩‍👧','🇨🇳','👍🏽'])for(const width of [1])for(const height of [6,8,24]){
  const original=glyph+'A'+glyph+'B'+glyph+'C',r=rig(width,height)
  const draw=()=>{r.draw();frames++},idle=()=>{r.idle();frames++;idles++}
  try{
   r.stage.onAction({action:'insert',text:original});assert.deepEqual(r.stage.view().input!.rows,['?','C',''],'oversize last glyph is marked, the following real letter is preserved')
   draw();idle()
   r.stage.onAction({action:'home'});assert.deepEqual(r.stage.view().input,{rows:['?','A','?'],caret:{row:0,col:0}});draw();idle()
   r.stage.onAction({action:'right'});assert.deepEqual(r.stage.view().input!.caret,{row:1,col:0},'right skips the original whole cluster to the real next letter');draw();idle()
   r.stage.onAction({action:'insert',text:'Z'});draw();idle()
   r.stage.onAction({action:'backspace'});draw();idle()
   for(const action of ['end','left','right'] as const){r.stage.onAction({action});draw();idle()}
   r.widen();const e=applyIntent(emptyEditor(),{t:'insert',text:original})
   const full=inputFrameOf({e,prompt:'> ',width:innerOf(80)})
   assert.deepEqual(r.stage.view().input,{rows:full.rows,caret:full.caret},'widening restores the actual glyphs and original caret, not substitute text')
   r.stage.onAction({action:'submit'});assert.deepEqual(r.presses,[original],'original UTF8 survives marking, editing and widening exactly once')
  }finally{r.close()}
  assert.ok(r.vt.lines.every(s=>s===''),'unchanged painted geometry closes its owned rectangle exactly')
 }
 console.log('marked wide input:12 geometries;frames'+frames+';idles'+idles+' bytes0;CJK/family/flag/skin;wrap0/scroll0;restored originals12/12')
})
test('folded paste, expansion, help reading and return retain the full original instead of storing display markers',()=>{
 let frames=0,idles=0
 const original=('中文 e\u0301 🇨🇳\n').repeat(40)+'END'
 for(const width of [1,2]){
  const r=rig(width,8),draw=()=>{r.draw();frames++},idle=()=>{r.idle();frames++;idles++}
  try{
   r.stage.onAction({action:'insert',text:original});draw();idle()
   r.stage.onAction({action:'toggleFold'});draw();idle()
   r.stage.onAction({action:'home'});draw();idle()
   const before=r.stage.view().input
   r.stage.onAction({action:'help'});draw();idle()
   r.stage.onAction({action:'read'});draw();idle()
   r.stage.onAction({action:'cancel'});draw();idle()
   r.stage.onAction({action:'cancel'});draw();idle()
   assert.deepEqual(r.stage.view().input,before,'return preserves the expanded original and caret')
   r.widen();const e=applyIntent({...applyIntent(emptyEditor(),{t:'insert',text:original}),unfolded:true},{t:'home'})
   const full=inputFrameOf({e,prompt:'> ',width:innerOf(80)})
   assert.deepEqual(r.stage.view().input,{rows:full.rows,caret:full.caret},'expanded original is restored on the wider viewport')
   r.stage.onAction({action:'submit'});assert.deepEqual(r.presses,[original],'folded multiline original submits exactly once')
  }finally{r.close()}
 }
 console.log('marked paste scenes:frames'+frames+';idles'+idles+' bytes0;fold/expand/help/read/return;complete original2/2')
})
test('fitting glyphs, ASCII and unknown dimensions keep their exact prior layout; short/headless/unknown hosts remain plain permanent output',()=>{
 let cases=0
 for(const width of [1,2,3,4,5,6,8,16,24,80,192,0,-1,1.5,NaN,Infinity])for(const text of ['ASCII-input','中文天地 e\u0301 👨‍👩‍👧']){
  if(width===1&&text.includes('中'))continue
  const presses:string[]=[]
  const stage=openStage({rows:()=>[],columns:()=>width,termRows:()=>8,pendingFace:async()=>null,redraw:()=>{},note:()=>{},now:()=>0,abort:()=>{},hint:()=>'',run:()=>({running:false,last:[],argvOf:()=>({words:[],argv:[],why:null}),press:s=>{presses.push(s);return true},stop:()=>false})})
  try{
   stage.setRaw(true);stage.onAction({action:'insert',text});let e=applyIntent(emptyEditor(),{t:'insert',text})
   for(const action of ['home','right','end','left'] as const){
    stage.onAction({action});e=applyIntent(e,{t:action});const f=inputFrameOf({e,prompt:'> ',width:innerOf(width)})
    assert.deepEqual(stage.view().input,{rows:f.rows,caret:f.caret},'all other widths and fitting text keep exact prior layout');cases++
   }
  }finally{stage.close()}
 }
 for(const width of [1,2])for(const rows of [1,2,3,4,5,8])for(const term of ['dumb','unknown-host','xterm'])for(const isTTY of [false,true]){
  if(isTTY&&term==='xterm'&&rows===8)continue
  const writes:string[]=[];let renders=0;const t=openTerm({out:{isTTY,columns:width,rows,write:s=>writes.push(s)},term,height:4})
  t.draw(['ORIGINAL'],()=>{renders++;return {rows:['UI'],input:{rows:['?'],caret:{row:0,col:0}}}});t.close()
  assert.equal(renders,0);assert.equal(writes.join(''),'ORIGINAL\n','all no-render floors retain pure original bytes')
 }
 console.log('marked wide floor:prior layout cases'+cases+';ASCII/3+cols/bad dimensions exact;short/headless/unknown renderer0 and permanent bytes exact')
})

test('a real matching key-help reader uses the marked input through covering, return and widening',()=>{
 let frames=0,idles=0
 const original='最近删除'
 for(const width of [1,2]){
  const r=rig(width,8),draw=()=>{r.draw();frames++},idle=()=>{r.idle();frames++;idles++}
  try{
   r.stage.onAction({action:'insert',text:original});r.stage.onAction({action:'home'});draw();idle()
   r.stage.onAction({action:'help'});assert.equal(r.stage.view().menu!.rows.length,1,'the draft actually matches one key row');draw();idle()
   r.stage.onAction({action:'read'});assert.equal(r.stage.view().read!.heading,'按键说明','the dedicated key-reader branch is really active');draw();idle()
   r.stage.onAction({action:'help'});draw();idle()
   r.stage.onAction({action:'cancel'});assert.equal(r.stage.view().read!.heading,'按键说明');draw();idle()
   r.stage.onAction({action:'cancel'});assert.equal(r.stage.view().read,undefined);draw();idle()
   r.stage.onAction({action:'cancel'});assert.equal(r.stage.view().menu,undefined);draw();idle()
   r.widen();const e=applyIntent(applyIntent(emptyEditor(),{t:'insert',text:original}),{t:'home'}),f=inputFrameOf({e,prompt:'> ',width:innerOf(80)})
   assert.deepEqual(r.stage.view().input,{rows:f.rows,caret:f.caret},'original matched Chinese filter and caret survive the reader')
   r.stage.onAction({action:'submit'});assert.deepEqual(r.presses,[original])
  }finally{r.close()}
 }
 console.log('matched key-reader:frames'+frames+';idles'+idles+' bytes0;candidate1/actual heading checked;cover/return;original2/2')
})

test('two-column physical input retains fitting whole CJK and emoji clusters through real cursor edits',()=>{
 let frames=0,idles=0
 for(const glyph of ['中','👨‍👩‍👧','🇨🇳','👍🏽'])for(const height of [6,8,24]){
  const original=glyph+'A'+glyph+'B'+glyph+'C',r=rig(2,height),draw=()=>{r.draw();frames++},idle=()=>{r.idle();frames++;idles++}
  try{
   r.stage.onAction({action:'insert',text:original});assert.deepEqual(r.stage.view().input!.rows,[glyph,'C',''],'a whole two-cell glyph fits two real cells and remains visible')
   draw();idle()
   for(const action of ['home','right'] as const){r.stage.onAction({action});draw();idle()}
   r.stage.onAction({action:'insert',text:'Z'});draw();idle()
   r.stage.onAction({action:'backspace'});draw();idle()
   for(const action of ['end','left','right'] as const){r.stage.onAction({action});draw();idle()}
   r.stage.onAction({action:'submit'});assert.deepEqual(r.presses,[original],'all fitting original clusters submit exactly once')
  }finally{r.close()}
  assert.ok(r.vt.lines.every(s=>s===''),'the unchanged physical two-column area closes exactly')
 }
 console.log('fitting two-column input:12 geometries;frames'+frames+';idles'+idles+' bytes0;CJK/family/flag/skin whole;wrap0/scroll0;original12/12')
})
