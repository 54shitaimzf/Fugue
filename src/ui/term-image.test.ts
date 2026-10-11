import assert from 'node:assert/strict'
import { test } from 'node:test'
import { openTerm, CLEAR_LINE } from './term.ts'
import type { Panel, TermOptions } from './term.ts'

const pixel = { width: 2, height: 1, rgba: new Uint8Array([22, 32, 47, 255, 234, 171, 58, 255]) }
const image = { image: pixel, row: 1, column: 2, columns: 12, rows: 3 }
const input = { rows: ['> abc'], caret: { row: 0, col: 3 } }
const panel = { rows: ['picture.png', '', '', '', 'status'], input, image }
const commands = (s: string): string[] => [...s.matchAll(/\x1b_G(.*?)\x1b\\/gs)].map(m => m[1]!)
const sent = (s: string): number => commands(s).filter(s => s.startsWith('a=T')).length
const deleted = (s: string): number => commands(s).filter(s => s.startsWith('a=d')).length

function setup(extra: Partial<TermOptions> = {}) {
  const writes: string[] = []
  let columns = 40, rows = 24, height = 5
  const term = openTerm({ term: 'xterm-kitty',
    columnsOf: () => columns, rowsOf: () => rows, heightOf: () => height, graphics: 'kitty', ...extra,
    out: { isTTY: true, ...extra.out, write: s => writes.push(s) } })
  return { term, writes, size: (c: number, r: number, h = height) => { columns = c; rows = r; height = h },
    draw: (p: Panel = panel, permanent: string[] = []) => {
      const at = writes.length; term.draw(permanent, () => p)
      assert.equal(writes.length - at, 1, 'text and picture are a single write')
      return writes.at(-1)!
    } }
}


