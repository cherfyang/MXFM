import { extOf } from './format'

/** 需要走解码器的扩展名(其余格式浏览器原生可显示) */
export const DECODE_IMAGE_EXTS = new Set(['tif', 'tiff', 'heic', 'heif', 'psd'])

export function needsImageDecode(ext: string): boolean {
  return DECODE_IMAGE_EXTS.has(ext)
}

async function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('位图转换失败'))), 'image/png')
  )
}

function rgbaToCanvas(rgba: Uint8Array, w: number, h: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')!
  const data = ctx.createImageData(w, h)
  data.data.set(rgba)
  ctx.putImageData(data, 0, 0)
  return canvas
}

/** TIFF(含多页,取第一页)—— utif.js */
async function decodeTiff(f: File): Promise<Blob> {
  const mod: any = await import('utif')
  const UTIF = mod.default ?? mod
  const buf = await f.arrayBuffer()
  const ifds = UTIF.decode(buf)
  if (!ifds.length) throw new Error('TIFF 中没有图像数据')
  UTIF.decodeImage(buf, ifds[0], ifds)
  const rgba = UTIF.toRGBA8(ifds[0])
  const canvas = rgbaToCanvas(rgba, ifds[0].width, ifds[0].height)
  return canvasToBlob(canvas)
}

/** HEIC/HEIF(iPhone 照片)—— libheif (heic-to) */
async function decodeHeic(f: File): Promise<Blob> {
  const { heicTo } = await import('heic-to')
  return heicTo({ blob: f, type: 'image/jpeg', quality: 0.92 })
}

/** PSD —— ag-psd(取合成图像) */
async function decodePsd(f: File): Promise<Blob> {
  const { readPsd } = await import('ag-psd')
  const buf = await f.arrayBuffer()
  const psd = readPsd(buf, { skipLayerImageData: true, skipThumbnail: true })
  if (!psd.canvas) throw new Error('PSD 中没有合成图像')
  return canvasToBlob(psd.canvas as HTMLCanvasElement)
}

/** 统一入口:能原生显示的原样返回,特殊的解码成 PNG/JPEG */
export async function decodeImageFile(f: File): Promise<Blob> {
  const ext = extOf(f.name)
  try {
    if (ext === 'tif' || ext === 'tiff') return await decodeTiff(f)
    if (ext === 'heic' || ext === 'heif') return await decodeHeic(f)
    if (ext === 'psd') return await decodePsd(f)
  } catch (e) {
    throw new Error(`该 ${ext.toUpperCase()} 文件解码失败:${(e as Error).message}`)
  }
  return f
}
