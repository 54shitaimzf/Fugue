import assert from 'node:assert/strict'
import { test } from 'node:test'
import { openTerm } from './term.ts'
import { screen } from '../../test/helpers/vt-screen.ts'

// 这一族只问一件事：**一条永久行写成两行的时候，旧 UI 的边框有没有留在第二行旁边**——
// 所以它要的正是"允许溢出折行"的那份模型，而不是"溢出当场红"那份。
// 它原先自带一份：延迟折行 · 数滚屏 · 逐行 `trimEnd`，与 `vt-screen.ts` 逐条同义
// （走一遍 `put` 的控制序列分支就能对上），所以并进那一份。

for(const columns of [8,16,40]){
  test(`permanent note at ${columns} columns clears every wrapped row and survives redraw/close`,()=>{
    const vt=screen(columns,24);let writes=0
    const term=openTerm({out:{isTTY:true,write:s=>{writes++;vt.put(s)}},columnsOf:()=>columns,rowsOf:()=>24,term:'xterm-256color',height:3})
    const panel=()=>({rows:['OLD','|'.repeat(columns),'TAIL'],input:{rows:['> '],caret:{row:0,col:2}}})
    term.draw(['KEEP'],panel)
    const note='A'.repeat(columns)+'B'.repeat(columns-3)
    term.draw([note],panel)
    assert.deepEqual(vt.lines.slice(0,3),['KEEP','A'.repeat(columns),'B'.repeat(columns-3)],'no old border remains beside the wrapped note')
    assert.deepEqual(vt.caret,{row:6,col:2});assert.equal(vt.scrolls,0)
    const before=writes;term.draw([],panel);assert.equal(writes,before+1);assert.deepEqual(vt.caret,{row:6,col:2})
    term.close();assert.deepEqual(vt.lines.filter(Boolean),['KEEP','A'.repeat(columns),'B'.repeat(columns-3)])
    const closed=writes;term.close();assert.equal(writes,closed)
  })
}

test('TTY physical note rows preserve all text, separators and grapheme clusters',()=>{
  const output:string[]=[]
  const term=openTerm({out:{isTTY:true,write:s=>output.push(s)},columnsOf:()=>8,rowsOf:()=>24,term:'xterm-256color',height:3})
  const source='abc中文 · e\u0301X  中文尾'
  term.draw([source],()=>['PANEL','',''])
  const note=output[0]!.slice(0,output[0]!.indexOf('\r\x1b[2KPANEL'))
  const physical=note.split('\n').slice(0,-1).map(s=>s.replace(/^\r\x1b\[2K/,''))
  assert.deepEqual(physical,['abc中文 ','· e\u0301X  中','文尾'])
  assert.equal(physical.join(''),source,'permanent words and punctuation are never trimmed')
})

test('a note ending exactly at the right margin creates no extra empty physical row',()=>{
  const vt=screen(8,24),term=openTerm({out:{isTTY:true,write:s=>vt.put(s)},columnsOf:()=>8,rowsOf:()=>24,term:'xterm-256color',height:3})
  term.draw(['12345678'],()=>({rows:['PANEL','',''],input:{rows:['> '],caret:{row:0,col:2}}}))
  assert.deepEqual(vt.caret,{row:4,col:2});term.close();assert.deepEqual(vt.lines.filter(Boolean),['12345678'])
})

test('headless and short-screen floors keep the original permanent bytes without rendering',()=>{
  for(const [tty,rows] of [[false,24],[true,2]] as const){
    const output:string[]=[];let render=0;const source='long 中文 · note  with spaces'
    const term=openTerm({out:{isTTY:tty,write:s=>output.push(s)},columnsOf:()=>8,rowsOf:()=>rows,term:'xterm-256color'})
    term.draw([source,''],()=>{render++;return []});term.close()
    assert.equal(render,0);assert.equal(output.join(''),source+'\n\n');assert.ok(!output.join('').includes('\x1b'))
  }
})
