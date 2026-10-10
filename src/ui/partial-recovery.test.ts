import assert from 'node:assert/strict'
import {test} from 'node:test'
import {openTerm} from './term.ts'

// Independent hard-line host: history is separate, with both XTerm resize gravities.
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

test('partial short frames establish owned blank prefix and retain the complete original history after repeated height returns',()=>{
 let cases=0,idles=0
 for(const gravity of ['south','north'] as const)for(const first of ['owned','facts']){
  const vt=host(gravity),facts=['SHELL0','SHELL1','KEEP FACT'];let phase='OLD',extra=0,grown=false
  if(first==='owned')vt.put(facts.join('\r\n')+'\r\n')
  const t=openTerm({out:{isTTY:true,write:vt.put},term:'xterm',columnsOf:()=>vt.columns,rowsOf:()=>vt.rows,heightOf:()=>vt.rows-4+extra,requestCursor:(_n,a)=>a(...vt.cursor)})
  const p=(s:{height:number})=>({rows:Array.from({length:s.height},(_,i)=>phase+i),input:{rows:['> draft'],caret:{row:0,col:2}}})
  t.draw(first==='facts'?facts:[],p)
  for(const n of [12,8,12,24]){
   vt.resize(n);phase='NOW';t.draw([],p);assert.deepEqual(vt.cursor,[n-1,2],'blank prefix anchors input at current bottom')
   const count=vt.writes;t.draw([],p);assert.equal(vt.writes,count+1);idles++
   if(n===12&&!grown){extra=3;grown=true;t.draw([],p);assert.deepEqual(vt.cursor,[11,2]);const count=vt.writes;t.draw([],p);assert.equal(vt.writes,count+1);idles++;extra=0}
  }
  t.close();t.close();assert.equal(vt.text.trimEnd(),facts.join('\n'),'complete history equality, including all lines, no old or current UI');cases++
 }
 console.log(`partial recovery:${cases} owned/fact prefixes x2 gravities;24→12→8→12→24;short UI9/5 leaves3 owned blanks;same-height growth consumes3 blanks;complete3-line history exact;idle${idles}`)
})

test('partial-frame fallback remains byte exact without complete proof, beyond capacity, with a nonbottom parent or new permanent facts',()=>{
 const run=(kind:string,context:string)=>{let rows=24;const raw:string[]=[],pending:((y:number,x:number)=>void)[]=[]
  const t=openTerm({out:{isTTY:true,write:s=>raw.push(s)},term:'xterm',columnsOf:()=>16,rowsOf:()=>rows,heightOf:()=>context==='overflow'?12:rows-4,
   ...(kind==='none'?{}:{requestCursor:(_n:number,a:(y:number,x:number)=>void)=>{pending.push(a);if(kind==='good')a(rows-1,2);if(kind==='wrong')a(rows-1,9);if(kind==='nonbottom')a(rows-2,2)}})})
  const p=(s:{height:number})=>({rows:Array.from({length:s.height},()=> 'TUI'),input:{rows:context==='overflow'?['draft','> ']:['> '],caret:{row:context==='overflow'?1:0,col:2}}})
  t.draw([],p);rows=context==='fractional'?12.5:12;t.draw(context==='fact'?['NEW FACT']:[],p);if(kind==='late')pending[0]?.(23,2);rows=24;t.draw([],p);t.close();return raw.join('')
 }
 for(const context of ['regular','overflow','fact','fractional'])for(const kind of ['missing','late','wrong','nonbottom'])assert.equal(run(kind,context),run('none',context))
 for(const context of ['overflow','fact','fractional'])assert.equal(run('good',context),run('none',context))
 console.log('partial recovery floor:16 missing/late/wrong/nonbottom cases and3 good-but-overflow/new-fact/fractional cases byte exact')
})

test('a permanent result after a proven partial shrink invalidates return clearing',()=>{
 const vt=host('south');const raw:string[]=[];const t=openTerm({out:{isTTY:true,write:s=>{raw.push(s);vt.put(s)}},term:'xterm',columnsOf:()=>vt.columns,rowsOf:()=>vt.rows,heightOf:()=>vt.rows-4,requestCursor:(_n,a)=>a(...vt.cursor)})
 const p=(s:{height:number})=>({rows:Array(s.height).fill('TUI'),input:{rows:['> '],caret:{row:0,col:2}}})
 t.draw(['SHELL0','SHELL1','KEEP FACT'],p);vt.resize(12);t.draw([],p);t.draw(['NEW FACT'],p);raw.length=0;vt.resize(24);t.draw([],p);assert.ok(!raw.join('').includes('\x1b[2J'));t.close()
 for(const fact of ['SHELL0','SHELL1','KEEP FACT','NEW FACT'])assert.equal(vt.text.split('\n').filter(l=>l===fact).length,1)
 console.log('partial recovery new result:temporary ownership invalidated;return full clear0;original and new fact each1')
})
