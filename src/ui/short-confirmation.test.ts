import assert from 'node:assert/strict'
import {test} from 'node:test'
import {openStage} from './stage.ts'
import {openSession} from './follow.ts'
import {openTerm} from './term.ts'
import {gateFaceOf,gateLayoutOf} from './gate.ts'
import {KEYMAP,keymapOf,decodeOf} from './keymap.ts'
import {innerOf} from './frame.ts'
import {widthOf} from './glyph.ts'
const face=gateFaceOf({round:'r1',fingerprint:'short-confirmation',same:[],contracts:[1,2].map(n=>({id:`r1.implement.${n}`,agent:`agent/r1/${n}`,kind:'implement',goal:'修复登录失败提示',ownedPaths:[`src/login-${n}.ts`],seed:[],deliverables:[],assertions:[{name:'登录行为',action:'test'}]})) as never},{test:'node tools/test-entry.js'})
const custom=keymapOf({approve:'Alt-A',reject:'Alt-N',submit:'Alt-S',cancel:'Alt-E',read:'Alt-Q'});assert.deepEqual(custom.problems,[])
async function rig(map=custom,columns=16,rows=8){
 let width=columns,height:number|undefined=rows,lastSize={columns,height:1};const presses:string[]=[],notes:string[]=[],writes:string[]=[]
 const stage=openStage({keymap:()=>map,rows:()=>[],columns:()=>width,termRows:()=>height,pendingFace:async()=>face,note:s=>notes.push(s),redraw:()=>{},hint:()=>'',run:()=>({running:false,last:[],argvOf:s=>({words:[s],argv:[s],why:null}),press:s=>{presses.push(s);return true},stop:()=>false}),now:()=>0,abort:()=>{}})
 stage.setRaw(true);await stage.refreshGate();const session=openSession({view:stage.view}),term=openTerm({out:{isTTY:true,get columns(){return width},get rows(){return height},write:s=>writes.push(s)},term:'xterm',heightOf:stage.heightWant})
 const draw=()=>{term.draw([],size=>{lastSize=size;return session.panel(size)});return session.panel(lastSize)}
 const plain=()=>{const p=draw();return p.rows.filter((_,i)=>p.roles?.[i]!=='border').map(s=>s.slice(1,-1).trim()).join('').replace(/\s/g,'')}
 return {stage,presses,notes,writes,plain,draw,measure:(w:number,h:number|undefined)=>{width=w;height=h},size:(w:number,h:number|undefined)=>{width=w;height=h;stage.onResize()},key:(bytes:string)=>{for(const d of decodeOf(bytes,map))stage.onAction(d)},close:()=>{stage.close();term.close()}}
}
test('short confirmation shows complete size instruction, pending count and actual read key instead of an incomplete decision face',async()=>{
 const r=await rig();assert.equal(r.plain(),'放大才能确认待确认2项Alt-Q看全')
 for(const bytes of ['\x1ba','\x1ba','\x1bs','\x1bn','\x1bn','\x1bs'])r.key(bytes)
 assert.deepEqual(r.presses,[]);assert.deepEqual(r.notes.filter(s=>!s.startsWith('这一轮打算开')),[])
 const p=r.draw();assert.equal(p.rows.filter((_,i)=>p.roles?.[i]==='waiting').map(s=>s.slice(1,-1).trim()).join(''),'放大才能确认')
 assert.equal(r.plain(),'放大才能确认待确认2项Alt-Q看全');r.key('\x1be');assert.equal(r.stage.view().bottom,undefined);r.close()
})
test('shrinking clears an armed decision; restoring height or width requires a fresh two-step approval',async()=>{
 for(const [initialWidth,initialRows,smallWidth,smallRows] of [[16,24,16,8],[40,8,16,8]]){
  const r=await rig(custom,initialWidth,initialRows);r.key('\x1ba');assert.ok(r.plain().includes('再按Alt-A/Alt-S执行整批'))
  r.size(smallWidth,smallRows);assert.equal(r.plain(),'放大才能确认待确认2项Alt-Q看全');assert.deepEqual(r.presses,[])
  r.size(initialWidth,initialRows);r.key('\x1bs');assert.deepEqual(r.presses,[]);assert.ok(r.plain().includes('Alt-A执行整批·Alt-N暂不执行'))
  r.key('\x1ba');assert.deepEqual(r.presses,[]);r.key('\x1bs');assert.deepEqual(r.presses,['round go']);r.close()
 }
})
test('small confirmation still permits full read/return and manual commands after hiding, with no stale approval',async()=>{
 const r=await rig();r.key('\x1bq');assert.equal(r.stage.view().bottom,undefined);assert.ok(r.stage.view().read?.rows.some(s=>s.includes('计划全文')))
 r.key('\x1ba');r.key('\x1bs');assert.deepEqual(r.presses,[]);r.key('\x1be');assert.equal(r.plain(),'放大才能确认待确认2项Alt-Q看全')
 r.key('\x1be');r.key('/status');r.key('\x1be');assert.equal(r.stage.view().menu,undefined);r.key('\x1bs');assert.deepEqual(r.presses,['/status']);r.close()
})
test('height omission/invalid metadata/fitting geometry retain the exact existing pure layout and raw-off floor',async()=>{
 for(const armed of [null,'approve','reject'] as const){
  const o={face,view:{at:0,armed},columns:innerOf(16),keymap:custom},old=gateLayoutOf(o)
  for(const height of [undefined,NaN,0,-1,Infinity,40])assert.deepEqual(gateLayoutOf({...o,height}),old)
  const small=gateLayoutOf({...o,height:7});assert.equal(small.blocked,true);assert.ok(small.rows.every(s=>widthOf(s)<=innerOf(16)));assert.equal(small.rows.join('').replace(/\s/g,''),'放大才能确认待确认2项Alt-Q看全')
 }
 const r=await rig(KEYMAP,40,24);r.stage.setRaw(false);assert.equal(r.stage.view().bottom,undefined);r.close()
})
test('a key arriving after geometry changed but before the resize callback cannot confirm a hidden old choice',async()=>{
 const r=await rig(custom,16,24);r.key('\x1ba');r.measure(16,8);r.key('\x1bs');assert.deepEqual(r.presses,[])
 r.measure(16,24);r.key('\x1bs');assert.deepEqual(r.presses,[]);r.key('\x1ba');r.key('\x1bs');assert.deepEqual(r.presses,['round go']);r.close()
})
test('capacity covers both confirmation phases even when only the second-step key is very long',()=>{
 const map=keymapOf({submit:'Alt-Alt-Alt-Alt-Enter'});assert.deepEqual(map.problems,[])
 for(const columns of [12,20,36])for(let height=5;height<=25;height++){
  const states=[null,'approve','reject'].map(armed=>gateLayoutOf({face,view:{at:0,armed:armed as 'approve'|'reject'|null},columns,height,keymap:map}))
  assert.equal(states[0].blocked,states[1].blocked);assert.equal(states[0].blocked,states[2].blocked)
 }
})
