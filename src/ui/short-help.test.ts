import assert from 'node:assert/strict'
import {test} from 'node:test'
import {openStage} from './stage.ts'
import {openSession} from './follow.ts'
import {openTerm} from './term.ts'
import {KEYMAP,keymapOf,keyLabelOf,decodeOf,hintLineOf,hintLimitOf} from './keymap.ts'
import {frameOf} from './frame.ts'
import {statusOf} from '../probe/status.ts'
import {gateFaceOf} from './gate.ts'
const compact=(s:string)=>s.replace(/[│|\s]/g,'')
function rig(columns=16,rows=8,custom=true){
 const km=custom?keymapOf({help:'Alt-H',cancel:'Alt-E',read:'Alt-T',historyNewer:'Alt-J'}):KEYMAP;assert.deepEqual(km.problems,[])
 const notes:string[]=[],presses:string[]=[],writes:string[]=[];let w=columns,h=rows,size={columns:w,height:1}
 const face=gateFaceOf({round:'r1',fingerprint:'r39',same:[],contracts:[{id:'r1.implement.1',agent:'agent/r1/1',kind:'implement',goal:'修复登录提示',ownedPaths:['src/login.ts'],seed:[],deliverables:[],assertions:[]}]} as never)
 const stage=openStage({keymap:()=>km,note:s=>notes.push(s),redraw:()=>{},rows:()=>[],columns:()=>w,termRows:()=>h,pendingFace:async()=>face,hint:when=>hintLineOf(km,hintLimitOf(w,km,when),when),run:()=>({running:false,last:[],argvOf:()=>({words:[],argv:[],why:null}),press:s=>{presses.push(s);return true},stop:()=>false}),now:()=>0,abort:()=>{}})
 stage.setRaw(true);const session=openSession({view:stage.view}),term=openTerm({out:{isTTY:true,get columns(){return w},get rows(){return h},write:s=>writes.push(s)},term:'xterm',heightOf:stage.heightWant})
 const draw=()=>{term.draw([],s=>{size=s;return session.panel(s)});return session.panel(size)}
 return {stage,km,notes,presses,writes,draw,key:(s:string)=>{for(const d of decodeOf(s,km))stage.onAction(d)},resize:(width:number,height:number)=>{w=width;h=height;stage.onResize()},close:()=>{stage.close();term.close()}}
}
test('every configured action has a complete explanation or a complete actual read entry in measured short help, instead of a clipped list',()=>{
 for(const width of [16,40,80])for(const rows of [8,12,24]){
  const r=rig(width,rows);r.key('\x1bh')
  for(const b of r.km.rows){
   const f=r.draw(),text=compact(f.rows.join(''));assert.ok(text.includes('按键帮助'),`${width}x${rows}/${b.action} retains help identity`)
   assert.ok(text.includes(compact(keyLabelOf(b)+' '+b.note))||text.includes('Alt-T看全'),`${width}x${rows}/${b.action} explanation has a visible reachable full-read entry`)
   assert.ok(!f.rows.some(s=>s.includes('等待输入')||s.includes('说说')));r.key('\x1bj')
  }
  assert.deepEqual(r.notes,[]);assert.deepEqual(r.presses,[]);r.close()
 }
})
test('short help full read reaches every physical explanation row using actual configured keys and cannot execute or edit',()=>{
 const r=rig();r.key('\x1bh')
 for(let n=0;n<r.km.rows.length;n++){
  const b=r.km.rows[n]!,menu=r.stage.view().menu!;r.key('\x1bt')
  const read=r.stage.view().read;assert.ok(read,'help read has a dedicated read-only foreground');assert.equal(r.stage.view().menu,undefined);assert.equal(r.stage.view().bottom,undefined)
  assert.ok(compact(read.rows.join('')).includes(compact(keyLabelOf(b)+' '+b.note)))
  const seen=new Set<string>();for(let j=0;j<read.rows.length;j++){const f=r.draw();f.rows.forEach((s,i)=>{if(f.roles?.[i]==='read')seen.add(compact(s))});r.key('\x1bj')}
  for(const row of read.rows)assert.ok([...seen].some(s=>s.includes(compact(row))),`${b.action}: every physical row can actually be shown`)
  const before=r.stage.view().input;r.key('yynng');r.key('\r');assert.deepEqual(r.stage.view().input,before);assert.deepEqual(r.presses,[])
  r.key('\x1be');assert.deepEqual(r.stage.view().menu,menu);r.key('\x1bj')
 }
 assert.deepEqual(r.notes,[]);r.close()
})
test('help read returns to the selected filtered item and original plan, and clears an armed batch before it can later execute',async()=>{
 const r=rig(16,24);await r.stage.refreshGate();r.key('y');r.key('\x1bh');r.key('最近删除');const menu=r.stage.view().menu!,input=r.stage.view().input,notes=[...r.notes]
 r.key('\x1bt');assert.ok(compact(r.stage.view().read!.rows.join('')).includes('最近删除的一段粘回光标处'))
 r.key('\x1bt');assert.ok(!compact(r.stage.view().bottom!.rows.join('')).includes('再按y'),'opening help read clears the old armed choice before any resize or cancel can hide it');assert.deepEqual(r.stage.view().menu,menu)
 r.key('\x1bt');r.resize(16,8);r.key('\x1bj');r.resize(16,24);r.key('\x1bt')
 assert.deepEqual(r.stage.view().menu,menu);assert.deepEqual(r.stage.view().input,input);assert.deepEqual(r.notes,notes);assert.deepEqual(r.presses,[])
 r.key('\x1be');r.key('\x1be');r.key('g');r.key('\r');assert.deepEqual(r.presses,[]);r.key('y');r.key('\r');assert.deepEqual(r.presses,['round go']);r.close()
})
test('missing or malformed full-read metadata and ordinary menus retain exact previous fallback bytes and roles',()=>{
 const base={snapshot:statusOf([]),width:16,height:7,menu:{rows:['Enter 发送输入','Esc 返回'],sel:0,detail:Array(10).fill('detail')}}
 const old=frameOf(base)
 for(const detailMore of [undefined,[],null,['x'.repeat(100)],Array(100).fill('x'),[42],'bad'])assert.deepEqual(frameOf({...base,menu:{...base.menu,detailMore:detailMore as never}}),old)
 const r=rig();r.key('/');assert.equal((r.stage.view().menu as {detailMore?:unknown}).detailMore,undefined);r.close()
})
test('help read has its own heading and physical position, supports page/end/start, and nested help retains the frozen explanation',()=>{
 const r=rig();r.key('\x1bh');r.key('\x1bj');r.key('\x1bj');r.key('\x1bt');const read=r.stage.view().read!,input=r.stage.view().input
 let f=r.draw();assert.ok(f.rows.some(s=>s.includes('按键说明')));assert.ok(f.rows.some(s=>s.includes(`1/${read.rows.length}`)&&s.includes('Alt-J')),'short reader shows the actual next-row key inside the frame');assert.ok(!f.rows.some(s=>s.includes('等待输入')))
 r.key('\x1b[6~');assert.equal(r.stage.view().read!.top,Math.min(Math.max(1,Math.floor(f.roles!.filter(role=>role==='read').length/2)),read.rows.length-1));r.key('\x1b[1;5F');assert.equal(r.stage.view().read!.top,read.rows.length-1)
 r.key('\x1b[1;5H');assert.equal(r.stage.view().read!.top,0);r.key('\x1bj');const frozen=r.stage.view().read
 r.key('\x1bh');assert.ok(r.stage.view().menu);r.key('\x1bj');assert.deepEqual(r.stage.view().read,frozen);r.key('yyng');r.key('\r');assert.deepEqual(r.presses,[])
 r.key('\x1be');assert.equal(r.stage.view().menu,undefined);assert.deepEqual(r.stage.view().read,frozen);r.key('\x1be');assert.ok(r.stage.view().menu);assert.equal(r.stage.view().read,undefined)
 assert.deepEqual(r.stage.view().input,input);assert.deepEqual(r.notes,[]);r.close()
 const base={snapshot:statusOf([]),width:40,height:8,read:{rows:['READ'],top:0}},old=frameOf(base)
 for(const value of [undefined,null,'',42])assert.deepEqual(frameOf({...base,read:{...base.read,heading:value as never,footer:value as never}}),old)
})
