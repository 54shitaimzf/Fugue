import assert from 'node:assert/strict'
import {test} from 'node:test'
import {openStage} from './stage.ts'
import {decodeOf,keymapOf,KEYMAP} from './keymap.ts'
import type {Keymap} from './keymap.ts'
import type {RunLauncher} from './run.ts'

function rig(keymap?:()=>Keymap){
 const notes:string[]=[],presses:string[]=[],signals:string[]=[]
 let running=false,acceptStop=true,available=true,aborts=0,redraws=0,last:readonly string[]=['node','/missing/fugue.ts','--root','/tmp/project','round','go']
 const run:RunLauncher={get running(){return running},get last(){return last},argvOf:line=>({words:[line],argv:['fugue',line],why:line==='bad'?'missing command':null}),press:line=>{presses.push(line);return true},stop:signal=>{signals.push(signal!);return acceptStop}}
 const stage=openStage({...(keymap===undefined?{}:{keymap}),note:s=>notes.push(s),redraw:()=>{redraws++},hint:()=>'',columns:()=>40,termRows:()=>24,rows:()=>[],pendingFace:async()=>null,run:()=>available?run:null,now:()=>0,abort:()=>{aborts++}})
 stage.setRaw(true)
 assert.equal(redraws,1,'input installation paints once before run feedback')
 redraws=0 // Each outcome assertion measures its own redraw, after installation.
 return {stage,notes,presses,signals,running:(v:boolean)=>{running=v},runAvailable:(v:boolean)=>{available=v},stopReply:(v:boolean)=>{acceptStop=v},last:(v:readonly string[])=>{last=v},aborts:()=>aborts,redraws:()=>redraws}
}
const unknownWriteback=(notes:readonly string[])=>{
 const body=notes.join('\n');assert.match(body,/文件是否已写回，请查看进展与记录/)
 assert.doesNotMatch(body,/本次.*未写回|结果已写回|没有改动.*文件|账照写|写到哪算哪/)
}
test('startup failures retain the original reason and actual command, offer a next step, and never claim execution succeeded',()=>{
 for(const last of [['node','/missing/fugue.ts','--root','/tmp/project','round','go'],[]]){
  const r=rig();r.last(last);r.stage.onRunDone({code:null,why:'spawn node ENOENT'})
  const body=r.notes.join('\n');assert.match(body,/执行未能启动：spawn node ENOENT/);assert.match(body,/检查运行环境与配置后重试/)
  if(last.length)assert.ok(body.includes(last.join(' ')));else assert.ok(!body.includes('启动命令：'))
  assert.doesNotMatch(body,/这一趟|手敲|已开始|成功|已写回/);assert.deepEqual(r.presses,[])
  assert.equal(r.redraws(),1);r.stage.close()
 }
})
test('nonzero and signal outcomes report exactly the known result without inferring whether files were written; success stays event-backed',()=>{
 for(const code of [7,null]){
  const r=rig();r.stage.onRunDone({code,why:null});const body=r.notes.join('\n')
  assert.match(body,code===null?/执行因信号结束/:/执行失败（退出码 7）/);unknownWriteback(r.notes)
  assert.deepEqual(r.presses,[]);assert.equal(r.redraws(),1);r.stage.close()
 }
 const success=rig();success.stage.onRunDone({code:0,why:null});assert.deepEqual(success.notes,[]);success.stage.close()
})
test('stop is a request, holds queued work, and the resume hint uses the current configured key',()=>{
 let km=KEYMAP;const r=rig(()=>km);r.running(true)
 for(const text of ['say first','say second']){r.stage.onAction({action:'insert',text});r.stage.onAction({action:'submit'})}
 r.notes.length=0;km=keymapOf({cancel:'Alt-E',submit:'Alt-S',interrupt:'Alt-I',quit:'Alt-Q'})
 for(const d of decodeOf('\x1be',km))r.stage.onAction(d)
 assert.deepEqual(r.signals,['SIGINT']);assert.match(r.notes.join('\n'),/已请求停止执行，正在等待结束/);unknownWriteback(r.notes)
 assert.match(r.notes.join('\n'),/排队任务暂停.*Alt-S.*下一条/);assert.doesNotMatch(r.notes.join('\n'),/Enter|打断了|SIGINT/)
 r.running(false);r.stage.onRunDone({code:null,why:null});assert.deepEqual(r.presses,[],'a stop request never auto-starts queued work')
 for(const d of decodeOf('\x1bs',km))r.stage.onAction(d)
 assert.deepEqual(r.presses,['say first']);r.stage.close()
 const lost=rig();lost.running(true);lost.stopReply(false);lost.stage.onAction({action:'interrupt'})
 assert.match(lost.notes.join('\n'),/没有正在运行的任务/);assert.doesNotMatch(lost.notes.join('\n'),/已请求|正在等待结束|排队任务暂停/);lost.stage.close()
})
test('busy exit waits once and then leaves only the interface, preserving cancellation signals and file uncertainty',()=>{
 const km=keymapOf({quit:'Alt-Q',cancel:'Alt-E',interrupt:'Alt-I'}),r=rig(()=>km);r.running(true)
 for(const d of decodeOf('\x1bq',km))r.stage.onAction(d)
 assert.equal(r.aborts(),0);assert.deepEqual(r.signals,[]);assert.match(r.notes.join('\n'),/任务仍在运行.*结束后退出/)
 assert.match(r.notes.join('\n'),/Alt-Q.*立即关闭界面.*任务可能继续运行/);assert.doesNotMatch(r.notes.join('\n'),/Esc|Ctrl-C|账要完整/)
 for(const d of decodeOf('\x1bq',km))r.stage.onAction(d)
 assert.equal(r.aborts(),1);assert.deepEqual(r.signals,[]);unknownWriteback(r.notes);assert.doesNotMatch(r.notes.at(-1)!,/已停止|已中止|硬退/);r.stage.close()
})
test('idle interrupt and nonempty exit feedback follow configured keys; absent maps preserve default behavior',()=>{
 const km=keymapOf({interrupt:'Alt-I',cancel:'Alt-E',quit:'Alt-Q'}),r=rig(()=>km)
 for(const d of decodeOf('\x1bi',km))r.stage.onAction(d)
 assert.match(r.notes.join('\n'),/再按一次 Alt-I.*3 秒/);assert.doesNotMatch(r.notes.join('\n'),/Ctrl-C/)
 r.stage.onAction({action:'insert',text:'unfinished'})
 for(const d of decodeOf('\x1bq',km))r.stage.onAction(d)
 assert.match(r.notes.join('\n'),/Alt-E.*Alt-Q/);assert.ok(r.stage.view().input?.rows.join('').includes('unfinished'));assert.equal(r.aborts(),0);r.stage.close()
 const absent=rig(),explicit=rig(()=>KEYMAP)
 for(const one of [absent,explicit]){one.stage.onAction({action:'interrupt'});one.stage.onAction({action:'insert',text:'unfinished'});for(const d of decodeOf('\x04',KEYMAP))one.stage.onAction(d);const input=one.stage.view().input?.rows.join('')??'';assert.ok(input.includes('unfinished')&&!input.includes('Ctrl-D')&&!input.includes('\x04'));one.stage.close()}
 assert.deepEqual(absent.notes,explicit.notes);assert.match(absent.notes.join('\n'),/Ctrl-C/);assert.match(absent.notes.join('\n'),/Esc.*Ctrl-D/)
})
test('queue feedback distinguishes automatic continuation, paused work and unavailable launchers; busy cancel means stop first',()=>{
 const km=keymapOf({submit:'Alt-S',cancel:'Alt-E'})
 for(const state of ['busy','paused','unavailable']){
  const r=rig(()=>km)
  if(state==='unavailable')r.runAvailable(false)
  else{r.running(true);if(state==='paused'){r.stage.onAction({action:'interrupt'});r.notes.length=0}}
  r.stage.onAction({action:'insert',text:'say queued'});for(const d of decodeOf('\x1bs',km))r.stage.onAction(d)
  const body=r.notes.join('\n');assert.match(body,/已排队 1 条/);assert.doesNotMatch(body,/Enter|Esc|入队|那一趟/)
  if(state==='busy')assert.match(body,/当前任务结束后逐条执行/)
  else{assert.doesNotMatch(body,/结束后逐条执行/);assert.ok(body.includes(state==='paused'?'排队任务暂停':'执行入口不可用'))}
  if(state==='unavailable'){assert.match(body,/Alt-E.*取消最后一条/);assert.ok(!body.includes('Alt-S'))}
  else{assert.match(body,/Alt-E.*请求停止/);assert.doesNotMatch(body,/取消最后一条/)}
  assert.deepEqual(r.presses,[]);r.stage.close()
 }
})
test('a rejected queued command preserves the remaining work and does not promise continuation without a running task',()=>{
 const km=keymapOf({submit:'Alt-S',cancel:'Alt-E'}),r=rig(()=>km)
 r.runAvailable(false);r.stage.onAction({action:'insert',text:'bad'});r.stage.onAction({action:'submit'});r.notes.length=0
 r.runAvailable(true);r.stage.onAction({action:'insert',text:'say next'});r.stage.onAction({action:'submit'})
 const body=r.notes.join('\n');assert.match(body,/missing command/);assert.match(body,/已排队 1 条.*排队任务暂停/)
 assert.doesNotMatch(body,/当前任务结束后逐条执行|接着看下一条/);assert.match(body,/Alt-S.*开始下一条.*Alt-E.*取消最后一条/)
 assert.deepEqual(r.presses,[]);r.stage.onAction({action:'submit'});assert.deepEqual(r.presses,['say next']);r.stage.close()
})
