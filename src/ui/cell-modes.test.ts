import assert from 'node:assert/strict'
import { test } from 'node:test'
import { openCellProbe } from './cell-probe.ts'
const DA='\x1b[?62;4;22c',SIZE='\x1b[6;24;12t',ANCHOR='\x1b[?80;2$y',PALETTE='\x1b[?1070;1$y'
// Mode-order scenarios provide a valid capacity alongside the cell-size fixture.
// The independent capacity suite exercises all five reply orders and missing capacity.
function rig(){let expire=()=>{},changes=0;const writes:string[]=[];const probe=openCellProbe({write:s=>writes.push(s),changed:()=>changes++,wait:(_,fn)=>{expire=fn;return ()=>{}}});const receive=probe.receive;probe.receive=(s:string)=>{if(s.includes('\x1b[6;'))receive('\x1b[?1;0;256S');receive(s)};return {probe,writes,timeout:()=>expire(),get changes(){return changes}}}
test('Sixel geometry requires cursor anchoring and isolated palettes, never changes host modes',()=>{
  const r=rig();r.probe.start();r.probe.receive(DA);r.probe.receive(SIZE)
  assert.equal(r.probe.cell,null,'DA and dimensions do not prove placement/palette safety')
  r.probe.receive(ANCHOR);assert.equal(r.probe.cell,null);r.probe.receive(PALETTE);assert.deepEqual(r.probe.cell,{width:12,height:24,colors:256})
  assert.equal(r.writes.join(''),'\x1b[c\x1b[16t\x1b[?80$p\x1b[?1070$p\x1b[?1;1;0S','only queries; no set/reset mode')
  r.probe.close()
})
test('every four-report order works, with no result before the last reply',()=>{
  function permutations(a:string[]):string[][]{return a.length===0?[[]]:a.flatMap((v,i)=>permutations(a.filter((_,j)=>i!==j)).map(rest=>[v,...rest]))}
  for(const reports of permutations([DA,SIZE,ANCHOR,PALETTE])){
    const r=rig();r.probe.start();for(const [i,report] of reports.entries()){r.probe.receive(report);if(i<3)assert.equal(r.probe.cell,null)}
    assert.deepEqual(r.probe.cell,{width:12,height:24,colors:256});assert.equal(r.changes,1);r.probe.close()
  }
})
test('unsafe, unknown and missing mode reports stay text; permanent safe states work',()=>{
  for(const modes of [[1,1],[3,1],[0,1],[2,0],[2,2],[2,4]]){
    const r=rig();r.probe.start();for(const s of [DA,SIZE,`\x1b[?80;${modes[0]}$y`,`\x1b[?1070;${modes[1]}$y`])r.probe.receive(s)
    assert.equal(r.probe.cell,null);assert.equal(r.changes,0);r.probe.close()
  }
  const safe=rig();safe.probe.start();for(const s of [DA,SIZE,'\x1b[?80;4$y','\x1b[?1070;3$y'])safe.probe.receive(s)
  assert.deepEqual(safe.probe.cell,{width:12,height:24,colors:256});safe.probe.close()
  const missing=rig();missing.probe.start();for(const s of [DA,SIZE,ANCHOR])missing.probe.receive(s);missing.timeout();missing.probe.receive(PALETTE);assert.equal(missing.probe.cell,null);missing.probe.close()
})
test('late mode replies cannot be spliced into the refreshed request',()=>{
  const r=rig();r.probe.start();r.probe.receive(DA);r.probe.receive(SIZE);r.probe.start()
  for(const s of [ANCHOR,PALETTE,DA,SIZE])r.probe.receive(s);assert.equal(r.probe.cell,null)
  r.probe.receive(ANCHOR);r.probe.receive(PALETTE);assert.deepEqual(r.probe.cell,{width:12,height:24,colors:256});r.probe.close()
})
