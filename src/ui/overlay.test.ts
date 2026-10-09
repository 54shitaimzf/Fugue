import assert from 'node:assert/strict'
import { test } from 'node:test'
import { openStage } from './stage.ts'
import { gateFaceOf, lineOf } from './gate.ts'
import { KEYMAP, HINT_WHEN, hintLineOf, hintPicksOf, keymapOf, hintWhenOf } from './keymap.ts'
import type { Contract } from '../contract/types.ts'
import type { StatusRow } from '../probe/status.ts'
import type { RunLauncher } from './run.ts'

function rig(withGate=true){
  const contracts=[1,2].map(i=>({id:`r1.implement.${i}`,agent:`agent/r1/${i}`,kind:'implement',goal:`调整第 ${i} 处标题`,ownedPaths:[`src/title-${i}.ts`],assertions:[],deliverables:[],seed:[]} as unknown as Contract))
  const face=gateFaceOf({round:'r1',fingerprint:'same-batch',same:[],contracts},{})
  const rows=[{pos:{writer:'agent/r1/1',seq:1},e:{t:'view/write',agent:'agent/r1/1',path:'result.txt',blob:'a'.repeat(40),rev:1,mode:0o100644}}] as unknown as StatusRow[]
  const presses:string[]=[],notes:string[]=[],whens:string[]=[]
  const go:RunLauncher={running:false,last:[],press:(s)=>{presses.push(s);return true},stop:()=>false,argvOf:s=>({words:[],argv:['fugue',s],why:null})}
  const stage=openStage({note:s=>notes.push(s),redraw:()=>{},hint:w=>{whens.push(w);return hintLineOf(KEYMAP,3,w)},keysOf:()=>'',columns:()=>40,termRows:()=>24,rows:()=>rows,pendingFace:async()=>withGate?face:null,run:()=>go,now:()=>0,abort:()=>{}})
  stage.setRaw(true);stage.onAdvance(rows)
  return {stage,presses,notes,whens}
}

test('hidden approval can be reopened without a process or inherited confirmation',async()=>{
  const r=rig();await r.stage.refreshGate()
  r.stage.onAction({action:'historyNewer'});r.stage.onAction({action:'approve',key:'y'})
  r.stage.onAction({action:'cancel',key:'Esc'})
  assert.equal(r.stage.view().bottom,undefined)
  assert.ok(r.stage.view().hint?.startsWith('按键 g/G 查看确认'),'hidden waiting batch exposes its reentry before other keys')
  await r.stage.refreshGate();assert.equal(r.stage.view().bottom,undefined,'repeated source refresh does not undo Esc')
  r.stage.onAction({action:'go',key:'g'})
  assert.equal(r.presses.length,0,'viewing approval must not run round go')
  const reopened=r.stage.view().bottom!.rows.join('\n')
  assert.ok(reopened.includes('第 2'));assert.ok(reopened.includes('src/title-2.ts'))
  assert.ok(!reopened.includes('再按 y'),'Esc cleared the old arm before reentry')
  r.stage.onAction({action:'submit'});assert.equal(r.presses.length,0)
  r.stage.onAction({action:'approve',key:'y'});assert.equal(r.presses.length,0)
  r.stage.onAction({action:'submit'});assert.deepEqual(r.presses,[lineOf('approve')])
  assert.equal(r.notes.filter(s=>s.includes('这一轮打算开')).length,1,'reentry never repeats the batch history')
  r.stage.close()
  console.log('hide→g: batch restored at card 2, process=0, old arm=0, history duplicate=0; y→Enter process=1')
})

test('g focuses an existing approval while preserving the direct command floor outside approval',async()=>{
  const r=rig();await r.stage.refreshGate();r.stage.onAction({action:'approve',key:'y'});r.stage.onAction({action:'read'});r.stage.onAction({action:'panel'})
  r.stage.onAction({action:'go',key:'g'})
  assert.equal(r.presses.length,0);assert.equal(r.stage.view().read,undefined);assert.equal(r.stage.view().menu,undefined)
  assert.ok(r.stage.view().bottom);r.stage.onAction({action:'submit'});assert.equal(r.presses.length,0,'g focus clears an earlier arm');r.stage.close()
  const plain=rig(false);plain.stage.onAction({action:'go',key:'g'});assert.deepEqual(plain.presses,[lineOf('approve')])
  plain.stage.onAction({action:'insert',text:'hello',key:'h'});plain.stage.onAction({action:'go',key:'g'})
  assert.equal(plain.presses.length,1);assert.ok(plain.stage.view().input?.rows.join('').includes('hellog'))
  plain.stage.close()
})

test('Esc closes the visible menu first and returns to the same reading position',()=>{
  const r=rig(false);r.stage.onAction({action:'read'});r.stage.onAction({action:'historyNewer'})
  const reading=r.stage.view().read
  r.stage.onAction({action:'panel'});assert.ok(r.stage.view().menu)
  r.stage.onAction({action:'cancel',key:'Esc'})
  assert.equal(r.stage.view().menu,undefined);assert.deepEqual(r.stage.view().read,reading)
  r.stage.onAction({action:'cancel',key:'Esc'});assert.equal(r.stage.view().read,undefined)
  assert.equal(r.presses.length,0);r.stage.close()
  console.log('menu over read: Esc1 menu=0/read=same; Esc2 read=0; processes=0')
})

test('hidden-waiting hint follows configured keys and keeps the same complete binding set',()=>{
  assert.equal(hintWhenOf({gate:false,read:false,pending:true}),'pending')
  assert.equal(hintWhenOf({gate:false,read:true,pending:true}),'read')
  assert.deepEqual(HINT_WHEN.pending.slice(0,1),['go'])
  assert.deepEqual(hintPicksOf(KEYMAP,'pending').map(b=>b.action).sort(),hintPicksOf(KEYMAP,'any').map(b=>b.action).sort())
  const custom=keymapOf({go:'Ctrl-G'})
  assert.ok(hintLineOf(custom,1,'pending').startsWith('按键 Ctrl-G 查看确认'))
  console.log('pending hint first=go; configured key=Ctrl-G; hidden bindings lost=0')
})
