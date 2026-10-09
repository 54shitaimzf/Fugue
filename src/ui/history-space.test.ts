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
test('dynamic normal panel reserves its own blank expansion space, never erases shell history, and leaves no old UI rows',()=>{
 const vt=screen(),writes:string[]=[];let height=8;const term=openTerm({out:{isTTY:true,columns:40,rows:24,write:s=>{writes.push(s);vt.put(s)}},term:'xterm',heightOf:()=>height})
 term.draw([],()=>panel(height,'old-'));retained(vt,['SHELL0','SHELL1']);let before=vt.scrolls;const initialScrolls=before
 height=20;term.draw([],()=>panel(height,'new-'));retained(vt,['SHELL0','SHELL1']);assert.equal(vt.scrolls-before,0,'reserved growth has zero scrolling')
 assert.equal(vt.all.some(s=>s.startsWith('old-')),false,'old UI never escapes into history');assert.equal(vt.visible.filter(s=>s.startsWith('new-')).length,20);assert.equal(vt.caret[0],2)
 term.draw([],()=>panel(height,'new-'));assert.equal(writes.at(-1),'','unchanged known-geometry redraw is silent')
 term.close();retained(vt,['SHELL0','SHELL1']);assert.equal(vt.all.some(s=>/^(old-|new-|> hi)/.test(s)),false,'close removes every UI row without erasing history')
 console.log(`owned blank expansion: initial scrolls ${initialScrolls}; growth scrolls ${vt.scrolls-initialScrolls}; shell occurrences 1/1; old/closed UI rows0`)
})
test('new permanent rows invalidate space above the panel; later growth preserves those facts by growing downward',()=>{
 const vt=screen();let height=8;const term=openTerm({out:{isTTY:true,columns:40,rows:24,write:vt.put},term:'xterm',heightOf:()=>height})
 term.draw([],()=>panel(height,'a-'));term.draw(['FACT0'],()=>panel(height,'b-'));term.draw(['FACT1'],()=>panel(height,'b-'));height=20;const before=vt.scrolls;term.draw([],()=>panel(height,'c-'))
 retained(vt,['SHELL0','SHELL1','FACT0','FACT1']);assert.ok(vt.scrolls-before<=12,'fallback scroll is bounded by the requested growth');assert.equal(vt.all.some(s=>/^(a-|b-)/.test(s)),false)
 term.close();retained(vt,['SHELL0','SHELL1','FACT0','FACT1']);assert.equal(vt.all.some(s=>/^(a-|b-|c-|> hi)/.test(s)),false)
 console.log(`facts invalidate ownership: growth scrolls ${vt.scrolls-before}/12; shell/fact occurrences 1 each; closed UI rows0`)
})
test('fixed panels and unknown geometry have no reserved ownership: growing input or frame preserves history by moving downward',()=>{
 for(const known of [false,true]){
  const vt=screen();let height=3;const term=openTerm({out:{isTTY:true,columns:40,...(known?{rows:24}:{}),write:vt.put},term:'xterm',...(known?{height:3}:{heightOf:()=>height})})
  term.draw([],()=>panel(3,'old-'));if(!known)height=13
  term.draw([],()=>known?{rows:['new-0','new-1','new-2'],input:{rows:['> a','  b','  c','  d','  e','  f'],caret:{row:5,col:2}}}:panel(height,'new-'))
  retained(vt,['SHELL0','SHELL1']);assert.equal(vt.all.some(s=>s.startsWith('old-')),false);assert.equal(vt.caret[0],2)
  term.close();retained(vt,['SHELL0','SHELL1']);assert.equal(vt.all.some(s=>/^(new-|> a|> hi|  [bcdef])/.test(s)),false)
 }
})
test('headless dynamic dimensions still emit only facts and never allocate or render a panel',()=>{
 const written:string[]=[];let rendered=0,height=8;const term=openTerm({out:{isTTY:false,rows:24,columns:40,write:s=>written.push(s)},term:'xterm',heightOf:()=>height})
 term.draw(['FACT0'],()=>{rendered++;return []});height=20;term.draw(['FACT1'],()=>{rendered++;return []});term.close()
 assert.equal(rendered,0);assert.equal(written.join(''),'FACT0\nFACT1\n')
})
