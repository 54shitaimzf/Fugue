import assert from 'node:assert/strict'
import {test} from 'node:test'
import {openTerm} from './term.ts'

// Independent hard-line host model: both documented XTerm height gravities.
// It keeps history separately and follows the resize cursor, not Term's region book.
function host(gravity:'south'|'north'){
 let rows=24,cols=16,x=0,y=0,grid=Array.from({length:rows},()=>''),history:string[]=[],writes=0
 const put=(raw:string)=>{writes++;for(let i=0;i<raw.length;){const c=raw[i++]!;if(c==='\x1b'){
  const m=/^\[([\d;]*)([A-Za-z])/.exec(raw.slice(i));assert.ok(m,'unhandled sequence');i+=m[0].length;const a=m[1]!.split(';').map(Number),n=a[0]||1
  if(m[2]==='A')y=Math.max(0,y-n);else if(m[2]==='B')y=Math.min(rows-1,y+n);else if(m[2]==='C')x=Math.min(cols-1,x+n);else if(m[2]==='D')x=Math.max(0,x-n)
  else if(m[2]==='H'){y=Math.min(rows-1,(a[0]||1)-1);x=Math.min(cols-1,(a[1]||1)-1)}
  else if(m[2]==='J'){assert.equal(a[0],2);grid=Array.from({length:rows},()=>'')}
  else if(m[2]==='K')grid[y]='';else if(m[2]==='M')grid.splice(y,n,...Array.from({length:Math.min(n,rows-y)},()=>''))
  else assert.fail('unhandled '+m[2])
 }else if(c==='\r')x=0;else if(c==='\n'){if(++y>=rows){y=rows-1;history.push(grid.shift()!);grid.push('')}}
 else {assert.ok(x<cols,'fixture must not wrap');grid[y]=(grid[y]??'').padEnd(x,' ').slice(0,x)+c+(grid[y]??'').slice(x+1);x++}
 }}
 return {put,get rows(){return rows},get columns(){return cols},get cursor(){return [y,x] as const},get text(){return [...history,...grid].join('\n')},get writes(){return writes},
 resize(next:number){if(next<rows){const remove=gravity==='south'?Math.max(0,y-next+1):0;if(remove){history.push(...grid.slice(0,remove));grid=grid.slice(remove);y-=remove}grid=grid.slice(0,next)}else if(next>rows){const recovered=gravity==='south'?Math.min(next-rows,history.length):0;if(recovered){grid=[...history.splice(history.length-recovered),...grid];y+=recovered}while(grid.length<next)grid.push('')}rows=next;y=Math.min(y,rows-1)},
 }
}
for(const gravity of ['south','north'] as const)test(`normal ${gravity} height recovery keeps original facts and removes restored UI`,()=>{
 const vt=host(gravity);let phase='OLD',queries=0
 const term=openTerm({out:{isTTY:true,write:vt.put},term:'xterm',columnsOf:()=>vt.columns,rowsOf:()=>vt.rows,heightOf:()=>Math.max(7,vt.rows-3),
 requestCursor:(_rows,accept)=>{queries++;accept(...vt.cursor)}})
 const panel=(size:{height:number})=>({rows:Array.from({length:size.height},(_,i)=>`${phase}${i}`),input:{rows:['> draft'],caret:{row:0,col:2}}})
 term.draw(['SHELL0','SHELL1','KEEP FACT'],panel)
 for(const next of [8,6,8,24,8,24]){vt.resize(next);phase='NOW';term.draw([],panel)}
 assert.ok(!vt.text.includes('OLD'));assert.equal(vt.text.match(/SHELL0/g)?.length,1);assert.equal(vt.text.match(/SHELL1/g)?.length,1);assert.equal(vt.text.match(/KEEP FACT/g)?.length,1)
 assert.deepEqual(vt.cursor,[23,2]);const w=vt.writes,q=queries;term.draw([],panel);assert.equal(vt.writes,w+1,'empty write is the original quiet contract');assert.equal(queries,q,'idle does not ask for another cursor report')
 term.close();term.close();assert.ok(!vt.text.includes('NOW'));assert.ok(!vt.text.includes('draft'));for(const label of ['SHELL0','SHELL1','KEEP FACT'])assert.equal(vt.text.match(new RegExp(label,'g'))?.length,1)
 console.log(`normal ${gravity}: model24→8→6→8→24→8→24; old/current UI0; original facts each1; idle extraQueries0; draft caret retained`)
})

test('unknown, stale or wrong-column cursor reports keep exactly the old resize bytes',()=>{
 const run=(kind:string)=>{let rows=24;const raw:string[]=[],pending:((row:number,col:number)=>void)[]=[]
  const t=openTerm({out:{isTTY:true,write:s=>raw.push(s)},term:'xterm',columnsOf:()=>16,rowsOf:()=>rows,heightOf:()=>Math.max(7,rows-3),
   ...(kind==='none'?{}:{requestCursor:(_rows:number,accept:(row:number,col:number)=>void)=>{pending.push(accept);if(kind==='wrong')accept(23,9)}})})
  const p=(s:{height:number})=>({rows:Array(s.height).fill('TUI'),input:{rows:['> '],caret:{row:0,col:2}}})
  t.draw([],p);rows=8;t.draw([],p);if(kind==='late')pending[0]?.(23,2);rows=24;t.draw([],p);t.close();return raw.join('')
 }
 const original=run('none');for(const kind of ['missing','late','wrong'])assert.equal(run(kind),original)
 console.log('normal recovery fallback: missing/stale/wrong-column reports retain original bytes')
})

test('a fact inserted while short invalidates temporary-row recovery and stays in genuine history',()=>{
 const vt=host('south');const raw:string[]=[];const term=openTerm({out:{isTTY:true,write:s=>{raw.push(s);vt.put(s)}},term:'xterm',columnsOf:()=>vt.columns,rowsOf:()=>vt.rows,heightOf:()=>Math.max(7,vt.rows-3),requestCursor:(_rows,accept)=>accept(...vt.cursor)})
 const p=(s:{height:number})=>({rows:Array(s.height).fill('TUI'),input:{rows:['> '],caret:{row:0,col:2}}})
 term.draw(['SHELL0','SHELL1'],p);vt.resize(8);term.draw([],p);term.draw(['LATE FACT'],p);raw.length=0;vt.resize(24);term.draw([],p)
 assert.ok(!raw.join('').includes('\x1b[2J'));term.close();for(const label of ['SHELL0','SHELL1','LATE FACT'])assert.equal(vt.text.match(new RegExp(label,'g'))?.length,1)
 console.log('short-window fact: recovery invalidated; original facts and new permanent result each1')
})
