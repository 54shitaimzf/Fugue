import assert from 'node:assert/strict'
import { test } from 'node:test'
import { openTerm } from './term.ts'

// Independent fixed hard-line VT model. These assertions only claim non-shrinking
// dimensions, where previously rendered UI lines do not get split or clipped.
function screen(cols:number,rows:number){
  let grid=Array.from({length:rows},()=>Array(cols).fill(' ')),x=0,y=0,scrolls=0
  return {
    resize(c:number,r:number){assert.ok(c>=cols&&r>=rows);grid=Array.from({length:r},(_,i)=>Array.from({length:c},(_,j)=>grid[i]?.[j]??' '));cols=c;rows=r},
    put(raw:string){
      for(let i=0;i<raw.length;){
        const c=raw[i++]!
        if(c==='\x1b'){
          const m=/^\[([\d;]*)([A-Za-z])/.exec(raw.slice(i));assert.ok(m,'unhandled control');i+=m[0].length
          const n=Number(m[1])||1
          if(m[2]==='A')y=Math.max(0,y-n)
          else if(m[2]==='B')y=Math.min(rows-1,y+n)
          else if(m[2]==='C')x=Math.min(cols-1,x+n)
          else if(m[2]==='D')x=Math.max(0,x-n)
          else if(m[2]==='K')grid[y]=Array(cols).fill(' ')
          else if(m[2]==='M')grid.splice(y,n,...Array.from({length:Math.min(n,rows-y)},()=>Array(cols).fill(' ')))
          else assert.fail('unhandled CSI '+m[2])
        }else if(c==='\r')x=0
        else if(c==='\n'){if(++y>=rows){y=rows-1;scrolls++;grid.shift();grid.push(Array(cols).fill(' '))}}
        else {assert.ok(x<cols,'fixture must not wrap');grid[y]![x++]=c}
      }
    },
    get lines(){return grid.map(l=>l.join('').trimEnd())},get caret(){return [x,y]},get scrolls(){return scrolls},
  }
}

for(const [name,c0,r0,c1,r1] of [['width',20,12,40,12],['height',20,12,20,24],['both',20,12,40,24]] as const){
  test(`growing ${name}: redraw replaces the old region, preserves history and keeps the input caret`,()=>{
    let columns:number=c0,rows:number=r0;const vt=screen(columns,rows)
    const term=openTerm({out:{isTTY:true,write:s=>vt.put(s)},columnsOf:()=>columns,rowsOf:()=>rows,term:'xterm-256color',height:3})
    const panel=(label:string)=>({rows:[label,'',''],input:{rows:['> hi'],caret:{row:0,col:2}}})
    term.draw(['KEEP 1','KEEP 2'],()=>panel('OLD TUI'))
    columns=c1;rows=r1;vt.resize(columns,rows)
    term.draw([],()=>panel('NEW TUI'))
    assert.equal(vt.lines.filter(l=>l.includes('NEW TUI')).length,1)
    assert.equal(vt.lines.filter(l=>l.includes('OLD TUI')).length,0)
    assert.deepEqual(vt.lines.slice(0,2),['KEEP 1','KEEP 2']);assert.deepEqual(vt.caret,[2,5]);assert.equal(vt.scrolls,0)
    term.close();assert.deepEqual(vt.lines.filter(Boolean),['KEEP 1','KEEP 2']);assert.equal(vt.scrolls,0)
  })
  test(`growing ${name}: close before the resize redraw still removes only the owned region`,()=>{
    let columns:number=c0,rows:number=r0;const vt=screen(columns,rows);let writes=0
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
  let columns=20;const vt=screen(columns,12)
  const term=openTerm({out:{isTTY:true,write:s=>vt.put(s)},columnsOf:()=>columns,rowsOf:()=>12,term:'xterm-256color',height:3})
  term.draw(['KEEP 1','KEEP 2'],()=>({rows:['OLD TUI','',''],input:{rows:['> first','OLD INPUT TAIL'],caret:{row:1,col:2}}}))
  columns=40;vt.resize(columns,12)
  term.draw([],()=>({rows:['NEW TUI','',''],input:{rows:['> hi'],caret:{row:0,col:2}}}))
  assert.ok(!vt.lines.some(l=>l.includes('OLD')));assert.deepEqual(vt.caret,[2,5]);assert.equal(vt.scrolls,0)
  term.close();assert.deepEqual(vt.lines.filter(Boolean),['KEEP 1','KEEP 2'])
})


test('a taller terminal may increase panel budget without expanding into permanent history',()=>{
  let rows=12,want=3;const vt=screen(20,rows)
  const term=openTerm({out:{isTTY:true,write:s=>vt.put(s)},columnsOf:()=>20,rowsOf:()=>rows,heightOf:()=>want,term:'xterm-256color'})
  const panel=()=>({rows:['TUI',...Array(want-1).fill('')],input:{rows:['> hi'],caret:{row:0,col:2}}})
  term.draw(['KEEP 1','KEEP 2'],panel)
  rows=24;want=7;vt.resize(20,rows);term.draw([],panel)
  assert.deepEqual(vt.lines.slice(0,2),['KEEP 1','KEEP 2']);assert.deepEqual(vt.caret,[2,9]);assert.equal(vt.scrolls,0)
  term.close();assert.deepEqual(vt.lines.filter(Boolean),['KEEP 1','KEEP 2'])
})
