import assert from 'node:assert/strict'
import { test } from 'node:test'
import { openStage } from './stage.ts'
import { openSession } from './follow.ts'
import { openTerm } from './term.ts'
import { statusOf } from '../probe/status.ts'
import type { StatusRow } from '../probe/status.ts'
import { graphicsOf } from './image.ts'
import { gateFaceOf } from './gate.ts'
import { frameOf } from './frame.ts'
import { readStateOf, readImageAt, facesOf, faceRowsOf } from './read.ts'

const pixel={width:2,height:1,rgba:new Uint8Array([22,32,47,255,30,180,90,255])}
const write=(seq:number,path='preview.png'):StatusRow=>({pos:{writer:'agent/r1/1',seq},e:{t:'view/write',agent:'agent/r1/1',path,rev:seq,blob:String(seq).repeat(40),mode:0o100644}} as unknown as StatusRow)
const tick=()=>new Promise<void>(done=>setImmediate(done))
function rig(tier:'none'|'kitty'|undefined='kitty',width=40,height=24){
  let rows:StatusRow[]=[write(1)],columns=width,termRows=height,redraws=0,gate=false
  const requests:{request:unknown;signal:AbortSignal;resolve:(p:typeof pixel|null)=>void}[]=[]
  const stage=openStage({note:()=>{},redraw:()=>{redraws+=1},hint:()=>'',keysOf:()=>'',columns:()=>columns,termRows:()=>termRows,rows:()=>rows,pendingFace:async()=>gate?gateFaceOf({round:'r1',fingerprint:'new',same:[],contracts:[]},{}):null,run:()=>null,now:()=>0,abort:()=>{},
    graphics:tier===undefined?undefined:()=>tier,readImage:(request,signal)=>new Promise(resolve=>requests.push({request,signal,resolve}))})
  stage.setRaw(true);stage.onAdvance(rows)
  const session=openSession({view:stage.view});session.push(rows)
  const chunks:string[]=[]
  const term=openTerm({out:{isTTY:true,columns,rows:termRows,write:s=>chunks.push(s)},term:'xterm-kitty',graphics:tier,columnsOf:()=>columns,rowsOf:()=>termRows,heightOf:stage.heightWant})
  return {stage,session,term,chunks,requests,redraws:()=>redraws,
    draw:()=>{term.draw([],size=>session.panel(size));return chunks.at(-1)!},
    add:()=>{const e=write(2,'other.png');rows=[...rows,e];session.push([e]);stage.onAdvance(rows)},
    gate:()=>{gate=true;return stage.refreshGate()},
    resize:(w:number,h:number)=>{columns=w;termRows=h;stage.onResize()},
  }
}

test('visible PNG loads once, grows a real image plane, and unchanged draws never retransmit',async()=>{
  const r=rig()
  r.stage.onAction({action:'read'})
  assert.equal(r.requests.length,1)
  assert.deepEqual(r.requests[0]!.request,{agent:'agent/r1/1',path:'preview.png',blob:'1'.repeat(40)})
  const waiting=r.stage.view().read!
  assert.equal(waiting.rows.filter(s=>s==='').length,0,'loading does not reserve empty image rows')
  assert.ok(r.draw().includes('正在读取预览'))
  assert.ok(!r.chunks.join('').includes('\x1b_G'))
  r.requests[0]!.resolve(pixel);await tick()
  const frame=r.session.panel({columns:40,height:r.stage.heightWant()})
  assert.ok(frame.image,'stage→session→frame carries actual pixels')
  assert.ok(frame.image.row>=1&&frame.image.row+frame.image.rows<=r.stage.heightWant()-2)
  const shown=r.draw();assert.ok(shown.includes('\x1b_Ga=T'))
  const unchanged=r.draw();assert.ok(!unchanged.includes('\x1b_G'))
  assert.equal(r.requests.length,1,'redraw is pure: no repeated file reads')
  r.stage.onAction({action:'cancel',key:'Esc'});r.draw()
  assert.ok(r.chunks.at(-1)!.includes('a=d,d=I'))
  assert.equal(r.stage.view().read,undefined)
  r.stage.close();r.term.close()
  console.log('PNG open: requests=1, empty loading rows=0; ready actual transfer=1; unchanged transfers=0; Esc scoped deletion=1')
})

