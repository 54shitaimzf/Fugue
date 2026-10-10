import assert from 'node:assert/strict'
import { test } from 'node:test'
import { themeOf, theme256, DEFAULT_THEME, SLOT_16, theme16 } from './theme.ts'
import { openTerm } from './term.ts'
import type { LineRole } from './frame.ts'
import { frameOf } from './frame.ts'
import { statusOf } from '../probe/status.ts'
import { setGlyphTier, widthOf } from './glyph.ts'

const rgb = (n:number):number[] => n>=232 ? Array(3).fill(8+(n-232)*10) : [Math.floor((n-16)/36),Math.floor((n-16)/6)%6,(n-16)%6].map(i=>[0,95,135,175,215,255][i]!)
const luminance = (v:readonly number[]) => v.map(x=>x/255).map(x=>x<=0.04045?x/12.92:((x+0.055)/1.055)**2.4).reduce((s,x,i)=>s+x*[0.2126,0.7152,0.0722][i]!,0)
const ratio = (a:readonly number[],b:readonly number[]) => {const [lo,hi]=[luminance(a),luminance(b)].sort((a,b)=>a-b);return (hi!+0.05)/(lo!+0.05)}
const foreground = (s:string) => rgb(Number(/(?:^|;)38;5;(\d+)(?:;|m)/.exec(s.replace('\x1b[',';'))?.[1]))
const unknown = ['','0;3','0;99','15;bogus','bogus',undefined]
const backgrounds = [['0;15',[250,250,250]],['0;7',[255,255,255]],['15;0',[18,22,29]],['15;8',[0,0,0]]] as const
const roles:LineRole[]=['waiting','system','hint','user','model','instruction','border','plan','footer','overlayBody','readHeading','ok','refuse','hit','read','body','overlay']
const render=(theme:ReturnType<typeof themeOf>,tty=true)=>{
 const writes:string[]=[];const term=openTerm({out:{isTTY:tty,columns:80,rows:40,write:s=>writes.push(s)},term:'xterm-256color',height:roles.length,theme})
 const rows=roles.map(r=>r+' · 原文');term.draw(['历史原文'],()=>({rows,roles}));term.close();return writes.join('')
}
test('背景不明时关键状态与当前提示使用宿主前景；明确深浅底保有可读层次',()=>{
 for(const colorFgBg of unknown){
  const theme=themeOf({term:'xterm-256color',colorFgBg})!
  assert.equal(theme.waiting,'\x1b[1m','未知底等待靠字重，不能猜黄色对比度')
  assert.equal(theme.system,'\x1b[39m','系统事实用宿主前景')
  assert.equal(theme.hint,'\x1b[39m','当前操作提示用宿主前景')
 }
 const readings=[]
 for(const [colorFgBg,bg] of backgrounds){
  const theme=themeOf({term:'xterm-256color',colorFgBg})!
  assert.ok(theme.waiting!.startsWith('\x1b[1;'),'等待动作必须有字重')
  const waiting=ratio(foreground(theme.waiting!),bg),system=ratio(foreground(theme.system!),bg)
  assert.ok(waiting>=5,colorFgBg+' waiting '+waiting+' >=5')
  assert.ok(system>=7,colorFgBg+' system '+system+' >=7')
  assert.notEqual(theme.system,theme.border,'事实与装饰框线各有层级')
  assert.equal(theme.model,undefined,'模型正文用原宿主前景')
  assert.ok(!theme.system!.includes('48;'),'系统事实不用提示框式背景')
  readings.push({colorFgBg,waiting,system})
 }
 console.log('theme contrast:'+JSON.stringify(readings)+'; unknown6 waiting bold/system+hint host foreground; no background probe')
})
test('颜色角色切换逐行复位，已知主题/未知主题保持文本与分段原序',()=>{
 for(const theme of [theme256(),theme256('light'),theme256('dark')]){
  const chunks:string[]=[]
  const term=openTerm({out:{isTTY:true,columns:32,rows:20,write:s=>chunks.push(s)},term:'xterm-256color',height:3,theme})
  const text=['等待确认','系统事实','模型原文'].map(s=>s+' '.repeat(32-widthOf(s)))
  const raw=()=>chunks.join('')
  term.draw([],()=>({rows:text,roles:['waiting','system','model']}))
  assert.ok(raw().includes(theme.waiting!+text[0]+'\x1b[0m'))
  assert.ok(raw().includes(theme.system!+text[1]+'\x1b[0m'))
  assert.ok(raw().includes(text[2]!))
  chunks.length=0
  term.draw([],()=>({rows:['SYSTEM MODEL'.padEnd(32,' '),'',''],roles:['body','body','body'],segments:[[{text:'SYSTEM ',role:'system'},{text:'MODEL'+' '.repeat(20),role:'model'}]]}))
  assert.ok(raw().includes(theme.system!+'SYSTEM '+'\x1b[0m'+'MODEL'+' '.repeat(20)),'分段系统色不泄漏进模型正文')
  term.close()
 }
 console.log('theme reset:3 background profiles x row/segment transitions; original text order; system/waiting reset before model')
})
test('无样式、未知能力、16色、非TTY的原地板与背景无关，逐字节保持',()=>{
 const plain=render(undefined)
 for(const colorFgBg of [...unknown,...backgrounds.map(b=>b[0])]){
  assert.equal(render(themeOf({term:'xterm-256color',colorFgBg,noStyle:true})),plain)
  assert.equal(render(themeOf({term:'xterm-256color',colorFgBg,noColor:'1'})),plain)
  assert.equal(render(themeOf({term:'unknown',colorFgBg})),render(DEFAULT_THEME))
  assert.equal(render(themeOf({term:'linux',colorFgBg,colorTerm:'truecolor'})),render(theme16()))
  assert.equal(render(themeOf({term:'xterm-16color',colorFgBg})),render(theme16()))
  assert.equal(render(themeOf({term:'xterm-256color',colorFgBg}),false),'历史原文\n')
 }
 assert.ok(!Object.values(theme16()).join('').includes('38;5'))
 for(const [role,slot] of [['waiting','waiting'],['system','dim'],['hint','dim']] as const)assert.equal(theme16()[role],SLOT_16[slot])
 console.log('theme floor:10 background declarations x no-style/NO_COLOR/attributes/linux/16color/headless exact; permanent ANSI0')
})
test('角色更新在三种字形和常见/窄矮窗口保持几何与停留零输出',()=>{
 let draws=0,idles=0
 const profiles=[theme256(),theme256('light'),theme256('dark'),theme16(),DEFAULT_THEME,undefined]
 for(const glyph of ['ascii','box','rich'] as const){
  setGlyphTier(glyph)
  for(const theme of profiles)for(const [width,height] of [[192,45],[80,19],[24,7]]){
   const chunks:string[]=[]
   const t=openTerm({out:{isTTY:true,columns:width,rows:height!+5,write:s=>chunks.push(s)},term:'xterm-256color',height:height!,theme})
   for(const role of ['waiting','system','user','model','instruction','hint'] as LineRole[]){
    const panel=frameOf({snapshot:statusOf([]),width:width!,height:height!,task:{round:'r1',goal:'核查当前内容',state:'Working',rows:[{text:role+' · 当前信息',role}]},operationArea:'input'})
    assert.equal(panel.lines.length,height);assert.ok(panel.lines.every(l=>widthOf(l)===width))
    t.draw([],()=>({rows:panel.lines,roles:panel.roles}));draws++
    chunks.length=0;t.draw([],()=>({rows:panel.lines,roles:panel.roles}));draws++;idles++
    assert.equal(chunks.join(''),'','同一幅主题/角色停留不得反复输出')
   }
   t.close()
  }
 }
 setGlyphTier('box')
 console.log('theme sequence:3 glyphs x6 profiles x3 geometries x6 roles;'+draws+' draws'+idles+' idles bytes0; geometry exact; no content mutation')
})

