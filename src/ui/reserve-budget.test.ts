import assert from 'node:assert/strict'
import {test} from 'node:test'
import {openTerm} from './term.ts'

// Fixed hard-line VT with real scrollback. Initial cursor is after two existing
// shell rows, not at an imagined empty bottom. The model only accepts the output
// controls involved in this unit; an unhandled sequence fails rather than vanishes.
function screen(columns=40,rows=24){
 let lines=Array.from({length:rows},()=>''),history:string[]=[],x=0,y=0,scrolls=0
 const put=(raw:string)=>{for(let i=0;i<raw.length;){
  const c=raw[i++]!
  if(c==='\x1b'){
   const m=/^\[([\d;]*)([A-Za-z])/.exec(raw.slice(i));assert.ok(m,'unhandled control');i+=m[0].length;const n=Number(m[1])||1
   if(m[2]==='A')y=Math.max(0,y-n);else if(m[2]==='B')y=Math.min(rows-1,y+n);else if(m[2]==='C')x=Math.min(columns-1,x+n);else if(m[2]==='D')x=Math.max(0,x-n)
   else if(m[2]==='K')lines[y]='';else if(m[2]==='M'){lines.splice(y,n);while(lines.length<rows)lines.push('')}
   else assert.fail('unhandled CSI '+m[2])
  }else if(c==='\r')x=0
  else if(c==='\n'){if(++y===rows){history.push(lines.shift()!);lines.push('');y=rows-1;scrolls++}}
  else {assert.ok(x<columns,'fixture must not wrap');const s=lines[y]!;lines[y]=s.slice(0,x).padEnd(x,' ')+c+s.slice(x+1);x++}
 }}
 put('SHELL0\r\nSHELL1\r\n')
 return {put,get all(){return [...history,...lines].map(s=>s.trimEnd())},get visible(){return lines.map(s=>s.trimEnd())},get caret(){return [x,y]},get scrolls(){return scrolls}}
}
const panel=(height:number,label:string)=>({rows:Array.from({length:height},(_,n)=>`${label}${n}`),input:{rows:['> hi'],caret:{row:0,col:2}}})
function retained(vt:ReturnType<typeof screen>,expected:readonly string[]){for(const name of expected)assert.equal(vt.all.filter(s=>s===name).length,1,`${name} remains exactly once in visible screen or scrollback`)}
test('a stage-sized first allocation keeps existing shell rows visible and preserves complete repeated overlay reading',()=>{
 const vt=screen();let height=8,calls=0;const writes:string[]=[]
 const term=openTerm({out:{isTTY:true,columns:40,rows:24,write:s=>{writes.push(s);vt.put(s)}},term:'xterm',heightOf:()=>height,reserveHeightOf:()=>{calls++;return 13}})
 term.draw([],()=>panel(height,'old-'));assert.deepEqual(vt.visible.slice(0,2),['SHELL0','SHELL1']);assert.deepEqual(vt.caret,[2,15]);assert.equal(vt.scrolls,0);assert.equal(calls,1)
 for(const next of [13,8,13,8]){
  height=next;term.draw([],()=>panel(height,'new-'));retained(vt,['SHELL0','SHELL1']);assert.deepEqual(vt.visible.slice(0,2),['SHELL0','SHELL1']);assert.equal(vt.visible.filter(s=>s.startsWith('new-')).length,height,'the real requested frame height stays complete');assert.equal(vt.scrolls,0)
 }
 const before=vt.scrolls;term.draw([],()=>panel(height,'new-'));assert.equal(writes.at(-1),'');assert.equal(vt.scrolls,before);assert.equal(calls,1);term.close();retained(vt,['SHELL0','SHELL1']);assert.equal(vt.all.some(s=>/^(old-|new-|> hi)/.test(s)),false)
 console.log('stage max13: initial reserve5/LF13/scroll0, height8->13->8->13->8 complete, original shell visible1/1, idle bytes0, closed UI0')
})
test('missing maximum retains exact default allocation bytes; invalid maximum uses zero spare rows and still grows a complete panel',()=>{
 function bytes(reserveHeightOf?:()=>number,full=false){const written:string[]=[];let height=8;const term=openTerm({out:{isTTY:true,rows:24,columns:40,write:s=>written.push(s)},term:'xterm',heightOf:()=>height,reserveHeightOf,full});term.draw([],()=>panel(height,'a-'));height=13;term.draw([],()=>panel(height,'b-'));term.close();return written.join('')}
 assert.equal(bytes(),bytes(()=>23));assert.equal(bytes(()=>1000),bytes(),'oversized max stays bounded to exactly the existing available allocation');assert.equal(bytes(()=>13,true),bytes(undefined,true),'owned full plane retains its exact existing bytes')
 for(const value of [NaN,Infinity,-Infinity,-2,0,2]){
  const vt=screen();let height=8;const term=openTerm({out:{isTTY:true,rows:24,columns:40,write:vt.put},term:'xterm',heightOf:()=>height,reserveHeightOf:()=>value})
  term.draw([],()=>panel(height,'a-'));assert.deepEqual(vt.caret,[2,10],'invalid max creates no spare row');assert.deepEqual(vt.visible.slice(0,2),['SHELL0','SHELL1'])
  height=13;term.draw([],()=>panel(height,'b-'));retained(vt,['SHELL0','SHELL1']);assert.equal(vt.visible.filter(s=>s.startsWith('b-')).length,13);term.close();retained(vt,['SHELL0','SHELL1'])
 }
})
test('reservation maximum is read only for a known-geometry empty normal first frame; facts, headless, unknown and full keep their existing floor',()=>{
 for(const mode of ['known','facts','headless','unknown','full'] as const){
  let calls=0,rendered=0;const written:string[]=[];const term=openTerm({out:{isTTY:mode!=='headless',columns:40,...(mode==='unknown'?{}:{rows:24}),write:s=>written.push(s)},term:'xterm',full:mode==='full',heightOf:()=>8,reserveHeightOf:()=>{calls++;return 13}})
  term.draw(mode==='facts'?['FACT']:[],()=>{rendered++;return panel(8,'a-')});term.draw([],()=>{rendered++;return panel(8,'a-')});term.close()
  assert.equal(calls,mode==='known'?1:0);assert.equal(rendered,mode==='headless'?0:2);if(mode==='headless')assert.equal(written.join(''),'')
 }
})
