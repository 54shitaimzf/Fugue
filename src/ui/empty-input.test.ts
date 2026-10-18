import assert from 'node:assert/strict'
import {test} from 'node:test'
import {spawnSync} from 'node:child_process'
import {mkdirSync,writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {tmpDir} from '../../test/helpers/tmp.ts'
import {frameOf} from './frame.ts'
import {statusOf} from '../probe/status.ts'
import type {StatusRow} from '../probe/status.ts'
import {taskOf} from './task.ts'
import {setGlyphTier,widthOf} from './glyph.ts'
import {openStage} from './stage.ts'
import {openSession} from './follow.ts'
import {openTerm} from './term.ts'
import {KEYMAP,hintLineForWidth} from './keymap.ts'
import {theme16,theme256,DEFAULT_THEME} from './theme.ts'
import {gateFaceOf} from './gate.ts'
const prompt='说说你想做什么。'
const empty=(width=192,height=45)=>({snapshot:statusOf([]),task:taskOf([]),operationArea:true,width,height})
const text=(f:ReturnType<typeof frameOf>)=>f.lines.map(s=>s.trim()).join('')
const events=[{pos:{writer:'round',seq:1},e:{t:'round/state',round:'r1',from:'Idle',to:'Planning'}},{pos:{writer:'round',seq:2},e:{t:'round/intent',round:'r1',body:'核对输入引导'}}] as StatusRow[]
const face=gateFaceOf({round:'r1',fingerprint:'empty-input',same:[],contracts:[{id:'r1.implement.1',agent:'agent/r1/1',kind:'implement',goal:'核对输入引导',ownedPaths:['src/login.ts'],seed:[],deliverables:[],assertions:[]}]} as never,{})

test('首次输入只展示当前邀请，就近且没有空框或重复等待；反馈与原屏幕容量保持',()=>{
 let cases=0
 try{for(const glyph of ['ascii','box','rich'] as const){setGlyphTier(glyph)
  for(const width of [8,11,16,24,51,80,192])for(const height of [8,19,35,45]){
   const o=empty(width,height),f=frameOf(o)
   assert.equal(text(f),prompt,'首次输入只需要说清现在能做什么')
   const at=f.lines.findIndex(s=>s.trim()!=='');assert.ok(at>0);assert.ok(f.lines.slice(0,at).every(s=>s===' '.repeat(width)))
   assert.equal(f.roles.filter(r=>r==='border'||r==='footer').length,0,'空态不把空容量或等待装进框')
   assert.ok(f.roles.slice(at).every(r=>r==='instruction'));assert.equal(f.footer,'')
   assert.equal(f.lines.length,height);assert.equal(f.roles.length,height);assert.ok(f.lines.every(s=>widthOf(s)===width))
   assert.deepEqual(frameOf(o),f);cases++
  }
 }
 setGlyphTier('box')
 const f=frameOf({...empty(),feedback:['执行入口不可用。']})
 assert.deepEqual(f.lines.filter(s=>s.trim()!=='').map(s=>s.trim()),[prompt,'系统 · 执行入口不可用。'])
 assert.ok(f.roles.slice(-2).every(r=>r==='instruction'),'当前问题必须在输入附近可见')
 for(const operationArea of [false,undefined]){const o={...empty(),operationArea};assert.deepEqual(frameOf(o),frameOf({...o,operationArea:false}));assert.ok(text(frameOf(o)).includes('先查看计划'))}
 for(const extra of [{task:undefined},{snapshot:{...statusOf([]),events:1}},{read:{rows:['完整原文'],top:0,heading:'当前记录'}},{menu:{rows:['帮助'],sel:0}},{bottom:{rows:['未知操作'],keep:1}},{nav:{rows:['已有执行者'],sel:0}}]){
  const f=frameOf({...empty(),...extra});assert.ok(f.roles.includes('border'),'未知、只读或已有其他内容保有原结构')
 }
 const original=frameOf({...empty(),conversation:[{text:'模型原文仍有用途',role:'model'}]})
 assert.ok(text(original).includes('模型原文仍有用途'));assert.ok(!text(original).includes(prompt))
 const task=frameOf({...empty(),snapshot:statusOf(events),task:taskOf(events)})
 assert.ok(text(task).includes('核对输入引导'));assert.ok(!text(task).includes(prompt));assert.ok(task.lines.some(l=>l.includes('当前任务')),'current task keeps its frame heading')
 const short=frameOf({...empty(3,4)});assert.equal(short.lines.length,1);assert.ok(short.roles.includes('body'),'画不出框的原下限仍有说明')
 }finally{setGlyphTier('box')}
 console.log('empty input:84 scene geometries;invitation and feedback adjacent to input;outlines/footer0;full allocated height;read-only/unknown/records/menu/card floor retained')
})

test('实际Stage/Session/Term多帧空态、输入、阅读、确认、变宽和任务出现：输入位置与草稿保持，停留字节0',async()=>{
 let frames=0,idles=0,resizes=0
 try{for(const glyph of ['ascii','box','rich'] as const){setGlyphTier(glyph)
  for(const theme of [theme16(),theme256(),theme256('light'),theme256('dark'),DEFAULT_THEME,undefined]){
   let width=192,height=50,rows:StatusRow[]=[],pending:typeof face|null=null
   const chunks:string[]=[],presses:string[]=[]
   const stage=openStage({columns:()=>width,termRows:()=>height,rows:()=>rows,pendingFace:async()=>pending,redraw:()=>{},note:()=>{},hint:w=>hintLineForWidth(width,KEYMAP,w),now:()=>0,abort:()=>{},run:()=>({running:false,last:[],argvOf:()=>({words:[],argv:[],why:null}),press:s=>{presses.push(s);return true},stop:()=>false})})
   stage.setRaw(true);const session=openSession({view:stage.view})
   const term=openTerm({out:{isTTY:true,get columns(){return width},get rows(){return height},write:s=>chunks.push(s)},term:'xterm',theme,heightOf:stage.heightWant})
   const draw=()=>{let p:ReturnType<typeof session.panel>;term.draw([],size=>{p=session.panel(size);return p});frames++;return p!}
   const idle=()=>{chunks.length=0;draw();assert.equal(chunks.join(''),'');idles++}
   try{
    const opening=draw();assert.equal(opening.rows.at(-1)!.trim(),prompt);assert.equal(opening.roles?.filter(r=>r==='border').length,0);idle()
    stage.onAction({action:'insert',text:'保留草稿'});const draft=stage.view().input;const typing=draw();assert.equal(typing.rows.length,opening.rows.length);assert.ok(!typing.rows.some(s=>s.includes(prompt)));idle()
    stage.onAction({action:'read'});assert.ok(draw().rows.some(s=>s.includes('事件流')));idle();stage.onAction({action:'cancel'});draw();idle();assert.deepEqual(stage.view().input,draft)
    for(const next of [24,80,192]){width=next;stage.onResize();const p=draw();assert.ok(!p.rows.some(s=>s.includes(prompt)));assert.ok(p.rows.length+(p.input?.rows.length??0)+2<=height);idle();resizes++}
    rows=events;stage.onAdvance(rows);session.push(rows);const working=draw();assert.ok(working.rows.some(s=>s.includes('当前任务')));assert.ok(!working.rows.some(s=>s.includes(prompt)));assert.equal(working.rows.length,opening.rows.length);idle()
    pending=face;await stage.refreshGate();const gate=draw();assert.ok(gate.rows.some(s=>s.includes('核对输入引导')));assert.ok(!gate.rows.some(s=>s.includes(prompt)));idle()
    stage.onAction({action:'approve',key:'y'});draw();stage.onAction({action:'read'});draw();stage.onAction({action:'cancel'});draw();stage.onAction({action:'submit'});draw();assert.deepEqual(presses,[],'全文返回清旧批准')
    stage.onAction({action:'cancel'});draw();idle();assert.deepEqual(stage.view().input,draft)
   }finally{stage.close();term.close()}
  }
 }}finally{setGlyphTier('box')}
 console.log('empty sequence:frames'+frames+';idles'+idles+' bytes0;resizes'+resizes+';3glyph x6themes;actual task replaces invitation;input capacity/draft exact;unapproved dispatch0')
})

test('实际Console和serve在空工作区只显示就近输入邀请；配置阅读、停留与退出保持',()=>{
 const actor=String.raw`
import assert from 'node:assert/strict'
const [module,root]=process.argv.slice(2),{tuiCmd}=await import(module),wait=n=>new Promise(r=>setTimeout(r,n))
let raw=false,output=''
Object.defineProperty(process.stdout,'isTTY',{configurable:true,value:true});Object.defineProperty(process.stdout,'columns',{configurable:true,value:80});Object.defineProperty(process.stdout,'rows',{configurable:true,value:40})
Object.defineProperty(process.stdin,'isTTY',{configurable:true,value:true});Object.defineProperty(process.stdin,'isRaw',{configurable:true,get:()=>raw});process.stdin.setRawMode=n=>{raw=n;return process.stdin}
const saved=process.stdout.write.bind(process.stdout);process.stdout.write=(chunk,enc,cb)=>{output+=Buffer.isBuffer(chunk)?chunk.toString():chunk;const fn=typeof enc==='function'?enc:cb;if(fn)queueMicrotask(fn);return true}
const signals=['SIGINT','SIGTERM','SIGHUP','SIGWINCH'],before=signals.map(s=>process.listenerCount(s))
const done=tuiCmd(root,new Map([['interval','25'],['no-style',true]]))
for(let i=0;i<500&&!raw;i++)await wait(20);assert.ok(raw)
// Track complete drawn rows, including unchanged ones skipped by incremental redraw.
// This process-local no-style fixture tracks cursor rows and whole-line writes, not native history.
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
let lines=[]
for(let i=0;i<500;i++){lines=drawn();if(lines.includes('说说你想做什么。')&&!lines.some(s=>s.includes('先查看计划')||s.includes('等待输入')))break;await wait(20)}
assert.ok(lines.includes('说说你想做什么。'));assert.ok(!lines.some(s=>s.includes('先查看计划')||s.includes('验收通过后')||s.includes('输入任务并发送')||s.includes('等待输入')),'当前输入不提前讲后续规则或重复等待')
const b=output.length;await wait(100);assert.equal(output.length,b)
process.stdin.emit('data',Buffer.from('\x1bl'));await wait(100);assert.ok(drawn().some(s=>s.includes('事件流')));assert.ok(!drawn().some(s=>s.includes('说说')))
process.stdin.emit('data',Buffer.from('\x1b'));await wait(100);assert.ok(drawn().includes('说说你想做什么。'))
process.stdin.emit('data',Buffer.from('\x04'));assert.equal(await done,0);assert.equal(raw,false);assert.deepEqual(signals.map(s=>process.listenerCount(s)),before)
assert.equal(process._getActiveHandles().filter(h=>h.constructor.name==='ChildProcess'&&h.exitCode===null).length,0)
saved(JSON.stringify({columns:80,rows:40,invite:'说说你想做什么。',readKey:'Alt-L',idleBytes:0,rawRestored:true,serveClosed:true,modelCalls:0})+'\n');process.stdin.pause()
`
 const root=tmpDir('fugue-empty-input-'),file=join(root,'actor.mjs')
 mkdirSync(join(root,'.fugue'));writeFileSync(join(root,'.fugue/config'),JSON.stringify({ui:{glyphs:'ascii',images:'off',keys:{read:'Alt-L'}}}));writeFileSync(file,actor)
 const result=spawnSync(process.execPath,[file,fileURLToPath(new URL('./console.ts',import.meta.url)),root],{encoding:'utf8',env:{...process.env,TERM:'xterm',FUGUE_SYSTEM_DIR:join(root,'system')},timeout:30000})
 assert.equal(result.status,0,result.stderr||String(result.error));console.log('actual empty Console:'+result.stdout.trim())
})
