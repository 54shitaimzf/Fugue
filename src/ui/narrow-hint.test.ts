import {spawnSync} from 'node:child_process'
import {mkdirSync,writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {tmpDir} from '../../test/helpers/tmp.ts'

import assert from 'node:assert/strict'
import {test} from 'node:test'
import * as keys from './keymap.ts'
import {widthOf} from './glyph.ts'
import {openStage} from './stage.ts'
import {openSession} from './follow.ts'
import {openTerm} from './term.ts'
import {gateFaceOf} from './gate.ts'

// The parent adapter reproduces its actual Console callback for the negative run.
const hint=(width:number,km=keys.KEYMAP,when:keys.HintWhen='input')=>
 typeof keys.hintLineForWidth==='function'?keys.hintLineForWidth(width,km,when):keys.hintLineOf(km,keys.hintLimitOf(width,km,when),when)

test('提示在最后一项边界也完整收口，窄窗优先保住真实键与当前动作',()=>{
 const exact=widthOf(keys.hintLineOf(keys.KEYMAP,4,'input'))
 assert.equal(keys.hintLimitOf(exact,keys.KEYMAP,'input'),4,'第5项不能越过整行容量')
 assert.equal(hint(16,keys.KEYMAP,'search'),'Esc 结束反查')
 assert.equal(hint(16,keys.KEYMAP,'pending'),'g 查看确认')
 const km=keys.keymapOf({read:'Alt-Enter'})
 assert.equal(hint(16,km,'gate'),'Alt-Enter 看全','实际配置的键保持完整')
 assert.equal(keys.decodeOf('\x1b\r',km)[0]!.action,'read')
 let cases=0
 for(const when of Object.keys(keys.HINT_WHEN).filter(w=>w!=='any') as keys.HintWhen[]){
  const full=keys.hintLineOf(keys.KEYMAP,0,when)
  for(let width=1;width<=240;width++){
   const line=hint(width,keys.KEYMAP,when),first=keys.hintPicksOf(keys.KEYMAP,when)[0]!
   // All ordinary entries that already fit retain their original order and wording.
   if(width>=widthOf(full))assert.equal(line,full)
   if(widthOf(keys.hintLineOf(keys.KEYMAP,1,when))<=width)assert.ok(widthOf(line)<=width,when+' '+width)
   if(widthOf(line)<=width)assert.ok(!line.endsWith(' · '),'不能剩半个条目')
   assert.ok(line.includes(first.keys[0]!),when+'第一操作的实际键')
   cases++
  }
 }
 assert.equal(hint(3),keys.hintLineOf(keys.KEYMAP,1,'input'),'连一个完整键动作都装不下时保留原地板')
 assert.equal(hint(NaN),keys.hintLineOf(keys.KEYMAP,0,'input'),'坏尺寸保留原行为')
 console.log('bounded hints:2880 scene-width cases;last-entry edge exact;compact search/pending/configured key;wide rows byte-identical;too-narrow/invalid floor retained')
})

test('舞台输入、整批全文与返回的多帧提示完整，重画安静、草稿和两段确认保持',async()=>{
 let frames=0,idles=0
 const km=keys.keymapOf({read:'Alt-Enter'})
 const face=gateFaceOf({round:'r1',fingerprint:'hint-fit',same:[],contracts:[{id:'r1.implement.1',agent:'agent/r1/1',kind:'implement',goal:'检查登录',ownedPaths:['src/login.ts'],seed:[],deliverables:[],assertions:[]}]} as never,{test:'node tools/test-entry.js'})
 for(const initialWidth of [16,24,80,120])for(const height of [8,40]){
  let width=initialWidth,pending:typeof face|null=null
  const writes:string[]=[],presses:string[]=[]
  const stage=openStage({rows:()=>[],columns:()=>width,termRows:()=>height,keymap:()=>km,pendingFace:async()=>pending,redraw:()=>{},note:()=>{},now:()=>0,abort:()=>{},hint:when=>hint(width,km,when),
   run:()=>({running:false,last:[],argvOf:()=>({words:[],argv:[],why:null}),press:s=>{presses.push(s);return true},stop:()=>false})})
  stage.setRaw(true)
  const session=openSession({view:stage.view}),term=openTerm({term:'xterm',heightOf:stage.heightWant,out:{isTTY:true,get columns(){return width},rows:height,write:s=>writes.push(s)}})
  const draw=()=>{
   writes.length=0;const view=stage.view();term.draw([],size=>session.panel(size));frames++
   assert.ok(widthOf(view.hint!)<=width,'完整键和动作不能靠终端裁掉')
   const count=(writes.join('').match(/\x1b\[2K/g)??[]).length
   assert.ok(count<=height,'提示仍占一行，没有挤出操作区')
   return writes.join('')
  }
  const idle=()=>{assert.equal(draw(),'');idles++}
  try{
   stage.onAction({action:'insert',text:'保留草稿'});const draft=stage.view().input
   draw();idle();pending=face;await stage.refreshGate();draw();idle()
   stage.onAction({action:'read'});draw();idle();assert.ok(stage.view().read)
   stage.onAction({action:'submit'});assert.deepEqual(presses,[],'只读全文不能执行')
   for(const next of [16,24,initialWidth]){width=next;stage.onResize();draw();idle()}
   stage.onAction({action:'cancel'});draw();idle();stage.onAction({action:'submit'});assert.deepEqual(presses,[],'返回不能继承旧批准')
   stage.onAction({action:'cancel'});pending=null;await stage.refreshGate();draw();idle();assert.deepEqual(stage.view().input,draft)
  }finally{stage.close();term.close()}
 }
 console.log('bounded hint sequence:frames'+frames+';idles'+idles+' bytes0;24 width changes;8 geometries;input/read/confirm/return;draft exact;unapproved dispatch0')
})
test('实际Console与serve的提示完整进入终端行，原输入能力和退出收尾保持',()=>{
 const actor=String.raw`
import assert from 'node:assert/strict'
const [module,root,columns]=process.argv.slice(2),width=Number(columns)
const {tuiCmd}=await import(module),wait=n=>new Promise(r=>setTimeout(r,n))
let raw=false,output=''
Object.defineProperty(process.stdout,'isTTY',{configurable:true,value:true})
Object.defineProperty(process.stdout,'columns',{configurable:true,value:width})
Object.defineProperty(process.stdout,'rows',{configurable:true,value:12})
Object.defineProperty(process.stdin,'isTTY',{configurable:true,value:true})
Object.defineProperty(process.stdin,'isRaw',{configurable:true,get:()=>raw})
process.stdin.setRawMode=n=>{raw=n;return process.stdin}
const saved=process.stdout.write.bind(process.stdout)
process.stdout.write=(chunk,enc,cb)=>{output+=Buffer.isBuffer(chunk)?chunk.toString():chunk;const fn=typeof enc==='function'?enc:cb;if(fn)queueMicrotask(fn);return true}
const signals=['SIGINT','SIGTERM','SIGHUP','SIGWINCH'],before=signals.map(s=>process.listenerCount(s))
const done=tuiCmd(root,new Map([['interval','25'],['no-style',true]]))
for(let i=0;i<500&&!raw;i++)await wait(20)
assert.ok(raw)
process.stdin.emit('data',Buffer.from('x'));process.stdin.emit('data',Buffer.from('\x7f'));await wait(100)
const lines=[...output.matchAll(/\r\x1b\[2K([^\r\n\x1b]*)/g)].map(m=>m[1].trimEnd())
const hints=lines.filter(s=>s.startsWith('按键 ')||s.startsWith('Enter ')||s.startsWith('Ctrl-G '))
const expected=width===11?'Ctrl-G 发送':'按键 Enter 发送 · / 命令 · Ctrl-R 记录 · Tab 视图'
assert.equal(hints.at(-1),expected,'实际Console必须接入完整提示，不留半个最后条目')
const b=output.length;await wait(100);assert.equal(output.length,b)
process.stdin.emit('data',Buffer.from('\x04'));assert.equal(await done,0)
assert.equal(raw,false);assert.deepEqual(signals.map(s=>process.listenerCount(s)),before)
assert.equal(process._getActiveHandles().filter(h=>h.constructor.name==='ChildProcess'&&h.exitCode===null).length,0)
saved(JSON.stringify({width,rows:12,hint:expected,idleBytes:0,rawRestored:true,serveClosed:true})+'\n')
process.stdin.pause()
`
 for(const width of [11,51]){
  const root=tmpDir('fugue-narrow-hint-'),file=join(root,'actor.mjs')
  mkdirSync(join(root,'.fugue'));writeFileSync(join(root,'.fugue/config'),JSON.stringify({ui:{glyphs:'ascii',images:'off',...(width===11?{keys:{submit:'Ctrl-G'}}:{})}}));writeFileSync(file,actor)
  const result=spawnSync(process.execPath,[file,fileURLToPath(new URL('./console.ts',import.meta.url)),root,String(width)],{encoding:'utf8',env:{...process.env,TERM:'xterm',FUGUE_SYSTEM_DIR:join(root,'system')},timeout:30000})
  assert.equal(result.status,0,result.stderr||String(result.error));console.log('actual bounded Console:'+result.stdout.trim())
 }
})
