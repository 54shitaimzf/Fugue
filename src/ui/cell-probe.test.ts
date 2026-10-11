import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EventEmitter } from 'node:events'
import { decoderOf, openKeys } from './keymap.ts'
import { CELL_WAIT_MS, MAX_CELL_REQUESTS, openCellProbe } from './cell-probe.ts'

function rig(){
  const writes:string[]=[],timers:{ms:number;fn:()=>void;active:boolean}[]=[];let changes=0
  const probe=openCellProbe({write:s=>writes.push(s),changed:()=>changes++,wait:(ms,fn)=>{const t={ms,fn,active:true};timers.push(t);return ()=>{t.active=false}}})
  const expire=()=>{for(const t of timers)if(t.active){t.active=false;t.fn()}}
  return {probe,writes,timers,expire,get changes(){return changes}}
}
const DA='\x1b[?62;4;22c',SIZE='\x1b[6;24;12t',MODES='\x1b[?80;2$y\x1b[?1070;1$y\x1b[?1;0;256S\x1b[?2;0;1000;1000S'
const modes=(r:ReturnType<typeof rig>)=>{r.probe.receive('\x1b[?80;2$y');r.probe.receive('\x1b[?1070;1$y');r.probe.receive('\x1b[?1;0;256S');r.probe.receive('\x1b[?2;0;1000;1000S')}

test('Sixel capability needs both attribute 4 and actual cell pixels, in either report order',()=>{
  for(const pair of [[DA,SIZE],[SIZE,DA]]){
    const r=rig();r.probe.start();assert.deepEqual(r.writes,['\x1b[c\x1b[16t\x1b[?80$p\x1b[?1070$p\x1b[?1;1;0S\x1b[?2;1;0S']);assert.equal(r.probe.cell,null)
    r.probe.receive(pair[0]!);assert.equal(r.probe.cell,null);r.probe.receive(pair[1]!);modes(r);assert.deepEqual(r.probe.cell,{width:12,height:24,colors:256,maxWidth:1000,maxHeight:1000})
    assert.equal(r.changes,1);assert.equal(r.timers[0]!.ms,CELL_WAIT_MS);assert.equal(r.timers[0]!.active,false)
    r.probe.receive(SIZE);assert.equal(r.changes,1,'unsolicited duplicate is ignored');r.probe.close()
  }
})

test('missing, unsupported and invalid reports keep the complete text floor',()=>{
  for(const pair of [['\x1b[?62;22c',SIZE],[DA,'\x1b[6;0;12t'],[DA,'\x1b[6;24;513t'],[DA,'\x1b[6;999999;12t'],['\x1b[?4c',SIZE],['\x1b[?1;4c',SIZE]]){
    const r=rig();r.probe.start();for(const s of pair)r.probe.receive(s);modes(r);assert.equal(r.probe.cell,null);assert.equal(r.changes,0);r.probe.close()
  }
  const r=rig();r.probe.start();r.probe.receive(DA);r.expire();r.probe.receive(SIZE);assert.equal(r.probe.cell,null);assert.equal(r.changes,0);r.probe.close()
})

test('expired responses cannot supply a newer request, even when refresh happens before the old reply',()=>{
  const r=rig();r.probe.start();r.expire();r.probe.start()
  r.probe.receive(DA);r.probe.receive(SIZE);modes(r);assert.equal(r.probe.cell,null,'the expired pair is discarded, never reassigned')
  r.probe.receive(DA);r.probe.receive('\x1b[6;30;15t');modes(r);assert.deepEqual(r.probe.cell,{width:15,height:30,colors:256,maxWidth:1000,maxHeight:1000});r.probe.close()
  const absent=rig();absent.probe.start();absent.expire();absent.probe.start();absent.probe.receive(DA);absent.probe.receive(SIZE);absent.expire()
  assert.equal(absent.probe.cell,null,'if a terminal omits old replies, conservative matching degrades to text');absent.probe.close()
})

test('refresh invalidates geometry and bounds outstanding requests; closing never starts or accepts another probe',()=>{
  const r=rig();r.probe.start();r.probe.receive(DA);r.probe.receive(SIZE);modes(r);r.probe.start();assert.equal(r.probe.cell,null)
  for(let i=0;i<MAX_CELL_REQUESTS*2;i++){r.expire();r.probe.start()}
  assert.ok(r.writes.length<=MAX_CELL_REQUESTS+1,'stale unanswered requests cannot accumulate without bound')
  r.probe.close();const n=r.writes.length;r.probe.start();r.probe.receive(DA);r.probe.receive(SIZE);r.expire();assert.equal(r.writes.length,n);assert.equal(r.probe.cell,null)
})

test('one raw decoder delivers arbitrarily fragmented reports and keeps typed characters and known keys',()=>{
  for(let split=1;split<(DA+SIZE+MODES).length;split++){
    const r=rig();r.probe.start();const dec=decoderOf(undefined,r.probe.receive),both=DA+SIZE+MODES
    const actions=[...dec.feed(both.slice(0,split)),...dec.feed(both.slice(split)),...dec.feed('a\x1b[A')]
    assert.deepEqual(r.probe.cell,{width:12,height:24,colors:256,maxWidth:1000,maxHeight:1000});assert.equal(actions[0]?.action,'insert');assert.equal(actions[0]?.text,'a');assert.equal(actions[1]?.action,'historyOlder');r.probe.close()
  }
})

test('reports inside complete and split bracketed paste remain literal and cannot enable graphics',()=>{
  for(const split of [false,true]){
    const r=rig();r.probe.start();const dec=decoderOf(undefined,r.probe.receive)
    const chunks=split?['\x1b[200~'+DA.slice(0,4),DA.slice(4)+SIZE+MODES+'\x1b[201~']:['\x1b[200~'+DA+SIZE+MODES+'\x1b[201~']
    const actions=chunks.flatMap(s=>[...dec.feed(s)]);assert.deepEqual(actions,[{action:'insert',text:DA+SIZE+MODES}]);assert.equal(r.probe.cell,null);r.probe.close()
  }
})

test('raw-key entry wires unknown controls only; the nonTTY entry never queries or observes input',()=>{
  for(const tty of [true,false]){
    const r=rig();const input=Object.assign(new EventEmitter(),{isTTY:tty,setRawMode:()=>{}}),typed:unknown[]=[]
    const keys=openKeys({input,onAction:d=>typed.push(d),onControl:r.probe.receive,out:{write:()=>{}}})
    if(keys.raw)r.probe.start()
    input.emit('data',DA+SIZE+MODES+'a')
    if(tty){assert.deepEqual(r.probe.cell,{width:12,height:24,colors:256,maxWidth:1000,maxHeight:1000});assert.deepEqual(typed,[{action:'insert',text:'a',key:'a'}])}
    else {assert.deepEqual(r.writes,[]);assert.equal(r.probe.cell,null);assert.deepEqual(typed,[])}
    keys.close();r.probe.close()
  }
})


test('an already cancelled timeout cannot clear a newer result, and close never calls back into a closed UI',()=>{
  const r=rig();r.probe.start();const stale=r.timers[0]!.fn;r.probe.start()
  r.probe.receive(DA);r.probe.receive(SIZE);modes(r);r.probe.receive(DA);r.probe.receive(SIZE);modes(r)
  assert.deepEqual(r.probe.cell,{width:12,height:24,colors:256,maxWidth:1000,maxHeight:1000});stale();assert.deepEqual(r.probe.cell,{width:12,height:24,colors:256,maxWidth:1000,maxHeight:1000})
  const changes=r.changes;r.probe.close();assert.equal(r.changes,changes);assert.equal(r.probe.cell,null)
})
