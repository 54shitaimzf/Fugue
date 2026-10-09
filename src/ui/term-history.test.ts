import assert from 'node:assert/strict'
import { test } from 'node:test'
import { openTerm } from './term.ts'

// Independent ASCII VT with delayed automatic wrapping. Unlike the old geometry
// model, this deliberately allows a permanent note to wrap over an existing UI.
function screen(columns:number,rows=24){
  let x=0,y=0,pending=false,scrolls=0
  const grid=Array.from({length:rows},()=>Array(columns).fill(' '))
  const down=()=>{if(++y>=rows){y=rows-1;scrolls++;grid.shift();grid.push(Array(columns).fill(' '))}}
  return {
    put(raw:string){for(let i=0;i<raw.length;){
      const c=raw[i++]!
      if(c==='\x1b'){
        const m=/^\[([\d;]*)([A-Za-z])/.exec(raw.slice(i));assert.ok(m,'unhandled control');i+=m[0].length
        const n=Number(m[1])||1;pending=false
        if(m[2]==='A')y=Math.max(0,y-n)
        else if(m[2]==='B')y=Math.min(rows-1,y+n)
        else if(m[2]==='C')x=Math.min(columns-1,x+n)
        else if(m[2]==='D')x=Math.max(0,x-n)
        else if(m[2]==='K')grid[y]=Array(columns).fill(' ')
        else if(m[2]==='M')grid.splice(y,n,...Array.from({length:Math.min(n,rows-y)},()=>Array(columns).fill(' ')))
        else assert.fail('unhandled CSI '+m[2])
      }else if(c==='\r'){x=0;pending=false}
      else if(c==='\n'){pending=false;down()}
      else {if(pending){x=0;down();pending=false}grid[y]![x]=c;if(++x>=columns){x=columns-1;pending=true}}
    }},
    get lines(){return grid.map(l=>l.join('').trimEnd())},get caret(){return [x,y]},get scrolls(){return scrolls},
  }
}

for(const columns of [8,16,40]){
  test(`permanent note at ${columns} columns clears every wrapped row and survives redraw/close`,()=>{
    const vt=screen(columns);let writes=0
    const term=openTerm({out:{isTTY:true,write:s=>{writes++;vt.put(s)}},columnsOf:()=>columns,rowsOf:()=>24,term:'xterm-256color',height:3})
    const panel=()=>({rows:['OLD','|'.repeat(columns),'TAIL'],input:{rows:['> '],caret:{row:0,col:2}}})
    term.draw(['KEEP'],panel)
    const note='A'.repeat(columns)+'B'.repeat(columns-3)
    term.draw([note],panel)
    assert.deepEqual(vt.lines.slice(0,3),['KEEP','A'.repeat(columns),'B'.repeat(columns-3)],'no old border remains beside the wrapped note')
    assert.deepEqual(vt.caret,[2,6]);assert.equal(vt.scrolls,0)
    const before=writes;term.draw([],panel);assert.equal(writes,before+1);assert.deepEqual(vt.caret,[2,6])
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
  const vt=screen(8),term=openTerm({out:{isTTY:true,write:s=>vt.put(s)},columnsOf:()=>8,rowsOf:()=>24,term:'xterm-256color',height:3})
  term.draw(['12345678'],()=>({rows:['PANEL','',''],input:{rows:['> '],caret:{row:0,col:2}}}))
  assert.deepEqual(vt.caret,[2,4]);term.close();assert.deepEqual(vt.lines.filter(Boolean),['12345678'])
})

test('headless and short-screen floors keep the original permanent bytes without rendering',()=>{
  for(const [tty,rows] of [[false,24],[true,2]] as const){
    const output:string[]=[];let render=0;const source='long 中文 · note  with spaces'
    const term=openTerm({out:{isTTY:tty,write:s=>output.push(s)},columnsOf:()=>8,rowsOf:()=>rows,term:'xterm-256color'})
    term.draw([source,''],()=>{render++;return []});term.close()
    assert.equal(render,0);assert.equal(output.join(''),source+'\n\n');assert.ok(!output.join('').includes('\x1b'))
  }
})
