import assert from 'node:assert/strict'
import {test} from 'node:test'
import {openStage} from './stage.ts'
import {openSession} from './follow.ts'
import {gateFaceOf,optionRowOf} from './gate.ts'
import {KEYMAP,keymapOf,decodeOf,helpRowsOf,keyLabelOf} from './keymap.ts'
import type {Keymap} from './keymap.ts'
const face=gateFaceOf({round:'r1',fingerprint:'aliases',same:[],contracts:[1,2].map(n=>({id:`r1.implement.${n}`,agent:`agent/r1/${n}`,kind:'implement',goal:'修复登录失败提示',ownedPaths:[`src/login-${n}.ts`],seed:[],deliverables:[],assertions:[{name:'登录行为',action:'test'}]})) as never},{test:'node tools/test-entry.js'})
const aliases=keymapOf({approve:'Alt-A · Alt-H · Alt-T · Alt-X · Alt-O',reject:'Alt-N · Alt-L · Alt-I · Alt-V · Alt-P',submit:'Alt-S · Alt-M · Alt-U · Alt-W · Alt-Y',cancel:'Alt-E · Alt-J · Alt-K · Alt-D · Alt-C'})
assert.deepEqual(aliases.problems,[])
async function rig(columns:number,map:Keymap){
 const presses:string[]=[]
 const stage=openStage({keymap:()=>map,rows:()=>[],columns:()=>columns,termRows:()=>24,pendingFace:async()=>face,note:()=>{},redraw:()=>{},hint:()=>'',run:()=>({running:false,last:[],argvOf:s=>({words:[s],argv:[s],why:null}),press:s=>{presses.push(s);return true},stop:()=>false}),now:()=>0,abort:()=>{}})
 stage.setRaw(true);await stage.refreshGate();const session=openSession({view:stage.view})
 const panel=()=>session.panel({columns,height:stage.heightWant()})
 const choices=()=>{const p=panel();return p.rows.filter((_,i)=>p.roles?.[i]==='waiting').map(s=>s.slice(1,-1).trim()).join('').replace(/\s/g,'')}
 return {stage,presses,panel,choices,key:(bytes:string)=>{for(const d of decodeOf(bytes,map))stage.onAction(d)}}
}
test('many valid confirmation aliases keep every decision and the batch count visible in the narrow real frame',async()=>{
 for(const columns of [16,24,40,80]){
  const r=await rig(columns,aliases)
  for(const [bytes,expected] of [['','Alt-A执行整批·Alt-N暂不执行·Alt-E收起'],['\x1bx','再按Alt-A/Alt-S执行整批·Alt-E收起'],['\x1bv','再按Alt-N/Alt-S暂不执行·Alt-E收起']]){
   if(bytes)r.key(bytes)
   assert.ok(r.panel().rows.map(s=>s.slice(1,-1).trim()).join('').replace(/\s/g,'').includes('待确认2项任务'))
   assert.equal(r.choices(),expected)
  }
  assert.deepEqual(r.presses,[]);r.stage.close()
 }
})
test('all secondary aliases remain discoverable in help and work with the same fresh two-step confirmation',async()=>{
 for(const approve of ['a','h','t','x','o'])for(const submit of ['s','m','u','w','y']){
  const r=await rig(16,aliases);r.key('\x1b'+approve);assert.deepEqual(r.presses,[]);r.key('\x1b'+submit);assert.deepEqual(r.presses,['round go']);r.stage.close()
 }
 for(const reject of ['n','l','i','v','p'])for(const cancel of ['e','j','k','d','c']){
  const r=await rig(16,aliases);r.key('\x1b'+reject);r.key('\x1bm');assert.deepEqual(r.presses,[])
  r.key('\x1bx');r.key('\x1b'+cancel);assert.equal(r.stage.view().bottom,undefined);r.key('g');r.key('\x1bu');assert.deepEqual(r.presses,[]);r.stage.close()
 }
 const help=helpRowsOf(aliases)
 for(const action of ['approve','reject','submit','cancel']){const b=aliases.rows.find(b=>b.action===action)!;assert.ok(help.some(s=>s.startsWith(keyLabelOf(b)+'  ')));assert.equal(b.keys.length,5)}
})
test('single-key/default/bad override floors keep the exact previous option bytes; non-TTY still has no confirmation panel',async()=>{
 const single=keymapOf({approve:'Alt-A',reject:'Alt-N',submit:'Alt-S',cancel:'Alt-E'});assert.deepEqual(single.problems,[])
 for(const [armed,defaultText,customText] of [[null,'y 执行整批 · n 暂不执行 · Esc 收起','Alt-A 执行整批 · Alt-N 暂不执行 · Alt-E 收起'],['approve','再按 y / Enter 执行整批 · Esc 收起','再按 Alt-A / Alt-S 执行整批 · Alt-E 收起'],['reject','再按 n / Enter 暂不执行 · Esc 收起','再按 Alt-N / Alt-S 暂不执行 · Alt-E 收起']] as const){
  const view={at:0,armed};assert.equal(optionRowOf(view),defaultText);assert.equal(optionRowOf(view,KEYMAP),defaultText);assert.equal(optionRowOf(view,keymapOf({approve:'bad-key'})),defaultText);assert.equal(optionRowOf(view,single),customText)
 }
 const r=await rig(16,aliases);r.stage.setRaw(false);assert.equal(r.stage.view().bottom,undefined);assert.deepEqual(r.presses,[]);r.stage.close()
})
