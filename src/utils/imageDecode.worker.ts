/// <reference lib="webworker" />
// 图片解码 Worker:TIFF/PSD 的全量解码是纯 CPU 密集操作,放在 worker 里避免主线程冻结数秒
// PSD 用 useImageData(不依赖 DOM canvas),TIFF 用 utif(纯 JS,天然 worker 兼容)

let UTIF: any = null
async function ensureUtif() {
  if (!UTIF) {
    const m: any = await import('utif')
    UTIF = m.default ?? m
  }
  return UTIF
}

async function decodeTiffInWorker(buf: ArrayBuffer) {
  const UTIF = await ensureUtif()
  const ifds = UTIF.decode(buf)
  if (!ifds.length) throw new Error('TIFF 中没有图像数据')
  UTIF.decodeImage(buf, ifds[0], ifds)
  const rgba: Uint8Array = UTIF.toRGBA8(ifds[0])
  return { rgba, width: ifds[0].width, height: ifds[0].height }
}

async function decodePsdInWorker(buf: ArrayBuffer) {
  const { readPsd } = await import('ag-psd')
  // useImageData: 返回 {width, height, data} 而非 canvas,worker 内无 DOM 也可用
  const psd: any = readPsd(buf, {
    skipLayerImageData: true,
    skipThumbnail: true,
    useImageData: true,
  })
  const img = psd.imageData
  if (!img || !img.data) throw new Error('PSD 中没有合成图像')
  return { rgba: img.data as Uint8Array, width: img.width as number, height: img.height as number }
}

self.onmessage = async (e: MessageEvent) => {
  const { id, kind, buf } = e.data as { id: number; kind: 'tiff' | 'psd'; buf: ArrayBuffer }
  try {
    const r = kind === 'psd' ? await decodePsdInWorker(buf) : await decodeTiffInWorker(buf)
    ;(self as any).postMessage({ id, ok: true, rgba: r.rgba, width: r.width, height: r.height }, [
      r.rgba.buffer,
    ])
  } catch (err) {
    ;(self as any).postMessage({ id, ok: false, error: (err as Error)?.message || '解码失败' })
  }
}
