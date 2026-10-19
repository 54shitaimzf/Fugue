import assert from 'node:assert/strict'
import {test} from 'node:test'
import {taskOf} from './task.ts'
import {frameOf} from './frame.ts'
import {statusOf} from '../probe/status.ts'
import type {StatusRow} from '../probe/status.ts'
import {openSession} from './follow.ts'
import {openStage} from './stage.ts'
import {openTerm} from './term.ts'
import {KEYMAP,keymapOf,hintLineOf,decodeOf,decoderOf} from './keymap.ts'
import {setGlyphTier,widthOf} from './glyph.ts'

const fence=String.fromCharCode(96).repeat(3)
function draft(count=3){
 const parts=[{kind:'investigate',question:'确认保留范围',evidenceRequired:[{note:'保留范围'}],seed:['keep.txt']},
 ...Array.from({length:count-1},(_,i)=>({kind:'implement',goal:'更新文件'+i,ownedPaths:['file'+i+'.txt'],deliverables:[{path:'file'+i+'.txt',form:'文本'}],assertions:[{action:'check',name:'文件内容正确'}],seed:[]}))]
 return '# 原说明标题\n保留所有说明。\n\n'+parts.map((v,i)=>'## 第 '+(i+1)+' 项\n'+fence+'json\n'+JSON.stringify(v)+'\n'+fence).join('\n\n')+'\n\n'+fence+'python\nprint("示例仍在")\n'+fence+'\n最后的解释不删。'
}
function ledger(body=draft()){
 const rows=[{pos:{writer:'round',seq:1},e:{t:'round/state',round:'r1',from:'Idle',to:'Planning'}},{pos:{writer:'round',seq:2},e:{t:'round/intent',round:'r1',body:JSON.stringify({goal:'核查后更新文件'})}},{pos:{writer:'round',seq:3},e:{t:'holder/distill',round:'r1',agent:'round',body}}] as StatusRow[]
 return rows
}
const strings=(f:ReturnType<typeof frameOf>)=>f.lines.join('\n')
const withoutPreview=(t:ReturnType<typeof taskOf>)=>({...t,rows:t.rows.map(({preview,...r})=>r)})
test('canonical valid draft has all human purposes while original prose, other code and raw record stay exact',()=>{
 for(const count of [3,8]){
  const body=draft(count),rows=ledger(body),before=statusOf(rows),t=taskOf(rows)
  const model=t.rows.find(r=>r.role==='model')!
  assert.equal(model.text,body)
  assert.ok(model.preview!.startsWith('任务草案\n'))
  assert.ok(model.preview!.includes('# 原说明标题'));assert.ok(model.preview!.includes('最后的解释不删。'))
  assert.ok(model.preview!.includes(fence+'python\nprint("示例仍在")\n'+fence))
  assert.ok(model.preview!.includes('调查：确认保留范围'))
  assert.ok(model.preview!.includes('1. 调查：确认保留范围'),'purposes are numbered in batch order')
  assert.ok(!model.preview!.includes('## 第'),'the markdown section skeleton stays off the human face')
  assert.ok(!model.preview!.includes('r1.implement'),'contract ids stay off the human face')
  for(let i=0;i<count-1;i++)assert.ok(model.preview!.includes('实现：更新文件'+i),'all purposes remain; no three-item cap')
  assert.ok(!model.preview!.includes('ownedPaths'))
  const full=taskOf(rows,null,true).rows.find(r=>r.role==='model')!
  assert.equal(full.text,model.text);assert.equal(full.preview,undefined)
  assert.deepEqual(statusOf(rows),before);assert.equal(rows[2]!.e.t,'holder/distill')
 }
 for(const body of ['普通模型说明',fence+'json\n{bad}\n'+fence,draft().replace('"ownedPaths"','"unknownField"'),draft().replace('"question":"确认保留范围"','"question":""')]){
  const t=taskOf(ledger(body)),model=t.rows.find(r=>r.role==='model')!
  assert.equal(model.preview,undefined,'unrecognized/invalid draft keeps original display')
  assert.equal(model.text,body)
 }
 console.log('draft projection:3/8 purposes exact; original raw/prose/headings/non-JSON code retained; 4 invalid/plain floors; machine exact')
})
test('interactive current main presents draft purposes; readonly, bad-key, stale and secondary contexts keep raw floor',()=>{
 const t=taskOf(ledger()),raw=withoutPreview(t),snapshot=statusOf(ledger())
 try{for(const glyph of ['ascii','box','rich'] as const){
  setGlyphTier(glyph)
  for(const [width,height] of [[192,45],[120,35],[80,19],[24,10]]){
   const o={snapshot,task:t,width,height,operationArea:true,taskReadKey:'Alt-L'}
   const f=frameOf(o),text=strings(f)
   assert.equal(f.lines.length,height);assert.ok(f.lines.every(l=>widthOf(l)===width))
   if(width>=80){assert.ok(text.includes('任务草案'));assert.ok(text.includes('实现：更新文件1'));assert.ok(text.includes('Alt-L 草案原文'));assert.ok(!text.includes('ownedPaths'))}
   for(const change of [{operationArea:false},{taskReadKey:undefined},{taskReadKey:''},{taskReadKey:'x'.repeat(100)},{taskReadKey:'\x1b[2J'},{menu:{rows:['选项'],sel:0}},{read:{rows:['全文'],top:0}},{view:'progress' as const},{view:'spending' as const},{task:{...t,round:'old'}}]){
    const changed={...o,...change},expected={...changed,task:withoutPreview(changed.task)}
    assert.deepEqual(frameOf(changed),frameOf(expected),'unknown/unavailable draft-reading context retains old frame bytes')
   }
   for(const narrow of [3,8,16]){const o={snapshot,task:t,width:narrow,height,operationArea:true,taskReadKey:'Ctrl-R'};assert.deepEqual(frameOf(o),frameOf({...o,task:raw}))}
  }
  const bottom={rows:['待确认 3 项任务','y 执行整批'],keep:2,waitingAt:1,waitingCount:1,confirmationRound:'r1'}
  const gate=frameOf({snapshot,task:t,width:192,height:45,operationArea:true,bottom})
  assert.ok(strings(gate).includes('任务草案'));assert.ok(!strings(gate).includes('ownedPaths'));assert.ok(strings(gate).includes('y 执行整批'))
 }}finally{setGlyphTier('box')}
})
test('configured reader opens the full raw draft and returns exact input without execution',()=>{
 for(const km of [KEYMAP,keymapOf({read:'Alt-L'})]){
  const rows=ledger(),launches:string[]=[]
  const stage=openStage({rows:()=>rows,keymap:()=>km,columns:()=>120,termRows:()=>40,pendingFace:async()=>null,note:()=>{},redraw:()=>{},run:()=>({running:false,last:[],argvOf:()=>({words:[],argv:[],why:null}),press:s=>{launches.push(s);return true},stop:()=>false}),now:()=>0,abort:()=>{},hint:w=>hintLineOf(km,2,w)})
  try{
   stage.setRaw(true);stage.onAdvance(rows);stage.onAction({action:'insert',text:'继续核查草稿'})
   const input=stage.view().input,session=openSession({view:stage.view});session.push(rows)
   assert.ok(session.panel({columns:120,height:35}).rows.join('\n').includes('草案原文'))
   const key=km.rows.find(r=>r.action==='read')!.keys[0],bytes=key==='Alt-L'?'\x1bl':'\x12'
   decodeOf(bytes,km).forEach(stage.onAction)
   assert.equal(stage.view().read!.heading,'当前任务记录')
   const read=stage.view().read!.rows.join('')
   for(const term of ['ownedPaths','evidenceRequired','最后的解释不删。','示例仍在','file1.txt'])assert.ok(read.includes(term),'full draft is actually readable: '+term)
   stage.onAction({action:'jumpLast'});stage.onAction({action:'cancel'})
   assert.deepEqual(stage.view().input,input);assert.deepEqual(launches,[])
  }finally{stage.close()}
 }
 console.log('draft reader:default/custom decoded key; exact raw projection; fields/end/non-JSON code accessible; input exact; execute0')
})
test('draft display, full reading, resize and updates produce silent idle and unchanged permanent folds',()=>{
 let draws=0,idles=0
 try{for(const glyph of ['ascii','box','rich'] as const){
  setGlyphTier(glyph);let cols=192,rowsCount=50;const rows=ledger(),output:string[]=[]
  const stage=openStage({rows:()=>rows,keymap:()=>KEYMAP,columns:()=>cols,termRows:()=>rowsCount,pendingFace:async()=>null,note:()=>{},redraw:()=>{},run:()=>null,now:()=>0,abort:()=>{},hint:w=>hintLineOf(KEYMAP,2,w)})
  const session=openSession({view:stage.view});stage.setRaw(true);stage.onAdvance(rows);session.push(rows)
  const term=openTerm({term:'xterm',heightOf:stage.heightWant,out:{isTTY:true,get columns(){return cols},get rows(){return rowsCount},write:s=>output.push(s)}})
  const draw=()=>{term.draw([],size=>{const p=session.panel(size);assert.ok(p.rows.every(l=>widthOf(l)===cols));return p});draws++}
  const pair=()=>{draw();output.length=0;draw();assert.equal(output.join(''),'');idles++;const fresh=openSession();fresh.push(rows);assert.deepEqual(session.permanent(),fresh.permanent())}
  try{
   stage.onAction({action:'insert',text:'保留的草稿'});const input=stage.view().input
   pair();stage.onAction({action:'read'});pair();stage.onAction({action:'jumpLast'});pair();stage.onAction({action:'cancel'});assert.deepEqual(stage.view().input,input);pair()
   for(const [c,r] of [[80,24],[24,12],[192,50]]){cols=c;rowsCount=r;stage.onResize();pair()}
   const update={pos:{writer:'round',seq:4},e:{t:'holder/distill',round:'r1',agent:'round',body:draft(8)}} as StatusRow
   rows.push(update);session.push([update]);stage.onAdvance([update]);pair()
   const message={pos:{writer:'round',seq:5},e:{t:'agent/handoff',round:'r1',agent:'agent/r1/1',body:'当前结果保持原文'}} as StatusRow
   rows.push(message);session.push([message]);stage.onAdvance([message]);pair()
  }finally{stage.close();term.close()}
 }}finally{setGlyphTier('box')}
 assert.equal(draws,54);assert.equal(idles,27)
 console.log('draft display:3 glyphs x9 transitions;54 draws27 idles bytes0;reader/resize/update;input exact;permanent folds exact')
})


