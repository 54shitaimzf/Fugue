import assert from 'node:assert/strict'
import {test} from 'node:test'
import {openStage} from './stage.ts'
import {helpRowsOf,keymapOf,KEYMAP,decodeOf,keyLabelOf} from './keymap.ts'
import type {Keymap} from './keymap.ts'
import {openSession} from './follow.ts'

function rig(keymap?:()=>Keymap){
 const notes:string[]=[],presses:string[]=[];let redraws=0
 const stage=openStage({...(keymap===undefined?{}:{keymap}),note:s=>notes.push(s),redraw:()=>{redraws++},hint:()=>'',columns:()=>40,termRows:()=>24,rows:()=>[],pendingFace:async()=>null,run:()=>({running:false,last:[],argvOf:()=>({words:[],argv:[],why:null}),press:s=>{presses.push(s);return true},stop:()=>false}),now:()=>0,abort:()=>{}})
 stage.setRaw(true);return {stage,notes,presses,redraws:()=>redraws}
}
test('help and the key menu read the same late-bound configured map as actual decoding; search and return stay local',()=>{
 let km=KEYMAP;const r=rig(()=>km)
 km=keymapOf({help:'Alt-H',cancel:'Alt-E',read:'Ctrl-T',historyOlder:'Alt-U',historyNewer:'Alt-J'})
 const before=r.redraws();for(const d of decodeOf('\x1bh',km))r.stage.onAction(d)
 assert.deepEqual(r.stage.view().menu!.rows,helpRowsOf(km));assert.equal(r.redraws()-before,1)
 const body=r.stage.view().menu!.rows.join('\n');assert.ok(body.includes('Alt-H')&&body.includes('Alt-E')&&body.includes('Ctrl-T'));assert.ok(!body.includes('Ctrl-R'))
 for(const d of decodeOf('Alt-H',km))r.stage.onAction(d)
 assert.equal(r.stage.view().menu!.rows.length,1);assert.ok(r.stage.view().menu!.rows[0]!.startsWith('Alt-H'))
 for(const d of decodeOf('\x1be',km))r.stage.onAction(d)
 assert.equal(r.stage.view().menu,undefined);assert.deepEqual(r.notes,[]);assert.deepEqual(r.presses,[]);r.stage.close()
})
test('help describes observable actions and cancellation order without implementation terms or fixed default shortcuts',()=>{
 const forbidden=/簇|kill|agent|diff|契约|取消链|在途|第一级|那一格|30 条|退出码|字节|第二份数据|`/
 for(const b of KEYMAP.rows)assert.ok(!forbidden.test(b.note),`${b.action}: ${b.note}`)
 const note=(action:string)=>KEYMAP.rows.find(b=>b.action===action)!.note
 for(const phrase of ['收起','停止','排队','反查','清空'])assert.ok(note('cancel').includes(phrase),phrase)
 assert.match(note('interrupt'),/3 秒/);assert.match(note('quit'),/输入.*空/)
 assert.match(note('yank'),/最近删除/);assert.match(note('read'),/计划全文/);assert.match(note('focus'),/执行者/)
 assert.match(note('menu'),/命令/);assert.ok(!note('menu').includes('这些键'))
 const configured=keymapOf({cancel:'Alt-E',help:'Alt-H',approve:'Alt-A',reject:'Alt-N'})
 for(const a of ['cancel','help','approve','reject'])assert.ok(!/\bEsc\b|\by\b|\bn\b/.test(configured.rows.find(b=>b.action===a)!.note),a)
})
test('omitting the configured help source preserves the default menu exactly and all actions remain reachable',()=>{
 const fallback=rig(),explicit=rig(()=>KEYMAP)
 for(const r of [fallback,explicit]){r.stage.onAction({action:'help'});assert.deepEqual(r.stage.view().menu!.rows,helpRowsOf(KEYMAP));assert.equal(r.stage.view().menu!.rows.length,KEYMAP.rows.length)}
 assert.deepEqual(fallback.stage.view(),explicit.stage.view())
 const rows=fallback.stage.view().menu!.rows
 for(const b of KEYMAP.rows)assert.equal(rows.filter(s=>s.startsWith(keyLabelOf(b)+' ')).length,1,b.action)
 const session=openSession({view:fallback.stage.view});assert.ok(session.panel({columns:40,height:fallback.stage.heightWant()}).rows.length>0)
 for(const r of [fallback,explicit]){r.stage.onAction({action:'cancel'});assert.equal(r.stage.view().menu,undefined);assert.deepEqual(r.presses,[]);r.stage.close()}
})
