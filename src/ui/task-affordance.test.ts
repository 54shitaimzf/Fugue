import assert from 'node:assert/strict'
import {test} from 'node:test'
import {frameOf,innerOf} from './frame.ts'
import {taskOf} from './task.ts'
import {statusOf} from '../probe/status.ts'
import type {StatusRow} from '../probe/status.ts'
import {setGlyphTier,widthOf} from './glyph.ts'
import {openSession} from './follow.ts'
import {openStage} from './stage.ts'
import {openTerm} from './term.ts'
import {KEYMAP,keymapOf,hintLineOf,decodeOf} from './keymap.ts'
import {gateFaceOf} from './gate.ts'
const goal='修复登录失败提示，保留账号。'
const reply=Array.from({length:60},(_,i)=>`原文 ${i} 检查登录与重试。`).join('\n')
const rows=[
 {pos:{writer:'round',seq:1},e:{t:'round/state',round:'r1',from:'Delegated',to:'Working'}},
 {pos:{writer:'round',seq:2},e:{t:'round/intent',round:'r1',body:JSON.stringify({goal})}},
 {pos:{writer:'holder/r1',seq:1},e:{t:'holder/todos',agent:'holder/r1',body:JSON.stringify({todos:[{content:'检查登录',status:'in_progress'},{content:'验证重试',status:'pending'}]})}},
 {pos:{writer:'agent/r1/1',seq:1},e:{t:'agent/handoff',agent:'agent/r1/1',body:reply}},
] as StatusRow[]
function rig(width=24,height=12,km=KEYMAP){
 const writes:string[]=[],launches:string[]=[];let w=width,h=height
 const face=gateFaceOf({round:'r1',fingerprint:'affordance',same:[],contracts:[{id:'r1.implement.1',agent:'agent/r1/1',kind:'implement',goal,ownedPaths:['src/login.ts'],seed:[],deliverables:[],assertions:[]}]} as never)
 let pending:typeof face|null=null
 const stage=openStage({keymap:()=>km,rows:()=>rows,columns:()=>w,termRows:()=>h,pendingFace:async()=>pending,note:()=>{},redraw:()=>{},now:()=>0,abort:()=>{},hint:when=>hintLineOf(km,1,when),run:()=>({running:false,last:[],argvOf:()=>({words:[],argv:[],why:null}),press:s=>{launches.push(s);return true},stop:()=>false})})
 stage.setRaw(true);stage.onAdvance(rows)
 const session=openSession({view:stage.view});session.push(rows)
 const term=openTerm({term:'xterm',heightOf:stage.heightWant,out:{isTTY:true,get columns(){return w},get rows(){return h},write:s=>writes.push(s)}})
 const draw=()=>{writes.length=0;let panel:ReturnType<typeof session.panel>|undefined;term.draw([],size=>{panel=session.panel(size);return panel});return panel!}
 return {stage,draw,writes,launches,key:(bytes:string)=>decodeOf(bytes,km).forEach(stage.onAction),gate:async()=>{pending=face;await stage.refreshGate()},resize:(width:number,height:number)=>{w=width;h=height;stage.onResize()},close:()=>{stage.close();term.close()}}
}