test('an actual Esc before terminal reports still returns once; configured Alt-Esc and control payloads retain their meaning',()=>{
 for(const report of ['\x1b[6;1R','\x1b[?6;2$y','\x1bP1$r1;50r\x1b\\']){
  const control:string[]=[],d=decoderOf(KEYMAP,s=>control.push(s))
  assert.deepEqual(d.feed('\x1b'),[])
  const esc=decoderOf(KEYMAP);esc.feed('\x1b')
  assert.deepEqual(d.feed(report),esc.flush(),'the real cancel is not swallowed by a following report')
  assert.deepEqual(control,[report]);assert.deepEqual(d.flush(),[])
 }
 const km=keymapOf({read:'Alt-Esc'}),d=decoderOf(km)
 assert.deepEqual(d.feed('\x1b'),[]);assert.deepEqual(d.feed('\x1b'),decodeOf('\x1b\x1b',km),'bound Alt-Esc is still one configured key')
 const control:string[]=[],payload='\x1bPpayload\x1b\x1b[6;1R\x1b\\',literal=decoderOf(KEYMAP,s=>control.push(s))
 assert.deepEqual(literal.feed(payload),[]);assert.deepEqual(control,[payload],'Esc bytes inside a control string never produce cancel')
 console.log('draft return:Esc +3 real report families cancel1 each; Alt-Esc binding unchanged; control payload actions0')
})