test('close and face switch cancel pending previews; late results cannot reopen them',async()=>{
  const r=rig();r.stage.onAction({action:'read'});const first=r.requests[0]!
  r.stage.onAction({action:'complete'})
  assert.equal(first.signal.aborted,true)
  const count=r.redraws();first.resolve(pixel);await tick()
  assert.equal(r.redraws(),count,'late completion must not redraw another face')
  assert.equal(r.session.panel({columns:40,height:r.stage.heightWant()}).image,undefined)
  r.stage.onAction({action:'read'});r.stage.onAction({action:'read'})
  assert.equal(r.requests.length,2)
  r.stage.close();assert.equal(r.requests[1]!.signal.aborted,true)
  r.requests[1]!.resolve(pixel);await tick()
  assert.equal(r.stage.view().read?.preview,undefined)
  console.log('face switch/close abort=1 each; stale result redraw=0; stale pixels=0')
})

test('failed previews keep path and explanation; off/default and short-screen floors never fetch or draw pixels',async()=>{
  const r=rig();r.stage.onAction({action:'read'});r.requests[0]!.resolve(null);await tick()
  const p=r.session.panel({columns:40,height:r.stage.heightWant()})
  assert.ok(p.rows.join('\n').includes('preview.png'));assert.ok(p.rows.join('\n').includes('预览不可用'))
  assert.equal(p.image,undefined);r.stage.close()
  const off=rig('none');off.stage.onAction({action:'read'});off.draw()
  assert.equal(off.requests.length,0);assert.ok(!off.chunks.join('').includes('\x1b_G'));off.stage.close()
  const short=rig('kitty',40,8);short.stage.onAction({action:'read'})
  assert.equal(short.requests.length,0,'do not read pixels that cannot fit at least two rows')
  short.stage.close()
  for(const env of [{TERM:'linux',KITTY_WINDOW_ID:'1'},{TERM:'screen',KITTY_WINDOW_ID:'1'},{TERM:'xterm-kitty',TMUX:'socket'},{TERM:'xterm-kitty',STY:'screen'}])assert.equal(graphicsOf(env),'none')
  console.log('failure keeps path+text; off/short requests=0; inherited Kitty in kernel/mux graphics=none')
})


test('new visible selection and approval cancel reads; late results stay discarded',async()=>{
  const r=rig('kitty',80,30);r.stage.onAction({action:'read'});const first=r.requests[0]!
  r.add();r.stage.onAction({action:'historyNewer'});r.stage.onAction({action:'historyNewer'})
  assert.equal(first.signal.aborted,true)
  assert.equal(r.requests.length,2)
  assert.equal((r.requests[1]!.request as {path:string}).path,'other.png')
  const count=r.redraws();first.resolve(pixel);await tick();assert.equal(r.redraws(),count)
  await r.gate();assert.equal(r.requests[1]!.signal.aborted,true,'approval owns the face and cancels the image read')
  const afterGate=r.redraws();r.requests[1]!.resolve(pixel);await tick();assert.equal(r.redraws(),afterGate)
  assert.equal(r.session.panel({columns:80,height:r.stage.heightWant()}).image,undefined)
  r.stage.close();r.term.close()
  console.log('selection old abort=1; requests=2; approval abort=1; both stale redraws=0')
})

