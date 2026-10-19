/**
 * 自动检测相邻截图的重叠区域。
 *
 * 思路：把每张图横向压缩成 N 列灰度、纵向保持原始像素的“行签名”。手机滚动截图的相邻两张，
 * 内容只是上下平移了 d 像素：B 的第 r 行 ≈ A 的第 r+d 行。对每个候选 d，找出连续匹配的最长一段
 * （只统计有文字/图形的“有效行”，空白行和色块内部不算，避免误匹配）。最佳 d 的匹配段末尾就是切点：
 * A 保留到该处，B 从该处开始。这样 A 底部的浏览器工具栏、B 顶部的状态栏和地址栏都会被自然切掉。
 */

import type { Crop, Shot } from './types'

interface Sig {
  w: number
  h: number
  cols: number
  data: Uint8Array // h * cols 灰度
  info: Uint8Array // 每行是否为有效行
  acc: Int32Array // info 的前缀和，用于快速统计区间内有效行数
}

const COARSE_COLS = 48
const FINE_COLS = 256
// 粗搜宽松、精搜严格：粗搜只负责找候选，精搜区分“看起来很像”的重复行（如列表项）
const COARSE = { tol: 12, missRatio: 0.06 }
const FINE = { tol: 8, missRatio: 0.03 }
const TOP_CANDIDATES = 30
const MAX_GAP = 3 // 匹配段中允许的连续不匹配行数
// 有效行：行内有足够多的明暗跳变（文字、图标），或与上一行明显不同（色块边缘）。
// 色块内部、空白行都不算，否则不同颜色但灰度相近的色块会被误判为重叠
const EDGE_DELTA = 16
const MIN_EDGES = 4
const ROW_CHANGE = 6

export interface DetectResult {
  crops: Crop[]
  notes: (string | undefined)[]
}

export async function detectOverlaps(shots: Shot[]): Promise<DetectResult> {
  const n = shots.length
  const crops: Crop[] = shots.map(s => ({ top: 0, bottom: s.height }))
  const notes: (string | undefined)[] = new Array(n).fill(undefined)
  if (n < 2) return { crops, notes }

  const coarse = shots.map(s => signature(s.img, s.width, s.height, COARSE_COLS))
  const fine = shots.map(s => signature(s.img, s.width, s.height, FINE_COLS))

  for (let i = 0; i < n - 1; i++) {
    // 让出主线程，避免长时间卡住界面
    await new Promise(r => setTimeout(r, 0))
    const a = shots[i]
    const b = shots[i + 1]
    if (a.width !== b.width) {
      notes[i + 1] = '前の画像と幅が異なるため、自動検出をスキップしました'
      continue
    }
    const m = bestOffset(coarse[i], coarse[i + 1], fine[i], fine[i + 1])
    if (!m) {
      // 没有重叠：退而求其次，只去掉两张图相同的顶部（状态栏/地址栏）和底部（工具栏）
      const { header, footer } = commonEdges(fine[i], fine[i + 1])
      crops[i].bottom = Math.min(crops[i].bottom, a.height - footer)
      crops[i + 1].top = header
      notes[i + 1] = '前の画像との重なりを検出できませんでした。手動で確認してください'
      continue
    }
    const { run, ambiguous } = m
    crops[i].bottom = Math.min(crops[i].bottom, run.end + run.d)
    crops[i + 1].top = run.end
    if (ambiguous) notes[i + 1] = '似た内容が複数あるため、つなぎ目の位置を確認してください'
  }

  for (let i = 0; i < n; i++) {
    if (crops[i].bottom - crops[i].top < 8) {
      crops[i] = { top: 0, bottom: shots[i].height }
      notes[i] = '検出結果が不正なため（隣の画像と完全に重複している可能性があります）、画像全体に戻しました'
    }
  }
  return { crops, notes }
}

function signature(img: HTMLImageElement, w: number, h: number, cols: number): Sig {
  const canvas = document.createElement('canvas')
  canvas.width = cols
  canvas.height = h
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(img, 0, 0, w, h, 0, 0, cols, h)
  const px = ctx.getImageData(0, 0, cols, h).data
  const data = new Uint8Array(cols * h)
  const info = new Uint8Array(h)
  for (let i = 0, k = 0; i < cols * h; i++, k += 4) {
    data[i] = (px[k] * 299 + px[k + 1] * 587 + px[k + 2] * 114) / 1000
  }
  for (let r = 0; r < h; r++) {
    const o = r * cols
    let edges = 0
    let change = 0
    for (let c = 0; c < cols; c++) {
      if (c > 0 && Math.abs(data[o + c] - data[o + c - 1]) > EDGE_DELTA) edges++
      if (r > 0) change += Math.abs(data[o + c] - data[o - cols + c])
    }
    info[r] = edges >= MIN_EDGES || change / cols > ROW_CHANGE ? 1 : 0
  }
  const acc = new Int32Array(h + 1)
  for (let r = 0; r < h; r++) acc[r + 1] = acc[r] + info[r]
  return { w, h, cols, data, info, acc }
}

type Tol = typeof COARSE

