import assert from 'node:assert/strict'
import {test} from 'node:test'
import {openCellProbe} from './cell-probe.ts'
import {decoderOf} from './keymap.ts'
import {imageSequence} from './image-codec.ts'
import {openImageLayer} from './image-layer.ts'
const base=['\x1b[?62;4;22c','\x1b[6;20;10t','\x1b[?80;2$y','\x1b[?1070;1$y']
const report=(n:number)=>`\x1b[?1;0;${n}S`
function rig(){let timeout=()=>{},changes=0;const writes:string[]=[];const probe=openCellProbe({write:s=>writes.push(s),changed:()=>changes++,wait:(_,fn)=>{timeout=fn;return ()=>{}}});return {probe,writes,expire:()=>timeout(),get changes(){return changes}}}
function permutations(a:string[]):string[][]{return a.length===0?[[]]:a.flatMap((v,i)=>permutations(a.filter((_,j)=>i!==j)).map(rest=>[v,...rest]))}
test('Sixel queries actual register capacity without changing it; four old reports alone cannot enable pixels',()=>{
 const r=rig();r.probe.start();base.forEach(r.probe.receive);assert.equal(r.probe.cell,null)
 assert.equal(r.writes.join(''),'\x1b[c\x1b[16t\x1b[?80$p\x1b[?1070$p\x1b[?1;1;0S')
 r.probe.receive(report(16));assert.deepEqual(r.probe.cell,{width:10,height:20,colors:16});assert.equal(r.changes,1);r.probe.close()
})
test('all 120 report orders remain atomic; fragmented color reports share the raw decoder',()=>{
 for(const reports of permutations([...base,report(32)])){
  const r=rig();r.probe.start();for(const [i,s] of reports.entries()){r.probe.receive(s);if(i<4)assert.equal(r.probe.cell,null)}
  assert.deepEqual(r.probe.cell,{width:10,height:20,colors:32});assert.equal(r.changes,1);r.probe.close()
 }
 const bytes=base.join('')+report(256)
 for(let split=1;split<bytes.length;split++){
  const r=rig();r.probe.start();const d=decoderOf(undefined,r.probe.receive);d.feed(bytes.slice(0,split));d.feed(bytes.slice(split))
  assert.deepEqual(r.probe.cell,{width:10,height:20,colors:256});r.probe.close()
 }
})
test('missing, failed and invalid capacity retains text; large reported capacity is bounded to 256',()=>{
 for(const reply of ['',report(0),report(1),'\x1b[?1;1S','\x1b[?1;2;256S','\x1b[?1;3;256S','\x1b[?1;0;1048576S']){
  const r=rig();r.probe.start();base.forEach(r.probe.receive);if(reply)r.probe.receive(reply);r.expire()
  assert.equal(r.probe.cell,null);assert.equal(r.changes,0);r.probe.close()
 }
 for(const n of [2,16,256,1024]){const r=rig();r.probe.start();[...base,report(n)].forEach(r.probe.receive);assert.equal(r.probe.cell?.colors,Math.min(n,256));r.probe.close()}
})
test('late capacity cannot be attached to a new request; refresh can change only color capacity',()=>{
 const r=rig();r.probe.start();base.forEach(r.probe.receive);r.expire();r.probe.start();base.forEach(r.probe.receive)
 r.probe.receive(report(16));assert.equal(r.probe.cell,null);r.probe.receive(report(256));assert.equal(r.probe.cell?.colors,256)
 r.probe.start();assert.equal(r.probe.cell,null);[...base,report(16)].forEach(r.probe.receive);assert.equal(r.probe.cell?.colors,16);assert.equal(r.changes,3);r.probe.close()
})
const rgba=new Uint8Array(32*32*4)
for(let y=0;y<32;y++)for(let x=0;x<32;x++)rgba.set([x*8,y*8,(x+y)*4,255],(y*32+x)*4)
const image={width:32,height:32,rgba},place={id:1,columns:12,rows:3}
test('Sixel palette definitions and every paint register stay below reported capacity',()=>{
 for(const colors of [2,4,16,32,256]){
  const raw=imageSequence(image,{...place,colors},'sixel'),defs=[...raw.matchAll(/#(\d+);2;/g)],all=[...raw.matchAll(/#(\d+)/g)]
  assert.equal(defs.length,colors,'gradient uses available registers');assert.ok(all.every(m=>Number(m[1])<colors),'no terminal-side wrap or clamping')
 }
 const tiny={width:2,height:1,rgba:new Uint8Array([15,20,32,255,32,41,60,255])}
 assert.equal(imageSequence(tiny,{...place,colors:2},'sixel'),imageSequence(tiny,place,'sixel'),'few-color source retains original palette exactly')
 assert.equal(imageSequence(image,{...place,colors:256},'sixel'),imageSequence(image,place,'sixel'),'old 256-color encoding remains byte-identical')
})
test('invalid encoder capacity emits no partial Sixel and never changes Kitty encoding',()=>{
 const kitty=imageSequence(image,place,'kitty')
 for(const colors of [0,1,257,NaN,1.5]){assert.equal(imageSequence(image,{...place,colors},'sixel'),'');assert.equal(imageSequence(image,{...place,colors},'kitty'),kitty)}
})
const picture={image,row:1,column:2,columns:12,rows:3},frame={columns:40,height:5,cursorRow:5,changed:null}
test('Sixel layer requires capacity and updates when only the capacity changes',()=>{
 let cell:any={width:10,height:20};const layer=openImageLayer('sixel',()=>cell)
 assert.deepEqual(layer.update(picture,frame),{before:'',after:''},'dimensions alone do not prove palette capacity')
 cell={...cell,colors:16};const initial=layer.update(picture,frame);assert.ok(initial.after.includes('\x1bP'))
 assert.ok([...initial.after.matchAll(/#(\d+)/g)].every(m=>Number(m[1])<16))
 const stable={...frame,changed:[false,false,false,false,false]};assert.deepEqual(layer.update(picture,stable),{before:'',after:''})
 cell={...cell,colors:256};const changed=layer.update(picture,stable);assert.match(changed.before,/\x1b\[12X/);assert.match(changed.after,/#255/)
 cell={...cell,colors:0};const lost=layer.update(picture,stable);assert.match(lost.before,/\x1b\[12X/);assert.equal(lost.after,'')
})
