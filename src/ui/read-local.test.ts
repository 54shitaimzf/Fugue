import assert from 'node:assert/strict'
import {test} from 'node:test'
import {openStage} from './stage.ts'
import {openSession} from './follow.ts'
import {KEYMAP,keymapOf,hintLineOf,hintLimitOf,hintKeysOf,hintPicksOf} from './keymap.ts'
import {gateFaceOf} from './gate.ts'
import {widthOf} from './glyph.ts'
import type {StatusRow} from '../probe/status.ts'
const rows=[{pos:{writer:'agent/r1/1',seq:1},e:{t:'view/write',agent:'agent/r1/1',path:'design.png',rev:1,blob:'a'.repeat(40),mode:0o100644}}] as unknown as StatusRow[]
const face=gateFaceOf({round:'r1',fingerprint:'batch',same:[],contracts:[{id:'r1.implement.1',agent:'agent/r1/1',kind:'implement',goal:'修复登录提示',ownedPaths:['src/login.ts'],seed:[],deliverables:[],assertions:[]}]} as never)
function rig(pending:typeof face|null=null,columns=40,custom=false){
 const notes:string[]=[],presses:string[]=[],km=custom?keymapOf({cancel:'Alt-E',read:'Ctrl-T',complete:'Alt-V'}):KEYMAP;let redraws=0,legacyCalls=0
 const stage=openStage({rows:()=>rows,columns:()=>columns,termRows:()=>24,pendingFace:async()=>pending,note:s=>notes.push(s),redraw:()=>{redraws++},hint:w=>hintLineOf(km,hintLimitOf(columns,km,w),w),keysOf:w=>{legacyCalls++;return hintKeysOf(km,w)},run:()=>({running:false,last:[],argvOf:()=>({words:[],argv:[],why:null}),press:s=>{presses.push(s);return true},stop:()=>false}),now:()=>0,abort:()=>{}})
 stage.setRaw(true);stage.onAdvance(rows);const session=openSession({view:stage.view})
 return {stage,notes,presses,km,redraws:()=>redraws,legacyCalls:()=>legacyCalls,frame:()=>session.panel({columns,height:stage.heightWant()})}
}
test('opening and cycling log reading redraws once per action; current titles and configured keys stay on the face, with zero permanent instructions',()=>{
 const r=rig(null,80,true),before=r.redraws();r.stage.onAction({action:'read'})
 assert.deepEqual(r.notes,[]);assert.equal(r.legacyCalls(),0);assert.equal(r.redraws()-before,1)
 assert.ok(r.frame().rows.join(' ').includes('文件改动'));assert.match(r.stage.view().hint??'',/Alt-V 换一面/)
 const titles:string[]=[]
 for(let n=0;n<4;n++){const at=r.redraws();r.stage.onAction({action:'complete'});assert.equal(r.redraws()-at,1);titles.push(r.stage.view().read!.rows.join(' '));assert.deepEqual(r.notes,[])}
 assert.ok(titles.some(s=>s.includes('事件流')));assert.ok(titles.some(s=>s.includes('详情')));assert.ok(titles.some(s=>s.includes('文件改动')));assert.deepEqual(r.presses,[])
 r.stage.onAction({action:'cancel'});assert.equal(r.stage.view().read,undefined);assert.deepEqual(r.notes,[]);r.stage.close()
})
test('full-plan open and return keep their content and do not add history; narrow return is visible and follows the same configured cancel key',async()=>{
 for(const custom of [false,true]){
  const r=rig(face,16,custom);await r.stage.refreshGate();const original=[...r.notes],before=r.redraws();r.stage.onAction({action:'read'})
  assert.deepEqual(r.notes,original);assert.equal(r.legacyCalls(),0);assert.equal(r.redraws()-before,1)
  const hint=r.stage.view().hint!;assert.equal(hint,custom?'按键 Alt-E 返回':'按键 Esc 返回');assert.ok(widthOf(hint)<=16)
  assert.ok(r.frame().rows.some(s=>s.includes('计划全文')));assert.ok(r.stage.view().read!.rows.join('').includes('修复登录提示'))
  r.stage.onAction({action:'historyNewer'});r.stage.onAction({action:'cancel'});assert.equal(r.stage.view().read,undefined);assert.ok(r.stage.view().bottom);assert.deepEqual(r.notes,original);assert.deepEqual(r.presses,[]);r.stage.close()
 }
 assert.deepEqual(hintPicksOf(KEYMAP,'plan').map(b=>b.action),['cancel','historyNewer','historyOlder','pageDown','read'],'readonly hint contains only current actions')
})
