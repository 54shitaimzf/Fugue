import assert from 'node:assert/strict'
import {test} from 'node:test'
import {frameOf} from './frame.ts'
import {taskOf} from './task.ts'
import {statusOf} from '../probe/status.ts'
import type {StatusRow} from '../probe/status.ts'
import {themeOf,theme16,theme256,DEFAULT_THEME} from './theme.ts'
import {openTerm} from './term.ts'
import {setGlyphTier,widthOf} from './glyph.ts'

const ticks='\x60'
const paragraphs=[
 '# 一级标题','正文保持原句。',
 '## 二级标题','### 三级标题','#### 四级标题','##### 五级标题','###### 六级标题',
 '#没有空格不是标题','####### 七个标记不是标题','    # 缩进代码保持正文',
 ticks.repeat(4)+'text','# 四标记代码块里的文字',ticks.repeat(3),'## 短关闭标记后仍属代码',ticks.repeat(4),
 '~~~text','## 波浪线代码块里的文字','~~~',
 'Setext标题','===','', '另一标题','---','',
 ticks.repeat(3)+'unfinished','## 未关闭代码中的文字',
]
const events=(body=paragraphs.join('\n')):StatusRow[]=>[
 {pos:{writer:'round',seq:1},e:{t:'round/state',round:'r1',from:'Delegated',to:'Working'}},
 {pos:{writer:'round',seq:2},e:{t:'round/intent',round:'r1',body:JSON.stringify({goal:'检查标题层次'})}},
 {pos:{writer:'round',seq:3},e:{t:'holder/distill',round:'r1',agent:'round',body}},
] as StatusRow[]
const textOf=(frame:ReturnType<typeof frameOf>)=>frame.lines.map(l=>l.slice(1,-1).trim())
test('模型身份与ATX/Setext标题独立，代码块与正文不误强调，原文仍完整',()=>{
 const rows=events(),task=taskOf(rows),frame=frameOf({snapshot:statusOf(rows),task,width:120,height:45})
 const text=textOf(frame),header=['模型 · 当前理解',...paragraphs.slice(0,1),...paragraphs.slice(2,7),'Setext标题','另一标题']
 for(const line of header){const at=text.indexOf(line);assert.ok(at>=0,line+' 保留');assert.equal(frame.roles[at],'modelHeading',line+' 是标题')}
 for(const line of paragraphs.filter(l=>l.trim()!==''&&!header.includes(l))){const at=text.indexOf(line.trim());assert.ok(at>=0,line);assert.equal(frame.roles[at],'model',line+' 保持正文')}
 assert.equal(task.rows.find(r=>r.role==='model')!.text,'模型 · 当前理解\n'+paragraphs.join('\n'))
 assert.deepEqual(taskOf(rows,null,true).rows.find(r=>r.role==='model'),task.rows.find(r=>r.role==='model'),'原文阅读不提取或删改标题')
 const read=frameOf({snapshot:statusOf(rows),task,width:120,height:45,read:{rows:paragraphs,top:0,heading:'完整记录',footer:'原文'}})
 assert.ok(!read.roles.includes('modelHeading'),'原文阅读正文不解析标题')
 assert.ok(read.lines.some(l=>l.includes('## 未关闭代码中的文字')))
 for(const view of ['progress','spending'] as const)assert.ok(!frameOf({snapshot:statusOf(rows),task,width:120,height:45,view}).roles.includes('modelHeading'))
 console.log('model headings:identity+ATX1..6+Setext; two fence types, short close, unclosed and indented code remain model; raw and secondary views unchanged')
})
test('长标题折行、尾部身份恢复、计划侧栏仍保留标题角色，用户原文不作Markdown解释',()=>{
 for(const glyph of ['ascii','box','rich'] as const){
  setGlyphTier(glyph)
  for(const width of [192,80,24])for(const height of [45,19,8]){
   const body='## 需要核查的模型标题需要核查的模型标题\n'+Array.from({length:60},(_,i)=>'原文 '+i+' 逐句保留').join('\n')
   const rows=events(body),task=taskOf(rows),snapshot=statusOf(rows)
   const frame=frameOf({snapshot,task,width,height})
   assert.equal(frame.lines.length,height);assert.ok(frame.lines.every(l=>widthOf(l)===width))
   const identity=textOf(frame).indexOf('模型 · 当前理解');assert.ok(identity>=0);assert.equal(frame.roles[identity],'modelHeading','截尾恢复的身份仍有标题角色')
   assert.ok(frame.lines.some(l=>l.includes('原文 59')))
   const user=frameOf({snapshot,task:{...task,rows:[{role:'user',text:'你\n## 用户原文'}]},width,height})
   assert.ok(!user.roles.includes('modelHeading'))
  }
  for(const width of [192,80,24]){
   const title='## '+'需要检查标题'.repeat(10),rows=events(title+'\n正文')
   const frame=frameOf({snapshot:statusOf(rows),task:taskOf(rows),width,height:45})
   const headings=frame.lines.filter((_,i)=>frame.roles[i]==='modelHeading').map(l=>l.slice(1,-1).trim())
   assert.ok(headings.length>=(width===24?4:2),'长标题的每条折行都有标题角色')
   assert.equal(headings.slice(1).join('').replace(/\s/g,''),title.replace(/\s/g,''),'折行保留标题全部文字')
  }
  const rows=events('## 一条很长的标题'.repeat(5)+'\n正文')
  const task={...taskOf(rows),plan:[{text:'核查消息',status:'in_progress' as const}]}
  const frame=frameOf({snapshot:statusOf(rows),task,width:192,height:45,operationArea:true})
  assert.ok(frame.segments);assert.ok(frame.segments!.some(p=>p.some(s=>s.role==='modelHeading')),'侧栏分段保持消息标题角色')
  assert.ok(frame.lines.every(l=>widthOf(l)===192))
 }
 setGlyphTier('box')
 console.log('model heading geometry:3 glyphs x3 widths x3 heights; tail identity27/27; user Markdown0; plan segments3/3; full wrapped title9/9; text retained')
})
test('16色与256色标题宿主加粗，正文复位；属性与两道全关门保持原样，非TTY纯原文',()=>{
 const rows=events('## 标题\n正文段落'),snapshot=statusOf(rows),task=taskOf(rows)
 const panel=frameOf({snapshot,task,width:80,height:19})
 const render=(theme:ReturnType<typeof themeOf>,tty=true)=>{
  const writes:string[]=[];const term=openTerm({out:{isTTY:tty,columns:80,rows:24,write:s=>writes.push(s)},height:19,theme,term:'xterm-256color'})
  term.draw(['永久原文'],()=>({rows:panel.lines,roles:panel.roles}));term.close();return writes.join('')
 }
 for(const theme of [theme16(),theme256(),theme256('light'),theme256('dark')]){
  assert.equal(theme.modelHeading,'\x1b[1m');assert.equal(theme.model,undefined)
  const raw=render(theme)
  for(const [i,role] of panel.roles.entries())if(role==='modelHeading')assert.ok(raw.includes('\x1b[1m'+panel.lines[i]+'\x1b[0m'),'标题只加粗并在行末复位')
  const at=panel.lines.findIndex(l=>l.includes('正文段落'));assert.ok(raw.includes(panel.lines[at]!),'正文原文在位')
  assert.equal(render(theme,false),'永久原文\n')
 }
 assert.equal(themeOf({term:'unknown'}),DEFAULT_THEME);assert.equal(DEFAULT_THEME.modelHeading,undefined)
 const plain=render(undefined)
 for(const colorFgBg of [undefined,'0;15','15;0','bogus']){
  assert.equal(render(themeOf({term:'xterm-256color',colorFgBg,noStyle:true})),plain)
  assert.equal(render(themeOf({term:'xterm-256color',colorFgBg,noColor:'1'})),plain)
 }
 console.log('model heading style:16/256 default/light/dark host bold/reset; model unchanged; original DEFAULT_THEME and no-style/NO_COLOR bytes exact; nonTTY ANSI0')
})
test('标题流式变化、代码围栏闭合、阅读往返和宽度变化保持原序与停留零输出',()=>{
 let draws=0,idles=0
 for(const glyph of ['ascii','box','rich'] as const){
  setGlyphTier(glyph)
  for(const theme of [theme16(),theme256(),theme256('light'),theme256('dark'),DEFAULT_THEME,undefined]){
   let width=192;const writes:string[]=[]
   const term=openTerm({out:{isTTY:true,get columns(){return width},rows:50,write:s=>writes.push(s)},height:45,term:'xterm-256color',theme})
   for(const [w,body,reading] of [[192,'## 章节\n正文',false],[80,ticks.repeat(3)+'text\n## 代码中的文字',false],[24,ticks.repeat(3)+'text\n## 代码中的文字\n'+ticks.repeat(3)+'\n## 新章节',false],[192,'## 章节\n正文',true],[192,'## 章节\n正文',false]] as const){
    width=w;const rows=events(body),task=taskOf(rows)
    const panel=frameOf({snapshot:statusOf(rows),task,width,height:45,...(reading?{read:{rows:body.split('\n'),top:0,heading:'完整记录'}}:{})})
    assert.ok(panel.lines.every(l=>widthOf(l)===width));assert.equal(panel.lines.length,45)
    const draw=()=>term.draw([],()=>({rows:panel.lines,roles:panel.roles}))
    draw();draws++;writes.length=0;draw();draws++;idles++;assert.equal(writes.join(''),'')
   }
   term.close()
  }
 }
 setGlyphTier('box')
 console.log('model heading sequence:3 glyphs x6 themes x5 transitions;'+draws+' draws'+idles+' idles bytes0; stream/fence/read/return/width; component sequence, not native resize')
})
test('多行Setext完整强调，分隔线不构成标题，围栏只允许ASCII空白关闭',()=>{
 const cases=[
  {body:'第一行标题\n第二行标题\n===\n正文',headings:['第一行标题','第二行标题'],plain:['===','正文']},
  {body:'===\n---\n\n# \u00a0\n后续正文',headings:['===','#'],plain:['---','后续正文']},
  {body:'---\n---\n\n***\n---\n\n___\n---',headings:[],plain:['---','***','___']},
  {body:ticks.repeat(3)+'text\n## 围栏中的文字\n'+ticks.repeat(3)+'\u00a0\n## 非ASCII尾部后仍在代码中\n'+ticks.repeat(3)+'\n## 真正关闭后的标题',
   headings:['## 真正关闭后的标题'],plain:['## 围栏中的文字','## 非ASCII尾部后仍在代码中']},
 ]
 for(const c of cases){
  const rows=events(c.body),task=taskOf(rows),frame=frameOf({snapshot:statusOf(rows),task,width:120,height:45}),text=textOf(frame)
  for(const line of c.headings){const at=text.indexOf(line);assert.ok(at>=0);assert.equal(frame.roles[at],'modelHeading',line)}
  for(const line of c.plain)for(const [at,value] of text.entries())if(value===line)assert.equal(frame.roles[at],'model',line)
  assert.equal(task.rows.find(r=>r.role==='model')!.text,'模型 · 当前理解\n'+c.body)
 }
 console.log('model heading grammar:multiline Setext all lines; thematic breaks plain; NBSP fence tail stays code until exact ASCII close; cases4/4 raw exact')
})
