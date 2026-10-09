import assert from 'node:assert/strict'
import {test} from 'node:test'
import {openTerm,CLEAR_LINE} from './term.ts'
const image={width:2,height:1,rgba:new Uint8Array([22,32,47,255,234,171,58,255])},picture={image,row:1,column:2,columns:12,rows:3}
const panel={rows:['picture.png','','','','status'],input:{rows:['> abc'],caret:{row:0,col:3}},image:picture}
const cell={width:10,height:20,colors:256,maxWidth:1000,maxHeight:1000}
const tx=(s:string)=>(s.match(/\x1bP0;1;0q/g)??[]).length
function rig(extra:any={}){const writes:string[]=[];const term=openTerm({term:'xterm-sixel',graphics:'sixel',sixelCells:()=>cell,height:5,columnsOf:()=>40,rowsOf:()=>24,...extra,out:{isTTY:true,...extra.out,write:(s:string)=>writes.push(s)}});return {term,writes,draw:(p:any=panel,note:string[]=[])=>{const at=writes.length;term.draw(note,()=>p);assert.equal(writes.length-at,1,'text and pixels share exactly one write');return writes.at(-1)!}}}
// Independent fixed-size VT geometry: track bitmap cells and caret, not encoded
// movement parameters as expected coordinates. ECH clears only intersecting cells.
function replay(raw:string){
 let x=0,y=0,saved=[0,0],bitmaps:number[][]=[];const notes=new Map<number,string>()
 for(const m of raw.matchAll(/\x1bP.*?\x1b\\|\x1b[78]|\x1b\[([?\d;]*)([A-Za-z])|[^\x1b\r\n]+|[\r\n]/gs)){
  const s=m[0]
  if(s.startsWith('\x1bP')){const size=/"1;1;(\d+);(\d+)/.exec(s)!;bitmaps.push([x,y,Math.ceil(Number(size[1])/10),Math.ceil(Number(size[2])/20)])}
  else if(s==='\x1b7')saved=[x,y]
  else if(s==='\x1b8')[x,y]=saved as [number,number]
  else if(m[2]){const n=Number(m[1])||1
   if(m[2]==='A')y=Math.max(0,y-n)
   else if(m[2]==='B')y=Math.min(23,y+n)
   else if(m[2]==='C')x=Math.min(39,x+n)
   else if(m[2]==='D')x=Math.max(0,x-n)
   else if(m[2]==='X')bitmaps=bitmaps.filter(b=>!(y>=b[1]!&&y<b[1]!+b[3]!&&x<b[0]!+b[2]!&&x+n>b[0]!))
   else if(m[2]==='K'){notes.delete(y);bitmaps=bitmaps.filter(b=>!(y>=b[1]!&&y<b[1]!+b[3]!))}
   else if(m[2]==='M'){for(let r=y;r<y+n;r++)notes.delete(r);bitmaps=bitmaps.filter(b=>b[1]!+b[3]!<=y||b[1]!>=y+n)}
  }else if(s==='\r')x=0
  else if(s==='\n'){y++;assert.ok(y<24,'fixed geometry scenario never scrolls')}
  else {notes.set(y,(notes.get(y)??'')+s);x+=s.length}
 }
 return {caret:[x,y],bitmaps,notes:[...notes.values()]}
}
test('actual Term writes Sixel with verified geometry; unchanged and unrelated rows retain pixels',()=>{
 const r=rig();const first=r.draw();assert.equal(tx(first),1);assert.match(first,/"1;1;120;60/)
 assert.deepEqual(replay(r.writes.join('')).caret,[3,5]);assert.deepEqual(replay(r.writes.join('')).bitmaps,[[2,1,12,3]])
 const same=r.draw();assert.equal(tx(same),0);assert.equal(same.split(CLEAR_LINE).length-1,0)
 const status=r.draw({...panel,rows:['picture.png','','','','new status']});assert.equal(tx(status),0)
 assert.deepEqual(replay(r.writes.join('')).bitmaps,[[2,1,12,3]]);r.term.close()
})
test('repaint, permanent notes, input shrink and hide clear the old anchored picture before repainting',()=>{
 let height=8;const r=rig({heightOf:()=>height});r.draw({...panel,input:{rows:['earlier','> abc'],caret:{row:1,col:3}}})
 assert.deepEqual(replay(r.writes.join('')).caret,[3,9]);height=5
 const repaint=r.draw({...panel,rows:['picture.png','repaint','','','status']});assert.equal(tx(repaint),1)
 assert.ok(repaint.indexOf('[12X')<repaint.indexOf(CLEAR_LINE));assert.deepEqual(replay(r.writes.join('')).caret,[3,5])
 assert.deepEqual(replay(r.writes.join('')).bitmaps,[[2,1,12,3]])
 const moved=r.draw(panel,['KEEP HISTORY']);assert.equal(tx(moved),1);const result=replay(r.writes.join(''))
 assert.deepEqual(result.caret,[3,6]);assert.deepEqual(result.bitmaps,[[2,2,12,3]]);assert.ok(result.notes.includes('KEEP HISTORY'))
 const {image:ignored,...text}=panel;assert.equal(tx(r.draw(text)),0);assert.deepEqual(replay(r.writes.join('')).bitmaps,[])
 r.term.close();assert.deepEqual(replay(r.writes.join('')).bitmaps,[]);assert.ok(replay(r.writes.join('')).notes.includes('KEEP HISTORY'))
})
test('closing actual Term erases owned Sixel cells once and keeps permanent history',()=>{
 const r=rig();r.draw(panel,['KEEP HISTORY']);const at=r.writes.length;r.term.close();assert.equal(r.writes.length,at+1)
 assert.ok(r.writes.at(-1)!.startsWith('\x1b7'));assert.equal((r.writes.at(-1)!.match(/\x1b\[12X/g)??[]).length,3)
 assert.deepEqual(replay(r.writes.join('')).bitmaps,[]);assert.ok(replay(r.writes.join('')).notes.includes('KEEP HISTORY'))
 r.term.close();assert.equal(r.writes.length,at+1)
})
test('missing capability, default off, invalid limits and nonTTY retain exact text bytes',()=>{
 const {image:ignored,...text}=panel
 function bytes(extra:any,p:any){const r=rig(extra);r.term.draw(['KEEP HISTORY'],()=>p);r.term.close();return r.writes.join('')}
 for(const extra of [{sixelCells:undefined},{sixelCells:()=>null},{graphics:undefined},{graphics:'none'},{sixelCells:()=>({...cell,maxHeight:5})}])assert.equal(bytes(extra,panel),bytes(extra,text))
 assert.equal(bytes({out:{isTTY:false}},panel),'KEEP HISTORY\n')
})
