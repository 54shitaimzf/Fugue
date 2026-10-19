import assert from 'node:assert/strict'
import { test } from 'node:test'
import { frameOf, footerOf } from './frame.ts'
import { taskOf } from './task.ts'
import { statusOf } from '../probe/status.ts'
import type { StatusRow } from '../probe/status.ts'
import { setGlyphTier, widthOf } from './glyph.ts'
import { gateFaceOf, gateLayoutOf } from './gate.ts'
import type { Contract } from '../contract/types.ts'
import { openStage } from './stage.ts'
import { openSession } from './follow.ts'
import { openTerm } from './term.ts'
import { KEYMAP, hintLineOf } from './keymap.ts'

const body = Array.from({length:60},(_,i)=>`原文 ${String(i).padStart(2,'0')} 登录错误与重试行为`).join('\n')
const events = (): StatusRow[] => [
  {pos:{writer:'round',seq:1},e:{t:'round/state',round:'r1',from:'Delegated',to:'Working'}},
  {pos:{writer:'round',seq:2},e:{t:'round/intent',round:'r1',body:JSON.stringify({goal:'修复登录提示。'})}},
  {pos:{writer:'agent/r1/1',seq:1},e:{t:'agent/handoff',agent:'agent/r1/1',body}},
  {pos:{writer:'agent/r1/1',seq:2},e:{t:'run/start',agent:'agent/r1/1',argv0:'node',argv:['node','tools/test-entry.js']}},
] as StatusRow[]
const face = gateFaceOf({round:'r1',fingerprint:'review',same:[],contracts:[{id:'r1.implement.1',agent:'agent/r1/1',kind:'implement',goal:'修复登录提示',ownedPaths:['src/login.ts'],assertions:[],deliverables:[],seed:[]}] as unknown as Contract[]},{})
const plain = (f:ReturnType<typeof frameOf>) => f.lines.map(l=>l.slice(1,-1).trim())

test('主面实际动作替代笼统执行阶段；失败与未知状态保持独立事实',()=>{
  const rows=events(), task=taskOf(rows), snapshot=statusOf(rows)
  const f=frameOf({snapshot,task,width:120,height:35})
  assert.equal(plain(f).filter(l=>l==='正在执行').length,0,'已经显示实际命令，不再重复笼统阶段')
  assert.equal(plain(f).filter(l=>l==='正在执行：node tools/test-entry.js').length,1)
  assert.equal(f.roles.includes('footer'),false,'实际动作承担已知当前任务状态')
  const full=taskOf(rows,null,true)
  assert.ok(full.rows.some(r=>r.text===body),'完整消息原文不因裁切改变')
  const failed=[...rows,{pos:{writer:'agent/r1/1',seq:3},e:{t:'run/end',agent:'agent/r1/1',exit:1}},{pos:{writer:'round',seq:3},e:{t:'round/state',round:'r1',from:'Verifying',to:'Working'}}] as StatusRow[]
  const bad=taskOf(failed)
  assert.equal(bad.rows.filter(r=>r.text==='命令失败（退出码 1）。').length,1)
  assert.equal(bad.rows[0]!.text,'验收未通过，本次结果未写回工作区。','验收失败不能被动作覆盖')
  const fallback=taskOf(rows.filter(r=>r.e.t!=='run/start'))
  assert.equal(fallback.rows[0]!.text,'正在执行','没有实际动作时保留已知阶段')
  const unknown=frameOf({snapshot,task:{...task,state:null},width:120,height:35})
  assert.equal(unknown.footer,footerOf(snapshot))
  console.log('main action: actual command one; generic duplicate0; failure one; unknown status floor kept; full message exact')
})

test('裁切长用户或模型消息仍把消息首行与尾巴一起留下；窄矮与无样式保住几何和全文入口',()=>{
  const rows=events(), snapshot=statusOf(rows)
  for(const glyph of ['ascii','box','rich'] as const){
    setGlyphTier(glyph)
    for(const [role,first] of [['model','原文 00 登录重试'],['user','> 原文 00 登录重试']] as const){
      const text=(role==='user'?'> ':'')+Array.from({length:60},(_,i)=>`原文 ${String(i).padStart(2,'0')} 登录重试`).join('\n')
      const task={...taskOf(rows),rows:[{text:'正在执行',role:'system' as const},{text:'',role:'body' as const},{text,role}]}
      for(const width of [120,80,24])for(const height of [35,19,8,7]){
        const f=frameOf({snapshot,task,width,height}), lines=plain(f)
        // 24 列那几档只有 7 行框：留得住消息首行时留下；留不住时必须留着完整记录入口，不静默丢。
        assert.ok(width<80||lines.some(l=>l.includes(first)),`${glyph} ${width}x${height} ${role}: 消息首行不能丢在截断里`)
        assert.ok(width<80||lines.some(l=>l.includes('原文 59')),`${role} 最新正文仍可见`)
        assert.ok(lines.some(l=>/未展开|看全/.test(l)),`${glyph} ${width}x${height} ${role}: 省略必须可见`)
        assert.equal(f.lines.length,height);assert.ok(f.lines.every(l=>widthOf(l)===width))
        assert.equal(f.roles.length,height)
      }
      for(const height of [5,6]){
        const f=frameOf({snapshot,task,width:16,height})
        assert.equal(f.lines.length,height);assert.ok(f.lines.every(l=>widthOf(l)===16))
      }
    }
  }
  setGlyphTier('box')
  console.log('identity: model/user x ascii/box/rich x120/80/24 x35/19/8/7; message first line + latest body + omission; 16x5/6 exact')
})

