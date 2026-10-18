import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Download, ImagePlus, Layers, Share2, Trash2, Wand2, Loader2 } from 'lucide-react'
import { CropCard } from './CropCard'
import { Preview } from './Preview'
import { detectOverlaps } from './detect'
import { downloadBlob, exportFileName, planExport, renderMerged } from './exporter'
import type { Shot } from './types'

type Format = 'image/png' | 'image/jpeg'

export default function App() {
  const [shots, setShots] = useState<Shot[]>([])
  const [cardHeight, setCardHeight] = useState(initialCardHeight)
  // 单张卡片拖拉调整过的高度；拖动全局滑块时清空，所有卡片统一大小
  const [viewHeights, setViewHeights] = useState<Record<string, number>>({})
  const [previewWidth, setPreviewWidth] = useState(360)
  const [showSeams, setShowSeams] = useState(true)
  const [format, setFormat] = useState<Format>('image/png')
  const [busy, setBusy] = useState<string | null>(null)
  const [highlight, setHighlight] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  const segments = useMemo(() => shots.filter(s => s.committed), [shots])
  const plan = useMemo(() => planExport(segments), [segments])

  const addFiles = useCallback(async (files: FileList | File[]) => {
    const list = Array.from(files)
      .filter(f => f.type.startsWith('image/'))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
    if (list.length === 0) return
    const loaded = await Promise.all(list.map(loadShot))
    setShots(prev => [...prev, ...loaded.filter((s): s is Shot => s !== null)])
    if (loaded.some(s => s === null)) setError('有图片无法读取，已跳过')
  }, [])

  useEffect(() => {
    if (!error) return
    const t = setTimeout(() => setError(null), 4000)
    return () => clearTimeout(t)
  }, [error])

  useEffect(() => {
    try {
      localStorage.setItem(CARD_HEIGHT_KEY, String(cardHeight))
    } catch {
      // 隐私模式等情况下无法保存，忽略
    }
  }, [cardHeight])

  // 支持 Ctrl+V 粘贴截图
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const files = Array.from(e.clipboardData?.files ?? [])
      if (files.length) addFiles(files)
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [addFiles])

  // 有内容时离开页面前提醒
  useEffect(() => {
    if (shots.length === 0) return
    const onBeforeUnload = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [shots.length])

  const update = (id: string, patch: Partial<Shot>) => setShots(prev => prev.map(s => (s.id === id ? { ...s, ...patch } : s)))

  const onCrop = (id: string, top: number, bottom: number) => update(id, { top, bottom, note: undefined })

  const onResizeCard = (id: string, h: number | undefined) =>
    setViewHeights(prev => {
      const next = { ...prev }
      if (h === undefined) delete next[id]
      else next[id] = h
      return next
    })

  const onCommit = (id: string) =>
    setShots(prev => prev.map(s => (s.id === id ? { ...s, committed: { top: s.top, bottom: s.bottom } } : s)))

  const onRemoveShot = (id: string) =>
    setShots(prev => {
      const s = prev.find(x => x.id === id)
      if (s) URL.revokeObjectURL(s.url)
      return prev.filter(x => x.id !== id)
    })

  const onUncommit = (id: string) => update(id, { committed: null })

  // 原图区左右移动：在全部图片中移动
  const onMoveShot = (id: string, delta: number) =>
    setShots(prev => {
      const i = prev.findIndex(s => s.id === id)
      return swap(prev, i, i + delta)
    })

  // 预览区上下移动：与相邻的已加入片段交换位置
  const onMoveSegment = (id: string, delta: number) =>
    setShots(prev => {
      const i = prev.findIndex(s => s.id === id)
      let j = i + delta
      while (j >= 0 && j < prev.length && !prev[j].committed) j += delta
      return swap(prev, i, j)
    })

  const onReorder = (activeId: string, overId: string) =>
    setShots(prev => {
      const from = prev.findIndex(s => s.id === activeId)
      const to = prev.findIndex(s => s.id === overId)
      const next = [...prev]
      const [item] = next.splice(from, 1)
      next.splice(to, 0, item)
      return next
    })

  const onLocate = (id: string) => {
    document.getElementById(`card-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' })
    setHighlight(id)
    setTimeout(() => setHighlight(h => (h === id ? null : h)), 1500)
  }

  const onClear = () => {
    if (!confirm('清空全部图片？')) return
    shots.forEach(s => URL.revokeObjectURL(s.url))
    setShots([])
  }

  const onAuto = async () => {
    if (shots.length < 2) {
      setError('至少需要两张图片才能自动拼接')
      return
    }
    setBusy('正在检测重叠…')
    try {
      const { crops, notes } = await detectOverlaps(shots)
      setShots(prev =>
        prev.map((s, i) => ({ ...s, ...crops[i], committed: { ...crops[i] }, note: notes[i] })),
      )
    } catch (e) {
      setError(`自动检测失败：${(e as Error).message}`)
    } finally {
      setBusy(null)
    }
  }

  const makeBlob = async () => {
    setBusy('正在合并…')
    try {
      return await renderMerged(segments, format)
    } catch (e) {
      setError((e as Error).message)
      return null
    } finally {
      setBusy(null)
    }
  }

  const ext = format === 'image/png' ? 'png' : 'jpg'

  const onExport = async () => {
    const blob = await makeBlob()
    if (blob) downloadBlob(blob, exportFileName(ext))
  }

  const canShare = typeof navigator.canShare === 'function'
  const onShare = async () => {
    const blob = await makeBlob()
    if (!blob) return
    const file = new File([blob], exportFileName(ext), { type: format })
    if (!navigator.canShare({ files: [file] })) {
      downloadBlob(blob, file.name)
      return
    }
    try {
      await navigator.share({ files: [file] })
    } catch {
      // 用户取消分享
    }
  }

  return (
    <div
      className={`app${dragOver ? ' drag-over' : ''}`}
      onDragOver={e => {
        e.preventDefault()
        setDragOver(true)
      }}
      onDragLeave={e => {
        if (e.currentTarget === e.target) setDragOver(false)
      }}
      onDrop={e => {
        e.preventDefault()
        setDragOver(false)
        addFiles(e.dataTransfer.files)
      }}
    >
      <header className="topbar">
        <div className="brand">
          <Layers size={20} /> 截图拼接
        </div>
        <div className="toolbar">
          <button className="btn" onClick={() => fileInput.current?.click()}>
            <ImagePlus size={16} /> 上传图片
          </button>
          <button className="btn" onClick={onAuto} disabled={!!busy}>
            <Wand2 size={16} /> 自动拼接
          </button>
          <button className="btn" onClick={onClear} disabled={shots.length === 0}>
            <Trash2 size={16} /> 清空
          </button>
          <input
            ref={fileInput}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={e => {
              if (e.target.files) addFiles(e.target.files)
              e.target.value = ''
            }}
          />
        </div>
      </header>

      {error && (
        <div className="toast" role="alert" onClick={() => setError(null)}>
          {error}
        </div>
      )}

      <section className="section">
        <div className="section-head">
          <span className="section-title">① 原图区：拖动蓝色上下边线选取需要的部分，点“确定”加入预览</span>
          <label className="range">
            原图高度
            <input type="range" min={300} max={2000} step={20} value={cardHeight} onChange={e => {
                setCardHeight(+e.target.value)
                setViewHeights({})
              }} />
            <span className="range-value">{cardHeight}px</span>
          </label>
        </div>
        {shots.length === 0 ? (
          <button className="empty" onClick={() => fileInput.current?.click()}>
            <ImagePlus size={28} />
            <span>上传手机截图</span>
            <span className="muted">点击选择、拖入文件，或 Ctrl+V 粘贴。按文件名排序，可多选</span>
          </button>
        ) : (
          <div className="strip" style={{ ['--card-h' as string]: `${cardHeight}px` }}>
            {shots.map((s, i) => (
              <CropCard
                key={s.id}
                shot={s}
                index={i}
                total={shots.length}
                highlighted={highlight === s.id}
                viewHeight={viewHeights[s.id]}
                onResize={onResizeCard}
                onCrop={onCrop}
                onCommit={onCommit}
                onRemove={onRemoveShot}
                onMove={onMoveShot}
              />
            ))}
            <button className="add-card" onClick={() => fileInput.current?.click()} aria-label="继续添加">
              <ImagePlus size={24} />
              继续添加
            </button>
          </div>
        )}
      </section>

      <section className="section">
        <div className="section-head">
          <span className="section-title">② 预览区：按顺序无缝拼接，鼠标悬停片段可拖动排序、上下移动</span>
          <div className="section-tools">
            <label className="range">
              预览宽度
              <input type="range" min={240} max={800} step={20} value={previewWidth} onChange={e => setPreviewWidth(+e.target.value)} />
            </label>
            <label className="check">
              <input type="checkbox" checked={showSeams} onChange={e => setShowSeams(e.target.checked)} />
              显示接缝辅助线
            </label>
          </div>
        </div>

        <div className="preview-layout">
          <div className="preview-wrap" style={{ maxWidth: previewWidth }}>
            {segments.length === 0 ? (
              <div className="preview-empty muted">在上方截图下点“确定”，或点“自动拼接”</div>
            ) : (
              <Preview
                segments={segments}
                showSeams={showSeams}
                onReorder={onReorder}
                onMove={onMoveSegment}
                onRemove={onUncommit}
                onLocate={onLocate}
              />
            )}
          </div>

          <aside className="panel">
            <div className="stat">
              <span className="muted">片段</span>
              <strong className="stat-big">{segments.length}</strong>
            </div>
            <div className="stat">
              <span className="muted">导出尺寸</span>
              <strong>{segments.length ? `${plan.width} × ${plan.height} px` : '—'}</strong>
              {plan.scale < 1 && <span className="warn">超出浏览器画布上限，已缩小到 {Math.round(plan.scale * 100)}%</span>}
            </div>
            <label className="stat">
              <span className="muted">格式</span>
              <select value={format} onChange={e => setFormat(e.target.value as Format)}>
                <option value="image/png">PNG（无损）</option>
                <option value="image/jpeg">JPG（体积小）</option>
              </select>
            </label>
            <button className="btn btn-primary btn-block" onClick={onExport} disabled={segments.length === 0 || !!busy}>
              {busy ? <Loader2 size={16} className="spin" /> : <Download size={16} />} {busy ?? '合并导出'}
            </button>
            {canShare && (
              <button className="btn btn-block" onClick={onShare} disabled={segments.length === 0 || !!busy}>
                <Share2 size={16} /> 分享 / 存到相册
              </button>
            )}
            <p className="hint muted">图片仅在本地浏览器处理，不会上传</p>
          </aside>
        </div>
      </section>
    </div>
  )
}

const CARD_HEIGHT_KEY = 'image-splicing:card-height'

// 默认让原图高度接近一屏，看得清细节；用户调整过则沿用上次的值
function initialCardHeight() {
  try {
    const saved = Number(localStorage.getItem(CARD_HEIGHT_KEY))
    if (saved >= 300 && saved <= 2000) return saved
  } catch {
    // 忽略
  }
  return Math.max(480, Math.round((window.innerHeight - 230) / 20) * 20)
}

function loadShot(file: File): Promise<Shot | null> {
  return new Promise(resolve => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () =>
      resolve({
        id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        name: file.name,
        url,
        img,
        width: img.naturalWidth,
        height: img.naturalHeight,
        top: 0,
        bottom: img.naturalHeight,
        committed: null,
      })
    img.onerror = () => {
      URL.revokeObjectURL(url)
      resolve(null)
    }
    img.src = url
  })
}

function swap<T>(arr: T[], i: number, j: number): T[] {
  if (i < 0 || j < 0 || i >= arr.length || j >= arr.length) return arr
  const next = [...arr]
  ;[next[i], next[j]] = [next[j], next[i]]
  return next
}
