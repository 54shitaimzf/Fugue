import assert from 'node:assert/strict'
import {test} from 'node:test'
import {spawnSync} from 'node:child_process'
import {mkdirSync,writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {tmpDir} from '../../test/helpers/tmp.ts'
import {frameOf} from './frame.ts'
import {statusOf} from '../probe/status.ts'
import {taskOf} from './task.ts'
import {openStage} from './stage.ts'
import {openSession} from './follow.ts'
import {openTerm} from './term.ts'
import {KEYMAP,hintLineForWidth} from './keymap.ts'
import {setGlyphTier,widthOf} from './glyph.ts'
import type {StatusRow} from '../probe/status.ts'
import { screen } from '../../test/helpers/vt-screen.ts'

const prompt='说说你想做什么。'
const empty=(width=192,height=45)=>({snapshot:statusOf([]),task:taskOf([]),operationArea:true,width,height})
const content=(f:ReturnType<typeof frameOf>)=>f.lines.map(s=>s.trim()).join('')
const events=[{pos:{writer:'round',seq:1},e:{t:'round/state',round:'r1',from:'Idle',to:'Planning'}},{pos:{writer:'round',seq:2},e:{t:'round/intent',round:'r1',body:'Current work already has a purpose'}}] as StatusRow[]
test('the empty-input invitation belongs only to an unstarted input; current feedback, full host capacity and unknown-context fallback stay',()=>{
 let frames=0,cases=0
 try{for(const glyph of ['ascii','box','rich'] as const){setGlyphTier(glyph)
  for(const width of [8,16,24,80,120,192])for(const height of [8,19,35,45]){
   const o=empty(width,height),waiting=frameOf(o),active=frameOf({...o,inputIdle:false}),idle=frameOf({...o,inputIdle:true});frames+=3;cases++
   assert.equal(content(waiting),prompt);assert.deepEqual(idle,waiting,'omitted metadata preserves the useful original empty-input floor')
   assert.equal(content(active),'','typing has no invitation, onboarding, old waiting or invented progress')
   assert.equal(active.footer,'');assert.ok(active.lines.every(s=>s===' '.repeat(width)));assert.ok(active.roles.every(r=>r==='body'))
   assert.equal(active.height,waiting.height);assert.equal(active.lines.length,height);assert.ok(active.lines.every(s=>widthOf(s)===width))
   const f=frameOf({...o,inputIdle:false,feedback:['输入有误']});frames++
   assert.match(content(f).replace(/\s/g,''),/^系统(?:·)?输入有误$/);assert.ok(f.roles.includes('instruction'),'a current problem is still visible near input')
   for(const inputIdle of [undefined,true,null,0,'false'] as const){assert.deepEqual(frameOf({...o,inputIdle} as never),waiting);frames++}
   for(const extra of [{operationArea:false},{operationArea:undefined},{task:undefined},{snapshot:{...statusOf([]),events:1}},{snapshot:statusOf(events),task:taskOf(events)},{conversation:[{text:'Original model message',role:'model' as const}]},{read:{rows:['Original read line'],top:0,heading:'Current reading',footer:'1/1 行 · 只读'}},{menu:{rows:['Current help'],sel:0}},{bottom:{rows:['Current action'],keep:1}},{nav:{rows:['Existing agent'],sel:0}},{view:'progress' as const},{view:'spending' as const}]){
    assert.deepEqual(frameOf({...o,...extra,inputIdle:false}),frameOf({...o,...extra}),'other actual contexts keep their complete original frame');frames+=2
   }
  }
 }}finally{setGlyphTier('box')}
 console.log('input invitation frame:cases'+cases+';frames'+frames+';active invitation/onboarding/waiting0;feedback exact;full dimensions;unknown/read-only/task/read/menu/card/view floors exact')
})
test('actual editor, Session and Term withdraw and restore the invitation through typing, read/help, clear/undo and dispatch without moving or losing input',()=>{
 let frames=0,idles=0,cases=0
 try{for(const glyph of ['ascii','box','rich'] as const){setGlyphTier(glyph)
 for(const width of [24,80,120,192])for(const height of [12,24,40,50]){
  const vt=screen(width,height),writes:string[]=[],presses:string[]=[],notes:string[]=[];let running=false
  const stage=openStage({columns:()=>width,termRows:()=>height,rows:()=>[],pendingFace:async()=>null,redraw:()=>{},note:s=>notes.push(s),notes:()=>notes,hint:w=>hintLineForWidth(width,KEYMAP,w),now:()=>0,abort:()=>{},run:()=>({get running(){return running},last:[],argvOf:s=>({words:[s],argv:[s],why:null}),press:s=>{presses.push(s);running=true;return true},stop:()=>{running=false;return true}})})
  stage.setRaw(true);const session=openSession({view:stage.view}),term=openTerm({out:{isTTY:true,columns:width,rows:height,write:s=>{writes.push(s);vt.put(s)}},term:'xterm',heightOf:stage.heightWant,reserveHeightOf:()=>height-1})
  const draw=()=>{const p=session.panel({columns:width,height:Math.min(height-1,stage.heightWant())});term.draw([],s=>session.panel(s));frames++
   const input=stage.view().input!;assert.equal(vt.wraps,0);assert.equal(vt.scrolls,0);assert.deepEqual(vt.caret,{row:height-input.rows.length+input.caret.row,col:input.caret.col});assert.deepEqual(vt.lines.slice(height-input.rows.length),input.rows.map(s=>s.trimEnd()))
   const bytes=writes.length;term.draw([],s=>session.panel(s));frames++;idles++;assert.equal(writes.slice(bytes).join(''),'','same complete input operation is byte quiet');return p.rows.map(s=>s.trim()).join('')
  }
  const type=(s:string)=>{for(const ch of s)stage.onAction({action:'insert',text:ch})}
  try{
   assert.equal(draw(),prompt);type(' ');assert.equal(draw(),'','a real whitespace draft has already begun');assert.equal(stage.view().inputIdle,false)
   const original=' DRAFT-ORIGINAL-'+('abc'.repeat(60))+'中文';type(original.slice(1));const draft=stage.view().input;assert.equal(draw(),'')
   stage.notify('CURRENT-INPUT-PROBLEM');assert.match(draw().replace(/\s/g,''),/^系统(?:·)?CURRENT-INPUT-PROBLEM$/)
   stage.onAction({action:'home'});assert.equal(draw(),'');const home=stage.view().input
   stage.onAction({action:'read'});assert.ok(draw().includes('事件流'));stage.onAction({action:'cancel'});assert.equal(draw(),'');assert.deepEqual(stage.view().input,home)
   stage.onAction({action:'help'});draw();stage.onAction({action:'cancel'});assert.equal(draw(),'');assert.deepEqual(stage.view().input,home)
   stage.onAction({action:'cancel'});assert.ok(draw().includes(prompt));assert.equal(stage.view().inputIdle,true)
   stage.onAction({action:'undo'});assert.equal(draw(),'');assert.deepEqual(stage.view().input,home)
   stage.onAction({action:'end'});assert.equal(draw(),'');assert.deepEqual(stage.view().input,draft)
   stage.onAction({action:'submit'});assert.deepEqual(presses,[original]);assert.equal(stage.view().inputIdle,false);assert.ok(!draw().includes(prompt),'dispatch in flight is not a new-input invitation')
   running=false;stage.onRunDone({code:0,signal:null,why:null});assert.equal(stage.view().inputIdle,true);assert.ok(draw().includes(prompt),'idle entry becomes useful again')
   stage.setRaw(false);assert.equal(stage.view().input,undefined);assert.equal(stage.view().inputIdle,undefined)
   cases++
  }finally{stage.close();term.close();assert.ok(vt.lines.every(s=>s===''),'owned fixed-size operation closes cleanly')}
 }
 }}finally{setGlyphTier('box')}
 console.log('input invitation sequence:cases'+cases+';frames'+frames+';idles'+idles+' bytes0;3glyph/4width/4height;wrap0/scroll0;all visible input/caret/full originals exact;in-flight invitation0;raw-off metadata absent;owned close0')
})
test('actual Console and serve keep only a useful invitation through raw typing, configured reading, clear and undo; no submit and helpers close',()=>{
 const actor=String.raw`
import assert from 'node:assert/strict'
const [module,root]=process.argv.slice(2),{tuiCmd}=await import(module),wait=n=>new Promise(r=>setTimeout(r,n))
let raw=false,output=''
Object.defineProperty(process.stdout,'isTTY',{configurable:true,value:true});Object.defineProperty(process.stdout,'columns',{configurable:true,value:80});Object.defineProperty(process.stdout,'rows',{configurable:true,value:40})
Object.defineProperty(process.stdin,'isTTY',{configurable:true,value:true});Object.defineProperty(process.stdin,'isRaw',{configurable:true,get:()=>raw});process.stdin.setRawMode=n=>{raw=n;return process.stdin}
const saved=process.stdout.write.bind(process.stdout);process.stdout.write=(chunk,enc,cb)=>{output+=Buffer.isBuffer(chunk)?chunk.toString():chunk;const fn=typeof enc==='function'?enc:cb;if(fn)queueMicrotask(fn);return true}
const signals=['SIGINT','SIGTERM','SIGHUP','SIGWINCH'],before=signals.map(s=>process.listenerCount(s)),prompt='说说你想做什么。'
const done=tuiCmd(root,new Map([['interval','25'],['no-style',true]]))
const drawn=()=>{
 const rows=new Map();let row=0,at=0
 while(at<output.length){
  if(output[at]==='\r'){at++;continue}
  if(output[at]==='\n'){row++;at++;continue}
  if(output[at]==='\x1b'){
   const rest=output.slice(at),c=/^\x1b\[([0-?]*)([ -/]*)([@-~])/.exec(rest)
   if(c){const n=Number(c[1])||1;if(c[3]==='A')row-=n;else if(c[3]==='B')row+=n;else if(c[3]==='K')rows.set(row,'');at+=c[0].length;continue}
   const d=/^\x1bP[\s\S]*?\x1b\\/.exec(rest);if(d){at+=d[0].length;continue}
   at++;continue
  }
  let end=at;while(end<output.length&&!/[\r\n\x1b]/.test(output[end]))end++
  rows.set(row,output.slice(at,end));at=end
 }
 return [...rows.values()].map(s=>s.trim()).filter(Boolean)
}
const rawKey=s=>process.stdin.emit('data',Buffer.from(s)),type=s=>{for(const ch of s)rawKey(ch)}
const observe=async()=>{await wait(100);return drawn()}
let idles=0
const quiet=async()=>{const bytes=output.length;await wait(100);assert.equal(output.length,bytes);idles++}
try{
 for(let i=0;i<500&&!raw;i++)await wait(20);assert.ok(raw)
 for(let i=0;i<500&&!drawn().includes(prompt);i++)await wait(20);assert.ok(drawn().includes(prompt));await quiet()
 const original='DRAFT-ORIGINAL-'+('xyz'.repeat(60))+'中文'
 type(original);let lines=await observe();assert.ok(!lines.includes(prompt),'actual Console withdraws the invitation once input starts');assert.ok(lines.join('').includes(original),'every visible original input row remains');await quiet()
 rawKey('\x1bl');lines=await observe();assert.ok(lines.some(s=>s.includes('事件流')));assert.ok(!lines.includes(prompt));await quiet()
 rawKey('\x1b');lines=await observe();assert.ok(!lines.includes(prompt));assert.ok(lines.join('').includes(original));await quiet()
 rawKey('\x1b');lines=await observe();assert.ok(lines.includes(prompt),'clearing returns the useful empty-input invitation');await quiet()
 rawKey('\x1a');lines=await observe();assert.ok(!lines.includes(prompt));assert.ok(lines.join('').includes(original),'undo restores the full original without reviving its invitation');await quiet()
 rawKey('\x1b');lines=await observe();assert.ok(lines.includes(prompt));await quiet()
 rawKey('\x04');assert.equal(await done,0);assert.equal(raw,false);assert.deepEqual(signals.map(s=>process.listenerCount(s)),before)
 assert.equal(process._getActiveHandles().filter(h=>h.constructor.name==='ChildProcess'&&h.exitCode===null).length,0)
 saved(JSON.stringify({columns:80,rows:40,idles,idleBytes:0,fullOriginalVisible:true,readKey:'Alt-L',rawRestored:true,serveClosed:true,submitted:0,scope:'actual Console/serve with process-local stdout row observer; not native history or IME'})+'\n')
}finally{
 if(raw){for(let i=0;i<3;i++){rawKey('\x1b');await wait(80)}rawKey('\x04');await done}
 process.stdin.pause()
}
`
 const root=tmpDir('fugue-input-invitation-'),file=join(root,'actor.mjs')
 mkdirSync(join(root,'.fugue'));writeFileSync(join(root,'.fugue/config'),JSON.stringify({ui:{glyphs:'ascii',images:'off',keys:{read:'Alt-L'}}}));writeFileSync(file,actor)
 const result=spawnSync(process.execPath,[file,fileURLToPath(new URL('./console.ts',import.meta.url)),root],{encoding:'utf8',env:{...process.env,TERM:'xterm',FUGUE_SYSTEM_DIR:join(root,'system')},timeout:30000})
 assert.equal(result.status,0,result.stderr||String(result.error));console.log('actual input invitation Console:'+result.stdout.trim())
})
