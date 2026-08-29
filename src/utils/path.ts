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

/** 合法文件名(禁止路径分隔符) */
export function isValidName(name: string): boolean {
  return name.length > 0 && !/[/\\]/.test(name) && name !== '.' && name !== '..'
}