test('height/width changes cancel reads and remove images that no longer fit',async()=>{
  const r=rig('kitty',80,30);r.stage.onAction({action:'read'});r.draw()
  r.resize(40,8);assert.equal(r.requests[0]!.signal.aborted,true);r.draw()
  assert.equal(r.session.panel({columns:40,height:7}).image,undefined)
  r.resize(40,24);assert.equal(r.requests.length,2)
  r.requests[1]!.resolve(pixel);await tick();assert.ok(r.draw().includes('a=T'))
  r.resize(8,24);r.draw();assert.ok(r.session.panel({columns:8,height:r.stage.heightWant()}).image,'expanded height can show the complete image description at 8 columns');r.resize(4,24);const narrow=r.draw();assert.ok(narrow.includes('a=d,d=I'))
  assert.equal(r.requests.length,2,'an incomplete wrapped file description cannot start a new read')
  assert.equal(r.session.panel({columns:4,height:r.stage.heightWant()}).image,undefined)
  r.stage.close();r.term.close()
  console.log('80→40×8 abort=1; 40×24 requests=2 and image=1; 8 columns image fits; 4 columns image=0 and scoped delete=1')
})

test('default source capability is silent; loading adds one text line and no image reservation',()=>{
  const stage=openStage({note:()=>{},redraw:()=>{},hint:()=>'',keysOf:()=>'',columns:()=>40,termRows:()=>24,rows:()=>[write(1)],pendingFace:async()=>null,run:()=>null,now:()=>0,abort:()=>{},readImage:()=>{throw new Error('default capability must not read')}})
  stage.setRaw(true);stage.onAdvance([write(1)]);stage.onAction({action:'read'})
  const base=stage.view().read!
  assert.equal(base.preview,undefined)
  const f=frameOf({width:40,height:14,snapshot:statusOf([]),read:{...base,preview:{after:base.rows.length,state:'loading'}}})
  assert.equal(f.image,undefined)
  assert.equal(f.lines.filter(x=>x.includes('正在读取预览')).length,1)
  const plain=frameOf({width:40,height:14,snapshot:statusOf([]),read:base})
  const blanks=(lines:readonly string[])=>lines.filter(x=>/^[│|]\s*[│|]$/.test(x)).length
  assert.equal(blanks(f.lines),blanks(plain.lines)-1,'loading consumes exactly one text row')
  stage.close()
})

test('image coordinates follow wrapped descriptions and the truncated history marker',()=>{
  const rows=Array.from({length:205},(_,i)=>write(i+1,`目录/这是完整描述中需要折行的长文件路径/file-${i}.png`))
  const state=readStateOf(rows), text=faceRowsOf(facesOf(state),'diff',38)
  const top=text.findIndex(s=>s.includes('file-204.png'))
  // The filename can be on a continuation row; walk to the complete description start.
  let start=top;while(start>0&&!text[start]!.startsWith('写 '))start--
  const at=readImageAt(state,38,start,20)
  assert.ok(at);assert.equal(at.request.path,'目录/这是完整描述中需要折行的长文件路径/file-204.png')
  assert.ok(at.after>start);assert.equal(readImageAt(state,38,start+1,20),null)
  assert.equal(readImageAt(state,38,start,at.after-start+1),null,'one remaining row is not an image floor')
  console.log(`truncated text=${text.length} rows; final description starts=${start}, image after=${at.after}; partial description=none`)
})


test('loading remains adjacent to following file text without reserving blank image rows',()=>{
  const f=frameOf({width:40,height:14,snapshot:statusOf([]),read:{rows:['changes','image.png','following.txt'],top:0,preview:{after:2,state:'loading'}}})
  const loading=f.lines.findIndex(l=>l.includes('正在读取预览'))
  assert.ok(loading>0)
  assert.ok(f.lines[loading-1]!.includes('image.png'),'no empty preview reservation before the loading label')
  assert.ok(f.lines[loading+1]!.includes('following.txt'),'loading consumes one line, then the next file remains immediately visible')
  assert.equal(f.image,undefined)
})


test('queued drafts own the lower face and cancel an image that cannot be displayed',async()=>{
  const r=rig();r.stage.onAction({action:'read'});const request=r.requests[0]!
  r.stage.onAction({action:'insert',text:'another task',key:'a'});r.stage.onAction({action:'submit'})
  assert.equal(request.signal.aborted,true)
  request.resolve(pixel);await tick()
  assert.equal(r.session.panel({columns:40,height:r.stage.heightWant()}).image,undefined)
  r.stage.close();r.term.close()
})
