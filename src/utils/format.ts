export function fmtBytes(n: number): string {
  if (!isFinite(n) || n < 0) return '—'
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024
  let u = 0
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024
    u++
  }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[u]}`
}

export function fmtDate(ts: number | null): string {
  if (!ts) return '—'
  const d = new Date(ts)
  const p = (x: number) => String(x).padStart(2, '0')
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export function extOf(name: string): string {
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return ''
  return name.slice(dot + 1).toLowerCase()
}

/** 常见格式的 MIME 类型(SVG 等文本型图片必须带类型,否则 <img> 拒绝解码) */
export function mimeOf(ext: string): string {
  switch (ext) {
    case 'svg': return 'image/svg+xml'
    case 'png': return 'image/png'
    case 'jpg': case 'jpeg': return 'image/jpeg'
    case 'gif': return 'image/gif'
    case 'webp': return 'image/webp'
    case 'avif': return 'image/avif'
    case 'bmp': return 'image/bmp'
    case 'ico': return 'image/x-icon'
    case 'mp4': case 'm4v': return 'video/mp4'
    case 'webm': return 'video/webm'
    case 'mkv': return 'video/x-matroska'
    case 'mov': return 'video/quicktime'
    case 'mp3': return 'audio/mpeg'
    case 'wav': return 'audio/wav'
    case 'ogg': case 'oga': case 'opus': return 'audio/ogg'
    case 'flac': return 'audio/flac'
    case 'm4a': case 'aac': return 'audio/mp4'
    case 'pdf': return 'application/pdf'
    case 'json': return 'application/json'
    default: return ''
  }
}

/** 尝试 UTF-8 严格解码,失败则退回 GBK(中文环境常见),再退回宽松 UTF-8 */
export function decodeSmart(bytes: Uint8Array): { text: string; encoding: string } {
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'UTF-8' }
  } catch {
    try {
      return { text: new TextDecoder('gbk', { fatal: true }).decode(bytes), encoding: 'GBK' }
    } catch {
      return { text: new TextDecoder('utf-8').decode(bytes), encoding: 'UTF-8' }
    }
  }
}

/** 二进制嗅探:不可打印控制字符占比超过阈值则视为二进制 */
export function looksLikeText(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 4096)
  if (n === 0) return true
  let bad = 0
  for (let i = 0; i < n; i++) {
    const b = bytes[i]
    if (b < 9 || (b > 13 && b < 32) || b === 127) bad++
  }
  return bad / n < 0.05
}
