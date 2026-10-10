import assert from 'node:assert/strict'
import {test} from 'node:test'
import {openTerm} from './term.ts'

// The host independently keeps hard-line screen rows and scrollback. Width-only
// resizing truncates columns, retaining physical row coordinates; unlike Term,
// it has no previous frame/ownership book. Unhandled controls fail explicitly.
function host(){let cols=40,x=0,y=0,grid=Array<string>(24).fill(''),history:string[]=[],scrolls=0;const writes:string[]=[]
 const put=(raw:string)=>{writes.push(raw);for(let i=0;i<raw.length;){const c=raw[i++]!;if(c==='\x1b'){
  const m=/^\[([\d;]*)([A-Za-z])/.exec(raw.slice(i));assert.ok(m,'unhandled control');i+=m[0].length;const a=m[1]!.split(';').map(Number),n=a[0]||1
  if(m[2]==='A')y=Math.max(0,y-n);else if(m[2]==='B')y=Math.min(23,y+n);else if(m[2]==='C')x=Math.min(cols-1,x+n);else if(m[2]==='D')x=Math.max(0,x-n)
  else if(m[2]==='H'){y=Math.min(23,(a[0]||1)-1);x=Math.min(cols-1,(a[1]||1)-1)}
  else if(m[2]==='K')grid[y]='';else if(m[2]==='M')grid.splice(y,n,...Array(Math.min(n,24-y)).fill(''))
  else assert.fail('unhandled '+m[2])
 }else if(c==='\r')x=0;else if(c==='\n'){if(++y===24){history.push(grid.shift()!);grid.push('');y=23;scrolls++}}
 else{assert.ok(x<cols,'fixture must not wrap');grid[y]=grid[y]!.padEnd(x,' ').slice(0,x)+c+grid[y]!.slice(x+1);x++}}}
 return {put,get cols(){return cols},get cursor(){return [y,x] as const},get scrolls(){return scrolls},get writes(){return writes},get all(){return [...history,...grid].map(s=>s.trimEnd()).filter(Boolean)},resize(w:number){cols=w;grid=grid.map(s=>s.slice(0,w));x=Math.min(x,w-1)}}
}
test('trusted width-only changes replace the bottom hard-line UI in place, preserving every external line and full native row capacity',()=>{
 const vt=host(),original=Array.from({length:67},(_,i)=>`FACT${i}`);vt.put(original.map(s=>s+'\r\n').join(''));let phase='OLD',queries=0
 const term=openTerm({out:{isTTY:true,write:vt.put},columnsOf:()=>vt.cols,rowsOf:()=>24,term:'xterm',heightOf:()=>19,reserveHeightOf:()=>19,requestCursor:(_r,accept)=>{queries++;accept(...vt.cursor)}})
 const panel=({height}:{height:number})=>({rows:Array.from({length:height},(_,i)=>`${phase}${i}`),hint:'keys',input:{rows:['> hi'],caret:{row:0,col:2}}})
 term.draw([],panel);const initialScrolls=vt.scrolls
 for(const width of [16,8,24,40,16,40]){vt.resize(width);phase='NOW';term.draw([],panel);assert.equal(vt.scrolls,initialScrolls,'no UI linefeed reaches scrollback');for(const s of original)assert.equal(vt.all.filter(l=>l===s).length,1);assert.deepEqual(vt.cursor,[23,2]);const q=queries;term.draw([],panel);assert.equal(vt.writes.at(-1),'');assert.equal(queries,q)}
 term.close();assert.deepEqual(vt.all,original,'complete history equals every original line, with no old or current UI');const n=vt.writes.length;term.close();assert.equal(vt.writes.length,n)
 console.log('width-only:40x24→16x24→8x24→24x24→40x24→16x24→40x24;extra scroll0;67 originals exact;idles6 bytes0/query0;close2 bytes0')
})
test('width-only replacement also erases shortened old input tails inside the proven region without scrolling external history',()=>{
 const vt=host();vt.put('FACT0\r\nFACT1\r\n');let input=['one','two','> hi'];const term=openTerm({out:{isTTY:true,write:vt.put},columnsOf:()=>vt.cols,rowsOf:()=>24,term:'xterm',heightOf:()=>19,reserveHeightOf:()=>19,requestCursor:(_r,accept)=>accept(...vt.cursor)})
 const panel=()=>({rows:Array(19).fill('BODY'),input:{rows:input,caret:{row:input.length-1,col:2}}})
 term.draw([],panel);vt.resize(16);input=['> hi'];const scrolls=vt.scrolls;term.draw([],panel);assert.equal(vt.scrolls,scrolls);assert.ok(!vt.all.includes('one')&&!vt.all.includes('two'));term.close();assert.deepEqual(vt.all,['FACT0','FACT1'])
 console.log('width-only tail:old3 input rows→1;stale rows cleared only inside proven rectangle;extra scroll0;external FACT0/1 exact')
})
test('no, wrong or stale cursor replies retain the original width-change bytes; facts, graphics, changed heights, a nonbottom anchor and over-capacity input do not grant width-only positioning',()=>{
 const run=(kind:string)=>{let width=40,rows=24;const writes:string[]=[],pending:((y:number,x:number)=>void)[]=[];const term=openTerm({out:{isTTY:true,write:s=>writes.push(s)},columnsOf:()=>width,rowsOf:()=>rows,term:'xterm',heightOf:()=>19,reserveHeightOf:()=>19,...(kind==='graphics'?{graphics:'kitty' as const}:{}),...(kind==='none'?{}:{requestCursor:(_r:number,a:(y:number,x:number)=>void)=>{pending.push(a);if(kind==='wrong')a(23,9);else if(kind!=='stale')a(kind==='nonbottom'?22:23,2)}})})
 let input=['> hi'];const panel=()=>({rows:Array(19).fill('TUI'),hint:'keys',input:{rows:input,caret:{row:input.length-1,col:2}}});term.draw([],panel);width=16;if(kind==='height')rows=25;if(kind==='overflow')input=Array(8).fill('x');writes.length=0;term.draw(kind==='fact'?['NEW FACT']:[],panel);if(kind==='stale')pending[0]?.(23,2);const result=writes.join('');term.close();return result}
 const legacy=run('none');for(const k of ['wrong','stale'])assert.equal(run(k),legacy);assert.ok(run('valid').startsWith('\x1b[3;1H'))
 for(const k of ['fact','graphics','height','overflow','nonbottom'])assert.ok(!/^\x1b\[\d+;1H/.test(run(k)),k+' must not reposition a possibly foreign region')
 console.log('width-only floor:missing/wrong/stale bytes exact;new fact/graphics/height/overflow/nonbottom owned positioning0')
})
