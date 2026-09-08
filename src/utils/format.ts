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

/** UTF-16 启发式:无 BOM 时,偶数长度 + 0x00 字节大量交替出现即判 UTF-16。
 *  命中后还要实际解码校验:PE/ELF 等二进制的 0x00 填充同样命中字节特征,
 *  但解出来全是控制字符 —— 用可打印率把这类伪命中挡掉。 */
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
  const candidate = zeroAtOdd / total > 0.7 ? 'utf-16le' : zeroAtEven / total > 0.7 ? 'utf-16be' : null
  if (!candidate) return null
  try {
    const text = new TextDecoder(candidate, { fatal: true }).decode(bytes.subarray(0, n))
    let bad = 0
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i)
      if (c < 32 && c !== 9 && c !== 10 && c !== 13) bad++
    }
    return bad / Math.max(text.length, 1) < 0.05 ? candidate : null
  } catch {
    return null
  }
}

// 常用字频表:正确解码时高频字命中率远高于乱码解码,是区分 GBK/Big5 的关键
// (GBK 与 Big5/EUC-KR 的双字节区间高度重叠,任何「首个 fatal 成功者胜出」的
// 级联都会被 Big5 整体吞掉 —— 必须把全部候选解出来按内容打分择优)
const COMMON_ZH_HANS = '的一是了我不人在他有这上们来到时大地为子中你说生国年着就那和要她出也得里后自以会家可下而过天去能对小多然于心学么之都好看起发当没成只如事把还用第样道想作种开合问经行世界民东西'
const COMMON_ZH_HANT = '的一是了我不人在他有這上們來到時大地位為子中你說生國年著就那和要她出也得裡後自以會家可下而過天去能對小多然於心學麼之都好看起發當沒成隻如事把還用第樣道想作種開合問經行世界民東西'

/** 高频简/繁字命中数占全部汉字的比例 */
function zhScore(text: string, set: string): number {
  let han = 0
  let hits = 0
  for (const ch of text) {
    const c = ch.codePointAt(0)!
    if (c >= 0x3400 && c <= 0x9fff) {
      han++
      if (set.includes(ch)) hits++
    }
  }
  return han === 0 ? 0 : hits / han
}

/** CJK 候选解码打分:谁最像「正确的文本」谁赢。
 *  日文看假名占比,韩文看谚文占比,简中/繁中看各自高频字命中率。 */
function cjkDecodeScore(enc: string, text: string): number {
  let kana = 0
  let hangul = 0
  let total = 0
  for (const ch of text) {
    const c = ch.codePointAt(0)!
    if (c >= 0x3040 && c <= 0x30ff) {
      kana++
      total++
    } else if (c >= 0xac00 && c <= 0xd7a3) {
      hangul++
      total++
    } else if (c >= 0x3400 && c <= 0x9fff) {
      total++
    } else if (c >= 0xff61 && c <= 0xff9f) {
      total++ // 半角片假名:错误解码的典型噪音,计入总量但不加分
    }
  }
  if (total === 0) return -1
  if (enc === 'shift-jis') return (kana / total) * 2 + zhScore(text, COMMON_ZH_HANS) * 0.5
  // 真韩文几乎全是谚文;GBK 简中被 EUC-KR 误解也会混出大片谚文(可达 0.7+),
  // 必须按「接近纯谚文」从严给分,其余大幅降权,否则韩文会抢走简中文件
  if (enc === 'euc-kr') return hangul / total >= 0.98 ? 1.2 : (hangul / total) * 0.3
  if (enc === 'gbk') return zhScore(text, COMMON_ZH_HANS)
  return zhScore(text, COMMON_ZH_HANT) // big5
}

const CJK_ENC_LABEL: Record<string, string> = {
  'shift-jis': 'SHIFT-JIS',
  big5: 'BIG5',
  gbk: 'GBK',
  'euc-kr': 'EUC-KR',
}
/** 并列时的用户概率排序:简中 > 繁中 > 日文 > 韩文 */
const CJK_ENC_PRIORITY: Record<string, number> = { gbk: 4, big5: 3, 'shift-jis': 2, 'euc-kr': 1 }

/** 解码顺序:BOM → UTF-16 启发式(在严格 UTF-8 之前:BOM-less UTF-16 纯 ASCII
 *  是合法 UTF-8,严格解码总会成功,启发式必须先行)→ 严格 UTF-8 →
 *  CJK 候选(shift-jis/big5/gbk/euc-kr 全部 fatal 试解,按内容打分择优)→ 宽松 UTF-8 */
export function decodeSmart(bytes: Uint8Array): { text: string; encoding: string } {
  // BOM 优先
  if (bytes.length >= 2) {
    if (bytes[0] === 0xff && bytes[1] === 0xfe)
      return { text: new TextDecoder('utf-16le').decode(bytes), encoding: 'UTF-16LE' }
    if (bytes[0] === 0xfe && bytes[1] === 0xff)
      return { text: new TextDecoder('utf-16be').decode(bytes), encoding: 'UTF-16BE' }
  }
  const u16 = looksLikeUtf16(bytes)
  if (u16) {
    try {
      return { text: new TextDecoder(u16).decode(bytes), encoding: u16 === 'utf-16le' ? 'UTF-16LE' : 'UTF-16BE' }
    } catch {
      /* fallthrough */
    }
  }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'UTF-8' }
  } catch {
    /* 非 UTF-8,进入 CJK 候选打分 */
  }
  let best: { enc: string; text: string; score: number } | null = null
  for (const enc of ['shift-jis', 'big5', 'gbk', 'euc-kr']) {
    try {
      const text = new TextDecoder(enc, { fatal: true }).decode(bytes)
      const score = cjkDecodeScore(enc, text)
      if (
        text.length &&
        (best === null ||
          score > best.score ||
          (score === best.score && CJK_ENC_PRIORITY[enc] > CJK_ENC_PRIORITY[best.enc]))
      ) {
        best = { enc, text, score }
      }
    } catch {
      /* 该编码解不动,跳过 */
    }
  }
  if (best) return { text: best.text, encoding: CJK_ENC_LABEL[best.enc] }
  return { text: new TextDecoder('utf-8').decode(bytes), encoding: 'UTF-8' }
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
