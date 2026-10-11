import assert from 'node:assert/strict'
import {test} from 'node:test'
import {statusOf} from '../probe/status.ts'
import type {StatusRow} from '../probe/status.ts'
import {chatOf,frameOf,innerOf} from './frame.ts'
import {gateFaceOf,gateLayoutOf} from './gate.ts'
import {openStage} from './stage.ts'
import {openSession} from './follow.ts'
import {openTerm} from './term.ts'
import {KEYMAP,hintLineOf} from './keymap.ts'
import type {Contract} from '../contract/types.ts'
const snapshot=statusOf([]),plain=(lines:readonly string[])=>lines.map(l=>l.replace(/[│|\s]/g,'')).join('')
const face=gateFaceOf({round:'r1',fingerprint:'fixed',same:[],contracts:[{id:'r1.implement.1',agent:'agent/r1/1',kind:'implement',goal:'修复登录失败时的提示',ownedPaths:['src/login.ts','test/login.test.ts'],seed:[],deliverables:[],assertions:[{name:'登录行为',action:'test'}]}] as Contract[]},{test:'node tools/test-entry.js'})
test('first-use guidance yields to an actual card or menu and returns unchanged when those surfaces close',()=>{
 for(const width of [16,40,80]){
  const bottom=gateLayoutOf({face,view:{at:0,armed:null},columns:innerOf(width)}),height=Math.max(24,4+bottom.rows.length)
  const opening=frameOf({snapshot,width,height}),guide=plain(opening.lines)
  for(const fact of ['说说你想做什么。','先查看计划，再确认执行。','验收通过后写回工作区。'])assert.ok(guide.includes(fact))
  const shown=plain(frameOf({snapshot,width,height,bottom}).lines)
  assert.ok(!shown.includes('说说你想做什么。'));assert.ok(!shown.includes('先查看计划，再确认执行。'),'an actual plan replaces first-use guidance')
  assert.ok(shown.includes('修复登录失败时的提示'));assert.ok(shown.includes('当前1/1'))
  const menu=frameOf({snapshot,width,height,menu:{rows:['/help 查看帮助'],sel:0}})
  assert.ok(!plain(menu.lines).includes('说说你想做什么。'));assert.ok(plain(menu.lines).includes('/help'))
  assert.ok(!plain(frameOf({snapshot,width,height,menu:{rows:[],sel:0}}).lines).includes('说说你想做什么。'),'an empty search is still an active menu')
  assert.deepEqual(frameOf({snapshot,width,height,bottom:{rows:[],keep:0}}),opening,'an empty bottom does not hide guidance')
  assert.deepEqual(frameOf({snapshot,width,height}),opening,'closing restores exact opening rows and roles')
 }
})
test('the context switch suppresses only first-use guidance, never actual work or result evidence',()=>{
 const rows:StatusRow[]=[{pos:{writer:'round',seq:1},e:{t:'round/state',round:'r1',from:'Verifying',to:'Rebuilding'}} as StatusRow]
 for(const current of [snapshot,statusOf(rows),statusOf([{pos:{writer:'round',seq:1},e:{t:'round/state',round:'r1',from:'Idle',to:'Planning'}} as StatusRow]),statusOf([{pos:{writer:'round',seq:1},e:{t:'round/state',round:'r1',from:'Working',to:'Aborted'}} as StatusRow])]){
  const conversation=[{text:'实际汇报仍有自己的位置',role:'body' as const}]
  assert.deepEqual(chatOf({snapshot:current,conversation,onboarding:false}),chatOf({snapshot:current,conversation}))
  const frame=frameOf({snapshot:current,conversation,width:80,height:24,menu:{rows:['帮助'],sel:0}})
  assert.ok(frame.lines.some(l=>l.includes(current===snapshot?'实际汇报':current.rounds[0]!.state==='Rebuilding'?'结果已写回':current.rounds[0]!.state==='Aborted'?'中止':'实际汇报')))
 }
 assert.deepEqual(chatOf({snapshot,onboarding:false}),[])
 assert.deepEqual(chatOf({snapshot,onboarding:true}),chatOf({snapshot}),'absent/true switch preserves old pure chat answer')
})
test('card-only allocation uses the whole body budget and native draw is silent at rest; a hidden pending plan does not ask for new work',async()=>{
 const bottom=gateLayoutOf({face,view:{at:0,armed:null},columns:innerOf(40)})
 const tight=frameOf({snapshot,width:40,height:4+bottom.rows.length,bottom})
 assert.deepEqual(tight.lines.filter((_,i)=>['overlayBody','overlay','waiting'].includes(tight.roles[i]!)).map(l=>l.slice(1,-1).trim()),bottom.rows,'no hidden or reserved onboarding row trims the actual plan')
 const chunks:string[]=[],notes:string[]=[];let pending:typeof face|null=null,redraw=()=>{}
 const stage=openStage({rows:()=>[],columns:()=>40,termRows:()=>24,pendingFace:async()=>pending,note:s=>notes.push(s),redraw:()=>redraw(),hint:w=>hintLineOf(KEYMAP,2,w),keysOf:()=>'',run:()=>null,now:()=>0,abort:()=>{}})
 const session=openSession({view:stage.view}),term=openTerm({out:{isTTY:true,columns:40,rows:24,write:s=>chunks.push(s)},term:'xterm',full:true,heightOf:stage.heightWant})
 redraw=()=>term.draw([],size=>session.panel(size));stage.setRaw(true);redraw();const opening=session.frame({columns:40,height:stage.heightWant()})
 pending=face;await stage.refreshGate();const card=session.frame({columns:40,height:stage.heightWant()});assert.ok(!plain(card).includes('说说你想做什么。'))
 const before=chunks.join('');redraw();assert.equal(chunks.join(''),before,'idle writes zero bytes')
 stage.onAction({action:'cancel'});assert.equal(stage.view().inputIdle,false);assert.deepEqual(session.frame({columns:40,height:stage.heightWant()}),opening.map(()=>' '.repeat(40)),'hidden pending work does not restore a new-task invitation')
 stage.onAction({action:'go'});assert.ok(!plain(session.frame({columns:40,height:stage.heightWant()})).includes('说说你想做什么。'))
 assert.equal(notes.filter(s=>s.includes('这一轮打算开')).length,1,'guide visibility changes add no permanent summary')
 stage.close();term.close()
})
test('silent same-frame draw still applies caret, style, image, permanent and geometry changes',()=>{
 let columns=40,rows=24;const chunks:string[]=[],theme:{body?:string}={}
 const term=openTerm({out:{isTTY:true,get columns(){return columns},get rows(){return rows},write:s=>chunks.push(s)},term:'xterm',height:4,graphics:'kitty',theme})
 let caret=2,picture=false
 const image={image:{width:2,height:2,rgba:new Uint8Array(16).fill(255)},row:0,column:0,columns:2,rows:1}
 const render=()=>({rows:['PLAN'],roles:['body' as const],input:{rows:['> abc'],caret:{row:0,col:caret}},...(picture?{image}:{})})
 const draw=(notes:readonly string[]=[])=>{chunks.length=0;term.draw(notes,render);return chunks.join('')}
 assert.notEqual(draw(),'');assert.equal(draw(),'','exact same text/caret/image/geometry produces no movement-only write')
 caret=3;assert.notEqual(draw(),'','caret-only movement must remain visible');assert.equal(draw(),'')
 theme.body='\x1b[1m';assert.ok(draw().includes('\x1b[1m'));assert.equal(draw(),'')
 picture=true;assert.ok(draw().includes('\x1b_G'));assert.equal(draw(),'')
 assert.ok(draw(['KEEP']).includes('KEEP'),'a new permanent line cannot disappear');assert.equal(draw(),'')
 columns=50;assert.notEqual(draw(),'');assert.equal(draw(),'')
 rows=30;assert.notEqual(draw(),'','real host height changes still update the known geometry');assert.equal(draw(),'')
 picture=false;assert.ok(draw().includes('a=d'),'image-only removal cannot be skipped');assert.equal(draw(),'')
 term.close()
 const plain:string[]=[],headless=openTerm({out:{isTTY:false,write:s=>plain.push(s)},term:'xterm',graphics:'kitty'})
 headless.draw(['KEEP'],render);headless.draw([],render);headless.close();assert.equal(plain.join(''),'KEEP\n','headless old ANSI0 floor')
 const legacy:string[]=[],unknown=openTerm({out:{isTTY:true,columns:20,write:s=>legacy.push(s)},term:'xterm',height:2})
 const oldPanel=()=>({rows:['PLAN'],input:{rows:['>'],caret:{row:0,col:1}}})
 unknown.draw([],oldPanel);unknown.draw([],oldPanel)
 assert.equal(legacy[1],'\x1b[2A\r\x1b[1B\r\x1b[1B\r\x1b[1C','unknown row geometry preserves exact legacy cursor bytes')
 unknown.close()
})
