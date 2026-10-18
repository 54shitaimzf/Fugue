import assert from 'node:assert/strict'
import {test} from 'node:test'
import {frameOf,innerOf} from './frame.ts'
import {taskOf} from './task.ts'
import {statusOf} from '../probe/status.ts'
import type {StatusRow} from '../probe/status.ts'
import {glyphs,setGlyphTier,widthOf} from './glyph.ts'
import {gateFaceOf,gateLayoutOf} from './gate.ts'
import {openStage} from './stage.ts'
import {openSession} from './follow.ts'
import {openTerm} from './term.ts'
import {theme16,theme256,DEFAULT_THEME} from './theme.ts'
import {KEYMAP,hintLineOf} from './keymap.ts'
const events=(state='Working')=>[
 {pos:{writer:'round',seq:1},e:{t:'round/state',round:'r1',from:'Idle',to:state}},
 {pos:{writer:'round',seq:2},e:{t:'round/intent',round:'r1',body:'修复登录提示'}},
 {pos:{writer:'holder/r1',seq:1},e:{t:'holder/reply',agent:'holder/r1',body:'保留账号，只调整失败提示。'}},
] as StatusRow[]
const face=gateFaceOf({round:'r1',fingerprint:'top-content',same:[],contracts:[{id:'r1.implement.1',agent:'agent/r1/1',kind:'implement',goal:'修复登录提示',ownedPaths:['src/login.ts'],seed:[],deliverables:[],assertions:[]}]} as never,{})
const contents=(f:ReturnType<typeof frameOf>)=>f.lines.flatMap((l,i)=>!['border','footer'].includes(f.roles[i]!)&&l.slice(1,-1).trim()!==''?[{text:l,role:f.roles[i]}]:[])
const base=(rows:StatusRow[],width=192,height=45)=>({snapshot:statusOf(rows),task:taskOf(rows),width,height,operationArea:true})

// 这一份原先是「标题在第 0 行、确认在框外下方」的顶部阅读面（`top-content.test.ts`）。对话式界面
// 把重点挪到了输入上方：对话块从下往上长，确认块紧接在它下面，余量留在上面。旧判据（标题必须在
// 第 0 行、两区之间要大段留白）与现在的观感相反，因此随实现改名并改写；容量、正文逐字节、输入锚
// 与旧批准不执行这几条承诺原样保留。
test('当前任务与交流贴着输入往上长，决定块紧接在对话框下面；完整正文与固定操作位置保持',()=>{
 let cases=0
 try{for(const glyph of ['ascii','box','rich'] as const){setGlyphTier(glyph)
  for(const [width,height] of [[192,45],[160,35],[80,35],[24,35]])for(const state of ['Working','Planning','Aborted','Rebuilding']){
   const o=base(events(state),width,height)
   for(const gate of [false,true]){
    const bottom=gate?gateLayoutOf({face,view:{at:0,armed:null},columns:innerOf(width),height}):undefined
    const input={...o,bottom},f=frameOf(input),legacy=frameOf({...input,operationArea:false})
    const at=f.lines.findIndex(l=>l.startsWith(glyphs().tl))
    assert.ok(at>=0&&f.lines[at]!.includes('当前任务'),'任务身份在框顶')
    assert.notEqual(f.lines[at+1]!.slice(1,-1).trim(),'','正文从标题下一行开始')
    assert.equal(f.roles.at(-1),'border','框底始终画出来')
    assert.deepEqual(contents(f),contents(legacy),'所有非框线正文、角色与顺序保留')
    if(bottom){
     const firstCard=f.lines.length-bottom.rows.length-1
     assert.equal(f.roles[firstCard-3],'border','对话框在决定块上方收口')
     assert.equal(f.lines[firstCard-2]!.trim(),'','两块之间只空一行')
     assert.equal(f.roles[firstCard-1],'border','决定块有自己的顶边')
     assert.ok(firstCard-at>3,'对话块与决定块都贴着输入')
     assert.deepEqual(f.lines.slice(firstCard,-1).map(l=>l.slice(1,-1).trim()),bottom.rows.map(l=>l.trim()),'确认仍在原固定位置，逐行完整')
    }
    assert.ok(f.lines.slice(0,at).every(l=>l.trim()===''),'留白在框上方')
    assert.ok(f.roles.slice(0,at).every(r=>r==='body'),'空余行不承担等待或消息样式')
    assert.equal(f.lines.length,height);assert.equal(f.roles.length,height);assert.ok(f.lines.every(l=>widthOf(l)===width))
    assert.deepEqual(frameOf(input),f);cases++
   }
  }
 }}finally{setGlyphTier('box')}
 console.log('bottom content:'+cases+' text/role/order comparisons;title frame top/body next;adjacent lower confirmation;full capacity;spare above outlines')
})

