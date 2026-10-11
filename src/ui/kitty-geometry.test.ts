import assert from 'node:assert/strict'
import { test } from 'node:test'
import { openImageLayer } from './image-layer.ts'
import { openTerm } from './term.ts'

const image={width:4,height:2,rgba:new Uint8Array(32).fill(255)}
const picture={image,row:1,column:2,columns:36,rows:6}
const frame={columns:40,height:10,cursorRow:9,changed:null}
function transfer(bytes:string){
 const packets=[...bytes.matchAll(/\x1b_G([^;]*);([^\x1b]*)\x1b\\/g)]
 assert.ok(packets.length>0,'an actual native-sized transfer')
 const keys=Object.fromEntries(packets[0]![1]!.split(',').map(s=>s.split('=')))
 const rgba=Buffer.from(packets.map(p=>p[2]).join(''),'base64')
 return {keys,rgba}
}

test('Kitty uses actual cell pixels and keeps the entire image aspect ratio without host stretching',()=>{
 for(const cell of [{width:10,height:19},{width:12,height:24},{width:9,height:18}]){
  const layer=openImageLayer('kitty',undefined,()=>cell)
  const sent=transfer(layer.update(picture,frame).after)
  const w=Number(sent.keys.s),h=Number(sent.keys.v)
  assert.equal(w,h*2,'source 2:1 ratio remains 2:1 in physical pixels')
  assert.equal(h,picture.rows*cell.height,'fits and fills the height-limited slot')
  assert.ok(w<=picture.columns*cell.width)
  assert.equal(sent.rgba.length,w*h*4)
  assert.equal(sent.keys.c,undefined,'no independent column stretch')
  assert.equal(sent.keys.r,undefined,'no independent row stretch')
  assert.equal(sent.keys.C,'1');assert.equal(sent.keys.q,'2')
  assert.ok(sent.rgba.every(n=>n===255),'entire opaque source, no crop or introduced border')
 }
})

test('unknown or invalid Kitty geometry clears only its old image and keeps the exact text floor',()=>{
 let cell:{width:number;height:number}|null={width:10,height:19}
 const layer=openImageLayer('kitty',undefined,()=>cell),first=transfer(layer.update(picture,frame).after)
 cell=null;const missing=layer.update(picture,frame)
 assert.equal(missing.before,`\x1b_Ga=d,d=I,i=${first.keys.i},q=2\x1b\\`)
 assert.equal(missing.after,'');assert.deepEqual(layer.update(picture,frame),{before:'',after:''})
 for(const bad of [null,{width:0,height:19},{width:10,height:513},{width:1.5,height:19},{width:NaN,height:19}]){
  cell=bad;assert.deepEqual(layer.update(picture,frame),{before:'',after:''})
 }
 const none=openImageLayer('none',undefined,()=>({width:10,height:19}))
 assert.deepEqual(none.update(picture,frame),{before:'',after:''})
})

test('Kitty cell refresh changes pixels once; unchanged and unrelated rows never retransmit',()=>{
 let cell={width:10,height:19};const layer=openImageLayer('kitty',undefined,()=>cell)
 const first=transfer(layer.update(picture,frame).after),still={...frame,changed:Array(10).fill(false)}
 assert.deepEqual(layer.update(picture,still),{before:'',after:''})
 cell={width:12,height:24};const next=layer.update(picture,still),pixels=transfer(next.after)
 assert.match(next.before,/a=d,d=I/);assert.equal(pixels.keys.i,first.keys.i)
 assert.equal(Number(pixels.keys.v),144)
 assert.deepEqual(layer.update(picture,still),{before:'',after:''})
 assert.match(layer.clear(),/a=d,d=I/);assert.equal(layer.clear(),'')
})

test('Term forwards Kitty cells; absent reports preserve the complete picture-free output',()=>{
 const panel={rows:['file.png','','','','','','','status'],input:{rows:['> '],caret:{row:0,col:2}},image:picture}
 function bytes(cell:{width:number;height:number}|null,withImage=true){
  const writes:string[]=[];const term=openTerm({term:'xterm-kitty',graphics:'kitty',kittyCells:()=>cell,columnsOf:()=>40,rowsOf:()=>24,height:10,out:{isTTY:true,write:s=>writes.push(s)}})
  const {image:ignored,...plain}=panel;term.draw([],()=>withImage?panel:plain);term.close();return writes.join('')
 }
 assert.equal(transfer(bytes({width:10,height:19})).keys.v,'114')
 assert.equal(bytes(null),bytes(null,false),'missing cell report is exact text bytes')
 assert.equal(bytes({width:0,height:19}),bytes(null,false),'invalid cells are exact text bytes')
})
