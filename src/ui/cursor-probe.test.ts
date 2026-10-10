import assert from 'node:assert/strict'
import {test} from 'node:test'
import {openCursorProbe,CELL_WAIT_MS,MAX_CELL_REQUESTS} from './cell-probe.ts'
const query='\x1b[?6$p\x1b[?69$p\x1bP$qr\x1b\\\x1b[6n'
const envelope=(p:ReturnType<typeof openCursorProbe>,rows=24,origin=2,horizontal=2,top=1,bottom=rows)=>{
 p.receive(`\x1b[?6;${origin}$y`);p.receive(`\x1b[?69;${horizontal}$y`);p.receive(`\x1bP1$r${top};${bottom}r\x1b\\`)
}
test('cursor reports: expired FIFO slots cannot locate a later frame; all four fresh reports grant absolute coordinates',()=>{
 const writes:string[]=[],timers:{active:boolean,fn:()=>void}[]=[],seen:number[][]=[]
 const p=openCursorProbe({write:s=>writes.push(s),wait:(ms,fn)=>{assert.equal(ms,CELL_WAIT_MS);const t={active:true,fn};timers.push(t);return()=>{t.active=false}}})
 p.start(24,(row,col)=>seen.push([1,row,col]));timers[0]!.fn();p.start(24,(row,col)=>seen.push([2,row,col]))
 p.receive('\x1b[24;1R');envelope(p);assert.deepEqual(seen,[])
 for(const bad of ['\x1b[1000000;1R','\x1b[24;1Rjunk','\x1b[?24;1R'])p.receive(bad)
 p.receive('\x1b[24;3R');assert.deepEqual(seen,[]);envelope(p);assert.deepEqual(seen,[[2,23,2]])
 assert.equal(timers[1]!.active,false);assert.deepEqual(writes,[query,query])
 p.start(8,()=>assert.fail('closed'));p.close();envelope(p,8);p.receive('\x1b[8;1R');p.start(8,()=>assert.fail('closed'))
 assert.equal(writes.length,3)
 console.log('cursor reports: expired/closed grant0; four fresh replies give absolute zero-based row/column')
})
test('unrecognized/relative origin, horizontal margins, wrong scrolling range and invalid cursor grant no ownership',()=>{
 let grants=0
 for(const [origin,horizontal,top,bottom,row,col] of [[0,2,1,24,24,1],[1,2,1,24,24,1],[3,2,1,24,24,1],[2,1,1,24,24,1],[2,2,2,24,24,1],[2,2,1,23,24,1],[2,2,1,24,0,1],[2,2,1,24,24,0],[2,2,1,24,25,1]]){
  const p=openCursorProbe({write:()=>{},wait:()=>()=>{}});p.start(24,()=>{grants++});envelope(p,24,origin,horizontal,top,bottom);p.receive(`\x1b[${row};${col}R`);p.close()
 }
 assert.equal(grants,0)
 for(const mode of [2,4]){const p=openCursorProbe({write:()=>{},wait:()=>()=>{}});p.start(24,()=>{grants++});envelope(p,24,mode,mode);p.receive('\x1b[24;1R');p.close()}
 assert.equal(grants,2);console.log('cursor boundary: nine unsafe report sets grant0; reset/permanent-reset each grant1')
})
test('a host without all reports exhausts a bounded queue and leaves the original text path available',()=>{
 let writes=0,accepts=0;const p=openCursorProbe({write:()=>{writes++},wait:()=>()=>{}})
 for(let i=0;i<MAX_CELL_REQUESTS+30;i++)p.start(24,()=>{accepts++})
 assert.equal(writes,MAX_CELL_REQUESTS);assert.equal(accepts,0);p.close();console.log(`cursor fallback: requests bounded${MAX_CELL_REQUESTS}; missing reports grant0`)
})
