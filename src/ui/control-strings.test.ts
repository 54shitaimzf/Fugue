import assert from 'node:assert/strict'
import { test } from 'node:test'
import { decoderOf, decodeOf, openKeys, KEYMAP, keymapOf, hintLineOf } from './keymap.ts'
import { openStage } from './stage.ts'
import { openSession } from './follow.ts'
import { openTerm } from './term.ts'
import { gateFaceOf } from './gate.ts'

const ST='\x1b\\'
const payload='0+Rreply y\n\x03\x10\x1b[200~embedded\x1b[201~end'
const reports=['P','_',']','^','X'].map(c=>'\x1b'+c+payload+ST).concat('\x1b]52;title\x07')
const text=(actions:ReturnType<typeof decodeOf>)=>actions.filter(d=>d.action==='insert').map(d=>d.text).join('')

test('终端字符串回报按完整消息隔离，所有分块边界与粘贴标记都不能生成用户动作',()=>{
 let seams=0
 for(const report of reports){
  assert.deepEqual(decodeOf(report),[],'完整回报不是按键或草稿')
  for(let at=0;at<=report.length;at++){
   const controls:string[]=[],d=decoderOf(KEYMAP,s=>controls.push(s))
   assert.deepEqual([...d.feed(report.slice(0,at)),...d.feed(report.slice(at)),...d.flush()],[])
   assert.deepEqual(controls,[report]);assert.equal(d.pending,'');assert.equal(d.pasting,false);seams++
  }
  const controls:string[]=[],d=decoderOf(KEYMAP,s=>controls.push(s));const actions=d.feed('前文'+report+'后文')
  assert.equal(text(actions),'前文后文');assert.ok(actions.every(a=>a.action==='insert'));assert.deepEqual(controls,[report])
 }
 console.log(`control strings: reports=${reports.length}; splitSeams=${seams}; actions0; controls once; embedded paste ignored`)
})
test('半截回报超时不变成Esc，普通键与用户实际粘贴保持',()=>{
 for(const lead of ['P','_',']','^','X']){
  const d=decoderOf();assert.deepEqual(d.feed('\x1b'+lead+'0+Rpartial y\n'),[])
  assert.notEqual(d.pending,'');assert.deepEqual(d.flush(),[],'半截系统回报不能收起确认');assert.equal(d.pending,'')
  assert.equal(text(d.feed('继续')),'继续')
 }
 const km=keymapOf({approve:'Alt-P'});assert.equal(km.problems.length,0)
 assert.equal(decodeOf('\x1bp',km)[0]!.action,'approve');assert.equal(decoderOf(km).feed('\x1bp')[0]!.action,'approve')
 assert.equal(decodeOf('\x1bP',km)[0]!.action,'approve');const alt=decoderOf(km);assert.deepEqual(alt.feed('\x1bP'),[]);assert.equal(alt.flush()[0]!.action,'approve')
 assert.deepEqual(decoderOf().feed('\x1bOA'),[]);assert.equal(decoderOf().feed('\x1b[A')[0]!.action,'historyOlder');const esc=decoderOf();esc.feed('\x1b');assert.equal(esc.flush()[0]!.action,'cancel')
 const safe=reports.at(-1)!;const d=decoderOf();assert.deepEqual(d.feed('\x1b[200~'+safe+'\x1b[201~'),[{action:'insert',text:safe}])
 console.log('control string fallback: incomplete flush actions0; ordinary input/Alt-P/SS3/Esc and literal OSC paste retained')
})
test('raw回报的多帧序列保持确认、草稿与静止输出；实际点头仍执行一次',async()=>{
 const face=(fingerprint:string)=>gateFaceOf({round:'r1',fingerprint,same:[],contracts:[{id:'r1.implement.1',agent:'agent/r1/1',kind:'implement',goal:'修复登录提示',ownedPaths:['src/login.ts'],seed:[],deliverables:[],assertions:[{name:'登录行为',action:'test'}]}]} as never,{test:'node tools/test-entry.js'})
 let batch='control';const writes:string[]=[],presses:string[]=[],controls:string[]=[],timers:(()=>void)[]=[];let sink:(chunk:string)=>void=()=>{},draw=()=>{}
 const stage=openStage({rows:()=>[],columns:()=>120,termRows:()=>40,pendingFace:async()=>face(batch),note:()=>{},redraw:()=>draw(),hint:w=>hintLineOf(KEYMAP,3,w),now:()=>0,abort:()=>{},
  run:()=>({running:false,last:[],argvOf:()=>({words:[],argv:[],why:null}),press:s=>{presses.push(s);return true},stop:()=>false})})
 const session=openSession({view:stage.view}),term=openTerm({term:'xterm',heightOf:stage.heightWant,out:{isTTY:true,columns:120,rows:40,write:s=>writes.push(s)}})
 draw=()=>term.draw([],size=>session.panel(size))
 const keys=openKeys({input:{isTTY:true,setRawMode:()=>{},on:(_,fn)=>{sink=fn},removeListener:()=>{}},onAction:stage.onAction,onControl:s=>controls.push(s),wait:(_,fn)=>{timers.push(fn);return()=>{}}})
 try{
  stage.setRaw(keys.raw);stage.onAction({action:'insert',text:'保留草稿'});const draft=stage.view().input
  await stage.refreshGate();draw();const bottom=stage.view().bottom;writes.length=0
  for(const report of reports){for(const ch of report)sink(ch);draw();assert.deepEqual(stage.view().bottom,bottom)}
  sink('\x1bP0+Rhalf y\n');timers.at(-1)!();draw();assert.deepEqual(stage.view().bottom,bottom)
  assert.equal(writes.join(''),'');assert.deepEqual(presses,[]);assert.deepEqual(controls,reports)
  stage.onAction({action:'cancel'});assert.deepEqual(stage.view().input,draft)
  batch='control-next';await stage.refreshGate();stage.onAction({action:'approve'});assert.deepEqual(presses,[]);stage.onAction({action:'submit'});assert.deepEqual(presses,['round go'])
  console.log('raw control sequence: draft kept; approval kept; report redrawBytes0; readonly/hidden press0; fresh second confirmation1')
 }finally{stage.close();term.close();keys.close()}
})
