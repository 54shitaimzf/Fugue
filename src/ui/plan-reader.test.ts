import assert from 'node:assert/strict'
import {test} from 'node:test'
import {openStage} from './stage.ts'
import {openSession} from './follow.ts'
import {gateFaceOf,gateLayoutOf} from './gate.ts'
import {frameOf,innerOf} from './frame.ts'
import {statusOf} from '../probe/status.ts'
import {KEYMAP,hintLineOf,hintLimitOf,hintPicksOf,keymapOf} from './keymap.ts'
import {widthOf} from './glyph.ts'
import type {Contract} from '../contract/types.ts'
const face=gateFaceOf({round:'r1',fingerprint:'one',same:[],contracts:[1,2].map(n=>({id:`r1.implement.${n}`,agent:`agent/r1/${n}`,kind:'implement',goal:`修复第${n}项登录失败提示`+'并明确下一步'.repeat(12),ownedPaths:[`src/login-${n}.ts`,`test/login-${n}.test.ts`],seed:[],deliverables:[],assertions:[{name:'登录行为',action:'test'}]})) as Contract[]},{test:'node tools/test-entry.js'})
function rig(columns=16){
 let pending:typeof face|null=face,calls=0;const notes:string[]=[],presses:string[]=[]
 const stage=openStage({rows:()=>[],columns:()=>columns,termRows:()=>24,pendingFace:async()=>{calls++;return pending},note:s=>notes.push(s),redraw:()=>{},hint:w=>hintLineOf(KEYMAP,hintLimitOf(columns,KEYMAP,w),w),keysOf:w=>hintLineOf(KEYMAP,4,w),run:()=>({running:false,last:[],argvOf:()=>({words:[],argv:[],why:null}),press:s=>{presses.push(s);return true},stop:()=>false}),now:()=>0,abort:()=>{}})
 stage.setRaw(true);const session=openSession({view:stage.view})
 return {stage,session,notes,presses,calls:()=>calls,pending:(value:typeof face|null)=>{pending=value},frame:()=>session.panel({columns,height:stage.heightWant()})}
}
test('a narrow confirmation first reveals the configured full-plan reader while retaining every item-navigation binding',()=>{
 assert.deepEqual(hintPicksOf(KEYMAP,'gate').slice(0,3).map(b=>b.action),['read','historyOlder','historyNewer'])
 assert.equal(hintLineOf(KEYMAP,hintLimitOf(16,KEYMAP,'gate'),'gate'),'按键 Ctrl-R 看全')
 const custom=keymapOf({read:'Ctrl-T'});assert.equal(hintLineOf(custom,hintLimitOf(16,custom,'gate'),'gate'),'按键 Ctrl-T 看全')
 assert.deepEqual(hintPicksOf(KEYMAP,'gate').map(b=>b.action),['read','historyOlder','historyNewer'])
 assert.equal(hintLineOf(KEYMAP,2,'plan'),'按键 Esc 返回 · ↓ 下一行')
})
test('full plan uses the actual selected card, every physical row is reachable, and reading never launches or refetches it',async()=>{
 for(const width of [16,40,80]){
  const r=rig(width);await r.stage.refreshGate();const layout=r.stage.view().bottom!;if(layout.rows.length>r.stage.heightWant()-4)assert.ok(r.frame().rows.some(line=>line.includes('计划有省略')),'actual cropped geometry must disclose omitted plan');else assert.ok(r.frame().roles!.includes('waiting'),'expanded geometry still retains actions');r.stage.onAction({action:'historyNewer'});r.stage.onAction({action:'read'})
  const reading=r.stage.view().read;assert.ok(reading,'the current plan has a complete reader even before any contract/issue event')
  assert.equal(r.stage.view().bottom,undefined,'plan reading gets the body budget without a duplicate confirmation card')
  const text=[reading.heading,...reading.rows].join('').replace(/\s/g,'');for(const phrase of ['计划全文','当前2/2','修复第2项登录失败提示','src/login-2.ts','test/login-2.test.ts','node tools/test-entry.js'])assert.ok(text.includes(phrase.replace(/\s/g,'')),phrase)
  const seen=new Set<string>()
  for(let n=0;n<=reading.rows.length;n++){
   const f=r.frame();assert.ok(f.rows.every(line=>widthOf(line)<=width),'native frame rows never exceed actual width')
   f.rows.forEach((line,i)=>{if(f.roles?.[i]==='read')seen.add(line.slice(1,-1).trim())})
   r.stage.onAction({action:'historyNewer'})
  }
  for(const line of reading.rows)assert.ok(seen.has(line.trim()),`every full physical plan row is reachable: ${line}`)
  assert.deepEqual(r.presses,[]);assert.equal(r.calls(),1,'opening/scrolling read the existing face, not a new backend source')
  r.stage.onAction({action:'cancel'});assert.equal(r.stage.view().read,undefined)
  assert.ok(r.stage.view().bottom!.rows.join(' ').includes('当前 2/2'),'Esc returns to the same selected confirmation')
  r.stage.close()
 }
})
test('opening the plan clears an earlier arm, menu escape retains reading position, refresh cannot leave stale plan text',async()=>{
 const r=rig(40);await r.stage.refreshGate();r.stage.onAction({action:'approve',key:'y'});r.stage.onAction({action:'read'});r.stage.onAction({action:'submit'});assert.deepEqual(r.presses,[],'read mode cannot carry approval or execute a queue')
 r.stage.onAction({action:'approve',key:'y'});r.stage.onAction({action:'submit'});r.stage.onAction({action:'reject',key:'n'});r.stage.onAction({action:'submit'});assert.deepEqual(r.presses,[],'approval and rejection are inert in the read-only plan')
 r.stage.onAction({action:'panel'});assert.ok(r.frame().roles!.includes('overlay'),'a full reader reserves visible room for its top menu');r.stage.onAction({action:'cancel'})
 r.stage.onAction({action:'pageDown'});const before=r.stage.view().read;assert.ok(before!.top>0)
 r.stage.onAction({action:'panel'});assert.ok(r.frame().roles!.includes('overlay'),'the help menu physically appears above the existing read position')
 r.stage.onAction({action:'historyNewer'});assert.equal(r.stage.view().menu!.sel,1);assert.deepEqual(r.stage.view().read,before,'navigation moves the top menu, not its background reader')
 r.stage.onAction({action:'pageDown'});assert.ok(r.stage.view().menu!.sel>1);assert.deepEqual(r.stage.view().read,before)
 r.stage.onAction({action:'cancel'});assert.deepEqual(r.stage.view().read,before,'Esc closes only the overlaid menu')
 r.stage.onAction({action:'read'});assert.equal(r.stage.view().read,undefined);r.stage.onAction({action:'submit'});assert.deepEqual(r.presses,[],'returning still requires a fresh first action')
 r.stage.onAction({action:'approve',key:'y'});r.stage.onAction({action:'submit'});assert.deepEqual(r.presses,['round go'])
 r.stage.onAction({action:'read'});r.pending(null);await r.stage.refreshGate();assert.equal(r.stage.view().read,undefined,'a replaced pending face invalidates its reading coordinates')
 assert.equal(r.notes.filter(s=>s.includes('这一轮打算开')).length,1);r.stage.close()
 const plain=rig();plain.pending(null);await plain.stage.refreshGate();plain.stage.onAction({action:'read'});assert.ok(plain.stage.view().read!.heading==='事件流','no pending card keeps the existing log reader');const log=plain.stage.view().read;plain.stage.onAction({action:'panel'});plain.stage.onAction({action:'historyNewer'});assert.equal(plain.stage.view().menu!.sel,1);assert.deepEqual(plain.stage.view().read,log,'log reading shares the same top-menu priority');plain.stage.onAction({action:'cancel'});assert.deepEqual(plain.stage.view().read,log);plain.stage.close()
})
test('a truncated card reports its own omission while preserving all batch and action rows; missing disclosure keeps the old layout',()=>{
 for(const width of [16,40])for(const armed of [null,'approve','reject'] as const){
  const bottom=gateLayoutOf({face,view:{at:0,armed},columns:innerOf(width)}),frame=frameOf({snapshot:statusOf([]),width,height:13,bottom})
  assert.ok(frame.lines.some(l=>l.includes('计划有省略')),'the omitted plan does not silently turn into only its tail paths')
  assert.ok(frame.roles.includes('waiting'));assert.ok(frame.lines.length<=13)
  assert.deepEqual(frame.lines.flatMap((line,i)=>frame.roles[i]==='overlay'||frame.roles[i]==='waiting'?[line.slice(1,-1).trim()]:[]),bottom.rows.slice(-bottom.keep),'the complete batch heading and all wrapped actions remain visible')
  const legacy=frameOf({snapshot:statusOf([]),width,height:13,bottom:{...bottom,overflow:undefined}})
  assert.ok(!legacy.lines.some(l=>l.includes('计划有省略')),'absent metadata retains the old suffix layout')
  assert.doesNotThrow(()=>assert.deepEqual(frameOf({snapshot:statusOf([]),width,height:13,bottom:{...bottom,overflow:12 as unknown as string}}),legacy),'bad optional metadata retains exact legacy layout')
  assert.equal(frame.roles.filter(r=>r==='waiting').length,bottom.waitingCount,'disclosure never consumes an action row')
 }
})
