import assert from 'node:assert/strict'
import { test } from 'node:test'
import { frameOf, footerOf } from './frame.ts'
import { frameBudgetOf } from './layout.ts'
import { taskOf } from './task.ts'
import { statusOf } from '../probe/status.ts'
import type { StatusRow } from '../probe/status.ts'
import { openStage } from './stage.ts'
import { openSession } from './follow.ts'
import { openTerm } from './term.ts'
import { widthOf } from './glyph.ts'
import { KEYMAP, hintLineOf } from './keymap.ts'

const body = Array.from({ length: 60 }, (_, i) => `正文 ${String(i).padStart(2, '0')} 检查登录错误与重试行为`).join('\n')
function rows(from = 'Delegated', to = 'Working'): StatusRow[] {
  return [
    { pos: { writer: 'round', seq: 1 }, e: { t: 'round/state', round: 'r1', from, to } },
    { pos: { writer: 'round', seq: 2 }, e: { t: 'round/intent', round: 'r1', body: JSON.stringify({ goal: '修复登录提示并保留输入。' }) } },
    { pos: { writer: 'agent/r1/1', seq: 1 }, e: { t: 'agent/handoff', agent: 'agent/r1/1', body } },
  ] as StatusRow[]
}
const content = (f: ReturnType<typeof frameOf>) => f.lines.filter((_, i) => !['border', 'footer'].includes(f.roles[i]!)).map(s => s.slice(1, -1).trim())
test('当前任务的状态只在正文展示；两行页脚空间用于更多原文，生命周期结果仍可见', () => {
  const sequence: string[] = []
  for (const [from, to] of [['Idle','Planning'],['Delegated','Working'],['Verifying','Working'],['Verifying','Committed'],['Committed','Rebuilding'],['Working','Aborted']]) {
    const events=rows(from,to), task=taskOf(events), snapshot=statusOf(events)
    const f=frameOf({snapshot,task,width:120,height:35})
    assert.equal(f.roles.filter(r=>r==='footer').length,0, `${from}->${to} 主面已有任务状态`)
    assert.equal(f.footer,'')
    assert.ok(content(f).includes(task.rows[0]!.text), '任务状态/写回结论在正文原样可见')
    assert.equal(f.lines.length,35);assert.ok(f.lines.every(l=>widthOf(l)===120))
    sequence.push(to)
  }
  const events=rows(), task=taskOf(events), snapshot=statusOf(events)
  for(const width of [120,80,16])for(const height of [35,19,7,5]){
    const f=frameOf({snapshot,task,width,height})
    const legacy=frameOf({snapshot,task:{...task,state:null},width,height})
    assert.equal(f.roles.includes('footer'),false)
    assert.equal(f.lines.length,height);assert.ok(f.lines.every(l=>widthOf(l)===width))
    if(width>=80){
      assert.equal(content(f).filter(s=>s==='正在执行').length,1,'窄矮场景仍保留状态，一处足够')
      if(height>=7){
        const model=(v:ReturnType<typeof frameOf>)=>v.roles.filter(r=>r==='model').length
        assert.equal(model(f),model(legacy)+2,'正文实际多显示两行模型原文')
      }
    }
  }
  console.log(`task footer: lifecycle=${sequence.join('/')}; status one; 120/80/16 x35/19/7/5 exact geometry; modelRows+2 at readable widths`)
})
test('二级视图、阅读位置和帮助筛选的页脚保持，未知任务投影保留状态地板',()=>{
  const events=rows(), snapshot=statusOf(events), task=taskOf(events)
  const base={snapshot,width:120,height:35}
  for(const view of ['progress','spending'] as const){
    assert.deepEqual(frameOf({...base,view,task}),frameOf({...base,view}), '任务去重不触及其他视图')
    assert.ok(frameOf({...base,view,task}).roles.includes('footer'))
  }
  const reading={rows:['原文一','原文二'],top:1,heading:'当前任务记录',footer:'2/2 行 · 只读'}
  assert.deepEqual(frameOf({...base,task,read:reading}),frameOf({...base,read:reading}))
  const help={rows:['按键一','按键二'],sel:1,detail:['当前键：返回'],detailMore:[]}
  assert.deepEqual(frameOf({...base,task,menu:help}),frameOf({...base,menu:help}))
  assert.equal(frameOf({...base,task,read:reading}).footer,reading.footer)
  for(const fallback of [{...task,round:'other'},{...task,state:null},{...task,rows:[]},{...task,rows:[{text:'用户文字',role:'user' as const}]}]){
    const f=frameOf({...base,task:fallback})
    assert.equal(f.footer,footerOf(snapshot));assert.ok(f.roles.includes('footer'))
  }
  for(const height of [5,7,19,35]){
    assert.deepEqual(frameBudgetOf(height),{withFooter:true,rows:height-4})
    assert.deepEqual(frameBudgetOf(height,0,false),{withFooter:false,rows:height-2})
  }
  const focused=openSession({view:()=>({focus:'agent/r1/1'})});focused.push(events)
  const f=focused.panel({columns:120,height:35})
  assert.ok(!f.roles!.includes('footer'),'子任务快照没有轮次边时，全账任务投影仍准确承担状态')
  assert.ok(f.rows.some(line=>line.includes('正在执行')));assert.ok(!f.rows.some(line=>line.includes('等待输入')))
  console.log('task footer fallback: absent/mismatched task keeps status; reading/help/progress/spending unchanged; default allocation unchanged')
})
test('主面与阅读、菜单、Tab往返的物理高度稳定，草稿只读和停留零输出保持',()=>{
  const events=rows(), writes:string[]=[], presses:string[]=[]
  let width=120,height=40,lastRoles:readonly string[]=[]
  const stage=openStage({rows:()=>events,columns:()=>width,termRows:()=>height,pendingFace:async()=>null,
    note:()=>{},redraw:()=>{},now:()=>0,abort:()=>{},hint:w=>hintLineOf(KEYMAP,3,w),
    run:()=>({running:false,last:[],argvOf:()=>({words:[],argv:[],why:null}),press:s=>{presses.push(s);return true},stop:()=>false}),
  })
  stage.setRaw(true);stage.onAdvance(events)
  const session=openSession({view:stage.view});session.push(events)
  const term=openTerm({term:'xterm',heightOf:stage.heightWant,out:{isTTY:true,get columns(){return width},get rows(){return height},write:s=>writes.push(s)}})
  const draw=()=>{writes.length=0;term.draw([],size=>{const panel=session.panel(size);lastRoles=panel.roles!;return panel})}
  try{
    stage.onAction({action:'insert',text:'接下来验证登录'});const draft=stage.view().input,mainHeight=stage.heightWant()
    draw();assert.equal(lastRoles.includes('footer'),false);draw();assert.equal(writes.join(''),'')
    stage.onAction({action:'read'});draw();assert.ok(lastRoles.includes('footer'))
    stage.onAction({action:'pageDown'});draw();const read=stage.view().read!;assert.equal(read.top,15)
    stage.onAction({action:'panel'});draw();assert.ok(lastRoles.includes('footer'))
    stage.onAction({action:'cancel'});draw();assert.deepEqual(stage.view().read,read)
    stage.onAction({action:'cancel'});draw();assert.equal(lastRoles.includes('footer'),false)
    assert.equal(stage.heightWant(),mainHeight);assert.deepEqual(stage.view().input,draft)
    stage.onAction({action:'complete'});draw();assert.ok(lastRoles.includes('footer'))
    stage.onAction({action:'complete'});draw();assert.ok(lastRoles.includes('footer'))
    stage.onAction({action:'complete'});draw();assert.equal(lastRoles.includes('footer'),false)
    for(const [w,h] of [[80,24],[16,8],[120,40]]){width=w;height=h;stage.onResize();draw();assert.equal(lastRoles.includes('footer'),false);draw();assert.equal(writes.join(''),'')}
    assert.deepEqual(presses,[])
    console.log('task footer sequence: chat/read/menu/read/chat/progress/spending/chat; frame height stable; pageDown15; draft kept; execute0; idle bytes0')
  }finally{stage.close();term.close()}
})
