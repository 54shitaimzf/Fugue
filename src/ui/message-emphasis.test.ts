import assert from 'node:assert/strict'
import {test} from 'node:test'
import {createHash} from 'node:crypto'
import {frameOf} from './frame.ts'
import {readingsOf} from '../probe/status.ts'
import {taskOf} from './task.ts'
import {openTerm} from './term.ts'
import {themeOf} from './theme.ts'
import {setGlyphTier,widthOf} from './glyph.ts'
import type {StatusRow} from '../probe/status.ts'
function input(scene:string,width:number,height:number,plan:boolean,goal='修复提示并保留账号。'){
 const rows:StatusRow[]=[],push=(e:object)=>rows.push({pos:{writer:'round',seq:rows.length+1},e} as never)
 if(scene!=='empty'){
  push({t:'round/state',round:'r1',from:'Idle',to:'Planning'});push({t:'round/intent',round:'r1',body:JSON.stringify({goal})})
  push({t:'holder/distill',agent:'round',body:'我会检查失败路径，再修改提示并验证登录。'})
  if(plan)push({t:'holder/todos',agent:'round',body:JSON.stringify({todos:[{content:'检查失败路径',status:'completed'},{content:'修复提示与输入状态',status:'in_progress'},{content:'验证登录行为',status:'pending'}]})})
  if(['run','failed','done'].includes(scene)){
   push({t:'round/state',round:'r1',from:'Delegated',to:'Working'})
   push({t:'agent/handoff',agent:'agent/r1/1',body:'失败提示已就近显示，账号内容保留；接着验证重试和成功路径。'})
   push({t:'run/start',agent:'agent/r1/1',argv0:'node',argv:['node','tools/test-entry.js','fast']})
  }
  if(scene==='failed'){push({t:'run/end',agent:'agent/r1/1',exit:1});push({t:'round/state',round:'r1',from:'Verifying',to:'Working'})}
  if(scene==='done'){push({t:'merge/accept',round:'r1',commit:'result',assertions:[{assertion:'重试',verdict:'pass'},{assertion:'成功',verdict:'pass'}]});push({t:'round/state',round:'r1',from:'Committed',to:'Rebuilding'})}
  if(scene==='next'){push({t:'round/state',round:'r2',from:'Idle',to:'Planning'});push({t:'round/intent',round:'r2',body:JSON.stringify({goal:'检查下一件任务。'})})}
 }
 return {...readingsOf(rows),task:taskOf(rows),operationArea:true,taskReadKey:'Alt-T',width,height,
  ...(scene==='approve'?{bottom:{rows:['将修改 src/login.ts','y 执行整批 · n 暂不执行'],waitingAt:1,waitingCount:1,keep:2,confirmationRound:'r1'}}:{})}
}
function* cases(){
 for(const glyph of ['ascii','box','rich'] as const){setGlyphTier(glyph)
  for(const width of [192,120,108,80,40,24,16])for(const height of [8,12,24,40,50])
  for(const plan of [false,true])for(const scene of ['empty','approve','run','failed','done','next'])yield {glyph,width,height,plan,scene,base:input(scene,width,height,plan)}
 }
}
function painted(frame:ReturnType<typeof frameOf>,theme:ReturnType<typeof themeOf>){
 let out='';const t=openTerm({out:{isTTY:true,columns:frame.width,rows:frame.height+4,write:s=>{out+=s}},term:'xterm',heightOf:()=>frame.height,theme})
 t.draw([],()=>({rows:frame.lines,roles:frame.roles,segments:frame.segments}));const first=out;out='';t.draw([],()=>({rows:frame.lines,roles:frame.roles,segments:frame.segments}));assert.equal(out,'','unchanged segmented paint remains byte quiet');t.close();return first
}
const plainHash=()=>createHash('sha256'),plain=(f:ReturnType<typeof frameOf>)=>{const {segments,...rest}=f;return rest}
function floors(base:ReturnType<typeof input>){
 return [{...base,operationArea:undefined},{...base,operationArea:false},{...base,operationArea:'true'},
  {...base,operationArea:null},{...base,view:'progress'},{...base,view:'spending'},
  {...base,read:{rows:['FULL ORIGINAL RECORD'],top:0,heading:'Record'}},
  {...base,menu:{source:'cmd',rows:['/status'],sel:0}},
  {...base,task:{...base.task,round:'foreign'}},
  input('run',base.width,base.height,false,'LONG-'+('abcdefghij'.repeat(50))),
  {...base,task:{...base.task,rows:base.task.rows.map(r=>r.role==='user'?{...r,text:''}:r)}}] as never[]
}

