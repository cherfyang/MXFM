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

/** UTF-16 启发式:无 BOM 时,偶数长度 + 0x00 字节大量交替出现即判 UTF-16 */
function looksLikeUtf16(bytes: Uint8Array): 'utf-16le' | 'utf-16be' | null {
  const n = Math.min(bytes.length, 4096)
  if (n < 4 || n % 2 !== 0) return null
  let zeroAtOdd = 0 // 奇数位为 0 → LE(ASCII 字符高位在后)
  let zeroAtEven = 0 // 偶数位为 0 → BE
  for (let i = 0; i < n; i++) {
    if (bytes[i] === 0) {
      if (i % 2 === 1) zeroAtOdd++
      else zeroAtEven++
    }
  }
  const total = n / 2
  if (zeroAtOdd / total > 0.7) return 'utf-16le'
  if (zeroAtEven / total > 0.7) return 'utf-16be'
  return null
}

/** 尝试 UTF-8 严格解码 → UTF-16(BOM/启发式) → GBK → 宽松 UTF-8 */
export function decodeSmart(bytes: Uint8Array): { text: string; encoding: string } {
  // BOM 优先
  if (bytes.length >= 2) {
    if (bytes[0] === 0xff && bytes[1] === 0xfe)
      return { text: new TextDecoder('utf-16le').decode(bytes), encoding: 'UTF-16LE' }
    if (bytes[0] === 0xfe && bytes[1] === 0xff)
      return { text: new TextDecoder('utf-16be').decode(bytes), encoding: 'UTF-16BE' }
  }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'UTF-8' }
  } catch {
    const u16 = looksLikeUtf16(bytes)
    if (u16) {
      try {
        return { text: new TextDecoder(u16).decode(bytes), encoding: u16.toUpperCase().replace('-', '') }
      } catch {
        /* fallthrough */
      }
    }
    try {
      return { text: new TextDecoder('gbk', { fatal: true }).decode(bytes), encoding: 'GBK' }
    } catch {
      return { text: new TextDecoder('utf-8').decode(bytes), encoding: 'UTF-8' }
    }
  }
}

/** 编码 → 字节(保存回写用,与 decodeSmart 的 encoding 值对称) */
export function encodeSmart(text: string, encoding: string): Uint8Array {
  switch (encoding) {
    case 'UTF-16LE': {
      const out = new Uint8Array(text.length * 2 + 2)
      out[0] = 0xff
      out[1] = 0xfe
      for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i)
        out[2 + i * 2] = c & 0xff
        out[3 + i * 2] = c >> 8
      }
      return out
    }
    case 'UTF-16BE': {
      const out = new Uint8Array(text.length * 2 + 2)
      out[0] = 0xfe
      out[1] = 0xff
      for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i)
        out[2 + i * 2] = c >> 8
        out[3 + i * 2] = c & 0xff
      }
      return out
    }
    case 'GBK': {
      // TextDecoder 反向不可用;非 GBK 字符退回 UTF-8(GB2312 汉字范围可用转码表,此处从简,优先保 UTF-16 场景)
      return new TextEncoder().encode(text)
    }
    default:
      return new TextEncoder().encode(text)
  }
}

/** 二进制嗅探:不可打印控制字符占比超过阈值则视为二进制 */
export function looksLikeText(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 4096)
  if (n === 0) return true
  // UTF-16 文本(含 BOM)不算二进制
  if (
    (bytes[0] === 0xff && bytes[1] === 0xfe) ||
    (bytes[0] === 0xfe && bytes[1] === 0xff) ||
    looksLikeUtf16(bytes)
  )
    return true
  let bad = 0
  for (let i = 0; i < n; i++) {
    const b = bytes[i]
    if (b < 9 || (b > 13 && b < 32) || b === 127) bad++
  }
  return bad / n < 0.05
}
