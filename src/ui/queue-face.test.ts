import assert from 'node:assert/strict'
import {test} from 'node:test'
import {openStage} from './stage.ts'
import {openSession} from './follow.ts'
import {KEYMAP,keymapOf} from './keymap.ts'
import type {RunLauncher} from './run.ts'
import {innerOf} from './frame.ts'
import {widthOf} from './glyph.ts'
import {EMPTY_QUEUE,enqueueOf,queueRowOf,queueRowsOf} from './queue.ts'
import {gateFaceOf} from './gate.ts'
import type {GateFace} from './gate.ts'

function rig(columns=40,custom=false){
 let km=custom?keymapOf({submit:'Alt-S',cancel:'Alt-E'}):KEYMAP,running=true,available=true,face:GateFace|null=null
 const presses:string[]=[],signals:string[]=[],notes:string[]=[]
 const run:RunLauncher={get running(){return running},last:[],argvOf:line=>({words:[line],argv:[line],why:null}),press:line=>{presses.push(line);running=true;return true},stop:s=>{signals.push(s!);return true}}
 const stage=openStage({keymap:()=>km,columns:()=>columns,termRows:()=>24,rows:()=>[],pendingFace:async()=>face,run:()=>available?run:null,note:s=>notes.push(s),redraw:()=>{},hint:()=>'',now:()=>0,abort:()=>{}})
 stage.setRaw(true)
 const session=openSession({view:stage.view})
 const body=()=>session.frame({columns,height:stage.heightWant()}).join('\n')
 const queue=()=>{stage.onAction({action:'insert',text:'say queued'});stage.onAction({action:'submit'})}
 return {stage,body,queue,presses,signals,notes,keys:()=>{km=keymapOf({submit:'Alt-T',cancel:'Alt-U'})},idle:()=>{running=false},unavailable:()=>{available=false},face:(v:GateFace)=>{face=v},bottom:()=>stage.view().bottom}
}
test('queued status uses the current map and the busy cancel action, not a fixed or unavailable start instruction',()=>{
 const r=rig(80,true);r.queue();let body=r.body()
 assert.match(body,/排队 1 条/);assert.match(body,/自动继续/);assert.match(body,/下一条：say queued/);assert.match(body,/Alt-E 停止/)
 assert.doesNotMatch(body,/Enter|Esc|Alt-S 开始|丢掉最后/);assert.deepEqual(r.presses,[])
 r.keys();body=r.body();assert.match(body,/Alt-U 停止/);assert.doesNotMatch(body,/Alt-E/)
 assert.deepEqual(r.signals,[],'a view reads state and keys, never stops a task');r.stage.close()
})
test('stopping and idle queue status follow actual running state; manual start and last-item cancel remain distinct',()=>{
 const r=rig(40,true);r.queue();r.stage.onAction({action:'cancel'})
 let body=r.body();assert.match(body,/等待结束/);assert.match(body,/Alt-E 停止/);assert.doesNotMatch(body,/Alt-S 开始|自动继续/)
 r.idle();r.stage.onRunDone({code:null,why:null});body=r.body()
 assert.match(body,/等待开始/);assert.match(body,/Alt-S 开始/);assert.match(body,/Alt-E 撤回/);assert.deepEqual(r.presses,[])
 r.stage.onAction({action:'submit'});assert.deepEqual(r.presses,['say queued']);assert.equal(r.bottom(),undefined);r.stage.close()
 const blocked=rig(40,true);blocked.unavailable();blocked.queue();body=blocked.body()
 assert.match(body,/无法开始/);assert.match(body,/Alt-E 撤回/);assert.doesNotMatch(body,/Alt-S 开始|自动继续/)
 blocked.stage.onAction({action:'cancel'});assert.equal(blocked.bottom(),undefined);assert.deepEqual(blocked.presses,[]);blocked.stage.close()
})
test('narrow queue face preserves count, visible preview and complete current actions without widening physical rows',()=>{
 for(const columns of [16,24,40,80])for(const custom of [false,true]){
  const r=rig(columns,custom);r.queue();r.stage.onAction({action:'cancel'});r.idle();r.stage.onRunDone({code:null,why:null})
  const rows=r.bottom()!.rows,body=r.body(),submit=custom?'Alt-S':'Enter',cancel=custom?'Alt-E':'Esc'
  assert.ok(rows.every(s=>widthOf(s)<=innerOf(columns)),JSON.stringify(rows));assert.match(body,/排队 1 条/);assert.match(body,/下一条：/)
  assert.ok(body.includes(submit+' 开始'),body);assert.ok(body.includes(cancel+' 撤回'),body);assert.match(body,/等待开始/)
  assert.equal(r.bottom()!.keep,rows.length);assert.deepEqual(r.presses,[]);r.stage.close()
  assert.ok(rows.every(row=>!row.endsWith('·')),JSON.stringify(rows))
  if(columns===40)assert.equal(rows.length,3,'two short actions share one physical row when they fit')
 }
 const absent=openStage({columns:()=>40,termRows:()=>24,rows:()=>[],pendingFace:async()=>null,run:()=>null,note:()=>{},redraw:()=>{},hint:()=>'',now:()=>0,abort:()=>{}})
 absent.setRaw(true);assert.equal(absent.view().bottom,undefined);absent.onAction({action:'insert',text:'later'});absent.onAction({action:'submit'})
 assert.ok(absent.view().bottom!.rows.join('\n').includes('Esc 撤回'));absent.setRaw(false);assert.equal(absent.view().bottom,undefined);absent.close()
})
test('queue layout without controls preserves exact legacy bytes, and absent queue or raw input adds no rows',()=>{
 const q=enqueueOf(EMPTY_QUEUE,{line:'old command',mode:'Say'})
 for(const columns of [0,12,36,76])assert.deepEqual(queueRowsOf(q,columns),[queueRowOf(q,columns)])
 assert.equal(queueRowOf(q),'排队 1 条 · 下一条：old command · Enter 起下一条 · Esc 丢掉最后一条')
 assert.deepEqual(queueRowsOf(EMPTY_QUEUE,12),[])
 assert.deepEqual(queueRowsOf(EMPTY_QUEUE,12,{submit:'Alt-S',cancel:'Alt-E',state:'paused'}),[])
})
test('queue actions yield to an open menu, gate or unfinished input without changing cancel priority',async()=>{
 const r=rig(40,true);r.queue();r.stage.onAction({action:'panel'})
 assert.doesNotMatch(r.bottom()!.rows.join('\n'),/Alt-E 停止/)
 r.stage.onAction({action:'cancel'});assert.deepEqual(r.signals,[]);assert.match(r.bottom()!.rows.join('\n'),/Alt-E 停止/)
 r.face(gateFaceOf({round:'r1',fingerprint:'fp-q',same:[],contracts:[]},{}));await r.stage.refreshGate()
 assert.doesNotMatch(r.bottom()!.rows.join('\n'),/Alt-E 停止/)
 r.stage.onAction({action:'cancel'});assert.deepEqual(r.signals,[]);assert.match(r.bottom()!.rows.join('\n'),/Alt-E 停止/)
 r.stage.onAction({action:'cancel'});r.idle();r.stage.onRunDone({code:null,why:null});r.stage.onAction({action:'insert',text:'new draft'})
 assert.doesNotMatch(r.bottom()!.rows.join('\n'),/Alt-S 开始/)
 assert.deepEqual(r.presses,[]);r.stage.onAction({action:'killToStart'});assert.match(r.bottom()!.rows.join('\n'),/Alt-S 开始/);r.stage.close()
})
