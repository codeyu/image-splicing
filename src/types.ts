export interface Crop {
  top: number
  bottom: number
}

/** 一张上传的截图。top/bottom 为正在编辑的裁剪范围（原图像素），committed 为已加入预览的范围 */
export interface Shot {
  id: string
  name: string
  url: string
  img: HTMLImageElement
  width: number
  height: number
  top: number
  bottom: number
  committed: Crop | null
  note?: string
}

export const MIN_CROP = 8
