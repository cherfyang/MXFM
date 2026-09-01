export function segments(path: string): string[] {
  return path.split('/').filter(Boolean)
}

export function joinPath(dir: string, name: string): string {
  return (dir === '/' ? '' : dir) + '/' + name
}

export function parentOf(path: string): string {
  const segs = segments(path)
  if (segs.length <= 1) return '/'
  return '/' + segs.slice(0, -1).join('/')
}

export function baseName(path: string): string {
  const segs = segments(path)
  return segs[segs.length - 1] ?? ''
}

/** "name (2).ext" 风格的后备名 */
export function altName(name: string, i: number): string {
  const dot = name.lastIndexOf('.')
  if (dot > 0) return `${name.slice(0, dot)} (${i})${name.slice(dot)}`
  return `${name} (${i})`
}

/** Windows 保留设备名(CON/PRN/AUX/NUL/COM1-9/LPT1-9),不带扩展名或扩展名前命中都算保留 */
const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i

/** Windows 文件名非法字符 */
const WIN_ILLEGAL = /[<>:"|?*\u0000-\u001f]/

/**
 * 合法文件名(禁止路径分隔符 + Windows 规则)
 * - Windows 非法字符 <>:"|?* 与控制字符、保留设备名、结尾的空格/点
 * - 其它平台只拦路径分隔符与相对引用
 */
export function isValidName(name: string): boolean {
  if (!name || name === '.' || name === '..') return false
  if (/[/\\]/.test(name)) return false
  // Windows 环境或将来可能跨平台复制的名字,统一按较严格规则校验
  if (WIN_ILLEGAL.test(name)) return false
  if (WIN_RESERVED.test(name)) return false
  // Windows 不允许结尾的空格/点(开头允许,.gitignore 等隐藏文件合法)
  if (/[. ]$/.test(name)) return false
  return true
}
