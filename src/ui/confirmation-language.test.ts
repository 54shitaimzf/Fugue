import assert from 'node:assert/strict'
import {test} from 'node:test'
import {WORDS,archNameOf} from '../words.ts'
import {conclusionLineOf,gateFaceOf,gateQueueRowOf,optionRowOf,gateLayoutOf} from './gate.ts'
import {openStage} from './stage.ts'
import {KEYMAP,hintLineOf,hintKeysOf,helpRowsOf} from './keymap.ts'
import {frameOf,innerOf} from './frame.ts'
import {statusOf} from '../probe/status.ts'
import {openTerm} from './term.ts'
import {themeOf} from './theme.ts'
const face=gateFaceOf({round:'r1',fingerprint:'batch',same:[],contracts:[1,2].map(n=>({id:`r1.implement.${n}`,agent:`agent/r1/${n}`,kind:'implement',goal:'修复登录失败提示',ownedPaths:[`src/login-${n}.ts`],seed:[],deliverables:[],assertions:[{name:'登录行为',action:'test'}]})) as never},{test:'node tools/test-entry.js'})
test('confirmation names the actual choice in plain language; a no-op does not claim the persisted plan was rejected',()=>{
 assert.equal(WORDS.gate,'等待确认');assert.match(archNameOf('gate'),/门/)
 assert.equal(conclusionLineOf(face.conclusion),'这一轮打算开 2 个任务 · 覆盖 2 条路径 · 验收 2 条 · 等待确认')
 assert.equal(optionRowOf({at:0,armed:null}),'y 执行整批 · n 暂不执行 · Esc 收起')
 assert.equal(optionRowOf({at:0,armed:'approve'}),'再按 y / Enter 执行整批 · Esc 收起')
 assert.equal(optionRowOf({at:0,armed:'reject'}),'再按 n / Enter 暂不执行 · Esc 收起')
 assert.equal(gateQueueRowOf({...face,cards:[]},0),'没有待确认任务')
 const notes=helpRowsOf(KEYMAP).filter(s=>/有待确认的任务|执行整批|暂不执行/.test(s));assert.equal(notes.length,3)
 assert.doesNotMatch(notes.join('\n'),/门口|放行|fugue|round go|T7|一个字节/)
})
test('second confirmation alone launches the exact batch command; defer and hide leave it pending and explain that no execution started',async()=>{
 const notes:string[]=[],presses:string[]=[],stage=openStage({rows:()=>[],columns:()=>40,termRows:()=>24,pendingFace:async()=>face,note:s=>notes.push(s),redraw:()=>{},hint:w=>hintLineOf(KEYMAP,4,w),keysOf:w=>hintKeysOf(KEYMAP,w),run:()=>({running:false,last:[],argvOf:s=>({words:s.split(' '),argv:['fugue',...s.split(' ')],why:null}),press:s=>{presses.push(s);return true},stop:()=>false}),now:()=>0,abort:()=>{}})
 stage.setRaw(true);await stage.refreshGate();stage.onAction({action:'approve',key:'y'});assert.deepEqual(presses,[])
 stage.onAction({action:'submit'});assert.deepEqual(presses,['round go']);assert.equal(notes.at(-1),'已确认执行这批计划（2 项任务）')
 assert.equal(stage.view().bottom,undefined,'启动后操作区恢复输入');stage.onAction({action:'go',key:'g'});stage.onAction({action:'reject',key:'n'});assert.equal(presses.length,1);stage.onAction({action:'submit'});assert.equal(presses.length,1)
 assert.equal(notes.at(-1),'本次选择没有启动执行。计划仍等你确认；可补充要求再讨论。');assert.ok(stage.view().bottom)
 stage.onAction({action:'cancel'});assert.equal(notes.at(-1),'确认已收起；这批计划仍等你确认');assert.equal(stage.view().bottom,undefined)
 stage.onAction({action:'go',key:'g'});assert.equal(presses.length,1);assert.ok(stage.view().bottom)
 assert.doesNotMatch(notes.join('\n'),/门口|放行|T7|round go|一个字节/);stage.close()
})
test('confirmation never claims execution began when the existing launcher rejects, is missing, or remains busy',async()=>{
 for(const mode of ['declined','missing','busy'] as const){
  const notes:string[]=[],attempts:string[]=[],stage=openStage({rows:()=>[],columns:()=>40,termRows:()=>24,pendingFace:async()=>face,note:s=>notes.push(s),redraw:()=>{},hint:()=>'',keysOf:()=>'',run:()=>mode==='missing'?null:{running:mode==='busy',last:[],argvOf:()=>({words:[],argv:[],why:null}),press:s=>{attempts.push(s);return false},stop:()=>false},now:()=>0,abort:()=>{}})
  stage.setRaw(true);await stage.refreshGate();stage.onAction({action:'approve',key:'y'});assert.deepEqual(attempts,[]);stage.onAction({action:'submit'})
  assert.deepEqual(attempts,mode==='declined'?['round go']:[]);assert.ok(stage.view().bottom)
  assert.equal(notes.at(-1),mode==='declined'?'未能启动执行，计划仍等你确认。':mode==='missing'?'执行入口不可用，计划仍等你确认。':'当前任务仍在运行，这批计划尚未开始执行。')
  assert.equal(notes.some(s=>s.startsWith('已确认执行')),false);stage.close()
 }
})
test('the entire choice remains readable at 16/40/80 columns; plain, NO_COLOR and headless floors remain exact',()=>{
 for(const columns of [16,40,80])for(const armed of [null,'approve','reject'] as const){
  const bottom=gateLayoutOf({face,view:{at:0,armed},columns:innerOf(columns)}),frame=frameOf({width:columns,height:24,snapshot:statusOf([]),bottom})
  const shown=frame.lines.flatMap((s,i)=>frame.roles[i]==='waiting'?[s.slice(1,-1).trim()]:[]).join('').replace(/\s/g,'')
  assert.equal(shown,optionRowOf({at:0,armed}).replace(/\s/g,''),'all physical action rows survive')
  const output=(theme:ReturnType<typeof themeOf>,tty=true)=>{const writes:string[]=[];const t=openTerm({out:{isTTY:tty,columns,rows:30,write:s=>writes.push(s)},term:'xterm',height:24,theme});t.draw(['FACT'],()=>({rows:frame.lines,roles:frame.roles}));t.close();return writes.join('')}
  assert.equal(output(themeOf({noStyle:true})),output(undefined));assert.equal(output(themeOf({noColor:'1'})),output(undefined));assert.equal(output(undefined,false),'FACT\n')
 }
})
