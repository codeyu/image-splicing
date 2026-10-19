import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Download, Eye, EyeOff, ImagePlus, Layers, Share2, Trash2, Wand2, Loader2 } from 'lucide-react'
import { CropCard } from './CropCard'
import { Preview } from './Preview'
import { detectOverlaps } from './detect'
import { cleanBaseName, downloadBlob, exportFileName, nextBaseName, planExport, renderMerged } from './exporter'
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
  // 默认 1，每次点下载后自动加 1；重新上传一批图片时回到 1
  const [fileName, setFileName] = useState('1')
  const [removeAfterExport, setRemoveAfterExport] = useState(initialRemoveAfterExport)
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
    setFileName('1')
    const loaded = await Promise.all(list.map(loadShot))
    setShots(prev => [...prev, ...loaded.filter((s): s is Shot => s !== null)])
    if (loaded.some(s => s === null)) setError('読み込めない画像があったため、スキップしました')
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

  useEffect(() => {
    try {
      localStorage.setItem(REMOVE_AFTER_EXPORT_KEY, removeAfterExport ? '1' : '0')
    } catch {
      // 忽略
    }
  }, [removeAfterExport])

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

  // 预览区接缝手柄：同时更新裁剪线和已加入的范围，原图区卡片保持一致
  const onAdjustSegment = (id: string, top: number, bottom: number) => update(id, { top, bottom, committed: { top, bottom } })

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
    if (!confirm('すべての画像をクリアしますか？')) return
    shots.forEach(s => URL.revokeObjectURL(s.url))
    setShots([])
  }

  // 自动拼接指定的图片；不在其中的图片撤出预览区，保证预览区只有这一组
  const autoSplice = async (targets: Shot[]) => {
    if (targets.length < 2) {
      setError('自動結合には 2 枚以上の画像が必要です')
      return
    }
    setBusy('重なりを検出中…')
    try {
      const { crops, notes } = await detectOverlaps(targets)
      const index = new Map(targets.map((s, i) => [s.id, i]))
      setShots(prev =>
        prev.map(s => {
          const i = index.get(s.id)
          if (i === undefined) return s.committed ? { ...s, committed: null } : s
          return { ...s, ...crops[i], committed: { ...crops[i] }, note: notes[i] }
        }),
      )
    } catch (e) {
      setError(`自動検出に失敗しました：${(e as Error).message}`)
    } finally {
      setBusy(null)
    }
  }

  const onAuto = () => autoSplice(shots)

  const onAutoTo = (id: string) => autoSplice(shots.slice(0, shots.findIndex(s => s.id === id) + 1))

  const makeBlob = async () => {
    setBusy('結合中…')
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
    if (!blob) return
    downloadBlob(blob, exportFileName(ext, fileName))
    const base = cleanBaseName(fileName)
    if (base) setFileName(nextBaseName(base))
    if (removeAfterExport) {
      const used = new Set(segments.map(s => s.id))
      segments.forEach(s => URL.revokeObjectURL(s.url))
      setShots(prev => prev.filter(s => !used.has(s.id)))
    }
  }

  const canShare = typeof navigator.canShare === 'function'
  const onShare = async () => {
    const blob = await makeBlob()
    if (!blob) return
    const file = new File([blob], exportFileName(ext, fileName), { type: format })
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
          <Layers size={20} /> スクショ結合
        </div>
        <div className="toolbar">
          <button className="btn" onClick={() => fileInput.current?.click()}>
            <ImagePlus size={16} /> 画像を追加
          </button>
          <button className="btn" onClick={onAuto} disabled={!!busy}>
            <Wand2 size={16} /> 自動結合
          </button>
          <button className="btn" onClick={onClear} disabled={shots.length === 0}>
            <Trash2 size={16} /> クリア
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
          <span className="section-title">① 元画像：青い上下の線をドラッグして使う範囲を選び、「確定」でプレビューに追加します</span>
          <label className="range">
            表示の高さ
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
            <span>スクリーンショットを追加</span>
            <span className="muted">クリックで選択、ドラッグ＆ドロップ、または Ctrl+V で貼り付け。複数選択でき、ファイル名順に並びます</span>
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
                onAutoTo={onAutoTo}
              />
            ))}
            <button className="add-card" onClick={() => fileInput.current?.click()} aria-label="画像を追加">
              <ImagePlus size={24} />
              追加
            </button>
          </div>
        )}
      </section>

      <section className="section">
        <div className="section-head">
          <span className="section-title">② プレビュー：順番どおりにつなげて表示します。マウスを重ねると並べ替え・上下移動ができます</span>
          <div className="section-tools">
            <label className="range">
              プレビュー幅
              <input type="range" min={240} max={800} step={20} value={previewWidth} onChange={e => setPreviewWidth(+e.target.value)} />
            </label>
            <label className="check">
              <input type="checkbox" checked={showSeams} onChange={e => setShowSeams(e.target.checked)} />
              つなぎ目を表示
            </label>
          </div>
        </div>

        <div className="preview-layout">
          {/* 左右留出接缝手柄和浮动按钮的空间，见 .preview-wrap */}
          <div className="preview-wrap" style={{ ['--preview-max' as string]: `${previewWidth}px` }}>
            {segments.length === 0 ? (
              <div className="preview-empty muted">上の画像で「確定」を押すか、「自動結合」を押してください</div>
            ) : (
              <Preview
                segments={segments}
                showSeams={showSeams}
                onReorder={onReorder}
                onMove={onMoveSegment}
                onRemove={onUncommit}
                onLocate={onLocate}
                onAdjust={onAdjustSegment}
              />
            )}
            {segments.length > 1 && (
              <div className="seam-toggle-rail">
                <button
                  className="seam-toggle"
                  onClick={() => setShowSeams(v => !v)}
                  aria-pressed={showSeams}
                  title={showSeams ? 'つなぎ目とハンドルを隠して仕上がりを確認' : 'つなぎ目とハンドルを表示'}
                >
                  {showSeams ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              </div>
            )}
          </div>

          <aside className="panel">
            <div className="stat">
              <span className="muted">結合枚数</span>
              <strong className="stat-big">{segments.length}</strong>
            </div>
            <div className="stat">
              <span className="muted">出力サイズ</span>
              <strong>{segments.length ? `${plan.width} × ${plan.height} px` : '—'}</strong>
              {plan.scale < 1 && <span className="warn">ブラウザの Canvas 上限を超えるため、{Math.round(plan.scale * 100)}% に縮小して保存します</span>}
            </div>
            <label className="stat">
              <span className="muted">ファイル形式</span>
              <select value={format} onChange={e => setFormat(e.target.value as Format)}>
                <option value="image/png">PNG（劣化なし）</option>
                <option value="image/jpeg">JPG（軽量）</option>
              </select>
            </label>
            <label className="stat">
              <span className="muted">ファイル名</span>
              <div className="filename">
                <input
                  type="text"
                  value={fileName}
                  placeholder="空欄の場合は日時で命名"
                  onChange={e => setFileName(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && segments.length > 0 && !busy && onExport()}
                />
                <span className="muted">.{ext}</span>
              </div>
            </label>
            <button className="btn btn-primary btn-block" onClick={onExport} disabled={segments.length === 0 || !!busy}>
              {busy ? <Loader2 size={16} className="spin" /> : <Download size={16} />} {busy ?? '結合して保存'}
            </button>
            <label className="check">
              <input type="checkbox" checked={removeAfterExport} onChange={e => setRemoveAfterExport(e.target.checked)} />
              保存後、使用した画像を一覧から削除
            </label>
            {canShare && (
              <button className="btn btn-block" onClick={onShare} disabled={segments.length === 0 || !!busy}>
                <Share2 size={16} /> 共有 / 写真に保存
              </button>
            )}
            <p className="hint muted">画像はブラウザ内でのみ処理され、アップロードされません</p>
          </aside>
        </div>
      </section>
    </div>
  )
}

const CARD_HEIGHT_KEY = 'image-splicing:card-height'
const REMOVE_AFTER_EXPORT_KEY = 'image-splicing:remove-after-export'

function initialRemoveAfterExport() {
  try {
    return localStorage.getItem(REMOVE_AFTER_EXPORT_KEY) === '1'
  } catch {
    return false
  }
}

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