// R5：一条**长单段**（没有换行，折成很多行）在矮屏上截断时，开头不能被尾巴挤掉；
// `> ` 是这条消息的行首标记，只能出现在第一行——续行缩进两格。
test('R5 · 40×12 长单段：首行带 `> ` 可识别 · 标记只一处 · 省略可见', () => {
  const rows=events(), snapshot=statusOf(rows)
  const body='修复登录提示、保留账号、检查重试与失败回执，'.repeat(12)
  const text='> '+body
  for(const glyph of ['ascii','box','rich'] as const){
    setGlyphTier(glyph)
    const task={...taskOf(rows),rows:[{text:'正在执行',role:'system' as const},{text,role:'user' as const}]}
    const f=frameOf({snapshot,task,width:40,height:12}), lines=plain(f)
    assert.ok(lines.some(l=>l.startsWith('> 修复登录提示')),`${glyph}: 消息首行不能只剩尾行`)
    assert.equal(lines.filter(l=>l.trimStart().startsWith('> ')).length,1,`${glyph}: \`> \` 只贴第一行`)
    assert.ok(lines.some(l=>/未展开|看全/.test(l)),`${glyph}: 省略必须可见`)
    assert.equal(f.lines.length,12);assert.ok(f.lines.every(l=>widthOf(l)===40))
  }
  setGlyphTier('box')
  console.log('R5: long single paragraph 40x12 x3 glyphs; first line with one marker; omission visible')
})

test('确认区域已有当前指示时收起等待输入页脚；坏范围、阅读与二级视图保留地板',()=>{
  const snapshot=statusOf([]), bottom=gateLayoutOf({face,view:{at:0,armed:null},columns:114,height:35})
  const base={snapshot,width:120,height:35}
  const f=frameOf({...base,bottom})
  assert.equal(f.roles.includes('footer'),false,'确认时用户需要看确认动作')
  assert.equal(f.footer,'');assert.ok(!f.lines.join('\n').includes('等待输入'))
  assert.ok(f.roles.includes('waiting'));assert.match(f.lines.join('\n'),/执行整批/)
  for(const bad of [{...bottom,waitingAt:-1},{...bottom,waitingCount:0},{...bottom,waitingAt:bottom.rows.length},{...bottom,keep:0},{rows:['普通队列'],keep:1}]){
    assert.equal(frameOf({...base,bottom:bad}).footer,'等待输入','未知操作元数据保持原页脚')
  }
  const read={rows:['确认原文'],top:0,heading:'计划全文',footer:'1/1 行 · 只读'}
  assert.equal(frameOf({...base,bottom,read}).footer,read.footer)
  for(const view of ['progress','spending'] as const){
    const a=frameOf({...base,bottom,view}), b=frameOf({...base,bottom:{...bottom,waitingAt:-1},view})
    assert.deepEqual(a.lines,b.lines);assert.equal(a.footer,b.footer)
  }
  console.log('operation footer: valid confirmation waiting-input0; five invalid ranges keep floor; reading/secondary views unchanged')
})

test('真实舞台往返与重排保留消息身份、草稿和两段确认；停留零输出',async()=>{
  const rows=events(), writes:string[]=[], presses:string[]=[]
  let width=120,height=40,pending=false
  const stage=openStage({rows:()=>rows,columns:()=>width,termRows:()=>height,pendingFace:async()=>pending?face:null,
    note:()=>{},redraw:()=>{},now:()=>0,abort:()=>{},hint:w=>hintLineOf(KEYMAP,3,w),
    run:()=>({running:false,last:[],argvOf:()=>({words:[],argv:[],why:null}),press:s=>{presses.push(s);return true},stop:()=>false})})
  stage.setRaw(true);stage.onAdvance(rows)
  const session=openSession({view:stage.view});session.push(rows)
  const term=openTerm({term:'xterm',heightOf:stage.heightWant,out:{isTTY:true,get columns(){return width},get rows(){return height},write:s=>writes.push(s)}})
  let frames=0,idles=0
  const draw=()=>{let panel:ReturnType<typeof session.panel>|undefined;writes.length=0;term.draw([],size=>{panel=session.panel(size);return panel});frames++;return panel!}
  const idle=()=>{draw();assert.equal(writes.join(''),'');idles++}
  try{
    stage.onAction({action:'insert',text:'接下来检查重试'});const draft=stage.view().input
    for(const [w,h] of [[120,40],[80,24],[24,12],[120,40]]){
      width=w;height=h;stage.onResize();const p=draw();assert.match(p.rows.join('\n'),w>=80?/原文 00/:/修复登录提示/);idle()
    }
    stage.onAction({action:'read'});draw();stage.onAction({action:'pageDown'});draw()
    stage.onAction({action:'panel'});draw();stage.onAction({action:'cancel'});draw();stage.onAction({action:'cancel'});draw()
    assert.deepEqual(stage.view().input,draft);assert.match(draw().rows.join('\n'),/原文 00/);idle()
    pending=true;await stage.refreshGate();draw();stage.onAction({action:'approve'});draw();assert.equal(presses.length,0)
    stage.onAction({action:'read'});draw();stage.onAction({action:'cancel'});draw()
    stage.onAction({action:'submit'});draw();assert.equal(presses.length,0,'阅读返回不能沿用旧确认')
    stage.onAction({action:'approve'});draw();assert.equal(presses.length,0)
    stage.onAction({action:'approve'});draw();assert.equal(presses.length,1)
    assert.deepEqual(stage.view().input,draft);idle()
    console.log(`main recognition sequence: frames${frames}; idles${idles} bytes0; draft kept; readonly/old press0; fresh second1`)
  }finally{stage.close();term.close()}
})
