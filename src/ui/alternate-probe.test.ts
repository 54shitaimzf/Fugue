import assert from 'node:assert/strict'
import {test} from 'node:test'
import * as probes from './cell-probe.ts'
import {decoderOf} from './keymap.ts'
const QUERY='\x1b[?1049$p',reply=(n:number)=>`\x1b[?1049;${n}$y`
function rig(){
 assert.equal(typeof (probes as any).openAlternateProbe,'function','verified ownership needs its own reply lifecycle')
 const writes:string[]=[],timers:{ms:number,fn:()=>void,cancelled:boolean}[]=[];let changes=0
 const p=(probes as any).openAlternateProbe({write:(s:string)=>writes.push(s),changed:()=>changes++,wait:(ms:number,fn:()=>void)=>{const t={ms,fn,cancelled:false};timers.push(t);return ()=>{t.cancelled=true}}})
 return {p,writes,timers,changes:()=>changes}
}
test('alternate ownership asks once without setting any host mode; fragmented raw report proves resettable full screen',()=>{
 const r=rig();assert.equal(r.p.owned,false);r.p.start();assert.deepEqual(r.writes,[QUERY]);assert.equal(r.timers[0]!.ms,200)
 const d=decoderOf(undefined,(s)=>r.p.receive(s));for(const c of reply(1))d.feed(c)
 assert.equal(r.p.owned,true);assert.equal(r.changes(),1);assert.equal(r.timers[0]!.cancelled,true)
})
test('unknown, reset, and permanent modes never grant a screen that this session can restore',()=>{
 for(let n=0;n<=4;n++){const r=rig();r.p.start();r.p.receive(reply(n));assert.equal(r.p.owned,n===1,'only a set, resettable alternate plane is owned')}
 for(const s of ['\x1b[?1047;1$y','\x1b[?1049;11$y','\x1b[1049;1$y','\x1b[?1049;1h']){
  const r=rig();r.p.start();r.p.receive(s);assert.equal(r.p.owned,false);r.p.receive(reply(1));assert.equal(r.p.owned,true,'unrelated/malformed controls do not consume a pending reply')
 }
})
test('a new request invalidates ownership; expired reply consumes its old place and cannot authorize a newer frame',()=>{
 const r=rig();r.p.start();r.p.receive(reply(1));assert.equal(r.p.owned,true);r.p.start();assert.equal(r.p.owned,false)
 r.timers.at(-1)!.fn();r.p.start();r.p.receive(reply(1));assert.equal(r.p.owned,false,'late prior reply must stay in its tombstone')
 r.p.receive(reply(1));assert.equal(r.p.owned,true);assert.equal(r.changes(),3)
})
test('even a callback already queued before cancellation cannot revoke a newer successful proof',()=>{
 const r=rig();r.p.start();const old=r.timers[0]!.fn;r.p.receive(reply(1));r.p.start();r.p.receive(reply(1));old();assert.equal(r.p.owned,true)
})
test('missing replies stay bounded and fail closed; draining old replies allows a fresh independent proof',()=>{
 const r=rig();for(let i=0;i<100;i++)r.p.start();assert.equal(r.writes.length,16);assert.equal(r.p.owned,false)
 for(let i=0;i<16;i++)r.p.receive(reply(1));assert.equal(r.p.owned,false,'overflow must not promote a cancelled request')
 r.p.start();assert.equal(r.writes.length,17);r.p.receive(reply(1));assert.equal(r.p.owned,true)
})
test('paste cannot impersonate terminal ownership; close cancels work and ignores future controls and starts',()=>{
 const r=rig();r.p.start();const d=decoderOf(undefined,(s)=>r.p.receive(s));d.feed('\x1b[200~'+reply(1)+'\x1b[201~');assert.equal(r.p.owned,false)
 d.feed(reply(1));assert.equal(r.p.owned,true);r.p.start();const count=r.writes.length;r.p.close();assert.equal(r.p.owned,false)
 for(const t of r.timers)t.fn();r.p.receive(reply(1));r.p.start();r.p.close();assert.equal(r.writes.length,count);assert.equal(r.p.owned,false);assert.ok(r.timers.every(t=>t.cancelled))
})

test('a reply after the current request deadline cannot grant ownership without a fresh request',()=>{
 const r=rig();r.p.start();r.timers[0]!.fn();r.p.receive(reply(1));assert.equal(r.p.owned,false);assert.equal(r.changes(),0)
 r.p.start();r.p.receive(reply(1));assert.equal(r.p.owned,true)
})
