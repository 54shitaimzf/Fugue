import assert from 'node:assert/strict'
import {test} from 'node:test'
import {openStage} from './stage.ts'
import {openSession} from './follow.ts'
import {KEYMAP,keymapOf,hintLineOf,hintLimitOf,keyLabelOf,helpRowsOf} from './keymap.ts'
import {frameOf,innerOf} from './frame.ts'
import {statusOf} from '../probe/status.ts'
import {widthOf} from './glyph.ts'
import {gateFaceOf} from './gate.ts'

function rig(columns=16,custom=false){
 const notes:string[]=[],presses:string[]=[],km=custom?keymapOf({cancel:'Alt-E',help:'Alt-H',historyNewer:'Alt-J'}):KEYMAP
 const face=gateFaceOf({round:'r1',fingerprint:'r31',same:[],contracts:[{id:'r1.implement.1',agent:'agent/r1/1',kind:'implement',goal:'修复登录提示',ownedPaths:['src/login.ts'],seed:[],deliverables:[],assertions:[]}]} as never)
 const stage=openStage({keymap:()=>km,note:s=>notes.push(s),redraw:()=>{},hint:w=>hintLineOf(km,hintLimitOf(columns,km,w),w),columns:()=>columns,termRows:()=>24,rows:()=>[],pendingFace:async()=>face,run:()=>({running:false,last:[],argvOf:()=>({words:[],argv:[],why:null}),press:s=>{presses.push(s);return true},stop:()=>false}),now:()=>0,abort:()=>{}})
 stage.setRaw(true);const session=openSession({view:stage.view});return {stage,session,notes,presses,km,frame:()=>session.panel({columns,height:stage.heightWant()})}
}
test('all help actions show their whole configured key and explanation in real 16/40/80-column frames, without a second body or clipped rows',()=>{
 for(const width of [16,40,80]){
  const r=rig(width,true);r.stage.onAction({action:'help'})
  for(let n=0;n<r.km.rows.length;n++){
   const b=r.km.rows[n]!,f=r.frame(),text=f.rows.join('').replace(/[│|\s]/g,'')
   assert.ok(f.rows.some(s=>s.includes('按键帮助')),(width,b.action,'clear help title'))
   const detail=(r.stage.view().menu as {detail?:readonly string[]}).detail;assert.ok(detail&&detail.length>0)
   assert.ok(!/ {2,}/.test(detail.join('')),'focused key never retains long table padding')
   assert.ok(r.stage.view().hint!.startsWith('按键 Alt-E 返回'),'plain help uses the configured return context')
   assert.ok(text.includes((keyLabelOf(b)+' '+b.note).replace(/\s/g,'')),(width,b.action,text))
   assert.ok(!f.rows.some(s=>s.includes('还有')||s.includes('等待输入')||s.includes('说说')),`${width}/${b.action} not a clipped list or second body`)
   assert.ok(f.rows.some(s=>s.includes(`${n+1}/${r.km.rows.length} · 筛选`)));assert.ok(f.roles!.includes('overlay'))
   if(detail.length>1)assert.ok(f.roles!.includes('overlayBody'),'wrapped explanation has normal body brightness')
   assert.ok(f.rows.every(s=>widthOf(s)<=width));r.stage.onAction({action:'historyNewer'})
  }
  assert.deepEqual(r.notes,[]);assert.deepEqual(r.presses,[]);r.stage.close()
 }
})
test('help foreground follows configured return/navigation hints, retains filtering and preserves the current plan on return',async()=>{
 for(const custom of [false,true]){
  const r=rig(16,custom);await r.stage.refreshGate();r.stage.onAction({action:'help'});assert.ok(!r.frame().roles!.includes('waiting'),'help has foreground over confirmation too');r.stage.onAction({action:'cancel'})
  r.stage.onAction({action:'read'});r.stage.onAction({action:'historyNewer'});const read=r.stage.view().read!,notes=[...r.notes]
  r.stage.onAction({action:'help'});assert.equal(r.stage.view().hint,custom?'按键 Alt-E 返回':'按键 Esc 返回')
  const f=r.frame();assert.ok(!f.roles!.includes('waiting'));assert.ok(!f.roles!.includes('read'),'no old plan body leaks into foreground help');assert.ok(!f.rows.some(s=>s.includes('计划全文')))
  r.stage.onAction({action:'historyNewer'});assert.equal(r.stage.view().menu!.sel,1);assert.deepEqual(r.stage.view().read,read)
  r.stage.onAction({action:'insert',text:'最近删除'});assert.equal(r.stage.view().menu!.rows.length,1)
  assert.ok(r.frame().rows.join('').replace(/[│|\s]/g,'').includes('最近删除的一段粘回光标处'))
  r.stage.onAction({action:'cancel'});assert.equal(r.stage.view().menu,undefined);assert.deepEqual(r.stage.view().read,read);assert.deepEqual(r.notes,notes);assert.deepEqual(r.presses,[]);r.stage.close()
 }
})
test('missing, invalid or too-tall help detail returns exact original menu bytes and roles; ordinary commands are still ordinary menus',()=>{
 const base={snapshot:statusOf([]),width:40,height:13,menu:{rows:['Enter 发送输入','Esc 返回'],sel:0}}
 const old=frameOf(base)
 for(const detail of [undefined,[],null,['x'.repeat(100)],Array(100).fill('x'),[42],'bad'])assert.deepEqual(frameOf({...base,menu:{...base.menu,detail:detail as never}}),old,JSON.stringify(detail))
 const r=rig(40);r.stage.onAction({action:'menu',key:'/'});assert.equal((r.stage.view().menu as {detail?:unknown}).detail,undefined);assert.equal(r.frame().roles!.filter(s=>s==='hit').length,1);assert.ok(r.frame().rows[r.frame().roles!.indexOf('readHeading')]!.includes('命令'));assert.deepEqual(r.presses,[]);r.stage.close()
 assert.ok(innerOf(40)<40)
})
test('wide help uses spare rows for nearby configured keys while narrow help keeps only the current full explanation',()=>{
 for(const columns of [16,40,80]){
  const r=rig(columns,true);r.stage.onAction({action:'help'});const f=r.frame(),text=f.rows.join(' ')
  if(columns>=40)assert.ok(text.includes('Ctrl-J/Alt-Enter')&&text.includes('Alt-E'),'neighbor keys are discoverable in spare rows')
  else assert.ok(!text.includes('Ctrl-J'),'no cut neighbor list competes with narrow explanation')
  assert.ok(text.includes('Enter'));assert.equal(r.stage.view().menu!.sel,0);assert.deepEqual(r.presses,[]);r.stage.close()
 }
})
