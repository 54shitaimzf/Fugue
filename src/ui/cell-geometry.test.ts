import assert from 'node:assert/strict'
import {test} from 'node:test'
import {openCellProbe} from './cell-probe.ts'
import {decoderOf} from './keymap.ts'
import {fitSixel} from './pixels.ts'
import {openImageLayer} from './image-layer.ts'
import {MAX_IMAGE_PIXELS} from './image-codec.ts'
const base=['\x1b[?62;4;22c','\x1b[6;20;10t','\x1b[?80;2$y','\x1b[?1070;1$y','\x1b[?1;0;256S']
const geometry=(width:number,height:number)=>`\x1b[?2;0;${width};${height}S`
function rig(){let timeout=()=>{};const writes:string[]=[];const probe=openCellProbe({write:s=>writes.push(s),changed:()=>{},wait:(_,fn)=>{timeout=fn;return ()=>{}}});return {probe,writes,expire:()=>timeout()}}
function permutations(a:string[]):string[][]{return a.length===0?[[]]:a.flatMap((v,i)=>permutations(a.filter((_,j)=>i!==j)).map(rest=>[v,...rest]))}
test('known colors and cells cannot replace graphic limits; query geometry read-only',()=>{
 const r=rig();r.probe.start();base.forEach(r.probe.receive);assert.equal(r.probe.cell,null)
 assert.equal(r.writes.join(''),'\x1b[c\x1b[16t\x1b[?80$p\x1b[?1070$p\x1b[?1;1;0S\x1b[?2;1;0S')
 r.probe.receive(geometry(36,24));assert.deepEqual(r.probe.cell,{width:10,height:20,colors:256,maxWidth:36,maxHeight:24});r.probe.close()
})
test('all 720 six-report orders and fragmented geometry replies remain atomic',()=>{
 for(const reports of permutations([...base,geometry(36,24)])){
  const r=rig();r.probe.start();for(const [i,s] of reports.entries()){r.probe.receive(s);if(i<5)assert.equal(r.probe.cell,null)}
  assert.deepEqual(r.probe.cell,{width:10,height:20,colors:256,maxWidth:36,maxHeight:24});r.probe.close()
 }
 const bytes=base.join('')+geometry(36,24)
 for(let split=1;split<bytes.length;split++){const r=rig();r.probe.start();const d=decoderOf(undefined,r.probe.receive);d.feed(bytes.slice(0,split));d.feed(bytes.slice(split));assert.equal(r.probe.cell?.maxHeight,24);r.probe.close()}
})
test('unknown, failed and malformed geometry keeps text; explicit unlimited dimensions still obey our pixel ceiling',()=>{
 for(const s of ['',geometry(0,24),geometry(36,0),'\x1b[?2;1S','\x1b[?2;2;36;24S','\x1b[?2;3;36;24S','\x1b[?2;0;1048576;24S']){
  const r=rig();r.probe.start();base.forEach(r.probe.receive);if(s)r.probe.receive(s);r.expire();assert.equal(r.probe.cell,null);r.probe.close()
 }
 const r=rig();r.probe.start();[...base,geometry(0,0)].forEach(r.probe.receive);assert.equal(r.probe.cell?.maxWidth,MAX_IMAGE_PIXELS);assert.equal(r.probe.cell?.maxHeight,MAX_IMAGE_PIXELS);r.probe.close()
})
test('a late graphics-size reply never supplies refreshed geometry',()=>{
 const r=rig();r.probe.start();base.forEach(r.probe.receive);r.expire();r.probe.start();base.forEach(r.probe.receive)
 r.probe.receive(geometry(1000,1000));assert.equal(r.probe.cell,null);r.probe.receive(geometry(36,24));assert.equal(r.probe.cell?.maxWidth,36);r.probe.close()
})
const image={width:32,height:32,rgba:new Uint8Array(4096).fill(255)},p={image,row:1,column:2,columns:12,rows:3},frame={columns:40,height:5,cursorRow:5,changed:null},cell={width:10,height:20,colors:256,maxWidth:36,maxHeight:24}
test('Sixel contains both cell allocation and host graphics limits, including whole six-pixel bands',()=>{
 const fitted=fitSixel(image,p,cell,{width:36,height:24});assert.equal(fitted?.width,24);assert.equal(fitted?.height,24)
 for(const [width,height] of [[1,6],[35,23],[36,24],[1000,1000]]){
  const got=fitSixel(image,p,cell,{width,height});assert.ok(got);assert.ok(got.width<=Math.min(width,120));assert.ok(Math.ceil(got.height/6)*6<=Math.min(height,60))
 }
 for(const limits of [{width:0,height:24},{width:36,height:5},{width:NaN,height:24},{width:36,height:1.5}])assert.equal(fitSixel(image,p,cell,limits),null)
})
test('image layer requires graphic limits, and replaces when only the limit changes',()=>{
 let measured:any={width:10,height:20,colors:256};const layer=openImageLayer('sixel',()=>measured)
 assert.deepEqual(layer.update(p,frame),{before:'',after:''})
 measured=cell;assert.match(layer.update(p,frame).after,/"1;1;24;24/)
 const stable={...frame,changed:[false,false,false,false,false]};assert.deepEqual(layer.update(p,stable),{before:'',after:''})
 measured={...cell,maxWidth:1000,maxHeight:1000};const changed=layer.update(p,stable);assert.match(changed.before,/\x1b\[12X/);assert.match(changed.after,/"1;1;60;60/)
 measured={...cell,maxHeight:5};const lost=layer.update(p,stable);assert.match(lost.before,/\x1b\[12X/);assert.equal(lost.after,'')
})
