import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fitPixels, fitSixel } from './pixels.ts'
import type { PixelImage } from './image-codec.ts'

function solid(width:number,height:number):PixelImage {
  return {width,height,rgba:Uint8Array.from({length:width*height*4},(_,i)=>[240,32,80,255][i%4]!)}
}
test('pixel fit keeps ratio, natural dimensions by default, and bounded output',()=>{
  const source=solid(100,50),copy=source.rgba.slice()
  const fitted=fitPixels(source,40,40)!
  assert.deepEqual([fitted.width,fitted.height],[40,20]);assert.deepEqual(fitted.rgba,solid(40,20).rgba)
  assert.equal(fitPixels(source,200,200),source,'default fit does not magnify')
  assert.deepEqual(source.rgba,copy,'source is immutable')
  for(const [width,height] of [[1024,1024],[1,524289],[524289,1]]){
    const s=solid(width,height),f=fitPixels(s,width,height)!
    assert.ok(f.width*f.height<=262144);assert.ok(f.width<=width&&f.height<=height)
  }
})
test('explicit magnification keeps aspect and exact solid pixels',()=>{
  const f=fitPixels(solid(7,5),100,60,true)!
  assert.deepEqual([f.width,f.height],[84,60]);assert.deepEqual(f.rgba,solid(84,60).rgba)
})
test('area resampling preserves fine lines and premultiplied transparent edges',()=>{
  const rgba=Uint8Array.from([255,0,0,255,0,0,255,0])
  const f=fitPixels({width:2,height:1,rgba},1,1)!
  assert.deepEqual([...f.rgba],[255,0,0,128])
  const stripes=Uint8Array.from({length:8*4},(_,i)=>i%4===3?255:(Math.floor(i/4)%2?0:255))
  assert.deepEqual([...fitPixels({width:8,height:1,rgba:stripes},1,1)!.rgba],[128,128,128,255])
})
test('invalid image or pixel bounds fall back without allocating output',()=>{
  for(const change of [{width:0},{height:NaN},{rgba:new Uint8Array(3)}])assert.equal(fitPixels({...solid(1,1),...change},8,8),null)
  for(const [w,h] of [[0,8],[8,-1],[NaN,8],[8,Infinity],[2.5,8]])assert.equal(fitPixels(solid(1,1),w,h),null)
})
test('Sixel uses reported cell pixels and rounds its painted six-band footprint down to fit',()=>{
  const source=solid(100,100),place={columns:10,rows:2}
  const f=fitSixel(source,place,{width:8,height:17})!
  assert.deepEqual([f.width,f.height],[30,30])
  assert.ok(Math.ceil(f.height/6)*6<=place.rows*17)
  const other=fitSixel(solid(2,1),place,{width:16,height:24})!
  assert.deepEqual([other.width,other.height],[96,48],'actual cell aspect is used, not a guessed 1:2')
})
test('missing, invalid, too small or overflowing Sixel geometry stays text',()=>{
  const source=solid(2,1),place={columns:10,rows:2}
  for(const cell of [null,{width:0,height:24},{width:8,height:513},{width:2.5,height:24},{width:2,height:2}])assert.equal(fitSixel(source,place,cell),null)
  for(const p of [{columns:0,rows:2},{columns:10,rows:-1},{columns:1.5,rows:2},{columns:Infinity,rows:2}])assert.equal(fitSixel(source,p,{width:8,height:17}),null)
})
test('Sixel sample bounds hold over narrow cells, non-six heights and extreme aspect ratios',()=>{
  let count=0
  for(const [width,height] of [[1,200],[200,1],[7,5],[50,50]])for(const [cw,ch] of [[1,6],[8,17],[12,24],[512,512]])for(const [columns,rows] of [[1,1],[5,2],[40,6]]){
    const f=fitSixel(solid(width,height),{columns,rows},{width:cw,height:ch})!
    assert.ok(f.width<=columns*cw);assert.ok(Math.ceil(f.height/6)*6<=rows*ch);assert.ok(f.width*f.height<=262144);count++
  }
  assert.equal(count,48)
})
