import type { Shot } from './types'

// 浏览器 canvas 上限：iOS Safari 约 1677 万像素，各浏览器单边安全值 32767
const MAX_AREA = 16_777_216
const MAX_SIDE = 32_767

export interface ExportPlan {
  width: number
  height: number
  /** 小于 1 表示因浏览器限制被等比缩小 */
  scale: number
}

/** 以最宽片段为基准宽度，其余片段等比缩放到同宽后纵向累加 */
export function planExport(segments: Shot[]): ExportPlan {
  if (segments.length === 0) return { width: 0, height: 0, scale: 1 }
  const baseWidth = Math.max(...segments.map(s => s.width))
  const fullHeight = segments.reduce((sum, s) => sum + segHeight(s) * (baseWidth / s.width), 0)
  const scale = Math.min(1, MAX_SIDE / fullHeight, MAX_SIDE / baseWidth, Math.sqrt(MAX_AREA / (baseWidth * fullHeight)))
  return { width: Math.round(baseWidth * scale), height: Math.round(fullHeight * scale), scale }
}

export async function renderMerged(segments: Shot[], type: 'image/png' | 'image/jpeg', quality = 0.92): Promise<Blob> {
  const plan = planExport(segments)
  const canvas = document.createElement('canvas')
  canvas.width = plan.width
  canvas.height = plan.height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('无法创建画布')
  ctx.imageSmoothingQuality = 'high'
  if (type === 'image/jpeg') {
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, plan.width, plan.height)
  }

  // 用累计的浮点位置取整，避免片段之间出现 1px 缝隙或重叠
  let acc = 0
  for (const s of segments) {
    const { top, bottom } = s.committed!
    const k = plan.width / s.width
    const y0 = Math.round(acc)
    acc += (bottom - top) * k
    const y1 = Math.round(acc)
    ctx.drawImage(s.img, 0, top, s.width, bottom - top, 0, y0, plan.width, y1 - y0)
  }

  return new Promise((resolve, reject) => {
    canvas.toBlob(b => (b ? resolve(b) : reject(new Error('导出失败，图片可能过大'))), type, quality)
  })
}

export function defaultBaseName() {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `splice-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

// 用户自填的文件名：去掉系统不允许的字符和多余的扩展名，留空则用时间戳
export function exportFileName(ext: string, baseName = '') {
  const clean = baseName
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '')
    .replace(/\.(png|jpe?g)$/i, '')
    .trim()
    .replace(/^\.+|\.+$/g, '')
  return `${clean || defaultBaseName()}.${ext}`
}

export function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

function segHeight(s: Shot) {
  return s.committed!.bottom - s.committed!.top
}
