import assert from 'node:assert/strict'
import { test } from 'node:test'
import { openPixelProbe, CELL_WAIT_MS, MAX_CELL_REQUESTS } from './cell-probe.ts'
import { decoderOf } from './keymap.ts'

function rig(){
 const writes:string[]=[],timers:{fn:()=>void;active:boolean;ms:number}[]=[];let changes=0
 const probe=openPixelProbe({write:s=>writes.push(s),changed:()=>changes++,wait:(ms,fn)=>{const t={ms,fn,active:true};timers.push(t);return ()=>{t.active=false}}})
 const expire=()=>{for(const t of timers)if(t.active){t.active=false;t.fn()}}
 return {probe,writes,timers,expire,get changes(){return changes}}
}
const SIZE='\x1b[6;19;10t'
test('Kitty geometry uses the real raw report, with every possible fragment boundary',()=>{
 for(let split=1;split<SIZE.length;split++){
  const r=rig();r.probe.start();const decoder=decoderOf(undefined,r.probe.receive)
  assert.deepEqual(decoder.feed(SIZE.slice(0,split)),[]);assert.equal(r.probe.cell,null)
  assert.deepEqual(decoder.feed(SIZE.slice(split)),[]);assert.deepEqual(r.probe.cell,{width:10,height:19})
  assert.deepEqual(r.writes,['\x1b[16t']);assert.equal(r.changes,1);assert.equal(r.timers[0]!.ms,CELL_WAIT_MS);assert.equal(r.timers[0]!.active,false)
  r.probe.receive(SIZE);assert.equal(r.changes,1);r.probe.close()
 }
})
test('missing and invalid cell reports keep text; paste cannot authorize Kitty pixels',()=>{
 for(const bytes of ['\x1b[6;0;10t','\x1b[6;19;0t','\x1b[6;513;10t','\x1b[6;19;513t','\x1b[6;999999;10t']){
  const r=rig();r.probe.start();r.probe.receive(bytes);assert.equal(r.probe.cell,null);assert.equal(r.changes,0);r.probe.close()
 }
 for(const split of [false,true]){
  const r=rig();r.probe.start();const decoder=decoderOf(undefined,r.probe.receive)
  const chunks=split?['\x1b[200~'+SIZE.slice(0,4),SIZE.slice(4)+'\x1b[201~']:['\x1b[200~'+SIZE+'\x1b[201~']
  assert.deepEqual(chunks.flatMap(s=>decoder.feed(s)),[{action:'insert',text:SIZE}]);assert.equal(r.probe.cell,null);r.expire();assert.equal(r.probe.cell,null);r.probe.close()
 }
 const expired=rig();expired.probe.start();expired.expire();expired.probe.receive(SIZE);assert.equal(expired.probe.cell,null,'a report after expiry cannot revive the old geometry');expired.probe.close()
})
test('refresh invalidates old cells and retains expired FIFO positions; stale timers cannot erase a new result',()=>{
 const r=rig();r.probe.start();r.probe.receive(SIZE);assert.deepEqual(r.probe.cell,{width:10,height:19})
 r.probe.start();const stale=r.timers.at(-1)!.fn;assert.equal(r.probe.cell,null);r.expire();r.probe.start()
 r.probe.receive(SIZE);assert.equal(r.probe.cell,null,'expired response cannot enable a newer resize')
 r.probe.receive('\x1b[6;24;12t');assert.deepEqual(r.probe.cell,{width:12,height:24});stale();assert.deepEqual(r.probe.cell,{width:12,height:24})
 const changes=r.changes;r.probe.close();r.probe.receive(SIZE);r.probe.start();r.expire();assert.equal(r.probe.cell,null);assert.equal(r.changes,changes);assert.equal(r.timers.at(-1)!.active,false)
})
test('unanswered requests are bounded and closing emits no probe or callback',()=>{
 const r=rig();for(let i=0;i<MAX_CELL_REQUESTS+20;i++){r.probe.start();r.expire()}
 assert.equal(r.writes.length,MAX_CELL_REQUESTS);assert.equal(r.changes,0)
 r.probe.close();const writes=r.writes.length;r.probe.start();r.probe.receive(SIZE);assert.equal(r.writes.length,writes);assert.equal(r.probe.cell,null)
})
