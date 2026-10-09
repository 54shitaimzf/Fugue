import assert from 'node:assert/strict'
import {test} from 'node:test'
import {openImageLayer} from './image-layer.ts'
const pixel={width:100,height:100,rgba:new Uint8Array(40000).fill(255)}
const picture={image:pixel,row:1,column:2,columns:10,rows:2}
const frame={columns:40,height:5,cursorRow:5,changed:null}
const cell={width:8,height:17,colors:256}
test('Sixel uses measured pixels at the picture anchor and restores the input caret',()=>{
 const layer=openImageLayer('sixel',()=>cell),r=layer.update(picture,frame)
 assert.equal(r.before,'');assert.match(r.after,/^\x1b7\x1b\[4A\r\x1b\[2C\x1bP0;1;0q"1;1;30;30/);assert.ok(r.after.endsWith('\x1b\\\x1b8'))
 assert.equal((r.after.match(/\x1bP/g)??[]).length,1)
})
test('unchanged and unrelated text rows do not retransmit; repaint restores the actual pixels',()=>{
 const layer=openImageLayer('sixel',()=>cell);layer.update(picture,frame)
 const stable={...frame,changed:[false,false,false,false,false,false]}
 assert.deepEqual(layer.update({...picture,image:{...pixel,rgba:pixel.rgba.slice()}},stable),{before:'',after:''})
 assert.deepEqual(layer.update(picture,{...stable,changed:[true,false,false,false,true,false]}),{before:'',after:''})
 const repaint=layer.update(picture,{...stable,changed:[false,true,false,false,false,false]})
 assert.match(repaint.before,/^\x1b7\x1b\[4A\r\x1b\[2C\x1b\[10X\x1b\[1B\x1b\[10X\x1b8$/)
 assert.match(repaint.after,/\x1bP0;1;0q/)
})
test('hide, replace and close erase only owned character cells, never paint a register-zero rectangle',()=>{
 const layer=openImageLayer('sixel',()=>cell);layer.update(picture,frame)
 const moved=layer.update({...picture,row:2,rows:2},frame)
 assert.match(moved.before,/\x1b\[4A/);assert.match(moved.after,/\x1b\[3A/)
 const hidden=layer.update(undefined,frame);assert.equal(hidden.after,'');assert.match(hidden.before,/\x1b\[3A/)
 assert.equal((hidden.before.match(/\x1b\[10X/g)??[]).length,2);assert.ok(!hidden.before.includes('\x1bP'),'erase restores terminal background without adding a black bitmap')
 assert.ok(!hidden.before.includes('[2J'),'no entire-screen clear');assert.equal(layer.clear(),'')
 layer.update(picture,frame);assert.equal(layer.clear(),hidden.before.replace('[3A','[4A'));assert.equal(layer.clear(),'')
})
test('unknown or invalid geometry retains the text floor; lost capability erases the old owned pixels',()=>{
 for(const geometry of [undefined,()=>null,()=>({width:0,height:17}),()=>({width:8,height:513})]){
  const layer=openImageLayer('sixel',geometry);assert.deepEqual(layer.update(picture,frame),{before:'',after:''});assert.equal(layer.clear(),'')
 }
 let measured:typeof cell|null=cell;const layer=openImageLayer('sixel',()=>measured);layer.update(picture,frame);measured=null
 const lost=layer.update(picture,frame);assert.match(lost.before,/\x1b\[10X/);assert.equal(lost.after,'');assert.equal(layer.clear(),'')
})
test('invalid picture position, dimensions or pixels never writes graphics',()=>{
 for(const change of [{row:-1},{row:4},{column:39},{rows:0},{columns:1.5},{image:{...pixel,rgba:new Uint8Array(3)}}]){
  const layer=openImageLayer('sixel',()=>cell);assert.deepEqual(layer.update({...picture,...change},frame),{before:'',after:''})
 }
})
test('different measured cells or source pixels replace the old image; dimensions are part of identity',()=>{
 let measured=cell;const layer=openImageLayer('sixel',()=>measured);layer.update(picture,frame)
 measured={width:12,height:24,colors:256};const resized=layer.update(picture,{...frame,changed:[false,false,false,false,false]})
 assert.match(resized.before,/\x1b\[10X/);assert.match(resized.after,/"1;1;48;48/)
 const replaced=layer.update({...picture,image:{...pixel,rgba:pixel.rgba.map((n,i)=>i%4===0?0:n)}},{...frame,changed:[false,false,false,false,false]})
 assert.match(replaced.before,/\x1b\[10X/);assert.match(replaced.after,/\x1bP/)
})

test('an identical frame hashes source pixels but never repeats area sampling',()=>{
 let reads=0
 const source={...pixel,get rgba(){reads++;return pixel.rgba}}
 const p={...picture,image:source},layer=openImageLayer('sixel',()=>cell)
 layer.update(p,frame);assert.ok(reads>100,'initial area sampling really reads pixel samples')
 reads=0;assert.deepEqual(layer.update(p,{...frame,changed:[false,false,false,false,false]}),{before:'',after:''})
 assert.ok(reads<10,`unchanged frame samples=${reads}: no resampling allocation or pixel loop`)
})