test('辅助计划从同一框顶展开，框上方不延伸分隔线；长计划保有全高度与省略入口',()=>{
 for(const glyph of ['ascii','box','rich'] as const){setGlyphTier(glyph)
  const o=base(events()),plan=[{text:'核对登录',status:'in_progress' as const},{text:'保留账号',status:'pending' as const}]
  const f=frameOf({...o,task:{...o.task,plan}}),s=f.segments!,at=f.lines.findIndex(l=>l.startsWith(glyphs().tl))
  assert.equal(s[at]![2]!.text.trim(),'计划');assert.ok(s[at]![0]!.text.includes('当前任务'));assert.notEqual(s[at+1]![0]!.text.slice(1,-1).trim(),'')
  for(let i=0;i<at;i++){assert.equal(s[i]![0]!.text.trim(),'');assert.equal(s[i]![1]!.text,'   ');assert.equal(s[i]![2]!.text.trim(),'')}
  const many=Array.from({length:60},(_,i)=>({text:'步骤'+i,status:'pending' as const}))
  const tall=frameOf({...o,task:{...o.task,plan:many}})
  assert.equal(tall.segments![0]![2]!.text.trim(),'计划');assert.ok(tall.segments!.at(-1)![2]!.text.includes('还有计划未展开'));assert.equal(tall.lines.length,45)
 }
 setGlyphTier('box')
 console.log('bottom plan:3glyph;primary/plan share frame top;short separator ends with route;60steps use all45rows and omission')
})

test('密集、只读、未知任务与操作、阅读帮助和二级面保留原字节；稀少余量不增加框线或挤正文',()=>{
 const o=base(events())
 for(const change of [{operationArea:false},{operationArea:undefined},{task:undefined},{task:{...o.task,round:'other'}},{task:{...o.task,rows:[{text:'unknown',role:'body' as const}]}},{bottom:{rows:['unknown'],keep:1}},{read:{rows:['完整原文'],top:0}},{menu:{rows:['菜单'],sel:0}},{menu:{rows:['菜单'],sel:0,detail:['帮助']}},{view:'progress' as const},{view:'spending' as const}]){
  const input={...o,...change},f=frameOf(input);assert.deepEqual(f,frameOf({...input,operationArea:false}))
  assert.ok(f.lines.slice(1,-1).every(l=>l.startsWith(glyphs().v)||l.startsWith(glyphs().ml)),'每个原内部行保有完整旧框线，未知场景不拆区')
 }
 for(const width of [192,80,24,16,8])for(const height of [45,19,7,5]){
  const dense={...o,width,height,task:{...o.task,rows:[...o.task.rows,{text:'模型\n'+Array.from({length:120},(_,i)=>'原文'+i).join('\n'),role:'model' as const}]}}
  assert.deepEqual(frameOf(dense),frameOf({...dense,operationArea:false}))
 }
 const small={...o,width:80,height:9},f=frameOf(small)
 assert.ok(f.lines.filter(l=>l.startsWith(glyphs().tl)).length<=(glyphs().tl===glyphs().bl?2:1),'余量少时不加第二个框头')
 assert.deepEqual(contents(f),contents(frameOf({...small,operationArea:false})))
 console.log('bottom content floor:11contexts+20dense geometries byte exact;small capacity spends no new rows')
})

test('实际Stage/Session/Term多帧增长、确认和阅读返回：输入锚、草稿/光标、旧批准与停留保持',async()=>{
 let paints=0,idles=0
 for(const glyph of ['ascii','box','rich'] as const){setGlyphTier(glyph)
  for(const theme of [theme16(),theme256(),theme256('light'),theme256('dark'),DEFAULT_THEME,undefined]){
   let rows=events(),pending:typeof face|null=null;const chunks:string[]=[],commands:string[]=[],anchors:number[]=[]
   const stage=openStage({columns:()=>192,termRows:()=>50,rows:()=>rows,pendingFace:async()=>pending,redraw:()=>{},note:()=>{},hint:w=>hintLineOf(KEYMAP,0,w),now:()=>0,abort:()=>{},run:()=>({running:false,last:[],argvOf:()=>({words:[],argv:[],why:null}),press:s=>{commands.push(s);return true},stop:()=>false})})
   stage.setRaw(true);stage.onAdvance(rows);const session=openSession({view:stage.view});session.push(rows)
   const term=openTerm({out:{isTTY:true,columns:192,rows:50,write:s=>chunks.push(s)},term:'xterm-256color',theme,heightOf:stage.heightWant})
   const draw=()=>{let p:ReturnType<typeof session.panel>;term.draw([],size=>{p=session.panel(size);return p});paints++;anchors.push(p!.rows.length);return p!}
   const idle=()=>{chunks.length=0;draw();assert.equal(chunks.join(''),'');idles++}
   stage.onAction({action:'insert',text:'保留草稿和光标'});const draft=stage.view().input;draw();idle()
   for(const n of [1,8,60,3]){const batch=[{pos:{writer:'holder/r1',seq:n+100},e:{t:'holder/reply',agent:'holder/r1',body:Array.from({length:n},(_,i)=>'进展'+i).join('\n')}}] as StatusRow[];rows=[...rows,...batch];stage.onAdvance(batch);session.push(batch);draw();idle()}
   pending=face;await stage.refreshGate();draw();idle();stage.onAction({action:'approve',key:'y'});draw()
   stage.onAction({action:'read'});draw();stage.onAction({action:'cancel'});draw();stage.onAction({action:'submit'});draw();assert.deepEqual(commands,[],'全文返回清除旧批准')
   stage.onAction({action:'cancel'});draw();idle();assert.deepEqual(stage.view().input,draft)
   assert.ok(anchors.every(x=>x===anchors[0]),'内容疏密与确认开合不移动输入锚')
   stage.close();term.close()
  }
 }
 assert.equal(paints,324);assert.equal(idles,126)
 setGlyphTier('box');console.log('bottom content sequence:'+paints+' paints/'+idles+' idle bytes0;3glyph x6themes;sparse/dense/confirmation/read return;input anchor/draft/caret exact;old approval executes0;component not native resize')
})
