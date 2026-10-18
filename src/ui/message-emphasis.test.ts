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
 // 字节基线重录（0.5.1）：12 行高的截断不再只把标题拿回来、正文留在中段——同一消息的物理行现在整条回到屏上
 //（`frame.test.ts` ⑰ 锁住这条）。1260 例里只有 height=12 的 36 例变了；上面那些分配、角色、宽度与强调断言一条没动，
 // 所以这份基线换的是“截断时印什么”，不是“容量与角色怎么分”。
 assert.equal(geometry.digest('hex'),'90baac4729348d0f87b2a77828378d34215054067655c49384167431c9d7c4a7','all six scenes retain every original plain frame field')
 assert.equal(none.digest('hex'),'332cdf85e4b3e1892ef12f5470bf23abb33b01627a5a6b3d3bbdbaa6ad08a5dd','no-style output is byte-exact with the parent across all scenes')
 assert.equal(attribute.digest('hex'),'efd8ed9229e9f03674d4f1e1fa047fae477f2e9d503a9270d3e887140927dc7f','the original attribute tier is byte-exact across all scenes')
 console.log('message emphasis:cases'+count+';boundedBlocks'+bounded+';oldCells'+pixelCellsOld+';newCells'+pixelCellsNew+';3glyph/7width/5height/plan+plain/6scenes;plain geometry exact;no-style+attribute parent bytes exact;content/roles/capacity exact;dark/light/16 visible bytes exact;all repeated paints0')
})
test('unsupported foreground and dense or empty user contexts keep the complete original frame metadata and style bytes',()=>{
 const legacy=plainHash();let count=0
 try{for(const c of cases())for(const o of floors(c.base)){
  const f=frameOf(o);legacy.update(JSON.stringify(f));legacy.update(painted(f,undefined));legacy.update(painted(f,themeOf({term:'unknown'})));count++
 }}finally{setGlyphTier('box')}
 assert.equal(legacy.digest('hex'),'03f84135c38e3e0bd612145a77599aef031df21bb4b89b3f53e6699064abb189','readonly/bad operation/secondary/reader/menu/foreign/dense/blank cases preserve complete parent frames and byte floors')
 console.log('message emphasis floors:cases'+count+';complete original frames+none/attribute bytes exact;repeated paints0')
})
