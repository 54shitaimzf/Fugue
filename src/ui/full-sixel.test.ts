import assert from 'node:assert/strict'
import {test} from 'node:test'
import {openTerm} from './term.ts'
// Independent ASCII VT: normal/alternate planes, resize, pixels, erases and caret.
// All expectations refer to visible cells and history, never product move counts.
class VT {
 columns=40;rows=24;x=0;y=0;saved=[0,0];scrolls=0;alt=false
 grid:string[][]=[];normal:{grid:string[][];x:number;y:number}|null=null
 constructor(){this.grid=this.empty()}
 empty(){return Array.from({length:this.rows},()=>Array(this.columns).fill(' '))}
 resize(c:number,r:number){this.columns=c;this.rows=r;const fit=(g:string[][])=>Array.from({length:r},(_,y)=>Array.from({length:c},(_,x)=>g[y]?.[x]??' '));this.grid=fit(this.grid);this.x=Math.min(this.x,c-1);this.y=Math.min(this.y,r-1);if(this.normal){this.normal.grid=fit(this.normal.grid);this.normal.x=Math.min(this.normal.x,c-1);this.normal.y=Math.min(this.normal.y,r-1)}}
 line(){this.y++;if(this.y>=this.rows){this.grid.shift();this.grid.push(Array(this.columns).fill(' '));this.y=this.rows-1;this.scrolls++}}
 feed(raw:string){for(const m of raw.matchAll(/\x1bP.*?\x1b\\|\x1b[78]|\x1b\[([?\d;]*)([A-Za-z])|[^\x1b\r\n]+|[\r\n]/gs)){
  const s=m[0]
  if(s.startsWith('\x1bP')){const dims=/"1;1;(\d+);(\d+)/.exec(s)!;const w=Math.ceil(Number(dims[1])/10),h=Math.ceil(Number(dims[2])/20);for(let dy=0;dy<h;dy++)for(let dx=0;dx<w;dx++)if(this.grid[this.y+dy]?.[this.x+dx]!==undefined)this.grid[this.y+dy]![this.x+dx]='@'}
  else if(s==='\x1b7')this.saved=[this.x,this.y]
  else if(s==='\x1b8')[this.x,this.y]=this.saved as [number,number]
  else if(m[2]){
   const args=(m[1]??'').replace('?','').split(';').map(Number),n=args[0]||1
   if(m[1]==='?1049'&&m[2]==='h'){this.normal={grid:this.grid.map(r=>r.slice()),x:this.x,y:this.y};this.alt=true;this.grid=this.empty()}
   else if(m[1]==='?1049'&&m[2]==='l'){if(this.normal){this.grid=this.normal.grid;this.x=this.normal.x;this.y=this.normal.y;this.normal=null};this.alt=false}
   else if(m[2]==='A')this.y=Math.max(0,this.y-n)
   else if(m[2]==='B')this.y=Math.min(this.rows-1,this.y+n)
   else if(m[2]==='C')this.x=Math.min(this.columns-1,this.x+n)
   else if(m[2]==='D')this.x=Math.max(0,this.x-n)
   else if(m[2]==='H'){this.y=Math.max(0,Math.min(this.rows-1,(args[0]||1)-1));this.x=Math.max(0,Math.min(this.columns-1,(args[1]||1)-1))}
   else if(m[2]==='J'&&args[0]===2)this.grid=this.empty()
   else if(m[2]==='K')this.grid[this.y]=Array(this.columns).fill(' ')
   else if(m[2]==='X'){for(let at=this.x;at<Math.min(this.columns,this.x+n);at++)this.grid[this.y]![at]=' '}
   else if(m[2]==='M'){this.grid.splice(this.y,n);while(this.grid.length<this.rows)this.grid.push(Array(this.columns).fill(' '))}
  }else if(s==='\r')this.x=0
  else if(s==='\n')this.line()
  else for(const ch of s){if(this.x>=this.columns){this.x=0;this.line()}this.grid[this.y]![this.x++]=ch}
 }}
 text(){return this.grid.map(r=>r.join('').trimEnd())}
 pixels(){return this.grid.flat().filter(c=>c==='@').length}
}
const pixel={width:2,height:1,rgba:new Uint8Array([22,32,47,255,234,171,58,255])},picture={image:pixel,row:1,column:2,columns:12,rows:3}
const panel={rows:['picture.png','','','','status'],input:{rows:['> abc'],caret:{row:0,col:3}},image:picture}
const cell={width:10,height:20,colors:256,maxWidth:1000,maxHeight:1000}
function rig(extra:any={}){const vt=new VT();vt.feed('SHELL0\r\nSHELL1\r\n');const writes:string[]=[];const term=openTerm({term:'xterm-sixel',graphics:'sixel',sixelCells:()=>cell,alternateScreenOf:()=>vt.alt,full:true,height:5,columnsOf:()=>vt.columns,rowsOf:()=>vt.rows,...extra,out:{isTTY:true,write:(s:string)=>{writes.push(s);vt.feed(s)}}});return {vt,writes,term,draw:(notes:string[]=[])=>term.draw(notes,()=>panel)}}
test('full Sixel rebuilds inside its alternate plane after size changes, preserving visible permanent notes and normal history',()=>{
 for(const [columns,rows] of [[30,24],[80,24],[40,12],[40,30]]){
  const r=rig();r.draw(['KEEP HISTORY']);r.draw();assert.equal(r.vt.pixels(),36);r.vt.resize(columns!,rows!);const before=r.vt.scrolls;r.draw()
  assert.equal(r.vt.pixels(),36,'exactly one owned bitmap, no previous placement or cropped tail');assert.equal(r.vt.text()[0],'KEEP HISTORY')
  assert.deepEqual([r.vt.x,r.vt.y],[3,6]);assert.equal(r.vt.scrolls-before,0,'resize rebuild fits the new viewport')
  const at=r.writes.length;r.term.close();assert.equal(r.writes.length,at+1);assert.equal(r.vt.alt,false);assert.equal(r.vt.pixels(),0)
  assert.deepEqual(r.vt.text().slice(0,2),['SHELL0','SHELL1'],'ordinary shell history is outside the owned plane')
 }
})
test('a severely short full viewport clears old graphics, prints recent notes, and can reopen without stale UI',()=>{
 const r=rig();r.draw(['KEEP HISTORY']);r.draw();r.vt.resize(30,3);r.draw(['NEW NOTE'])
 assert.equal(r.vt.pixels(),0);assert.ok(r.vt.text().includes('NEW NOTE'));assert.ok(r.vt.text().every(s=>!s.includes('picture.png')&&!s.includes('status')&&!s.includes('> abc')))
 r.vt.resize(40,24);r.draw();assert.equal(r.vt.pixels(),36);assert.ok(r.vt.text().includes('NEW NOTE'));r.term.close()
 assert.deepEqual(r.vt.text().slice(0,2),['SHELL0','SHELL1'])
})
test('full Sixel close immediately after resize restores normal history, with no redraw required',()=>{
 const r=rig();r.draw(['KEEP HISTORY']);r.draw();r.vt.resize(30,3);r.term.close();assert.equal(r.vt.alt,false);assert.equal(r.vt.pixels(),0)
 assert.deepEqual(r.vt.text().slice(0,2),['SHELL0','SHELL1']);const at=r.writes.length;r.term.close();assert.equal(r.writes.length,at)
})
test('recent alternate-plane notes are limited by the available viewport',()=>{
 const r=rig();for(let i=0;i<30;i++)r.draw(['NOTE'+String(i).padStart(2,'0')]);r.vt.resize(30,12);r.draw()
 const notes=r.vt.text().filter(s=>s.startsWith('NOTE'));assert.deepEqual(notes,['NOTE24','NOTE25','NOTE26','NOTE27','NOTE28','NOTE29'])
 assert.equal(r.vt.pixels(),36);assert.deepEqual([r.vt.x,r.vt.y],[3,11]);r.term.close();assert.deepEqual(r.vt.text().slice(0,2),['SHELL0','SHELL1'])
})

test('narrowing splits each long note without losing spaces, and replays the most recent complete physical rows',()=>{
 const r=rig(),note=(i:number)=>'NOTE'+String(i).padStart(2,'0')+' '+'0123456789'.repeat(3)
 for(let i=0;i<30;i++)r.draw([note(i)]);r.vt.resize(30,12);const before=r.vt.scrolls;r.draw()
 const lines=r.vt.text().slice(0,6);assert.deepEqual([lines[0]!+lines[1]!,lines[2]!+lines[3]!,lines[4]!+lines[5]!],[note(27),note(28),note(29)])
 assert.equal(r.vt.scrolls-before,0);assert.equal(r.vt.pixels(),36);assert.deepEqual([r.vt.x,r.vt.y],[3,11])
 r.term.close();assert.deepEqual(r.vt.text().slice(0,2),['SHELL0','SHELL1'])
})

test('unknown or rejected alternate-screen ownership stays byte-identical to full text through resize and close',()=>{
 for(const mode of [undefined,()=>false]){
  const text=rig({graphics:'none',sixelCells:undefined,alternateScreenOf:undefined}),unknown=rig({alternateScreenOf:mode})
  for(const r of [text,unknown]){r.draw(['KEEP HISTORY']);r.vt.resize(30,12);r.draw();r.vt.resize(30,3);r.draw(['NEW NOTE']);r.term.close()}
  assert.equal(unknown.writes.join(''),text.writes.join(''),'unverified ownership cannot add DCS, plane erase or replay')
  assert.equal(unknown.vt.pixels(),0)
 }
})

test('losing verified ownership discards stale image erases instead of moving into normal history',()=>{
 const r=rig();r.draw(['KEEP HISTORY']);r.draw();assert.equal(r.vt.pixels(),36)
 r.vt.feed('\x1b[?1049l');const at=r.writes.length;r.vt.resize(30,12);r.draw();r.term.close()
 const raw=r.writes.slice(at).join('');assert.doesNotMatch(raw,/\x1bP|\x1b[78]|\x1b\[\d+X|\x1b\[2J/,'no image or plane erase without current ownership')
})

test('close after ownership is lost never sends stale alternate-plane image cleanup to the normal plane',()=>{
 const r=rig();r.draw(['KEEP HISTORY']);r.draw();assert.equal(r.vt.pixels(),36);r.vt.feed('\x1b[?1049l')
 const at=r.writes.length;r.term.close();assert.doesNotMatch(r.writes.slice(at).join(''),/\x1bP|\x1b[78]|\x1b\[\d+X|\x1b\[2J/)
})
