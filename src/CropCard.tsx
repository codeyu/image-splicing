import { useRef } from 'react'
import { ArrowLeft, ArrowRight, Check, RefreshCw, RotateCcw, Wand2, X, AlertTriangle } from 'lucide-react'
import { MIN_CROP, type Shot } from './types'

type DragMode = 'top' | 'bottom' | 'move'
type ResizeMode = 'e' | 's' | 'se'

export const MIN_VIEW_HEIGHT = 200
export const MAX_VIEW_HEIGHT = 3000

interface Props {
  shot: Shot
  index: number
  total: number
  highlighted: boolean
  /** 单独拖拉调整过的显示高度，未设置则使用全局“原图高度” */
  viewHeight: number | undefined
  onResize: (id: string, height: number | undefined) => void
  onCrop: (id: string, top: number, bottom: number) => void
  onCommit: (id: string) => void
  onRemove: (id: string) => void
  onMove: (id: string, delta: number) => void
  /** 自动拼接第一张到这张 */
  onAutoTo: (id: string) => void
}

export function CropCard({ shot, index, total, highlighted, viewHeight, onResize, onCrop, onCommit, onRemove, onMove, onAutoTo }: Props) {
  const boxRef = useRef<HTMLDivElement>(null)
  const drag = useRef<{ mode: DragMode; startY: number; top: number; bottom: number } | null>(null)
  const resize = useRef<{ mode: ResizeMode; startX: number; startY: number; startH: number } | null>(null)

  const { width, height, top, bottom, committed } = shot
  const dirty = committed !== null && (committed.top !== top || committed.bottom !== bottom)

  // 把屏幕上的 y 位移换算成原图像素
  const toNatural = (dy: number) => {
    const rect = boxRef.current!.getBoundingClientRect()
    return (dy / rect.height) * height
  }

  const onPointerDown = (mode: DragMode) => (e: React.PointerEvent) => {
    e.preventDefault()
    e.stopPropagation()
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    drag.current = { mode, startY: e.clientY, top, bottom }
  }

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current
    if (!d) return
    const delta = Math.round(toNatural(e.clientY - d.startY))
    if (d.mode === 'top') {
      onCrop(shot.id, clamp(d.top + delta, 0, d.bottom - MIN_CROP), d.bottom)
    } else if (d.mode === 'bottom') {
      onCrop(shot.id, d.top, clamp(d.bottom + delta, d.top + MIN_CROP, height))
    } else {
      const h = d.bottom - d.top
      const t = clamp(d.top + delta, 0, height - h)
      onCrop(shot.id, t, t + h)
    }
  }

  const onPointerUp = () => {
    drag.current = null
  }

  // 拖拉卡片右边、下边或右下角缩放图片；宽高保持原图比例，所以都换算成显示高度
  const onResizeDown = (mode: ResizeMode) => (e: React.PointerEvent) => {
    e.preventDefault()
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    const startH = boxRef.current!.getBoundingClientRect().height
    resize.current = { mode, startX: e.clientX, startY: e.clientY, startH }
  }

  const onResizeMove = (e: React.PointerEvent) => {
    const r = resize.current
    if (!r) return
    const byX = (e.clientX - r.startX) * (height / width)
    const byY = e.clientY - r.startY
    const delta = r.mode === 'e' ? byX : r.mode === 's' ? byY : Math.abs(byX) > Math.abs(byY) ? byX : byY
    onResize(shot.id, Math.round(clamp(r.startH + delta, MIN_VIEW_HEIGHT, MAX_VIEW_HEIGHT)))
  }

  const onResizeUp = () => {
    resize.current = null
  }

  const resizeProps = (mode: ResizeMode) => ({
    onPointerDown: onResizeDown(mode),
    onPointerMove: onResizeMove,
    onPointerUp: onResizeUp,
    onPointerCancel: onResizeUp,
    onDoubleClick: () => onResize(shot.id, undefined),
    title: '拖动调整大小，双击恢复默认',
  })

  const setTop = (v: number) => onCrop(shot.id, clamp(v, 0, bottom - MIN_CROP), bottom)
  const setBottom = (v: number) => onCrop(shot.id, top, clamp(v, top + MIN_CROP, height))

  const pct = (v: number) => `${(v / height) * 100}%`
  const handlers = { onPointerMove, onPointerUp, onPointerCancel: onPointerUp }

  return (
    <div
      id={`card-${shot.id}`}
      className={`card${highlighted ? ' card-hl' : ''}`}
      style={{
        ['--ratio' as string]: width / height,
        ...(viewHeight ? { ['--card-h' as string]: `${viewHeight}px` } : {}),
      }}
    >
      <div className="card-head">
        <span className="card-index">{index + 1}</span>
        <span className="card-name" title={shot.name}>{shot.name}</span>
        <button className="icon-btn" aria-label="左移" disabled={index === 0} onClick={() => onMove(shot.id, -1)}>
          <ArrowLeft size={14} />
        </button>
        <button className="icon-btn" aria-label="右移" disabled={index === total - 1} onClick={() => onMove(shot.id, 1)}>
          <ArrowRight size={14} />
        </button>
        <button className="icon-btn" aria-label="删除" onClick={() => onRemove(shot.id)}>
          <X size={14} />
        </button>
      </div>

      <div className="crop-box" ref={boxRef}>
        <img src={shot.url} alt={shot.name} draggable={false} />
        <div className="dim" style={{ top: 0, height: pct(top) }} />
        <div className="dim" style={{ top: pct(bottom), bottom: 0 }} />
        <div
          className="crop-frame"
          style={{ top: pct(top), height: pct(bottom - top) }}
          onPointerDown={onPointerDown('move')}
          {...handlers}
        >
          <div className="handle handle-top" onPointerDown={onPointerDown('top')} {...handlers}>
            <span />
          </div>
          <div className="handle handle-bottom" onPointerDown={onPointerDown('bottom')} {...handlers}>
            <span />
          </div>
        </div>
      </div>

      <div className="crop-inputs">
        <label>
          上
          <input type="number" min={0} max={bottom - MIN_CROP} value={top} onChange={e => setTop(+e.target.value)} />
        </label>
        <label>
          下
          <input type="number" min={top + MIN_CROP} max={height} value={bottom} onChange={e => setBottom(+e.target.value)} />
        </label>
        <button className="icon-btn" aria-label="重置裁剪" title="重置为整张" onClick={() => onCrop(shot.id, 0, height)}>
          <RotateCcw size={14} />
        </button>
      </div>

      {shot.note && (
        <div className="card-note">
          <AlertTriangle size={12} /> {shot.note}
        </div>
      )}

      <div className="card-foot">
        <span className="muted">
          {width}×{bottom - top}
          {committed && !dirty && ' · 已加入'}
          {dirty && ' · 有修改'}
        </span>
        <span className="card-foot-actions">
          {index > 0 && (
            <button className="btn btn-sm" title="自动拼接第 1 张到这张" onClick={() => onAutoTo(shot.id)}>
              <Wand2 size={14} /> 拼接到此
            </button>
          )}
          {committed === null && (
            <button className="btn btn-primary btn-sm" onClick={() => onCommit(shot.id)}>
              <Check size={14} /> 确定
            </button>
          )}
          {dirty && (
            <button className="btn btn-primary btn-sm" onClick={() => onCommit(shot.id)}>
              <RefreshCw size={14} /> 更新
            </button>
          )}
        </span>
      </div>

      <div className="resize resize-e" {...resizeProps('e')} />
      <div className="resize resize-s" {...resizeProps('s')} />
      <div className="resize resize-se" {...resizeProps('se')} />
    </div>
  )
}

function clamp(v: number, lo: number, hi: number) {
  if (Number.isNaN(v)) return lo
  return Math.min(hi, Math.max(lo, v))
}
