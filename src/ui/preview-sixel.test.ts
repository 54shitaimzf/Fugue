import assert from 'node:assert/strict'
import {test} from 'node:test'
import {openStage} from './stage.ts'
import {openSession} from './follow.ts'
import {openTerm,ALT_ON,ALT_OFF} from './term.ts'
import type {SixelCells} from './cell-probe.ts'
import type {StatusRow} from '../probe/status.ts'
const cell={width:10,height:20,colors:256,maxWidth:1000,maxHeight:1000}
const pixel={width:2,height:1,rgba:new Uint8Array([22,32,47,255,30,180,90,255])},tick=()=>new Promise<void>(r=>setImmediate(r))
const rows:StatusRow[]=[{pos:{writer:'agent/r1/1',seq:1},e:{t:'view/write',agent:'agent/r1/1',path:'preview.png',rev:1,blob:'1'.repeat(40),mode:0o100644}} as StatusRow]
function rig(){
 let cells:SixelCells|null=null,owned=false,columns=40;const writes:string[]=[],requests:{signal:AbortSignal,resolve:(p:typeof pixel|null)=>void}[]=[]
 const stage=openStage({note:()=>{},redraw:()=>{},hint:()=>'',keysOf:()=>'',columns:()=>columns,termRows:()=>24,rows:()=>rows,pendingFace:async()=>null,run:()=>null,now:()=>0,abort:()=>{},graphics:()=>cells&&owned?'sixel':'none',readImage:(_,signal)=>new Promise(resolve=>requests.push({signal,resolve}))})
 stage.setRaw(true);stage.onAdvance(rows);const session=openSession({view:stage.view});session.push(rows)
 const term=openTerm({out:{isTTY:true,write:s=>writes.push(s)},term:'xterm-sixel',full:true,graphics:'sixel',sixelCells:()=>cells,alternateScreenOf:()=>owned,columnsOf:()=>columns,rowsOf:()=>24,heightOf:stage.heightWant})
 return {stage,term,session,requests,writes,draw:()=>{term.draw([],size=>session.panel(size));return writes.at(-1)!},report:(c:SixelCells|null,owns:boolean)=>{cells=c;owned=owns;stage.onResize()},resize:(n:number)=>{columns=n;stage.onResize()}}
}
test('full Sixel PNG reading waits for actual ownership and cells, transfers real pixels once, and clears on Esc',async()=>{
 const r=rig();r.stage.onAction({action:'read'});r.draw();assert.equal(r.requests.length,0)
 r.report(cell,false);assert.equal(r.requests.length,0,'cells alone cannot authorize full pixels')
 r.report(null,true);assert.equal(r.requests.length,0,'screen alone cannot authorize unknown pixels')
 r.report(cell,true);assert.equal(r.requests.length,1);r.requests[0]!.resolve(pixel);await tick()
 assert.ok(r.session.panel({columns:40,height:r.stage.heightWant()}).image);assert.match(r.draw(),/\x1bP0;1;0q/)
 assert.doesNotMatch(r.draw(),/\x1bP/);assert.equal(r.requests.length,1)
 r.stage.onAction({action:'cancel',key:'Esc'});assert.match(r.draw(),/\x1b\[\d+X/);assert.equal(r.stage.view().read,undefined)
 r.stage.close();r.term.close();assert.ok(r.writes.at(-1)!.includes(ALT_OFF))
})
test('cell refresh cancels pending PNG, keeps verified screen ownership for resize, and ignores stale pixels',async()=>{
 const r=rig();r.stage.onAction({action:'read'});r.draw();r.report(cell,true);const old=r.requests[0]!
 r.report(null,true);r.resize(30);assert.equal(old.signal.aborted,true);const resized=r.draw();assert.ok(resized.includes('\x1b[2J\x1b[H'));assert.doesNotMatch(resized,/\x1bP/)
 old.resolve(pixel);await tick();assert.equal(r.session.panel({columns:30,height:r.stage.heightWant()}).image,undefined)
 r.report(cell,true);assert.equal(r.requests.length,2);r.requests[1]!.resolve(pixel);await tick();assert.match(r.draw(),/\x1bP0;1;0q/)
 r.stage.close();r.term.close()
})
test('enter notification runs after the whole frame is written and its geometry is recorded; never on nonTTY or plain short floors',()=>{
 let calls=0,repaint=false;const writes:string[]=[]
 const term=openTerm({out:{isTTY:true,columns:40,rows:24,write:s=>writes.push(s)},term:'xterm',height:5,full:true,onAlternateScreen:()=>{calls++;assert.ok(writes.at(-1)!.includes(ALT_ON));if(!repaint){repaint=true;term.draw([],()=>['body'])}}} as any)
 term.draw([],()=>['body']);assert.equal(calls,1);assert.ok(writes[1]!.startsWith('\x1b[5A'),'a callback redraw sees completed previous geometry');term.draw([],()=>['body']);assert.equal(calls,1);term.close()
 for(const out of [{isTTY:false,columns:40,rows:24},{isTTY:true,columns:40,rows:3}]){
  let n=0;const t=openTerm({out:{...out,write:()=>{}},term:'xterm',full:true,onAlternateScreen:()=>n++} as any);t.draw(['NOTE'],()=>[]);t.close();assert.equal(n,0)
 }
})