test('省略行显示实际阅读键，窄窗保住按键和行数；正文容量、旧装配和坏元数据保持',()=>{
 const snapshot=statusOf(rows),task=taskOf(rows)
 for(const glyph of ['ascii','box','rich'] as const){
  setGlyphTier(glyph)
  for(const width of [160,120,80,40,24])for(const height of [35,19,7]){
   const base={snapshot,task,width,height},old=frameOf(base),f=frameOf({...base,taskReadKey:'Ctrl-R'})
   const at=f.lines.findIndex(l=>l.includes('Ctrl-R 看全'))
   assert.ok(at>0,`${glyph} ${width}x${height} 阅读入口就近可见`)
   assert.match(f.lines[at]!,/\d+ 行/,'真实省略行数仍可见')
   assert.equal(f.roles[at],'system');assert.deepEqual(f.roles,old.roles,'阅读说明不另占行')
   assert.equal(f.lines.length,height);assert.ok(f.lines.every(l=>widthOf(l)===width))
   const stable=(frame:typeof f)=>frame.lines.filter((_,i)=>frame.roles[i]!=='system')
   assert.deepEqual(stable(f),stable(old),'原正文和标题保持')
   const custom=frameOf({...base,taskReadKey:'Alt-L'});assert.ok(custom.lines.some(l=>l.includes('Alt-L 看全')))
  }
  for(const width of [16,8,3]){const base={snapshot,task,width,height:7};assert.deepEqual(frameOf({...base,taskReadKey:'Ctrl-R'}),frameOf(base),'极窄装不下动作与行数时回原省略说明')}
 }
 setGlyphTier('box')
 const base={snapshot,task,width:120,height:35}
 for(const bad of [undefined,'',' ',7,'\x1b[2J','Ctrl-R\n伪说明','x'.repeat(100)])assert.deepEqual(frameOf({...base,taskReadKey:bad as never}),frameOf(base))
 for(const view of ['progress','spending'] as const)assert.deepEqual(frameOf({...base,view,taskReadKey:'Ctrl-R'}),frameOf({...base,view}))
 for(const other of [{menu:{rows:['命令'],sel:0}},{read:{rows:['全文'],top:0}},{task:{...task,round:'old'}}])assert.deepEqual(frameOf({...base,...other,taskReadKey:'Ctrl-R'}),frameOf({...base,...other}))
 assert.ok(!frameOf({...base,task:{...task,rows:task.rows.slice(0,2)},taskReadKey:'Ctrl-R'}).lines.join('').includes('看全'),'未省略时不常驻说明')
 console.log('task affordance: ascii/box/rich x160/120/80/40/24 x35/19/7 key and count visible; no body row lost; 16/8/3 legacy; invalid/no metadata exact; secondary/menu/read/stale unchanged')
})

test('阅读键只在任务记录可打开时传递；配置、只读、确认和顶层菜单均有真实边界',async()=>{
 for(const km of [KEYMAP,keymapOf({read:'Alt-L'}),keymapOf({read:'bad-key'})]){
  const r=rig(120,40,km),key=km.rows.find(b=>b.action==='read')!.keys[0]!
  try{
   assert.equal(r.stage.view().taskReadKey,key)
   r.stage.onAction({action:'insert',text:'再检查重试'});assert.equal(r.stage.view().taskReadKey,key)
   r.stage.onAction({action:'panel'});assert.equal(r.stage.view().taskReadKey,undefined);r.stage.onAction({action:'cancel'})
   r.stage.onAction({action:'read'});assert.equal(r.stage.view().taskReadKey,undefined);r.stage.onAction({action:'cancel'})
   await r.gate();assert.equal(r.stage.view().taskReadKey,undefined,'同一阅读键此时打开计划，不承诺任务记录')
   r.stage.onAction({action:'read'});assert.match(r.stage.view().read!.heading!,/计划全文/);assert.equal(r.stage.view().taskReadKey,undefined)
   r.stage.onAction({action:'cancel'});r.stage.onAction({action:'cancel'});assert.equal(r.stage.view().taskReadKey,key,'确认收起后恢复任务阅读')
   r.stage.setRaw(false);assert.equal(r.stage.view().taskReadKey,undefined,'无输入不许诺按键')
   assert.deepEqual(r.launches,[])
  }finally{r.close()}
 }
 console.log('task affordance context: default/custom/bad-config source; typing available; menu/reader/gate/plan/no-input absent; hidden gate restores task record; execute0')
})

test('配置键从24列主面打开完整任务原文，返回恢复草稿；真实舞台重排与停留安静',()=>{
 const r=rig(24,12,keymapOf({read:'Alt-L'}));let frames=0,idles=0
 const draw=()=>{frames++;return r.draw()},idle=()=>{draw();assert.equal(r.writes.join(''),'');idles++}
 try{
  r.key('再检查重试');const draft=r.stage.view().input
  assert.ok(draw().rows.some(l=>l.includes('Alt-L 看全')));idle()
  r.key('\x1bl');assert.equal(r.stage.view().read!.heading,'当前任务记录')
  const read=r.stage.view().read!.rows.join('');assert.ok(read.includes(goal));assert.ok(read.includes(reply.replaceAll('\n','')))
  draw();idle();r.stage.onAction({action:'jumpLast'});draw();idle();r.stage.onAction({action:'cancel'})
  assert.deepEqual(r.stage.view().input,draft);assert.ok(draw().rows.some(l=>l.includes('Alt-L 看全')));idle()
  for(const [w,h] of [[120,40],[80,24],[24,12]]){r.resize(w,h);assert.ok(draw().rows.some(l=>l.includes('Alt-L 看全')));idle()}
  assert.deepEqual(r.launches,[])
  console.log(`task affordance sequence: frames${frames}; idles${idles} bytes0; configured key opens full original; draft exact; 24x12 to120x40/80x24/24x12; execute0`)
 }finally{r.close()}
})
