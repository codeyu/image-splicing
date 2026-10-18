import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core'
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { ArrowDown, ArrowUp, GripVertical, Crosshair, X } from 'lucide-react'
import type { Shot } from './types'

interface Props {
  segments: Shot[]
  showSeams: boolean
  onReorder: (activeId: string, overId: string) => void
  onMove: (id: string, delta: number) => void
  onRemove: (id: string) => void
  onLocate: (id: string) => void
}

export function Preview({ segments, showSeams, onReorder, onMove, onRemove, onLocate }: Props) {
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
              index={i}
              total={segments.length}
              showSeam={showSeams && i < segments.length - 1}
              onMove={onMove}
              onRemove={onRemove}
              onLocate={onLocate}
            />
          ))}
        </div>
      </SortableContext>
    </DndContext>
  )
}

interface SegmentProps {
  shot: Shot
  index: number
  total: number
  showSeam: boolean
  onMove: (id: string, delta: number) => void
  onRemove: (id: string) => void
  onLocate: (id: string) => void
}

function Segment({ shot, index, total, showSeam, onMove, onRemove, onLocate }: SegmentProps) {
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
      <img src={shot.url} alt="" draggable={false} style={{ top: `${(-top / h) * 100}%` }} />
      {showSeam && (
        <div className="seam">
          <span>
            {index + 1} / {index + 2}
          </span>
        </div>
      )}
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
