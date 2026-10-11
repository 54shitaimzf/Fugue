import assert from 'node:assert/strict'
import {test} from 'node:test'
import {openTerm} from './term.ts'
import type {TermOptions,Panel} from './term.ts'
const image={image:{width:4,height:2,rgba:new Uint8Array(32).fill(255)},row:1,column:2,columns:12,rows:3}
const panel:Panel={rows:['CURRENT FACE','','','','status'],input:{rows:['> abc'],caret:{row:0,col:3}},image}
const parts=(s:string)=>[...s.matchAll(/\x1b_G(.*?)\x1b\\/gs)].map(m=>m[1]!)
function rig(extra:Partial<TermOptions>={}){
 let columns=40,rows=24,owned=true;const writes:string[]=[]
 const term=openTerm({term:'xterm-kitty',graphics:'none',full:true,height:5,columnsOf:()=>columns,rowsOf:()=>rows,alternateScreenOf:()=>owned,kittyCells:()=>({width:10,height:19}),...extra,out:{isTTY:true,write:s=>writes.push(s)}})
 return {term,writes,size:(c:number,r:number)=>{columns=c;rows=r},own:(v:boolean)=>{owned=v},draw:(notes:string[]=[],face:Panel=panel)=>{const n=writes.length;term.draw(notes,()=>face);assert.equal(writes.length,n+1);return writes.at(-1)!}}
}
test('every verified full plane rebuilds only its visible viewport after width or height changes',()=>{
 for(const [columns,rows] of [[30,24],[80,24],[40,12],[40,30]]){
  const r=rig();r.draw(['KEEP HISTORY']);r.size(columns!,rows!);const resized=r.draw()
  assert.ok(resized.startsWith('\x1b[2J\x1b[H'),'verified plain full view resets at the top, never leaves the old block')
  assert.equal(resized.split('KEEP HISTORY').length-1,1,'replay the owned permanent fact once')
  assert.equal(resized.split('CURRENT FACE').length-1,1)
  assert.equal(resized.split('\x1b[?1049h').length-1,0,'resize stays in the owned alternate plane')
  assert.ok(!resized.includes('\x1b[3J'),'normal scrollback is never erased')
  const at=r.writes.length;r.draw();assert.equal(r.writes.at(-1),'','the rebuilt unchanged frame emits zero bytes')
  r.term.close();assert.equal(r.writes.length,at+2);assert.match(r.writes.at(-1)!,/\x1b\[\?1049l$/)
 }
})
test('Kitty resize releases its own pixel ID before the plane erase and redraws exactly one placement',()=>{
 const r=rig({graphics:'kitty'});const first=r.draw(['KEEP HISTORY']),id=/(?:^|,)i=(\d+)/.exec(parts(first)[0]!)![1]!
 r.size(30,12);const resized=r.draw()
 assert.ok(resized.startsWith(`\x1b_Ga=d,d=I,i=${id},q=2\x1b\\\x1b[2J\x1b[H`),'text erase alone does not erase Kitty pictures')
 assert.equal(parts(resized).filter(s=>s.startsWith('a=d')).length,1)
 assert.equal(parts(resized).filter(s=>s.startsWith('a=T')).length,1)
 assert.match(resized,new RegExp('a=T[^;]*i='+id+','));assert.ok(!/a=d,d=[aAcCpP]/.test(resized))
 r.term.close()
})
test('missing or rejected ownership keeps the exact legacy full text path through resize, short and close',()=>{
 for(const owner of [undefined,()=>false]){
  const plain=rig({alternateScreenOf:undefined}),unknown=rig({graphics:'kitty',alternateScreenOf:owner})
  for(const r of [plain,unknown]){r.draw(['KEEP HISTORY']);r.draw();r.size(30,12);r.draw();r.size(30,3);r.draw(['NEW NOTE']);r.term.close()}
  assert.equal(unknown.writes.join(''),plain.writes.join(''),'unverified ownership adds neither pixels nor plane erases')
  assert.ok(!unknown.writes.join('').includes('\x1b[2J'))
 }
})
test('normal mode never resets the plane; losing full ownership can safely delete only Kitty IDs',()=>{
 const normal=rig({full:false});normal.draw(['KEEP HISTORY']);normal.size(30,12);assert.ok(!normal.draw().includes('\x1b[2J'));normal.term.close()
 const lost=rig({graphics:'kitty'});lost.draw();lost.own(false);lost.size(30,12);const raw=lost.draw()
 assert.ok(!raw.includes('\x1b[2J'));assert.equal(parts(raw).filter(s=>s.startsWith('a=T')).length,0,'do not place on an unowned plane')
 assert.equal(parts(raw).filter(s=>s.startsWith('a=d,d=I')).length,1,'ID-scoped delete is safe without stale cursor coordinates')
 lost.term.close()
})
