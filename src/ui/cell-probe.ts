// Terminal reports arrive through the same raw decoder as keys, outside paste.
// Protocol: https://invisible-island.net/xterm/ctlseqs/ctlseqs.html
// DA advertises Sixel (attribute 4); CSI 16t reports actual character-cell pixels.
// DECSDM must already anchor at the cursor, and palettes must be private.
// We only query these modes; missing/invalid reports keep text. Expired requests stay in FIFO until consumed:
// an unidentified late reply can never be promoted to a newer request's result.
import type { WaitFn } from './keymap.ts'

export interface CellPixels { readonly width: number; readonly height: number }
export const CELL_WAIT_MS = 200
export const MAX_CELL_PIXELS = 512
export const MAX_CELL_REQUESTS = 16

interface Request {
  done: boolean
  attributes?: boolean
  pixels?: CellPixels | null
  anchored?: boolean
  privatePalette?: boolean
}

export function openCellProbe(o: {
  readonly write: (bytes: string) => void
  readonly changed: () => void
  readonly wait?: WaitFn
}) {
  const wait: WaitFn = o.wait ?? ((ms, fn) => { const t=setTimeout(fn,ms); return ()=>clearTimeout(t) })
  const attributes: Request[] = [],pixels: Request[] = [],anchors: Request[] = [],palettes: Request[] = []
  let current: Request | undefined,cell: CellPixels | null = null,closed=false,stop:(()=>void)|undefined
  const set=(next:CellPixels|null):void=>{
    if(cell?.width===next?.width && cell?.height===next?.height)return
    cell=next;o.changed()
  }
  const finish=(r:Request):void=>{
    if(r.done || r!==current || r.attributes===undefined || r.pixels===undefined || r.anchored===undefined || r.privatePalette===undefined)return
    r.done=true;stop?.();stop=undefined
    set(r.attributes && r.anchored && r.privatePalette ? r.pixels : null)
  }
  return {
    get cell():CellPixels|null{return cell},
    start():void {
      if(closed)return
      stop?.();stop=undefined
      if(current)current.done=true
      set(null)
      if(Math.max(attributes.length,pixels.length,anchors.length,palettes.length)>=MAX_CELL_REQUESTS)return
      const r:Request={done:false};current=r;attributes.push(r);pixels.push(r);anchors.push(r);palettes.push(r)
      stop=wait(CELL_WAIT_MS,()=>{if(r!==current||r.done)return;stop=undefined;r.done=true;set(null)})
      o.write('\x1b[c\x1b[16t\x1b[?80$p\x1b[?1070$p')
    },
    receive(bytes:string):void {
      if(closed)return
      const da=/^\x1b\[\?([0-9;]{1,64})c$/.exec(bytes)
      if(da){
        const r=attributes.shift();if(!r||r.done)return
        const values=da[1]!.split(';').map(Number)
        r.attributes=values.length>1&&[62,63,64,65].includes(values[0]!)&&values.slice(1).includes(4);finish(r);return
      }
      const mode=/^\x1b\[\?(80|1070);([0-4])\$y$/.exec(bytes)
      if(mode){
        const r=(mode[1]==='80'?anchors:palettes).shift();if(!r||r.done)return
        const value=Number(mode[2])
        if(mode[1]==='80')r.anchored=value===2||value===4
        else r.privatePalette=value===1||value===3
        finish(r);return
      }
      const size=/^\x1b\[6;([0-9]{1,6});([0-9]{1,6})t$/.exec(bytes)
      if(size){
        const r=pixels.shift();if(!r||r.done)return
        const height=Number(size[1]),width=Number(size[2])
        r.pixels=height>0&&width>0&&height<=MAX_CELL_PIXELS&&width<=MAX_CELL_PIXELS?{width,height}:null
        finish(r)
      }
    },
    close():void {
      if(closed)return
      closed=true;stop?.();stop=undefined
      if(current)current.done=true
      attributes.length=0;pixels.length=0;anchors.length=0;palettes.length=0;cell=null
    },
  }
}
