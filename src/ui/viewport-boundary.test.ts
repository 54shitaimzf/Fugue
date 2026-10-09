import assert from 'node:assert/strict'
import {test} from 'node:test'
import {openTerm} from './term.ts'
const panel=(height:number)=>({rows:Array.from({length:height},()=> 'PANEL'),input:{rows:['> '],caret:{row:0,col:2}}})
test('a new panel filling the physical viewport has no stale rows beneath it; shrink never scrolls the new panel out',()=>{
 let rows=24;const chunks:string[]=[]
 const term=openTerm({out:{isTTY:true,columns:16,get rows(){return rows},write:s=>chunks.push(s)},term:'xterm',heightOf:()=>Math.min(13,rows-1)})
 term.draw([],s=>panel(s.height));chunks.length=0;rows=8;term.draw([],s=>panel(s.height))
 const raw=chunks.join('');assert.equal(raw.split('\n').length-1,7,'only the seven new frame rows advance; no eight stale rows can exist below a full viewport')
 assert.ok(raw.endsWith('> '),'caret remains on the current input row instead of returning to the top after stale scrolling');term.close()
})
test('normal full-viewport close erases owned cells without moving a whole screen into scrollback; unknown/partial/alt keep original delete bytes',()=>{
 for(const [rows,full] of [[8,false],[9,false],[undefined,false],[8,true]] as const){
  const chunks:string[]=[];const term=openTerm({out:{isTTY:true,columns:16,rows,write:s=>chunks.push(s)},term:'xterm',height:7,full})
  term.draw([],s=>panel(s.height));chunks.length=0;term.close();term.close();const raw=chunks.join('')
  if(rows===8&&!full){assert.equal(raw,'\x1b[7A'+Array.from({length:8},(_,i)=>'\r\x1b[2K'+(i===7?'':'\x1b[1B')).join('')+'\x1b[7A');assert.equal(raw.split('\n').length-1,0);assert.ok(!/\x1b\[\d*M/.test(raw))}
  else assert.equal(raw,'\x1b[7A\x1b[8M'+(full?'\x1b[?1049l':''))
 }
})
