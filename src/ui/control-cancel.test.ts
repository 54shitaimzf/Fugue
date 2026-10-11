import assert from 'node:assert/strict'
import { test } from 'node:test'
import { decoderOf, decodeOf, openKeys, KEYMAP, keymapOf, hintLineOf } from './keymap.ts'
import { openStage } from './stage.ts'
import { openSession } from './follow.ts'
import { openTerm } from './term.ts'
import { gateFaceOf } from './gate.ts'

const leads=['P',']','_','^','X']
const cancels=['\x18','\x1a']
const inserted=(actions:ReturnType<typeof decodeOf>)=>actions.filter(x=>x.action==='insert').map(x=>x.text).join('')

test('已取消的终端字符串立即恢复真实输入，分块、普通键和粘贴地板保持',()=>{
 let seams=0
 const km=keymapOf({undo:'Ctrl-Z'})
 for(const lead of leads)for(const cancel of cancels){
  const report='\x1b'+lead+'reply y\r\x03'+cancel
  const input='继续输入'
  assert.equal(inserted(decodeOf(report+input,km)),input)
  for(let at=0;at<=report.length+input.length;at++){
   const controls:string[]=[],d=decoderOf(km,s=>controls.push(s)),all=report+input
   const actions=[...d.feed(all.slice(0,at)),...d.feed(all.slice(at))]
   assert.equal(inserted(actions),input);assert.ok(actions.every(x=>x.action==='insert'))
   assert.deepEqual(controls,[report]);assert.equal(d.pending,'');assert.deepEqual(d.flush(),[]);seams++
  }
  const laterEnd=report+input+'\x1b\\'
  assert.equal(inserted(decoderOf(km).feed(laterEnd)),input,'取消早于ST，后续文字不可再吞入回报')
  const terminated='\x1b'+lead+'ok\x1b\\'
  assert.equal(decoderOf(km).feed(terminated+'\x1a')[0]!.action,'undo','ST早于取消，后续Ctrl-Z仍是键')
  if(lead===']')assert.equal(decoderOf(km).feed('\x1b]ok\x07\x1a')[0]!.action,'undo','OSC的BEL终止优先')
  const literal=report+input,d=decoderOf(km)
  assert.deepEqual(d.feed('\x1b[200~'+literal+'\x1b[201~'),[{action:'insert',text:literal}])
 }
 assert.equal(decoderOf(km).feed('\x1a')[0]!.action,'undo','字符串之外仍是实际配置的按键')
 const ordinary=decoderOf();ordinary.feed('\x1bPpartial');assert.deepEqual(ordinary.flush(),[])
 assert.equal(inserted(ordinary.feed('继续')),'继续','缺取消标记仍沿用原超时与输入地板')
 console.log(`cancelled control strings: variants=10; seams=${seams}; immediate input exact; cancelled payload actions0; paste literal; ordinary Ctrl-Z retained`)
})

test('raw取消回报不修改完整确认和草稿，取消后实际y/Enter仍需两段点头',async()=>{
 const face=gateFaceOf({round:'r1',fingerprint:'cancel-control',same:[],contracts:[{id:'r1.implement.1',agent:'agent/r1/1',kind:'implement',goal:'修复登录提示',ownedPaths:['src/login.ts'],seed:[],deliverables:[],assertions:[{name:'登录行为',action:'test'}]}]} as never,{test:'node tools/test-entry.js'})
 const presses:string[]=[],writes:string[]=[],controls:string[]=[],actions:string[]=[],scheduled:{active:boolean;fire:()=>void}[]=[]
 let batch=0,sink:(chunk:string|Uint8Array)=>void=()=>{},draw=()=>{}
 const stage=openStage({rows:()=>[],columns:()=>120,termRows:()=>40,pendingFace:async()=>({...face,fingerprint:'cancel-control-'+batch++}),note:()=>{},redraw:()=>draw(),hint:w=>hintLineOf(KEYMAP,3,w),now:()=>0,abort:()=>{},
  run:()=>({running:false,last:[],argvOf:()=>({words:[],argv:[],why:null}),press:s=>{presses.push(s);return true},stop:()=>false})})
 const session=openSession({view:stage.view}),term=openTerm({term:'xterm',heightOf:stage.heightWant,out:{isTTY:true,columns:120,rows:40,write:s=>writes.push(s)}})
 draw=()=>term.draw([],size=>session.panel(size))
 const keys=openKeys({input:{isTTY:true,setRawMode:()=>{},on:(_,fn)=>{sink=fn},removeListener:()=>{}},onAction:d=>{actions.push(d.action);stage.onAction(d)},onControl:s=>controls.push(s),wait:(_,fn)=>{const t={active:true,fire:fn};scheduled.push(t);return()=>{t.active=false}}})
 try{
  stage.setRaw(keys.raw);sink(Buffer.from('保留草稿'));const draft=stage.view().input
  for(const lead of leads)for(const cancel of cancels){
   await stage.refreshGate();draw();const before=stage.view().bottom;writes.length=0;actions.length=0
   const report='\x1b'+lead+'reply y\r\x03'+cancel
   for(const byte of Buffer.from(report))sink(Uint8Array.of(byte))
   draw();assert.deepEqual(stage.view().bottom,before);assert.deepEqual(presses,[]);assert.deepEqual(actions,[]);assert.equal(writes.join(''),'')
   assert.ok(scheduled.every(t=>!t.active),'完整取消消息没有待处理Esc')
   stage.onAction({action:'cancel'});assert.deepEqual(stage.view().input,draft)
  }
  await stage.refreshGate();sink('\x1bPpartial\x18y');assert.deepEqual(presses,[],'第一段实际点头不能执行')
  sink('\r');assert.deepEqual(presses,['round go'],'取消后第二段实际确认执行一次')
  assert.equal(controls.length,11)
  console.log('raw cancel sequence: reports10; redrawBytes0; draft exact; pendingTimers0; embedded approval/interrupt actions0; actual second confirmation1')
 }finally{stage.close();term.close();keys.close()}
})
