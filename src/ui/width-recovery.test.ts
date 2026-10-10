import assert from 'node:assert/strict'
import {test} from 'node:test'
import {openTerm} from './term.ts'

// Independent hard-line host model: both documented XTerm height gravities.
// It keeps history separately and follows the resize cursor, not Term's region book.
function host(gravity:'south'|'north'){
 let rows=24,cols=40,x=0,y=0,grid=Array.from({length:rows},()=>''),history:string[]=[],writes=0
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
 resize(next:number,width=cols){cols=width;if(next<rows){const remove=gravity==='south'?Math.max(0,y-next+1):0;if(remove){history.push(...grid.slice(0,remove));grid=grid.slice(remove);y-=remove}grid=grid.slice(0,next)}else if(next>rows){const recovered=gravity==='south'?Math.min(next-rows,history.length):0;if(recovered){grid=[...history.splice(history.length-recovered),...grid];y+=recovered}while(grid.length<next)grid.push('')}rows=next;y=Math.min(y,rows-1)},
 }
}

for(const gravity of ['south','north'] as const)test(`normal ${gravity} width and height return erases only owned UI, with original history exact`,()=>{
 const vt=host(gravity);let phase='OLD',queries=0
 const term=openTerm({out:{isTTY:true,write:vt.put},term:'xterm',columnsOf:()=>vt.columns,rowsOf:()=>vt.rows,heightOf:()=>Math.max(7,vt.rows-3),requestCursor:(_rows,accept)=>{queries++;accept(...vt.cursor)}})
 const panel=(size:{height:number})=>({rows:Array.from({length:size.height},(_,i)=>`${phase}${i}`),input:{rows:['> '],caret:{row:0,col:2}}})
 term.draw(['SHELL0','SHELL1','FACT'],panel)
 for(const [width,height] of [[16,8],[24,6],[8,8],[16,12],[40,24],[8,8],[40,24]]){vt.resize(height!,width);phase='NOW';term.draw([],panel)}
 assert.ok(!vt.text.includes('OLD'),'old UI never remains in owned screen/history after full return');assert.deepEqual(vt.cursor,[23,2])
 const q=queries,w=vt.writes;term.draw([],panel);assert.equal(queries,q);assert.equal(vt.writes,w+1)
 term.close();const w1=vt.writes;term.close();assert.equal(vt.writes,w1);assert.ok(!vt.text.includes('NOW'));assert.ok(!vt.text.includes('> '))
 for(const fact of ['SHELL0','SHELL1','FACT'])assert.equal(vt.text.match(new RegExp(fact,'g'))?.length,1)
 console.log(`normal ${gravity} width return:40x24→16x8→24x6→8x8→16x12→40x24→8x8→40x24;UI0;facts each1;caret23,2;idle queries0;close2 bytes0`)
})

test('normal width return never erases unowned content: no/bad/stale reports retain bytes; wider, taller, permanent or graphical changes keep the original recovery floor',()=>{
 const run=(kind:string,lateFact=false,wide=false,tall=false,graphics=false)=>{let width=40,height=24;const raw:string[]=[],callbacks:((r:number,c:number)=>void)[]=[]
  const t=openTerm({out:{isTTY:true,write:s=>raw.push(s)},term:'xterm',columnsOf:()=>width,rowsOf:()=>height,heightOf:()=>Math.max(7,height-3),...(graphics?{graphics:'kitty' as const}:{}),...(kind==='none'?{}:{requestCursor:(_rows:number,accept:(r:number,c:number)=>void)=>{callbacks.push(accept);if(kind==='wrong')accept(height-1,9);else if(kind==='valid')accept(height-1,2)}})})
  const panel=(size:{height:number})=>({rows:Array(size.height).fill('TUI'),input:{rows:['> '],caret:{row:0,col:2}}})
  t.draw([],panel);width=16;height=8;t.draw([],panel);if(kind==='stale')callbacks[0]?.(23,2);if(lateFact)t.draw(['LATE FACT'],panel)
  width=wide?80:40;height=tall?32:24;raw.length=0;t.draw([],panel);const result=raw.join('');t.close();return result
 }
 const old=run('none');for(const kind of ['missing','wrong','stale'])assert.equal(run(kind),old)
 assert.ok(run('valid').includes('\x1b[2J\x1b[H'))
 for(const args of [[true,false,false,false],[false,true,false,false],[false,false,true,false],[false,false,false,true]] as const)assert.ok(!run('valid',...args).includes('\x1b[2J'))
 console.log('normal width floor:missing/wrong/stale bytes exact;fresh matching return clears owned viewport;new fact/wider/taller/graphics clear0')
})


test('a frame whose full visible prefix is its own emitted reserve clears old UI before the first narrow-window linefeed; original external history survives',()=>{
 for(const gravity of ['south','north'] as const){
  const vt=host(gravity),raw:string[]=[];const facts=Array.from({length:67},(_,i)=>`FACT${i}`)
  vt.put(facts.map(s=>s+'\r\n').join(''))
  const term=openTerm({out:{isTTY:true,write:s=>{raw.push(s);vt.put(s)}},term:'xterm',columnsOf:()=>vt.columns,rowsOf:()=>vt.rows,heightOf:()=>Math.max(7,vt.rows-3),requestCursor:(_r,accept)=>accept(...vt.cursor)})
  const panel=(size:{height:number})=>({rows:Array(size.height).fill('TUI'),input:{rows:['> '],caret:{row:0,col:2}}})
  term.draw([],panel);vt.resize(8,16);raw.length=0;term.draw([],panel)
  assert.ok(raw.join('').startsWith('\x1b[2J\x1b[H'),'prevent old owned prefix entering history at the first new LF')
  vt.resize(24,40);term.draw([],panel);term.close();assert.ok(!vt.text.includes('TUI'));for(const fact of facts)assert.equal(vt.text.split('\n').filter(s=>s.trimEnd()===fact).length,1)
 }
 console.log('owned prefix:reserve covers visible top;clear-before-LF two gravities;67 external facts each1;UI0')
})
