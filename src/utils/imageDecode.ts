import { extOf } from './format'

/** 需要走解码器的扩展名(其余格式浏览器原生可显示) */
export const DECODE_IMAGE_EXTS = new Set(['tif', 'tiff', 'heic', 'heif', 'psd'])

export function needsImageDecode(ext: string): boolean {
  return DECODE_IMAGE_EXTS.has(ext)
}

/** 超过该长边的解码结果会被降采样,防止 112px 缩略图/预览缓存 12MP 位图 */
const MAX_LONG_EDGE = 4096

/** 解码超时(毫秒):超时视为解码失败,避免 UI 无限等待 */
const DECODE_TIMEOUT = 30_000

async function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('位图转换失败'))), 'image/png')
  )
}

/** RGBA → canvas,长边超过 MAX_LONG_EDGE 时 drawImage 降采样(比全尺寸 putImageData + toBlob 省数倍内存) */
function rgbaToCanvas(rgba: Uint8Array, w: number, h: number): HTMLCanvasElement {
  const scale = Math.min(1, MAX_LONG_EDGE / Math.max(w, h))
  const src = document.createElement('canvas')
  src.width = w
  src.height = h
  const sctx = src.getContext('2d')!
  const clamped = new Uint8ClampedArray(w * h * 4)
  clamped.set(rgba)
  sctx.putImageData(new ImageData(clamped, w, h), 0, 0)
  if (scale >= 1) return src
  const dst = document.createElement('canvas')
  dst.width = Math.max(1, Math.round(w * scale))
  dst.height = Math.max(1, Math.round(h * scale))
  dst.getContext('2d')!.drawImage(src, 0, 0, dst.width, dst.height)
  return dst
}

// ---------- Worker 通道(TIFF/PSD 专用,HEIC 走 wasm 异步保留在主线程) ----------

let decodeWorker: Worker | null = null

function getDecodeWorker(): Worker | null {
  if (decodeWorker) return decodeWorker
  try {
    decodeWorker = new Worker(new URL('./imageDecode.worker.ts', import.meta.url), { type: 'module' })
  } catch {
    decodeWorker = null
  }
  return decodeWorker
}

function decodeInWorker(
  kind: 'tiff' | 'psd',
  buf: ArrayBuffer
): Promise<{ rgba: Uint8Array; width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const w = getDecodeWorker()
    if (!w) return reject(new Error('__no_worker__'))
    const id = ++decodeWorkerSeq
    const onMsg = (e: MessageEvent) => {
      if (e.data?.id !== id) return
      clearTimeout(timer)
      w.removeEventListener('message', onMsg)
      if (e.data.ok) resolve({ rgba: e.data.rgba, width: e.data.width, height: e.data.height })
      else reject(new Error(e.data.error || '解码失败'))
    }
    // worker 崩溃/超时都必须置空重建:否则死 worker 会让后续所有解码各白等满 30s
    const die = (msg: string) => {
      clearTimeout(timer)
      w.removeEventListener('message', onMsg)
      try {
        w.terminate()
      } catch {
        /* ignore */
      }
      if (decodeWorker === w) decodeWorker = null
      reject(new Error(msg))
    }
    const timer = setTimeout(() => die(`解码超时(${DECODE_TIMEOUT / 1000}s),文件可能过大或已损坏`), DECODE_TIMEOUT)
    w.onerror = () => die('解码 worker 已崩溃')
    w.addEventListener('message', onMsg)
    w.postMessage({ id, kind, buf }, [buf])
  })
}

let decodeWorkerSeq = 0

// ---------- 各格式解码 ----------

/** TIFF(含多页,取第一页)—— utif.js,优先 worker */
async function decodeTiff(f: File): Promise<Blob> {
  const buf = await f.arrayBuffer()
  let rgba: Uint8Array
  let width: number
  let height: number
  try {
    ;({ rgba, width, height } = await decodeInWorker('tiff', buf))
  } catch (e) {
    if ((e as Error).message !== '__no_worker__') throw e
    // 同步回退(worker 创建失败的开发环境)
    const mod: any = await import('utif')
    const UTIF = mod.default ?? mod
    const ifds = UTIF.decode(buf)
    if (!ifds.length) throw new Error('TIFF 中没有图像数据')
    UTIF.decodeImage(buf, ifds[0], ifds)
    rgba = UTIF.toRGBA8(ifds[0])
    width = ifds[0].width
    height = ifds[0].height
  }
  return canvasToBlob(rgbaToCanvas(rgba, width, height))
}

/** HEIC/HEIF(iPhone 照片)—— libheif (heic-to) */
async function decodeHeic(f: File): Promise<Blob> {
  const { heicTo } = await import('heic-to')
  return heicTo({ blob: f, type: 'image/jpeg', quality: 0.92 })
}

/** PSD —— ag-psd(取合成图像),优先 worker(useImageData) */
async function decodePsd(f: File): Promise<Blob> {
  const buf = await f.arrayBuffer()
  try {
    const { rgba, width, height } = await decodeInWorker('psd', buf)
    return canvasToBlob(rgbaToCanvas(rgba, width, height))
  } catch (e) {
    if ((e as Error).message !== '__no_worker__') throw e
    // 同步回退
    const { readPsd } = await import('ag-psd')
    const psd = readPsd(buf, { skipLayerImageData: true, skipThumbnail: true })
    if (!psd.canvas) throw new Error('PSD 中没有合成图像')
    return canvasToBlob(psd.canvas as HTMLCanvasElement)
  }
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
