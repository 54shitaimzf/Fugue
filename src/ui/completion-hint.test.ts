import assert from 'node:assert/strict'
import {test} from 'node:test'
import {openStage} from './stage.ts'
import {openSession} from './follow.ts'
import {openTerm} from './term.ts'
import {KEYMAP,decodeOf,keymapOf,hintPicksOf,hintLineOf,hintLimitOf} from './keymap.ts'
import type {HintWhen,Keymap} from './keymap.ts'
import type {StatusRow} from '../probe/status.ts'
import {gateFaceOf} from './gate.ts'
import {widthOf,setGlyphTier} from './glyph.ts'
const written=[{pos:{writer:'round',seq:1},e:{t:'round/state',round:'r1',from:'Idle',to:'Planning'}},{pos:{writer:'round',seq:2},e:{t:'round/intent',round:'r1',body:JSON.stringify({goal:'修复登录提示'})}},{pos:{writer:'round',seq:3},e:{t:'merge/accept',round:'r1',commit:'result',assertions:[{assertion:'登录',verdict:'pass'}]}},{pos:{writer:'round',seq:4},e:{t:'round/state',round:'r1',from:'Committed',to:'Rebuilding'}}] as StatusRow[]
const next=[...written,{pos:{writer:'round',seq:5},e:{t:'round/intent',round:'r2',body:'下一任务'}}] as StatusRow[]
const face=gateFaceOf({round:'r1',fingerprint:'pending',same:[],contracts:[{id:'r1.implement.1',agent:'agent/r1/1',kind:'implement',goal:'待确认',ownedPaths:['src/login.ts'],assertions:[],seed:[],deliverables:[]}]} as never,{test:'node tools/test-entry.js'})
function rig(km:Keymap=KEYMAP){
 let rows:readonly StatusRow[]=written,width=120,height=40,running=false,available=true,pending:typeof face|null=null,aborts=0
 const writes:string[]=[],notes:string[]=[],launches:string[]=[]
 const stage=openStage({keymap:()=>km,rows:()=>rows,columns:()=>width,termRows:()=>height,pendingFace:async()=>pending,note:s=>notes.push(s),redraw:()=>{},hint:w=>hintLineOf(km,hintLimitOf(width,km,w),w),now:()=>0,abort:()=>{aborts++},run:()=>available?{get running(){return running},last:[],argvOf:()=>({words:[],argv:[],why:null}),press:s=>{launches.push(s);return true},stop:()=>true}:null})
 stage.setRaw(true);stage.onAdvance(rows)
 const session=openSession({view:stage.view});session.push(rows)
 const term=openTerm({term:'xterm',heightOf:stage.heightWant,out:{isTTY:true,get columns(){return width},get rows(){return height},write:s=>writes.push(s)}})
 return {stage,session,term,writes,notes,launches,aborts:()=>aborts,keys:(bytes:string)=>{for(const d of decodeOf(bytes,km))stage.onAction(d)},setRows:(v:readonly StatusRow[])=>{rows=v;stage.onAdvance(rows);session.push(rows)},setRunning:(v:boolean)=>{running=v},setAvailable:(v:boolean)=>{available=v},setPending:async(v:typeof pending)=>{pending=v;await stage.refreshGate()},resize:(w:number,h:number)=>{width=w;height=h;stage.onResize()},draw:()=>{writes.length=0;term.draw([],s=>session.panel(s));return writes.join('')},close:()=>{stage.close();term.close()}}
}
test('completed hints select only current actions, prioritize configured exit at narrow widths, and preserve legacy help and configuration fallback',()=>{
 const expected=['quit','read','submit','help']
 assert.deepEqual(hintPicksOf(KEYMAP,'done').map(b=>b.action),expected)
 assert.equal(hintLineOf(KEYMAP,0,'done'),'按键 Ctrl-D 退出 · Ctrl-R 记录 · Enter 发送 · ? 帮助')
 const mapped=keymapOf({quit:'Alt-Q',read:'Alt-L',submit:'Alt-S'}),bad=keymapOf({quit:'not-a-key'})
 assert.equal(hintLineOf(mapped,0,'done'),'按键 Alt-Q 退出 · Alt-L 记录 · Alt-S 发送 · ? 帮助')
 assert.equal(hintLineOf(bad,0,'done'),hintLineOf(KEYMAP,0,'done'));assert.equal(bad.problems.length,1)
 for(const km of [KEYMAP,mapped,bad])for(const width of [160,120,80,40,24,16]){
  const line=hintLineOf(km,hintLimitOf(width,km,'done'),'done')
  assert.ok(line.includes(`${km.rows.find(b=>b.action==='quit')!.keys[0]} 退出`));assert.ok(widthOf(line)<=width);assert.ok(!line.includes('命令')&&!line.includes('视图'))
 }
 assert.ok(!hintPicksOf(KEYMAP,'input').some(b=>b.action==='quit'));assert.equal(hintLineOf(KEYMAP,1,'any'),'按键 Enter 提交')
 console.log('completion hints: 18 configured width checks; done=quit/read/submit/help; any/input exact; invalid config=default')
})
test('only the current written, empty, idle main scene uses completion hints; drafts, queues, pending, layers, secondary views and new tasks keep their own hints',async()=>{
 const r=rig(),hint=(when:HintWhen)=>hintLineOf(KEYMAP,hintLimitOf(120,KEYMAP,when),when)
 try{
  assert.equal(r.stage.view().hint,hint('done'))
  r.stage.onAction({action:'insert',text:'新问题'});const draft=r.stage.view().input;assert.equal(r.stage.view().hint,hint('typing'));r.keys('\x04');assert.equal(r.aborts(),0);assert.deepEqual(r.stage.view().input,draft);r.stage.onAction({action:'cancel'});assert.equal(r.stage.view().hint,hint('done'))
  r.setRunning(true);assert.equal(r.stage.view().hint,hint('run'));r.stage.onAction({action:'insert',text:'say queued'});r.stage.onAction({action:'submit'});r.setRunning(false);assert.equal(r.stage.view().hint,hint('queue'));r.stage.onAction({action:'cancel'});assert.equal(r.stage.view().hint,hint('done'));assert.deepEqual(r.launches,[])
  await r.setPending(face);assert.equal(r.stage.view().hint,hint('gate'));r.stage.onAction({action:'read'});assert.equal(r.stage.view().hint,hint('plan'));r.stage.onAction({action:'cancel'});r.stage.onAction({action:'cancel'});assert.equal(r.stage.view().hint,hint('pending'));await r.setPending(null);assert.equal(r.stage.view().hint,hint('done'))
  r.stage.onAction({action:'read'});assert.equal(r.stage.view().hint,hint('read'));r.stage.onAction({action:'cancel'});assert.equal(r.stage.view().hint,hint('done'))
  r.stage.onAction({action:'panel'});assert.equal(r.stage.view().hint,hint('menu'));r.stage.onAction({action:'cancel'});assert.equal(r.stage.view().hint,hint('done'))
  r.stage.onAction({action:'complete'});assert.equal(r.stage.view().hint,hint('input'));r.stage.onAction({action:'complete'});assert.equal(r.stage.view().hint,hint('input'));r.stage.onAction({action:'complete'});assert.equal(r.stage.view().hint,hint('done'))
  r.stage.setRaw(false);assert.equal(r.stage.view().hint,hint('input'));r.stage.setRaw(true)
  for(const changed of [[],written.slice(0,3),next,...['Planning','Working','Committed','Aborted','unknown'].map(to=>[...written.slice(0,3),{...written[3]!,e:{...written[3]!.e,to}}] as StatusRow[])]){r.setRows(changed);assert.equal(r.stage.view().hint,hint('input'))}
  r.setRows(written);r.setAvailable(false);assert.equal(r.stage.view().hint,hint('done'));r.keys('\x04');assert.equal(r.aborts(),1)
  console.log('completion context: written only; draft preserved/quit0; queue/pending/layers/views/nonTTY/new and unknown states original; idle quit1; launch0')
 }finally{r.close()}
})
test('completion sequence changes current hints across real frame resizes and source advance; unchanged draws emit zero bytes and configured exit dispatch stays exact',()=>{
 let frames=0,idles=0
 try{for(const glyph of ['ascii','box','rich'] as const){setGlyphTier(glyph);const r=rig(keymapOf({quit:'Alt-Q'}))
  const draw=()=>{frames++;return r.draw()},idle=()=>{assert.equal(draw(),'');idles++}
  try{for(const [w,h] of [[160,50],[120,40],[80,24],[24,12],[16,8]]){r.resize(w!,h!);const f=draw();assert.ok(r.stage.view().hint!.includes('Alt-Q 退出'));if(h!>=12)assert.ok(f.includes('Alt-Q 退出'));else assert.ok(!f.includes('Alt-Q 退出'),'existing short-height hint floor');idle();r.stage.onAction({action:'insert',text:'后续问题'});draw();const draft=r.stage.view().input;r.keys('\x1bq');draw();assert.equal(r.aborts(),0);assert.deepEqual(r.stage.view().input,draft);r.stage.onAction({action:'cancel'});draw();idle()}
   r.setRows(next);draw();assert.ok(!r.stage.view().hint!.includes('退出'));idle();r.setRows(written);draw();idle();r.keys('\x1bq');assert.equal(r.aborts(),1);assert.deepEqual(r.launches,[])
  }finally{r.close()}
 }}finally{setGlyphTier('box')}
 assert.equal(frames,102);assert.equal(idles,36)
 console.log(`completion sequence: ${frames} frames; ${idles} idles bytes0; 3 glyphs x5 sizes; draft quit0; new task removes exit; configured quit1; launch0`)
})