/** 两行是否相同（tol: 单点灰度容差，容忍 JPEG 噪点；missRatio: 允许不同的点的比例，容忍时钟等小区域变化） */
function rowMatch(a: Sig, ra: number, b: Sig, rb: number, { tol, missRatio }: Tol): boolean {
  const cols = a.cols
  const maxMiss = Math.floor(cols * missRatio)
  let miss = 0
  const oa = ra * cols
  const ob = rb * cols
  for (let c = 0; c < cols; c++) {
    const diff = a.data[oa + c] - b.data[ob + c]
    if (diff > tol || diff < -tol) {
      if (++miss > maxMiss) return false
    }
  }
  return true
}

function rowDiff(a: Sig, ra: number, b: Sig, rb: number): number {
  const cols = a.cols
  let sum = 0
  for (let c = 0, oa = ra * cols, ob = rb * cols; c < cols; c++) sum += Math.abs(a.data[oa + c] - b.data[ob + c])
  return sum / cols
}

interface Run {
  d: number
  start: number // B 坐标，匹配段起点
  end: number // B 坐标，匹配段终点（不含）
  info: number // 段内有效行数
  diff: number // 段内有效行的平均灰度差（越小越可信）
  score: number // info 减去“本应重叠却没对上”的有效行数
}

interface Edges {
  header: number
  footer: number
}

function countInfo(s: Sig, from: number, to: number) {
  const lo = Math.max(0, Math.min(s.h, from))
  const hi = Math.max(lo, Math.min(s.h, to))
  return s.acc[hi] - s.acc[lo]
}

/**
 * 在偏移 d 下，找出 B 中与 A 连续匹配、得分最高的一段。
 * 真正的滚动重叠应当从 B 的顶部（固定头部之下）一直延续到 A 的底部（固定工具栏之上），
 * 所以 B 段前、A 段后若还有没对上的有效行，就从得分中扣除。这能排除页面里内容恰好相同的两段。
 */
function longestRun(a: Sig, b: Sig, d: number, step: number, tol: Tol, edges: Edges): Run | null {
  const n = Math.min(a.h - d, b.h)
  let best: Run | null = null
  let start = -1
  let last = -1
  let info = 0
  let gap = 0
  const close = () => {
    if (start >= 0) {
      const end = last + 1
      const missed = countInfo(b, edges.header, start) + countInfo(a, end + d, a.h - edges.footer)
      const score = info - missed / step
      if (!best || score > best.score) best = { d, start, end, info, diff: 0, score }
    }
    start = -1
    info = 0
  }
  for (let rb = 0; rb < n; rb += step) {
    if (rowMatch(a, rb + d, b, rb, tol)) {
      if (start < 0) start = rb
      last = rb
      if (b.info[rb]) info++
      gap = 0
    } else if (start >= 0 && ++gap * step > MAX_GAP) {
      close()
      gap = 0
    }
  }
  close()
  return best
}

function bestOffset(ca: Sig, cb: Sig, fa: Sig, fb: Sig): { run: Run; ambiguous: boolean } | null {
  // 粗搜：每隔一行比较，48 列，宽松容差
  const coarseEdges = commonEdges(ca, cb, COARSE)
  const candidates: Run[] = []
  for (let d = 1; d < ca.h; d++) {
    const r = longestRun(ca, cb, d, 2, COARSE, coarseEdges)
    if (r && r.info > 0) candidates.push(r)
  }
  candidates.sort((x, y) => y.score - x.score)

  // 精搜：取前几名及其相邻偏移，逐行、256 列严格比较
  const minInfo = Math.max(12, Math.round(fb.h * 0.01))
  const fineEdges = commonEdges(fa, fb, FINE)
  const tried = new Set<number>()
  const fine: Run[] = []
  for (const c of candidates.slice(0, TOP_CANDIDATES)) {
    for (let d = c.d - 2; d <= c.d + 2; d++) {
      if (d < 1 || d >= fa.h || tried.has(d)) continue
      tried.add(d)
      const r = longestRun(fa, fb, d, 1, FINE, fineEdges)
      if (!r || r.info < minInfo || r.score <= 0) continue
      let sum = 0
      for (let rb = r.start; rb < r.end; rb++) if (fb.info[rb]) sum += rowDiff(fa, rb + d, fb, rb)
      r.diff = sum / r.info
      fine.push(r)
    }
  }
  if (fine.length === 0) return null

  // 真正的重叠几乎逐像素一致：优先选平均差最小的，差不多时选得分最高的
  const minDiff = Math.min(...fine.map(r => r.diff))
  const ranked = fine.filter(r => r.diff <= minDiff + 2).sort((x, y) => y.score - x.score)
  const run = ranked[0]
  // 另有一个明显不同的偏移得分也很接近（如重复的列表项），说明结果不唯一
  const ambiguous = ranked.some(r => Math.abs(r.d - run.d) > 4 && r.score >= run.score * 0.75)
  return { run, ambiguous }
}

/** 两张图从顶部/底部开始连续相同的行数（用于无重叠时去掉固定的状态栏和工具栏） */
function commonEdges(a: Sig, b: Sig, tol: Tol = FINE): Edges {
  const limit = Math.floor(Math.min(a.h, b.h) * 0.35)
  let header = 0
  while (header < limit && rowMatch(a, header, b, header, tol)) header++
  let footer = 0
  while (footer < limit && rowMatch(a, a.h - 1 - footer, b, b.h - 1 - footer, tol)) footer++
  return { header, footer }
}
