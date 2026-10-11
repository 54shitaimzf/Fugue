import assert from 'node:assert/strict'
import {test} from 'node:test'
import {frameOf,innerOf} from './frame.ts'
import {statusOf} from '../probe/status.ts'
import {glyphs,setGlyphTier,widthOf} from './glyph.ts'
import {readWrap} from './read.ts'
import {openStage} from './stage.ts'
import {openSession} from './follow.ts'
import {openTerm} from './term.ts'
import {gateFaceOf} from './gate.ts'
import {KEYMAP,hintLineOf} from './keymap.ts'
import type {FrameInput} from './frame.ts'
import type {StatusRow} from '../probe/status.ts'
function input(width=192,height=45):FrameInput{
 return {width,height,snapshot:statusOf([]),operationArea:true,read:{heading:'原文',footer:'1/4 行 · 只读',top:0,rows:['SOURCE A','','SOURCE B','']}}
}
test('text reader groups original title, every real row and position; spare capacity stays outside the outline',()=>{
 let cases=0,grouped=0,floors=0,blankRows=0
 try{for(const tier of ['ascii','box','rich'] as const){setGlyphTier(tier)
 for(const width of [192,120,80,40,24,16,8])for(const height of [8,12,24,35,45])for(const top of [0,1,3]){
  const o=input(width,height),rows=['SOURCE A','','SOURCE B',''].flatMap(s=>readWrap(s,innerOf(width)))
  o.read={...o.read!,rows,top:Math.min(top,rows.length-1),heading:width<16?'':'原文'}
  const f=frameOf(o),old=frameOf({...o,operationArea:false}),reads=f.roles.map((r,i)=>r==='read'?i:-1).filter(i=>i>=0),last=reads.at(-1)!
  const spare=height-(reads.length+4),fits=spare>0&&reads.every(i=>widthOf(old.lines[i]!.slice(2,-2))<=innerOf(width))
  assert.equal(f.lines.length,height);assert.equal(f.roles.length,height);assert.ok(f.lines.every(l=>widthOf(l)===width));assert.equal(f.footer,old.footer);assert.deepEqual(f.columns,old.columns)
  assert.equal(f.lines[0],old.lines[0]);assert.equal(f.roles[0],'readHeading')
  assert.deepEqual(reads.map(i=>f.lines[i]),old.lines.filter((_,i)=>old.roles[i]==='read'),'all original read rows, including real blanks, retain bytes/order/physical rows')
  if(fits){
   assert.equal(f.roles.indexOf('footer'),last+2,'position immediately follows original content with one separator')
   assert.equal(f.lines[last+2],old.lines[height-2]);assert.equal(f.lines[last+3],old.lines.at(-1))
   assert.ok(f.lines.slice(last+4).every(l=>l===' '.repeat(width)),'spare capacity has no fictitious reader outline')
   assert.ok(f.roles.slice(last+4).every(r=>r==='body'));grouped++
  }else{assert.deepEqual(f,old,'dense/tiny text retains the original complete frame');floors++}
  blankRows+=reads.filter(i=>o.read!.rows[i-1]?.trim()==='').length
  assert.deepEqual(frameOf(o),f);cases++
 }
 }}finally{setGlyphTier('box')}
 console.log('reader grouping:cases'+cases+';grouped'+grouped+';dense'+floors+';realBlankRows'+blankRows+';all text/roles/order/width/height/columns/footer exact;position adjacent;spare outside')
})
test('unknown operation/position/title, unsupported preview and covered reading retain original complete frame',()=>{
 let floors=0
 try{for(const tier of ['ascii','box','rich'] as const){setGlyphTier(tier)
 for(const width of [192,80,24])for(const height of [12,24,45]){
  const o=input(width,height)
  const changes:Partial<FrameInput>[]=[
   {operationArea:false},{operationArea:undefined},{operationArea:0 as never},
   {read:{...o.read!,footer:undefined}},{read:{...o.read!,footer:''}},{read:{...o.read!,footer:'\x1bBAD'}},
   {read:{...o.read!,rows:['X'.repeat(512),'','SOURCE B','']}},{read:{...o.read!,heading:undefined}},{read:{...o.read!,heading:'\x1bBAD'}},
   ...[-1,.5,NaN,Infinity,99].map(top=>({read:{...o.read!,top}})),
   ...[{after:2,state:'loading'},{after:2,state:'unavailable'},{after:2,state:'ready'},{after:2,state:'bad'}].map(preview=>({read:{...o.read!,preview:preview as never}})),
   {bottom:{rows:[],keep:0}},{bottom:{rows:['COVERED'],keep:1}},
   {menu:{rows:['UNKNOWN'],sel:0}},{menu:{rows:['ACTUAL HELP'],sel:0,help:true}},
  ]
  for(const change of changes){
   const source={...o,...change}
   const render=(o:FrameInput)=>{try{return {frame:frameOf(o)}}catch(error){return {error:(error as Error).name+': '+(error as Error).message}}}
   const f=render(source)
   // Independent guards disable grouping; the old reading projection ignores the sentinel and operation flag.
   const reference=render({...source,...(source.menu===undefined?{operationArea:false}:{}),read:{...source.read!,preview:source.read!.preview??({after:-1,state:'ready'} as never)}})
   assert.deepEqual(f,reference,'unsupported or covered reader is the exact same complete projection');floors++
  }
 }
 }}finally{setGlyphTier('box')}
 console.log('reader grouping floors:'+floors+';unknown/invalid operation, title/footer/top, preview states, menus and bottom exact;no new image/roles/interface')
})
test('actual plan/record/key reading retains full drafts, nonterminal caret, FIFO and fresh approval through layout/resize/menu sequences',async()=>{
 let cases=0,frames=0,idles=0,compact=0
 const goal='核对原文件，只修正登录提示。\n完成后确认验收和写回结果。'
 const rows=[{pos:{writer:'round',seq:1},e:{t:'round/state',round:'r1',from:'Idle',to:'Planning'}},{pos:{writer:'round',seq:2},e:{t:'round/intent',round:'r1',body:JSON.stringify({goal})}}] as StatusRow[]
 const face=gateFaceOf({round:'r1',fingerprint:'reader-group',same:[],contracts:[1,2,3].map(i=>({id:'r1.implement.'+i,agent:'agent/r1/'+i,kind:'implement',goal:'任务'+i+' 修正提示并保留原账号',ownedPaths:['src/login-'+i+'.ts'],seed:[],deliverables:[],assertions:[{name:'验证登录',action:'test'}]}))} as never,{test:'node checks.js'})
 try{for(const tier of ['ascii','box','rich'] as const){setGlyphTier(tier)
 for(const kind of ['plan','record','key'])for(const queued of [false,true]){
  let width=192,height=50,pending:typeof face|null=null,running=queued;const presses:string[]=[],writes:string[]=[]
  const stage=openStage({rows:()=>rows,columns:()=>width,termRows:()=>height,pendingFace:async()=>pending,note:()=>{},redraw:()=>{},now:()=>0,abort:()=>{},hint:w=>hintLineOf(KEYMAP,0,w),
   run:()=>({get running(){return running},last:[],argvOf:s=>({words:[s],argv:[s],why:null}),press:s=>{presses.push(s);running=true;return true},stop:()=>{running=false;return true}})})
  stage.setRaw(true);const session=openSession({view:stage.view});session.push(rows)
  const term=openTerm({term:'xterm',heightOf:stage.heightWant,reserveHeightOf:()=>height-1,out:{isTTY:true,get columns(){return width},get rows(){return height},write:s=>writes.push(s)}})
  const type=(s:string)=>{for(const ch of s)stage.onAction({action:'insert',text:ch})}
  const draw=()=>{let size={columns:width,height:1};term.draw([],s=>{size=s;return session.panel(s)});frames++
   const f=session.panel(size);assert.ok(size.height+stage.view().input!.rows.length<=height);assert.ok(f.rows.every(s=>widthOf(s)===width))
   const last=f.roles!.findLastIndex(r=>r==='read'),footer=f.roles!.indexOf('footer')
   if(last>=0&&footer===last+2&&footer<size.height-2){compact++;assert.ok(f.rows.slice(footer+2).every(s=>s.trim()===''))}
   writes.length=0;term.draw([],s=>session.panel(s));assert.equal(writes.join(''),'');frames++;idles++;return f
  }
  const queue=['QUEUE FIRST 原文','QUEUE SECOND 原文']
  try{
   if(queued){for(const q of queue){type(q);stage.onAction({action:'submit'})}stage.onAction({action:'cancel'});stage.onRunDone({code:0,signal:null,why:null})}
   const original='DRAFT 保留完整草稿\n第二行不得变化';type(original);stage.onAction({action:'left'});const draft=stage.view().input
   if(kind!=='record'){pending=face;await stage.refreshGate();stage.onAction({action:'approve',key:'y'})}
   if(kind==='key')stage.onAction({action:'help'})
   stage.onAction({action:'read'});draw();const source=stage.view().read!.rows.join('')
   for(const [w,h] of [[80,24],[24,12],[120,40],[192,50]]){
    width=w!;height=h!;stage.onResize();draw();assert.equal(stage.view().read!.rows.join(''),source,'all source text remains exact through known widths')
    stage.onAction({action:'approve',key:'y'});if(kind!=='record')stage.onAction({action:'submit'});assert.deepEqual(presses,[])
   }
   if(kind!=='key'){
    const read=stage.view().read;stage.onAction({action:'help'});type('ZZZ');draw();if(kind==='record')for(let i=0;i<3;i++)stage.onAction({action:'backspace'});stage.onAction({action:'cancel'});draw();assert.deepEqual(stage.view().read,read)
   }
   stage.onAction({action:'cancel'});draw()
   if(kind==='plan'){stage.onAction({action:'submit'});assert.deepEqual(presses,[]);stage.onAction({action:'cancel'})}
   if(kind==='key'){stage.onAction({action:'cancel'});stage.onAction({action:'cancel'})}
   draw();assert.deepEqual(stage.view().input,draft,'complete draft and actual nonterminal caret restored')
   if(queued)for(const q of queue){running=false;assert.equal(stage.startNext(),true);assert.equal(presses.at(-1),q)}
   running=false;stage.onAction({action:'submit'});assert.equal(presses.at(-1),original);cases++
  }finally{stage.close();term.close()}
 }
 }}finally{setGlyphTier('box')}
 assert.ok(compact>0,'actual sparse readers group position next to original content')
 console.log('reader grouping sequences:'+cases+';frames'+frames+';idles'+idles+' bytes0;compactFrames'+compact+';plan/record/key full text and draft/caret/FIFO exact;old approval execute0;actual height/width preserved')
})
