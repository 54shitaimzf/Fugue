import assert from 'node:assert/strict'
import {test} from 'node:test'
import {openStage} from './stage.ts'
import {openSession} from './follow.ts'
import {gateFaceOf,optionRowOf} from './gate.ts'
import {KEYMAP,keymapOf,decodeOf} from './keymap.ts'
import type {Keymap} from './keymap.ts'
import {innerOf} from './frame.ts'
import {widthOf} from './glyph.ts'
const face=gateFaceOf({round:'r1',fingerprint:'batch-keys',same:[],contracts:[1,2].map(n=>({id:`r1.implement.${n}`,agent:`agent/r1/${n}`,kind:'implement',goal:'修复登录失败提示',ownedPaths:[`src/login-${n}.ts`],seed:[],deliverables:[],assertions:[{name:'登录行为',action:'test'}]})) as never},{test:'node tools/test-entry.js'})
const custom=keymapOf({approve:'Alt-A',reject:'Alt-N',submit:'Alt-S',cancel:'Alt-E'})
assert.deepEqual(custom.problems,[])
async function rig(columns=40,map?:Keymap){
 let km=map;const presses:string[]=[],notes:string[]=[]
 const stage=openStage({...(map===undefined?{}:{keymap:()=>km!}),rows:()=>[],columns:()=>columns,termRows:()=>24,pendingFace:async()=>face,note:s=>notes.push(s),redraw:()=>{},hint:()=>'',run:()=>({running:false,last:[],argvOf:s=>({words:[s],argv:[s],why:null}),press:s=>{presses.push(s);return true},stop:()=>false}),now:()=>0,abort:()=>{}})
 stage.setRaw(true);await stage.refreshGate();const session=openSession({view:stage.view})
 const actions=()=>{const panel=session.panel({columns,height:stage.heightWant()});return panel.rows.filter((_,i)=>panel.roles?.[i]==='waiting').map(s=>s.slice(1,-1).trim()).join('').replace(/\s/g,'')}
 return {stage,presses,notes,actions,keys:(next:Keymap)=>{km=next},key:(bytes:string)=>{for(const d of decodeOf(bytes,km??KEYMAP))stage.onAction(d)}}
}
test('unarmed and armed confirmation face shows actual configured choices and second-step keys, including live map changes',async()=>{
 const r=await rig(40,custom)
 assert.equal(r.actions(),'Alt-A执行整批·Alt-N暂不执行·Alt-E收起');r.key('\x1ba');assert.deepEqual(r.presses,[])
 assert.equal(r.actions(),'再按Alt-A/Alt-S执行整批·Alt-E收起')
 const later=keymapOf({approve:'Alt-T',reject:'Alt-L',submit:'Alt-U',cancel:'Alt-J'});assert.deepEqual(later.problems,[])
 r.keys(later);assert.equal(r.actions(),'再按Alt-T/Alt-U执行整批·Alt-J收起')
 r.key('\x1bu');assert.deepEqual(r.presses,['round go']);r.stage.close()
})
test('configured rejection and hide still execute nothing; reopen clears the old choice and requires two fresh presses',async()=>{
 const r=await rig(40,custom);r.key('\x1bn');assert.deepEqual(r.presses,[]);assert.equal(r.actions(),'再按Alt-N/Alt-S暂不执行·Alt-E收起')
 r.key('\x1bs');assert.deepEqual(r.presses,[]);r.key('\x1ba');r.key('\x1be');assert.equal(r.stage.view().bottom,undefined)
 r.key('g');assert.deepEqual(r.presses,[]);assert.equal(r.actions(),'Alt-A执行整批·Alt-N暂不执行·Alt-E收起')
 r.key('\x1bs');assert.deepEqual(r.presses,[]);r.key('\x1ba');assert.deepEqual(r.presses,[]);r.key('\x1ba');assert.deepEqual(r.presses,['round go']);r.stage.close()
})
test('all configured confirmation actions survive the real frame at narrow widths; waiting coordinates cover every physical action row',async()=>{
 for(const columns of [16,24,40,80]){
  const r=await rig(columns,custom)
  for(const [bytes,expected] of [['','Alt-A执行整批·Alt-N暂不执行·Alt-E收起'],['\x1ba','再按Alt-A/Alt-S执行整批·Alt-E收起'],['\x1bn','再按Alt-N/Alt-S暂不执行·Alt-E收起']]){
   if(bytes)r.key(bytes);assert.equal(r.actions(),expected)
   const b=r.stage.view().bottom!;assert.ok(b.rows.every(row=>widthOf(row)<=innerOf(columns)));assert.equal(b.waitingAt!+b.waitingCount!,b.rows.length)
  }
  assert.deepEqual(r.presses,[]);r.stage.close()
 }
})
test('missing map and invalid overrides preserve exact default confirmation face and original optionRowOf bytes',async()=>{
 const absent=await rig(),normal=await rig(40,KEYMAP),bad=await rig(40,keymapOf({approve:'not-a-key',cancel:'not-a-key'}))
 for(const action of [null,'approve','reject'] as const){
  for(const one of [absent,normal,bad])if(action)one.stage.onAction({action})
  assert.deepEqual(absent.stage.view(),normal.stage.view());assert.deepEqual(absent.stage.view(),bad.stage.view())
  assert.equal(absent.actions(),optionRowOf({at:0,armed:action}).replace(/\s/g,''))
 }
 for(const one of [absent,normal,bad]){assert.deepEqual(one.presses,[]);one.stage.setRaw(false);assert.equal(one.stage.view().bottom,undefined);one.stage.close()}
})
