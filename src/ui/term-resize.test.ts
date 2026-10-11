import assert from 'node:assert/strict'
import { test } from 'node:test'
import { openTerm } from './term.ts'
import { screen } from '../../test/helpers/vt-screen.ts'

// 这一族的判据只claim**不缩小**的那几档：先前画过的 UI 行不会被切开或截掉。
// 模型并进 `vt-screen.ts`（那份按格存、认字形簇、数折行），两条本族自己的判据留在下面：
//   · **只许变大**——`resize` 那一层当场红（原模型里就是这么写的，原样搬过来）；
//   · **不许折行**——原模型是"写到边界下一格就红"，现在是 `wraps === 0`：同一件事，
//     改成数得出来的一个数，而且落在最后那一格上的折行也跑不掉（原模型那里漏）。
function host(cols:number,rows:number){
  let w=cols,h=rows
  const vt=screen(cols,rows)
  return {
    put:(raw:string):void=>{vt.put(raw);assert.equal(vt.wraps,0,'fixture must not wrap')},
    resize:(c:number,r:number):void=>{assert.ok(c>=w&&r>=h,'this fixture only claims non-shrinking dimensions');w=c;h=r;vt.resize(c,r)},
    get lines(){return vt.lines},
    get caret(){return vt.caret},
    get scrolls(){return vt.scrolls},
  }
}

for(const [name,c0,r0,c1,r1] of [['width',20,12,40,12],['height',20,12,20,24],['both',20,12,40,24]] as const){
  test(`growing ${name}: redraw replaces the old region, preserves history and keeps the input caret`,()=>{
    let columns:number=c0,rows:number=r0;const vt=host(columns,rows)
    const term=openTerm({out:{isTTY:true,write:s=>vt.put(s)},columnsOf:()=>columns,rowsOf:()=>rows,term:'xterm-256color',height:3})
    const panel=(label:string)=>({rows:[label,'',''],input:{rows:['> hi'],caret:{row:0,col:2}}})
    term.draw(['KEEP 1','KEEP 2'],()=>panel('OLD TUI'))
    columns=c1;rows=r1;vt.resize(columns,rows)
    term.draw([],()=>panel('NEW TUI'))
    assert.equal(vt.lines.filter(l=>l.includes('NEW TUI')).length,1)
    assert.equal(vt.lines.filter(l=>l.includes('OLD TUI')).length,0)
    assert.deepEqual(vt.lines.slice(0,2),['KEEP 1','KEEP 2']);assert.deepEqual(vt.caret,{row:5,col:2});assert.equal(vt.scrolls,0)
    term.close();assert.deepEqual(vt.lines.filter(Boolean),['KEEP 1','KEEP 2']);assert.equal(vt.scrolls,0)
  })
  test(`growing ${name}: close before the resize redraw still removes only the owned region`,()=>{
    let columns:number=c0,rows:number=r0;const vt=host(columns,rows);let writes=0
    const term=openTerm({out:{isTTY:true,write:s=>{writes++;vt.put(s)}},columnsOf:()=>columns,rowsOf:()=>rows,term:'xterm-256color',height:3})
    term.draw(['KEEP 1','KEEP 2'],()=>({rows:['OLD TUI','',''],input:{rows:['> hi'],caret:{row:0,col:2}}}))
    columns=c1;rows=r1;vt.resize(columns,rows);term.close()
    assert.deepEqual(vt.lines.filter(Boolean),['KEEP 1','KEEP 2']);assert.equal(vt.scrolls,0)
    const n=writes;term.close();assert.equal(writes,n,'repeated close writes nothing')
  })
}

test('headless growing dimensions still emits only permanent text and never calls the renderer',()=>{
  const written:string[]=[];let render=0
  const term=openTerm({out:{isTTY:false,write:s=>written.push(s)},term:'xterm-256color'})
  term.draw(['KEEP'],()=>{render++;return []});term.close()
  assert.equal(render,0);assert.equal(written.join(''),'KEEP\n');assert.ok(!written.join('').includes('\x1b'))
})


test('widening while the input shrinks clears its old last line and restores the caret from column zero',()=>{
  let columns=20;const vt=host(columns,12)
  const term=openTerm({out:{isTTY:true,write:s=>vt.put(s)},columnsOf:()=>columns,rowsOf:()=>12,term:'xterm-256color',height:3})
  term.draw(['KEEP 1','KEEP 2'],()=>({rows:['OLD TUI','',''],input:{rows:['> first','OLD INPUT TAIL'],caret:{row:1,col:2}}}))
  columns=40;vt.resize(columns,12)
  term.draw([],()=>({rows:['NEW TUI','',''],input:{rows:['> hi'],caret:{row:0,col:2}}}))
  assert.ok(!vt.lines.some(l=>l.includes('OLD')));assert.deepEqual(vt.caret,{row:5,col:2});assert.equal(vt.scrolls,0)
  term.close();assert.deepEqual(vt.lines.filter(Boolean),['KEEP 1','KEEP 2'])
})


test('a taller terminal may increase panel budget without expanding into permanent history',()=>{
  let rows=12,want=3;const vt=host(20,rows)
  const term=openTerm({out:{isTTY:true,write:s=>vt.put(s)},columnsOf:()=>20,rowsOf:()=>rows,heightOf:()=>want,term:'xterm-256color'})
  const panel=()=>({rows:['TUI',...Array(want-1).fill('')],input:{rows:['> hi'],caret:{row:0,col:2}}})
  term.draw(['KEEP 1','KEEP 2'],panel)
  rows=24;want=7;vt.resize(20,rows);term.draw([],panel)
  assert.deepEqual(vt.lines.slice(0,2),['KEEP 1','KEEP 2']);assert.deepEqual(vt.caret,{row:9,col:2});assert.equal(vt.scrolls,0)
  term.close();assert.deepEqual(vt.lines.filter(Boolean),['KEEP 1','KEEP 2'])
})
