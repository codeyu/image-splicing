import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core'
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { useRef } from 'react'
import { ArrowDown, ArrowUp, GripVertical, Crosshair, X } from 'lucide-react'
import { MIN_CROP, type Shot } from './types'

interface Props {
  segments: Shot[]
  showSeams: boolean
  onReorder: (activeId: string, overId: string) => void
  onMove: (id: string, delta: number) => void
  onRemove: (id: string) => void
  onLocate: (id: string) => void
  /** 在接缝处直接修改片段的显示范围 */
  onAdjust: (id: string, top: number, bottom: number) => void
}

export function Preview({ segments, showSeams, onReorder, onMove, onRemove, onLocate, onAdjust }: Props) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const onDragEnd = (e: DragEndEvent) => {
    if (e.over && e.active.id !== e.over.id) onReorder(String(e.active.id), String(e.over.id))
  }

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <SortableContext items={segments.map(s => s.id)} strategy={verticalListSortingStrategy}>
        <div className="preview-stack">
          {segments.map((s, i) => (
            <Segment
              key={s.id}
              shot={s}
              next={segments[i + 1]}
              index={i}
              total={segments.length}
              showSeam={showSeams && i < segments.length - 1}
              onMove={onMove}
              onRemove={onRemove}
              onLocate={onLocate}
              onAdjust={onAdjust}
            />
          ))}
        </div>
      </SortableContext>
    </DndContext>
  )
}

interface SegmentProps {
  shot: Shot
  /** 下一个片段，用于接缝下方的手柄 */
  next: Shot | undefined
  index: number
  total: number
  showSeam: boolean
  onMove: (id: string, delta: number) => void
  onRemove: (id: string) => void
  onLocate: (id: string) => void
  onAdjust: (id: string, top: number, bottom: number) => void
}

function Segment({ shot, next, index, total, showSeam, onMove, onRemove, onLocate, onAdjust }: SegmentProps) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: shot.id })
  const { top, bottom } = shot.committed!
  const h = bottom - top

  return (
    <div
      ref={setNodeRef}
      className={`segment${isDragging ? ' segment-dragging' : ''}`}
      style={{ aspectRatio: `${shot.width} / ${h}`, transform: CSS.Translate.toString(transform), transition }}
    >
      {/* 只显示 [top, bottom) 区间：图片按宽度铺满，再向上偏移 top 对应的比例 */}
      <div className="seg-clip">
        <img src={shot.url} alt="" draggable={false} style={{ top: `${(-top / h) * 100}%` }} />
      </div>
      {showSeam && next && !isDragging && <SeamHandles upper={shot} lower={next} index={index} onAdjust={onAdjust} />}
      <div className="seg-ops">
        <button className="icon-btn grip" aria-label="拖动排序" ref={setActivatorNodeRef} {...attributes} {...listeners}>
          <GripVertical size={14} />
        </button>
        <button className="icon-btn" aria-label="定位原图" onClick={() => onLocate(shot.id)}>
          <Crosshair size={14} />
        </button>
        <button className="icon-btn" aria-label="上移" disabled={index === 0} onClick={() => onMove(shot.id, -1)}>
          <ArrowUp size={14} />
        </button>
        <button className="icon-btn" aria-label="下移" disabled={index === total - 1} onClick={() => onMove(shot.id, 1)}>
          <ArrowDown size={14} />
        </button>
        <button className="icon-btn" aria-label="从预览移除" onClick={() => onRemove(shot.id)}>
          <X size={14} />
        </button>
      </div>
    </div>
  )
}

interface SeamHandlesProps {
  upper: Shot
  lower: Shot
  index: number
  onAdjust: (id: string, top: number, bottom: number) => void
}

/**
 * 接缝两侧的手柄：上方手柄拖动上图的下边（接缝跟着手走），下方手柄拖动下图的内容（图片跟着手走）。
 * 两张图始终紧贴，总高度随之变化；范围限制在原图之内。
 */
function SeamHandles({ upper, lower, index, onAdjust }: SeamHandlesProps) {
  const drag = useRef<{ which: 'upper' | 'lower'; startY: number; start: number; scale: number } | null>(null)

  const onPointerDown = (which: 'upper' | 'lower') => (e: React.PointerEvent) => {
    e.preventDefault()
    e.stopPropagation()
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    const shot = which === 'upper' ? upper : lower
    const width = (e.currentTarget as HTMLElement).closest('.segment')!.getBoundingClientRect().width
    const start = which === 'upper' ? upper.committed!.bottom : lower.committed!.top
    drag.current = { which, startY: e.clientY, start, scale: shot.width / width }
  }

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current
    if (!d) return
    const delta = Math.round((e.clientY - d.startY) * d.scale)
    if (d.which === 'upper') {
      const { top } = upper.committed!
      onAdjust(upper.id, top, clamp(d.start + delta, top + MIN_CROP, upper.height))
    } else {
      const { bottom } = lower.committed!
      onAdjust(lower.id, clamp(d.start - delta, 0, bottom - MIN_CROP), bottom)
    }
  }

  const onPointerUp = () => {
    drag.current = null
  }

  const handle = (which: 'upper' | 'lower', side: 'left' | 'right') => (
    <button
      className={`seam-handle seam-handle-${which} seam-handle-${side}`}
      aria-label={which === 'upper' ? `调整第 ${index + 1} 张的下边` : `调整第 ${index + 2} 张的上边`}
      title={which === 'upper' ? `拖动调整第 ${index + 1} 张的下边` : `拖动移动第 ${index + 2} 张`}
      onPointerDown={onPointerDown(which)}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      {which === 'upper' ? index + 1 : index + 2}
    </button>
  )

  return (
    <div className="seam-handles">
      {handle('upper', 'left')}
      {handle('lower', 'left')}
      {handle('upper', 'right')}
      {handle('lower', 'right')}
    </div>
  )
}

function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v))
}
