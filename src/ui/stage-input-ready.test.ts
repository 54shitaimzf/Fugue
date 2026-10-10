import assert from 'node:assert/strict'
import {test} from 'node:test'
import {openStage} from './stage.ts'
import {gateFaceOf} from './gate.ts'
import type {Contract} from '../contract/types.ts'
import {openSession} from './follow.ts'
import {openTerm} from './term.ts'
import {theme16,theme256,DEFAULT_THEME} from './theme.ts'
import {KEYMAP,hintLineOf} from './keymap.ts'
import {setGlyphTier,widthOf} from './glyph.ts'
import type {ViewInput} from './frame.ts'

const face=gateFaceOf({round:'r1',fingerprint:'ready-one',same:[],contracts:[{
 id:'r1.implement.1',agent:'agent/r1/1',kind:'implement',goal:'更新 alpha.txt',ownedPaths:['alpha.txt'],seed:[],deliverables:[],assertions:[],
}] as Contract[]},{})
function rig(onPaint?:(view:ViewInput)=>void,columns=192,rows=50){
 let inputReady=false,pending:typeof face|null=null
 const shown:ViewInput[]=[],notes:string[]=[],presses:string[]=[]
 const stage=openStage({columns:()=>columns,termRows:()=>rows,rows:()=>[],pendingFace:async()=>pending,
  hint:when=>inputReady?hintLineOf(KEYMAP,0,when):'输入尚未接好',
  redraw:()=>{const v=stage.view();shown.push(v);onPaint?.(v)},note:s=>notes.push(s),
  run:()=>({running:false,last:[],argvOf:()=>({words:[],argv:[],why:null}),press:s=>{presses.push(s);return true},stop:()=>false}),
  now:()=>0,abort:()=>{}})
 return {stage,shown,notes,presses,setPending:()=>{pending=face},setReady:(ready:boolean)=>{inputReady=ready;stage.setRaw(ready)}}
}
test('首批草案先到，输入随后接好，无新事件也重画确认；装配不批准，第一次举手不执行',async()=>{
 const r=rig();r.setPending();await r.stage.refreshGate()
 assert.equal(r.shown.at(-1)!.input,undefined)
 assert.equal(r.shown.at(-1)!.bottom,undefined)
 const before=r.shown.length,notes=r.notes.length
 r.setReady(true)
 assert.equal(r.shown.length,before+1,'输入接好后恰好请求一帧')
 assert.ok(r.shown.at(-1)!.input,'重画已包含输入位置')
 assert.equal(r.shown.at(-1)!.bottom!.confirmationRound,'r1','重画已包含同一批确认')
 assert.equal(r.notes.length,notes,'装配不重发草案注记');assert.deepEqual(r.presses,[])
 r.stage.onAction({action:'approve',key:'y'});assert.deepEqual(r.presses,[],'第一段批准不执行')
 assert.match(r.shown.at(-1)!.bottom!.rows.join(' '),/Enter/)
 r.stage.onAction({action:'submit',key:'Enter'});assert.deepEqual(r.presses,['round go'],'原两段批准恰一次执行')
 r.stage.close()
 console.log('input readiness:gate-before-keys repaint1; same batch visible without new event; note0/approval0; first press0/second1')
})
test('未知输入与重复通知不重画，状态变化各一帧，关闭后的迟到通知不写终端',()=>{
 const r=rig();r.setReady(false);r.setReady(false);assert.equal(r.shown.length,0,'非终端地板零额外帧')
 r.setReady(true);assert.equal(r.shown.length,1);assert.ok(r.shown.at(-1)!.input)
 r.setReady(true);assert.equal(r.shown.length,1,'重复可用通知不重画')
 r.setReady(false);assert.equal(r.shown.length,2);assert.equal(r.shown.at(-1)!.input,undefined)
 r.setReady(false);assert.equal(r.shown.length,2)
 r.stage.close();r.setReady(true);r.setReady(false);assert.equal(r.shown.length,2,'关闭后的变化没有迟到重画')
 assert.deepEqual(r.presses,[]);assert.deepEqual(r.notes,[])
 console.log('input readiness floor:false/repeat frames0; live state changes2frames; closed changes0; notes/commands0')
})
test('三字形与六主题的输入/确认往返保持草稿和几何，重复通知停留字节零',async()=>{
 let paints=0,idles=0
 for(const glyph of ['ascii','box','rich'] as const){
  setGlyphTier(glyph)
  for(const theme of [theme16(),theme256(),theme256('light'),theme256('dark'),DEFAULT_THEME,undefined])
  for(const [columns,rows] of [[192,50],[80,24],[24,30]]){
   const chunks:string[]=[]
   let session:ReturnType<typeof openSession>,term:ReturnType<typeof openTerm>
   const r=rig(()=>{term.draw([],size=>{const p=session.panel(size);assert.ok(p.rows.length<=rows-1);assert.ok(p.rows.every(x=>widthOf(x)<=columns));return p});paints++},columns,rows)
   session=openSession({view:r.stage.view})
   term=openTerm({out:{isTTY:true,columns,rows,write:s=>chunks.push(s)},term:'xterm-256color',theme,heightOf:r.stage.heightWant})
   term.draw(['原永久文字'],size=>session.panel(size))
   r.setReady(true);r.stage.onAction({action:'insert',text:'保留草稿'})
   const draft=r.stage.view().input!;assert.ok(draft.rows.join('').includes('保留草稿'))
   r.setPending();await r.stage.refreshGate()
   assert.ok(!r.stage.view().input!.rows.join('').includes('保留草稿'))
   r.setReady(false);assert.equal(r.stage.view().input,undefined)
   r.setReady(true);assert.equal(r.stage.view().bottom!.confirmationRound,'r1')
   r.stage.onAction({action:'cancel'});assert.deepEqual(r.stage.view().input,draft,'返回草稿文字和光标保持')
   chunks.length=0;r.setReady(true);assert.equal(chunks.join(''),'');idles++
   r.setReady(false);chunks.length=0;r.setReady(false);assert.equal(chunks.join(''),'');idles++
   r.stage.close();chunks.length=0;r.setReady(true);assert.equal(chunks.join(''),'');idles++
   assert.deepEqual(r.presses,[]);term.close()
  }
 }
 setGlyphTier('box')
 assert.equal(paints,378,'可见状态变化各请求一帧')
 console.log('input readiness sequence:3glyphs x6themes x3geometries;'+paints+' redraws/'+idles+' idle samples bytes0; draft/caret retained; component sequence, no native resize')
})
