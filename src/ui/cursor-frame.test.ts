import assert from 'node:assert/strict'
import {test} from 'node:test'
import {EventEmitter} from 'node:events'
import {openCursorProbe,MAX_CELL_REQUESTS} from './cell-probe.ts'
import {openStage} from './stage.ts'
import {openSession} from './follow.ts'
import {openTerm} from './term.ts'
import {openKeys,KEYMAP,hintLineOf} from './keymap.ts'
import {panelWantOf} from './layout.ts'
// The immediate start adapter also exercises the original product behavior.
const schedule=(p:ReturnType<typeof openCursorProbe>,rows:number,accept:(y:number,x:number)=>void)=>(p.schedule ?? p.start)(rows,accept)
const query='\x1b[?6$p\x1b[?69$p\x1bP$qr\x1b\\\x1b[6n'
const replies=(rows:number,col=2)=>`\x1b[?6;2$y\x1b[?69;2$y\x1bP1$r1;${rows}r\x1b\\\x1b[${rows};${col+1}R`
function report(p:ReturnType<typeof openCursorProbe>,rows:number,col=2){
 p.receive('\x1b[?6;2$y');p.receive('\x1b[?69;2$y');p.receive(`\x1bP1$r1;${rows}r\x1b\\`);p.receive(`\x1b[${rows};${col+1}R`)
}

test('synchronous frame bursts query only the latest completed frame; superseded replies keep their FIFO places and cannot grant it',async()=>{
 const writes:string[]=[],seen:number[][]=[];const p=openCursorProbe({write:s=>writes.push(s),wait:()=>()=>{}})
 for(let i=1;i<=126;i++)schedule(p,24,(y,x)=>seen.push([i,y,x]))
 assert.deepEqual(writes,[],'a query waits until synchronous painting finishes');await Promise.resolve();assert.deepEqual(writes,[query]);report(p,24)
 assert.deepEqual(seen,[[126,23,2]],'only the last callback owns these completed-frame replies')
 p.start(24,()=>assert.fail('superseded in-flight callback'));schedule(p,8,(y,x)=>seen.push([127,y,x]))
 report(p,24);assert.equal(seen.length,1,'scheduled replacement invalidates its predecessor immediately')
 await Promise.resolve();assert.equal(writes.length,3);report(p,8);assert.deepEqual(seen,[[126,23,2],[127,7,2]])
 p.start(24,()=>assert.fail('late old callback'));schedule(p,24,(y,x)=>seen.push([128,y,x]));await Promise.resolve()
 report(p,24,4);assert.equal(seen.length,2,'unidentified late replies stay with their expired request')
 report(p,24,7);assert.deepEqual(seen.at(-1),[128,23,7]);assert.equal(writes.length,5)
 p.close();console.log('cursor frame:126 synchronous frames→1 query;latest callback126;superseded in-flight grant0;fresh8-row complete reply grants1;late same-size FIFO grant0/new col7')
})

class Input extends EventEmitter {
 isTTY=true
 setRawMode(_raw:boolean){return this}
 resume(){return this}
 pause(){return this}
}
test('actual decoder/Stage/Session/Term rapid 126-character input obtains a fresh final-frame report, enabling the owned width-only replacement with unchanged draft and idle bytes',async()=>{
 const input=new Input(),writes:string[]=[],launches:string[]=[];let width=120;let term:ReturnType<typeof openTerm>|null=null,session:ReturnType<typeof openSession>|null=null
 const out={isTTY:true,get columns(){return width},rows:40,write:(s:string)=>{writes.push(s)}}
 const probe=openCursorProbe({write:out.write,wait:()=>()=>{}}),draw=()=>term?.draw([],size=>session!.panel(size))
 const stage=openStage({rows:()=>[],columns:()=>width,termRows:()=>40,pendingFace:async()=>null,redraw:draw,note:()=>{},now:()=>0,abort:()=>{},run:()=>({running:false,last:[],argvOf:()=>({words:[],argv:[],why:null}),press:s=>{launches.push(s);return true},stop:()=>false}),hint:w=>hintLineOf(KEYMAP,3,w)})
 session=openSession({view:stage.view});term=openTerm({out,term:'xterm',heightOf:stage.heightWant,reserveHeightOf:()=>panelWantOf(40,true),requestCursor:(r,a)=>schedule(probe,r,a)})
 const keys=openKeys({input,out,km:KEYMAP,onAction:stage.onAction,onControl:probe.receive})
 const queries=()=>writes.filter(s=>s===query).length
 try{
  stage.setRaw(keys.raw);draw();await Promise.resolve();assert.equal(queries(),1);input.emit('data',Buffer.from(replies(40)))
  const text='ABCDEFGHIJKLMN'.repeat(9);input.emit('data',Buffer.from(text));assert.equal(queries(),1);await Promise.resolve();assert.equal(queries(),2,'126 synchronous actions add just one query')
  const draft=stage.view().input!;input.emit('data',Buffer.from(replies(40,draft.caret.col)));writes.length=0;draw();assert.deepEqual(writes,['']);await Promise.resolve();assert.equal(queries(),0)
  width=16;stage.onResize();writes.length=0;draw();assert.ok(writes.join('').startsWith('\x1b[3;1H'),'fresh final-frame report authorizes the old bottom rectangle')
  assert.ok(stage.view().input!.rows.length>1);await Promise.resolve();assert.equal(queries(),1);input.emit('data',Buffer.from(replies(40,stage.view().input!.caret.col)))
  input.emit('data',Buffer.from('\r'));await Promise.resolve();assert.deepEqual(launches,[text],'the full retained editor submits once');assert.equal(stage.view().input!.rows.length,1)
  console.log('cursor frame integration:raw126 characters;initial/type/resize queries1/1/1;fresh final report→CUP3;draft retained;idle bytes0/query0')
 }finally{keys.close();stage.close();term.close();probe.close()}
})

test('queued close and invalid geometries send nothing; missing reports still bound every FIFO at16, with no grants',async()=>{
 let writes=0,grants=0;const p=openCursorProbe({write:()=>{writes++},wait:()=>()=>{}})
 schedule(p,24,()=>{grants++});p.close();await Promise.resolve();schedule(p,24,()=>{grants++});await Promise.resolve();report(p,24);assert.equal(writes,0);assert.equal(grants,0)
 const q=openCursorProbe({write:()=>{writes++},wait:()=>()=>{}})
 for(const rows of [0,-1,NaN,Infinity,2.5]){schedule(q,rows,()=>{grants++});await Promise.resolve()}
 assert.equal(writes,0)
 for(let i=0;i<MAX_CELL_REQUESTS+30;i++){schedule(q,24,()=>{grants++});await Promise.resolve()}
 assert.equal(writes,16);assert.equal(grants,0);q.close();report(q,24);assert.equal(grants,0)
 console.log('cursor frame floor:queued close/invalid size bytes0;missing reports bounded16;late/closed grants0')
})
