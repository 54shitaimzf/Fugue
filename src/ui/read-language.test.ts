import assert from 'node:assert/strict'
import {test} from 'node:test'
import type {StatusRow} from '../probe/status.ts'
import {statusOf} from '../probe/status.ts'
import {facesOf,faceRowsOf,readStateOf,readImageAt,readWrap} from './read.ts'
import {openStage} from './stage.ts'
import {hintKeysOf,keymapOf} from './keymap.ts'
const agent='agent/r1/1',path='图片/完整设计稿-这是带空格与中文的长文件名字 preview.png'
const events=[{t:'view/write',path,blob:'a'.repeat(40),mode:0o100644},{t:'view/remove',path:'old.txt'},{t:'view/rename',from:'before.txt',to:'after.txt'},{t:'view/chmod',path:'run.sh',mode:0o100755},{t:'view/symlink',path:'link',target:'target'}]
const rows=events.map((e,i)=>({pos:{writer:agent,seq:i+1},e:{...e,agent,rev:i+1}})) as unknown as StatusRow[]
const expected=[`写 ${path}`,'删 old.txt','改名 before.txt → after.txt','改权限 run.sh 755','符号链接 link → target']
test('file reading names the object, preserves each complete change, and leaves source coordinates in existing details',()=>{
 const state=readStateOf(rows,{snapshot:statusOf(rows)}),copy=structuredClone(state),faces=facesOf(state)
 assert.equal(faces.diff!.title,'文件改动 · 5 条');assert.deepEqual(faces.diff!.lines,expected)
 assert.ok(!faces.diff!.lines.join('').includes(agent),'default reading does not lead with internal writer coordinates')
 for(let i=0;i<expected.length;i++)assert.ok(faces.detail!.lines.includes(`${agent} ${i+1} · ${expected[i]}`),'all source coordinates remain in details')
 assert.deepEqual(state,copy,'presentation does not rewrite folded data')
 assert.equal(facesOf(readStateOf(rows)).detail,null,'missing snapshot retains the existing no-details floor')
})
test('PNG preview counts the same wrapped human file description at narrow and wide widths',()=>{
 const state=readStateOf(rows.slice(0,1))
 for(const columns of [8,16,38,78]){
  const text=faceRowsOf(facesOf(state),'diff',columns),heading=readWrap('文件改动 · 1 条',columns),body=readWrap(expected[0]!,columns)
  assert.deepEqual(text,[...heading,...body]);assert.equal(body.join(''),expected[0])
  const start=heading.length,at=readImageAt(state,columns,start,500);assert.ok(at)
  assert.equal(at.request.path,path);assert.equal(at.request.agent,agent);assert.equal(at.request.blob,'a'.repeat(40));assert.equal(at.after,text.length)
  assert.equal(readImageAt(state,columns,start+1,500),null,'a partly visible description is never attached to a bitmap')
  assert.equal(readImageAt(state,columns,start,body.length+1),null,'one spare row remains text')
 }
})
test('opening read emits complete object and configured-key notes without enclosing punctuation fragments',()=>{
 const notes:string[]=[],km=keymapOf({complete:'Ctrl-T',historyOlder:'Ctrl-U'}),keys=hintKeysOf(km,'read')
 const stage=openStage({note:s=>notes.push(s),redraw:()=>{},hint:()=>'',keysOf:w=>hintKeysOf(km,w),columns:()=>40,termRows:()=>24,rows:()=>rows.slice(0,1),pendingFace:async()=>null,run:()=>null,now:()=>0,abort:()=>{}})
 stage.setRaw(true);stage.onAdvance(rows.slice(0,1));stage.onAction({action:'read'})
 assert.deepEqual(notes,['阅读面 · 文件改动 · 1 条',keys]);assert.ok(keys.includes('Ctrl-T')&&keys.includes('Ctrl-U'))
 assert.ok(!notes.some(s=>s.includes('（')||s.includes('）')))
 stage.onAction({action:'read'});assert.equal(notes.length,2,'closing does not repeat the opening instructions');stage.close()
})
