import assert from 'node:assert/strict'
import {test} from 'node:test'
import type {Contract} from '../contract/types.ts'
import {statusOf} from '../probe/status.ts'
import {gateFaceOf,gateLayoutOf,gateQueueRowOf,gateSummaryOf,optionRowOf,previewLinesOf} from './gate.ts'
import {frameOf} from './frame.ts'
import {wrap} from './glyph.ts'
import {KEYMAP,hintLineOf,hintPicksOf,keymapOf} from './keymap.ts'
import {openStage} from './stage.ts'
import {openTerm} from './term.ts'
import {themeOf} from './theme.ts'
const face=gateFaceOf({round:'r1',fingerprint:'batch',same:[],contracts:[1,2,3].map(i=>({id:`r1.implement.${i}`,agent:`agent/r1/${i}`,kind:'implement',goal:`修复第 ${i} 项提示`,ownedPaths:[`src/file-${i}.ts`],assertions:[{name:'检查提示',action:'test'}],deliverables:[],seed:[]})) as unknown as Contract[]},{test:'node tools/test-entry.js'})
test('approval hint reveals full reading and existing item navigation and follows configured keys without losing any binding',()=>{
 assert.deepEqual(hintPicksOf(KEYMAP,'gate').slice(0,3).map(b=>b.action),['read','historyOlder','historyNewer'])
 assert.equal(hintLineOf(KEYMAP,3,'gate'),'按键 Ctrl-R 看全 · ↑ 上一项 · ↓ 下一项')
 const custom=keymapOf({historyOlder:'Ctrl-U',historyNewer:'Ctrl-J'})
 assert.equal(hintLineOf(custom,3,'gate'),'按键 Ctrl-R 看全 · Ctrl-U 上一项 · Ctrl-J 下一项')
 assert.deepEqual(hintPicksOf(KEYMAP,'gate').map(b=>b.action),['read','historyOlder','historyNewer']);assert.equal(hintPicksOf(KEYMAP,'any').length,KEYMAP.rows.length)
})
test('approval title and action retain emphasis while colorful body is regular; clipping and old attribute/text floors stay exact',()=>{
 for(const columns of [16,36,76])for(const armed of [null,'approve','reject'] as const){
  const view={at:0,armed},layout=gateLayoutOf({face,view,columns}),queue=wrap(gateQueueRowOf(face,0),columns),options=wrap(optionRowOf(view),columns)
  const body=previewLinesOf(face.cards[0]!).flatMap(s=>wrap(s.trimStart(),columns))
  const summary=gateSummaryOf(face).flatMap(s=>wrap(s.trimStart(),columns))
  assert.deepEqual(layout.rows,[...summary,...body,...queue,...options],'the style mechanism adds zero rows and changes zero content')
  const frame=frameOf({width:columns+4,height:40,snapshot:statusOf([]),bottom:layout})
  assert.equal(frame.roles.filter(r=>r==='overlay').length,queue.length,'only the entire batch heading keeps modal emphasis')
  assert.deepEqual(frame.roles.flatMap((r,i)=>r==='overlay'?[frame.lines[i]!.slice(1,-1).trim()]:[]),queue.map(s=>s.trim()),'emphasis belongs to the actual batch heading text, not another equally sized range')
  assert.equal(frame.roles.filter(r=>r==='overlayBody').length,summary.length+body.length,'all visible plan content receives the regular-body role')
  assert.equal(frame.roles.filter(r=>r==='waiting').length,options.length,'every wrapped confirmation action remains waiting')
  const legacy=frameOf({width:columns+4,height:40,snapshot:statusOf([]),bottom:{rows:layout.rows,keep:layout.keep,waitingAt:layout.waitingAt,waitingCount:layout.waitingCount}})
  for(const invalid of [{headingAt:999,headingCount:1},{headingAt:NaN,headingCount:1},{headingAt:0,headingCount:999},{headingAt:0,headingCount:0}])assert.deepEqual(frameOf({width:columns+4,height:40,snapshot:statusOf([]),bottom:{...layout,...invalid}}),legacy,'bad metadata falls back to the old complete modal style')
  const draw=(f:typeof frame,theme:ReturnType<typeof themeOf>,tty=true)=>{const chunks:string[]=[];const t=openTerm({out:{isTTY:tty,columns:columns+4,rows:50,write:s=>chunks.push(s)},term:'xterm',height:40,theme});t.draw(['KEEP'],()=>({rows:f.lines,roles:f.roles}));t.close();return chunks.join('')}
  assert.equal(draw(frame,themeOf({term:'xterm'})),draw(legacy,themeOf({term:'xterm'})),'unknown color capability preserves legacy attribute bytes')
  assert.equal(draw(frame,themeOf({noStyle:true})),draw(frame,undefined));assert.equal(draw(frame,themeOf({noColor:'1'})),draw(frame,undefined))
  assert.equal(draw(frame,undefined,false),'KEEP\n','headless ANSI0')
  assert.equal(themeOf({term:'xterm-256color'})?.overlayBody,undefined,'body uses the native foreground with no SGR')
  assert.equal(themeOf({term:'xterm-256color'})?.overlay,'\x1b[1m');assert.equal(themeOf({term:'linux'})?.overlayBody,undefined)
  const clipped=frameOf({width:columns+4,height:9,snapshot:statusOf([]),bottom:layout})
  assert.ok(clipped.roles.includes('waiting'));assert.ok(clipped.roles.filter(r=>r==='overlay').length<=queue.length,'clipping never moves heading style onto plan text')
 }
})
test('visible item navigation changes only the inspected plan; batch confirmation and its two phases retain their exact command',async()=>{
 const presses:string[]=[],notes:string[]=[],stage=openStage({rows:()=>[],columns:()=>40,termRows:()=>24,pendingFace:async()=>face,note:s=>notes.push(s),redraw:()=>{},hint:w=>hintLineOf(KEYMAP,3,w),keysOf:()=>'',run:()=>({running:false,last:[],argvOf:()=>({words:[],argv:[],why:null}),press:s=>{presses.push(s);return true},stop:()=>false}),now:()=>0,abort:()=>{}})
 stage.setRaw(true);await stage.refreshGate();assert.equal(stage.view().hint,'按键 Ctrl-R 看全 · ↑ 上一项 · ↓ 下一项')
 const shown=frameOf({width:40,height:13,snapshot:statusOf([]),...stage.view()});assert.ok(shown.roles.includes('overlayBody'),'actual Stage forwards body/heading geometry into Frame')
 assert.deepEqual(shown.roles.flatMap((r,i)=>r==='overlay'?[shown.lines[i]!.slice(1,-1).trim()]:[]),['待确认 3 项任务 · 当前 1/3'])
 for(const n of [2,3,3]){stage.onAction({action:'historyNewer'});assert.ok(stage.view().bottom!.rows.join(' ').includes(`当前 ${n}/3`));assert.equal(presses.length,0)}
 stage.onAction({action:'approve',key:'y'});assert.equal(presses.length,0);stage.onAction({action:'historyOlder'});assert.ok(stage.view().bottom!.rows.join(' ').includes('当前 2/3'))
 stage.onAction({action:'submit'});assert.deepEqual(presses,['round go'],'inspection keeps the already armed whole-batch command')
 assert.equal(notes.filter(s=>s.includes('这一轮打算开')).length,1,'navigation adds no history repetition');stage.close()
})