// 独立回放实际光标与图片号。断言坐标，不拿产品发出的移动参数作期望。
function replay(raw: string, columns = 40, rows = 24) {
  let x = 0, y = 0, saved = [0, 0]
  const images = new Map<string, number[]>()
  for (const m of raw.matchAll(/\x1b_G.*?\x1b\\|\x1b[78]|\x1b\[([?\d;]*)([A-Za-z])|[\s\S]/g)) {
    const s = m[0]
    if (s.startsWith('\x1b_G')) {
      const id = /(?:^|,)i=(\d+)/.exec(s.slice(3))?.[1]
      if (id && s.includes('a=d')) images.delete(id)
      else if (id && s.includes('a=T')) images.set(id, [x, y])
    } else if (s === '\x1b7') saved = [x, y]
    else if (s === '\x1b8') [x, y] = saved as [number, number]
    else if (m[2]) {
      const n = Number(m[1]) || 1
      if (m[2] === 'A') y = Math.max(0, y - n)
      else if (m[2] === 'B') y = Math.min(rows - 1, y + n)
      else if (m[2] === 'C') x = Math.min(columns - 1, x + n)
      else if (m[2] === 'D') x = Math.max(0, x - n)
    } else if (s === '\r') x = 0
    else if (s === '\n') {
      y += 1
      if (y >= rows) { y = rows - 1; for (const p of images.values()) p[1]! -= 1 }
    } else if (s !== '\x1b') x += 1
  }
  return { caret: [x, y], images: [...images.values()] }
}

test('image placement preserves input caret; unchanged and unrelated rows never retransmit', () => {
  const s = setup()
  const first = s.draw()
  assert.equal(sent(first), 1, 'an actual transfer, not reserved blank rows')
  assert.match(first, /\x1b7\x1b\[4A\r\x1b\[2C\x1b_Ga=T/)
  assert.ok(first.endsWith('\x1b\\\x1b8'), 'restore the input caret after pixels')
  assert.deepEqual(replay(s.writes.join('')), { caret: [3, 23], images: [[2, 19]] })
  const same = s.draw({ ...panel, image: { ...image, image: { ...pixel, rgba: pixel.rgba.slice() } } })
  assert.deepEqual(replay(s.writes.join('')), { caret: [3, 23], images: [[2, 19]] })
  assert.equal(sent(same), 0)
  assert.equal(deleted(same), 0)
  assert.equal(same.split(CLEAR_LINE).length - 1, 0)
  const status = s.draw({ ...panel, rows: ['picture.png', '', '', '', 'new status'] })
  assert.deepEqual(replay(s.writes.join('')), { caret: [3, 23], images: [[2, 19]] })
  assert.equal(sent(status), 0, 'unrelated status does not flicker the image')
  assert.equal(status.split(CLEAR_LINE).length - 1, 1)
  const repaint = s.draw({ ...panel, rows: ['picture.png', 'changed', '', '', 'new status'] })
  assert.equal(deleted(repaint), 1)
  assert.equal(sent(repaint), 1, 'a cleared image row must restore pixels')
  assert.ok(repaint.indexOf('a=d') < repaint.indexOf(CLEAR_LINE))
  assert.deepEqual(replay(s.writes.join('')), { caret: [3, 23], images: [[2, 19]] })
  console.log('placement up=4 col=2; transfers 1,0,0,1; unchanged clear-lines=0; status clear-lines=1')
})

test('replace, hide, grow, resize, short screen and close clear only this client image', () => {
  const s = setup()
  const initial = s.draw()
  const id = /(?:^|,)i=(\d+)/.exec(commands(initial)[0]!)![1]!
  const changed = { ...panel, image: { ...image, image: { ...pixel, rgba: new Uint8Array(8).fill(255) } } }
  const replace = s.draw(changed)
  assert.equal(deleted(replace), 1); assert.equal(sent(replace), 1)
  assert.match(replace, new RegExp(`a=d,d=I,i=${id},q=2`))
  const { image: ignored, ...text } = panel
  const hidden = s.draw(text)
  assert.equal(deleted(hidden), 1); assert.equal(sent(hidden), 0)
  assert.deepEqual(replay(s.writes.join('')).images, [])
  s.draw()
  const appended = s.draw(panel, ['permanent'])
  assert.equal(deleted(appended), 1); assert.equal(sent(appended), 1)
  assert.deepEqual(replay(s.writes.join('')), { caret: [3, 23], images: [[2, 19]] })
  s.size(40, 24, 8)
  const grew = s.draw()
  assert.equal(deleted(grew), 1); assert.equal(sent(grew), 1)
  assert.match(grew, /\x1b7\x1b\[7A\r\x1b\[2C/)
  s.size(30, 24)
  const resize = s.draw()
  assert.equal(deleted(resize), 1); assert.equal(sent(resize), 1)
  s.size(30, 3)
  const short = s.draw()
  assert.equal(deleted(short), 1); assert.equal(sent(short), 0)
  s.size(30, 24)
  s.draw()
  s.size(20, 20)
  const at = s.writes.length
  s.term.close()
  assert.equal(s.writes.length, at + 1)
  assert.equal(deleted(s.writes.at(-1)!), 1, 'delete by ID even after resize, without knowing the old cursor')
  s.term.close(); assert.equal(s.writes.length, at + 1)
  assert.ok(s.writes.every(w => !/a=d,d=[aAcC]/.test(w)), 'never delete another client picture')
  console.log('replace/hide/grow/resize/short/close scoped deletions=1 each; double-close extra writes=0')
})

test('image defaults, unsupported protocol, headless and out-of-bounds keep the text floor byte-for-byte', () => {
  function bytes(extra: Partial<TermOptions>, p: Panel) {
    const s = setup(extra); s.term.draw(['permanent'], () => p); s.term.close(); return s.writes.join('')
  }
  const { image: ignored, ...text } = panel
  for (const extra of [{ graphics: undefined }, { graphics: 'none' }, { graphics: 'sixel' }] as const) {
    assert.equal(bytes(extra, panel), bytes(extra, text))
  }
  const headless = bytes({ out: { write: () => undefined, isTTY: false } }, panel)
  assert.equal(headless, 'permanent\n')
  assert.ok(!headless.includes('\x1b'))
  for (const change of [{ row: -1 }, { row: 4 }, { column: 35 }, { rows: 0 }, { columns: 1.5 }]) {
    assert.equal(bytes({}, { ...panel, image: { ...image, ...change } }), bytes({}, text))
  }
  assert.equal(bytes({}, { ...panel, image: { ...image, image: { ...pixel, rgba: new Uint8Array(2) } } }), bytes({}, text))
  console.log('default/off/sixel/invalid text bytes equal; headless ANSI=0')
})


test('shrinking approval/input regions restores the actual caret after clearing stale lines',()=>{
  for(const col of [0,2,9])for(const inputRows of [['> abcdefgh'],['earlier input','> abcdefgh']]){
    const s=setup({graphics:'none'})
    s.size(40,24,14);s.draw({rows:['approval'],input:{rows:inputRows,caret:{row:inputRows.length-1,col}}})
    assert.deepEqual(replay(s.writes.join('')).caret,[col,23])
    s.size(40,24,10);s.draw({rows:['hidden'],input:{rows:['> abcdefgh'],caret:{row:0,col}}})
    assert.deepEqual(replay(s.writes.join('')).caret,[col,19-(inputRows.length-1)],'clearing stale rows finishes at the declared input column')
    s.draw({rows:['hidden'],input:{rows:['> abcdefgh'],caret:{row:0,col}}})
    assert.deepEqual(replay(s.writes.join('')).caret,[col,19-(inputRows.length-1)],'an unchanged draw cannot conceal a bad previous caret')
    s.term.close()
  }
  console.log('height 14→10 / input 2→1: actual caret columns 0,2,9 preserved over shrink and unchanged draw')
})