test('current short user messages form a content-sized consistent emphasis block, preserving full scene geometry, role text, original capacity and attribute/no-style byte floors',()=>{
 let count=0,bounded=0,pixelCellsOld=0,pixelCellsNew=0
 const geometry=plainHash(),none=plainHash(),attribute=plainHash()
 try{for(const c of cases()){
  const f=frameOf(c.base);geometry.update(JSON.stringify(plain(f)))
  none.update(painted(f,undefined));attribute.update(painted(f,themeOf({term:'unknown'})))
  assert.equal(f.height,c.height);assert.equal(f.lines.length,c.height);assert.ok(f.lines.every(s=>widthOf(s)===c.width))
  const starts=f.roles.flatMap((role,i)=>role==='user'&&(i===0||f.roles[i-1]!=='user')?[i]:[])
  for(const at of starts){
   let end=at;while(f.roles[end+1]==='user')end++
   const parts=f.segments?.slice(at,end+1)
   if(c.width>=80&&c.height>=24){
    assert.ok(parts?.every(row=>row.filter(p=>p.role==='user').length===1&&row.length>=3),'a sparse visible user block has one bounded role segment on each actual row')
    const widths=parts!.map(row=>widthOf(row.find(p=>p.role==='user')!.text));assert.ok(widths.every(w=>w===widths[0]),'all rows of the same message share one emphasis width')
    assert.ok(widths[0]!<f.columns.left-1,'user emphasis does not occupy unused main content columns')
    bounded++;pixelCellsOld+=(f.columns.left+4)*(end-at+1);pixelCellsNew+=widths[0]!*(end-at+1)
   }
  }
  if(f.segments)for(const [i,parts] of f.segments.entries())assert.equal(parts.map(p=>p.text).join(''),f.lines[i],'segment projection contains the exact complete original plain row')
  const dark=painted(f,themeOf({term:'xterm-256color',colorFgBg:'15;0'})),light=painted(f,themeOf({term:'xterm-256color',colorFgBg:'0;15'})),linux=painted(f,themeOf({term:'linux'}))
  assert.equal(dark.replace(/\x1b\[[\d;]*m/g,''),painted(f,undefined));assert.equal(light.replace(/\x1b\[[\d;]*m/g,''),painted(f,undefined));assert.equal(linux.replace(/\x1b\[[\d;]*m/g,''),painted(f,undefined))
  count++
 }}finally{setGlyphTier('box')}
 // 字节基线重录（维护版四笔）：第一笔是截断只停在消息边界上（`frame.test.ts` ⑰ 用旧版做过负对照）；
 // 第二笔是当前任务那一块从顶部改挂到输入上方；第三笔是去掉行首的身份词（“你”“模型 ·”），目标改用
 // `> ` 标记、框名固定为“当前任务”；第四笔是失败与中止那两句下一步文案（说一句怎么改 / 工作区可能已有
 // 部分改动）。四次都让 1260 例里相关的几何、无色与属性字节一起换了；上面那些分配、角色、宽度与强调
 // 断言一条没动，所以基线换的是“当前任务画在哪、长什么样”，不是“容量与角色怎么分”。
 assert.equal(geometry.digest('hex'),'543d542066f9e65844f4863baf90ab45c5eb91851b72ff6b72c3dd06689f045a','all six scenes retain every original plain frame field')
 assert.equal(none.digest('hex'),'840950f8aa1bac77a7dbd3954ac8c73bc795f4cdf17a3932b63f5e79db58140f','no-style output is byte-exact with the parent across all scenes')
 assert.equal(attribute.digest('hex'),'063e807dcd141f905373073770a9256517ef8dd8c7c9dd0a26d1e57d353895d0','the original attribute tier is byte-exact across all scenes')
 console.log('message emphasis:cases'+count+';boundedBlocks'+bounded+';oldCells'+pixelCellsOld+';newCells'+pixelCellsNew+';3glyph/7width/5height/plan+plain/6scenes;plain geometry exact;no-style+attribute parent bytes exact;content/roles/capacity exact;dark/light/16 visible bytes exact;all repeated paints0')
})
test('unsupported foreground and dense or empty user contexts keep the complete original frame metadata and style bytes',()=>{
 const legacy=plainHash();let count=0
 try{for(const c of cases())for(const o of floors(c.base)){
  const f=frameOf(o);legacy.update(JSON.stringify(f));legacy.update(painted(f,undefined));legacy.update(painted(f,themeOf({term:'unknown'})));count++
 }}finally{setGlyphTier('box')}
 assert.equal(legacy.digest('hex'),'e0d65dc329af5b4a4d251e9a66945956664cc358bb65de89d9673b0afa727614','readonly/bad operation/secondary/reader/menu/foreign/dense/blank cases preserve complete parent frames and byte floors')
 console.log('message emphasis floors:cases'+count+';complete original frames+none/attribute bytes exact;repeated paints0')
})
