import assert from 'node:assert/strict'
import { test } from 'node:test'
import { openStage } from './stage.ts'
import { openSession } from './follow.ts'
import type { StatusRow } from '../probe/status.ts'
import { KEYMAP, hintLineOf } from './keymap.ts'
test('当前任务原文在折叠侧栏与刚完成后仍可完整阅读，开始新任务只显示新记录', () => {
  const rows: StatusRow[] = [], add = (e: object, writer = 'round') => rows.push({pos:{writer,seq:rows.length+1},e} as StatusRow)
  add({t:'round/state',round:'r1',from:'Idle',to:'Planning'})
  add({t:'round/intent',round:'r1',body:JSON.stringify({goal:'详细要求'.repeat(70)+'原文结尾'})})
  add({t:'holder/todos',agent:'round',body:JSON.stringify({todos:[{content:'核对要求',status:'in_progress'},{content:'运行验证',status:'pending'}]})})
  add({t:'agent/handoff',agent:'agent/r1/1',body:'检查结果'.repeat(80)+'交接结尾'},'agent/r1/1')
  const stage=openStage({rows:()=>rows,columns:()=>80,termRows:()=>24,pendingFace:async()=>null,note:()=>{},redraw:()=>{},run:()=>null,now:()=>0,abort:()=>{},hint:w=>hintLineOf(KEYMAP,0,w)})
  stage.setRaw(true);stage.onAdvance(rows);stage.onAction({action:'read'})
  const read=()=>stage.view().read!.rows.join('')
  assert.match(read(),/原文结尾/);assert.match(read(),/交接结尾/);assert.match(read(),/运行验证/)
  add({t:'round/state',round:'r1',from:'Committed',to:'Rebuilding'});stage.onAdvance(rows.slice(-1))
  assert.match(read(),/原文结尾/,'完成主面收起，但只读原文仍可检查')
  add({t:'round/state',round:'r2',from:'Idle',to:'Planning'});add({t:'round/intent',round:'r2',body:'下一件事'});stage.onAdvance(rows.slice(-2))
  assert.match(read(),/下一件事/);assert.doesNotMatch(read(),/交接结尾/)
  // Very short physical rows still remain bounded instead of slice(-0) expanding the whole transcript.
  const session=openSession();session.push(rows)
  for(const height of [5,6,7,8])assert.ok(session.frame({columns:80,height}).length<=height)
  stage.close();console.log('task read: long intent/handoff exact; narrow plan accessible; completed readable; next excludes old; 5–8 rows bounded')
})
