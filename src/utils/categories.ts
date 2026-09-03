export type Category =
  | 'folder'
  | 'image'
  | 'video'
  | 'audio'
  | 'markdown'
  | 'pdf'
  | 'csv'
  | 'excel'
  | 'word'
  | 'ppt'
  | 'zip'
  | 'ebook'
  | 'code'
  | 'text'
  | 'legacy'
  | 'executable'
  | 'installer'
  | 'binary'

const EXT_MAP: Record<Exclude<Category, 'folder' | 'binary'>, string[]> = {
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif', 'ico', 'tif', 'tiff', 'heic', 'heif', 'psd'],
  video: ['mp4', 'm4v', 'webm', 'mkv', 'mov', 'ogv', 'avi', 'wmv', 'flv', 'mpg', 'mpeg', 'mpe', 'ts', 'm2ts', 'vob', '3gp', 'asf', 'rm', 'rmvb', 'f4v'],
  audio: ['mp3', 'wav', 'ogg', 'oga', 'flac', 'm4a', 'aac', 'opus', 'weba', 'ape', 'tta', 'wv', 'amr', 'ac3', 'dts', 'mka', 'caf'],
  markdown: ['md', 'markdown'],
  pdf: ['pdf'],
  csv: ['csv', 'tsv'],
  excel: ['xlsx', 'xls', 'xlsm', 'ods', 'xlsb', 'dif', 'sylk'],
  word: ['docx'],
  ppt: ['pptx'],
  legacy: ['doc', 'dot', 'ppt', 'pot', 'pps', 'rtf'],
  zip: ['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz'],
  ebook: ['epub'],
  code: [
    'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'json', 'jsonc', 'py', 'rb', 'go', 'rs', 'java',
    'c', 'h', 'cpp', 'hpp', 'cc', 'cxx', 'cs', 'php', 'swift', 'kt', 'kts', 'dart',
    'sh', 'bash', 'bat', 'cmd', 'ps1', 'sql', 'html', 'htm', 'css', 'scss', 'less', 'vue',
    'svelte', 'xml', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'env', 'proto', 'graphql',
    'makefile', 'cmake', 'dockerfile', 'gradle', 'prisma', 'vue2',
  ],
  text: ['txt', 'log', 'nfo', 'srt', 'ass', 'ssa', 'lrc', 'properties', 'license', 'readme'],
  // 可执行程序:双击 = 运行(经分级确认),绝不进 EDITABLE_CATEGORIES
  executable: ['exe', 'com', 'scr', 'pif', 'app', 'appimage', 'run', 'bin', 'command', 'jar', 'elf', 'out'],
  // 安装包:双击 = 安装(强化确认),与可执行程序语义分开,便于确认逻辑区分
  installer: ['msi', 'msp', 'msix', 'appx', 'pkg', 'deb', 'rpm', 'apk'],
}

const LOOKUP = new Map<string, Category>()
for (const [cat, exts] of Object.entries(EXT_MAP)) {
  for (const e of exts) LOOKUP.set(e, cat as Category)
}

/** macOS bundle 形态的目录扩展名(它们是目录,但语义上是"一个可执行应用") */
const BUNDLE_EXTS = new Set(['app', 'bundle', 'framework', 'workflow', 'appex'])

export function categoryOf(entry: { kind: 'file' | 'directory'; name: string; ext: string }): Category {
  // 目录默认是文件夹;但 macOS 的 .app 等 bundle 是目录形态的"应用",必须特殊化,
  // 否则双击会钻进 Contents/ 内部(目录的 entry.ext 恒为空串,所以要从 name 取)
  if (entry.kind === 'directory') {
    const ext = entry.ext || extFromName(entry.name)
    if (ext && BUNDLE_EXTS.has(ext)) return 'executable'
    return 'folder'
  }
  const ext = entry.ext || extFromName(entry.name)
  return LOOKUP.get(ext) ?? 'binary'
}

function extFromName(name: string): string {
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return ''
  return name.slice(dot + 1).toLowerCase()
}

const LABELS: Record<Category, string> = {
  folder: '文件夹',
  image: '图片',
  video: '视频',
  audio: '音频',
  markdown: 'Markdown 文档',
  pdf: 'PDF 文档',
  csv: '表格数据',
  excel: '表格工作簿',
  word: 'Word 文档',
  ppt: 'PPT 演示文稿',
  legacy: '旧版 Office 文档',
  zip: '压缩包',
  ebook: '电子书',
  code: '源代码',
  text: '文本文档',
  executable: '应用程序',
  installer: '安装包',
  binary: '文件',
}

export function describeType(entry: { kind: 'file' | 'directory'; name: string; ext: string }): string {
  const ext = entry.ext || extFromName(entry.name)
  const label = LABELS[categoryOf(entry)]
  if (entry.kind === 'directory') {
    // bundle 目录:显示「APP 应用程序」而非「文件夹」
    return BUNDLE_EXTS.has(ext) ? `${ext.toUpperCase()} ${label}` : '文件夹'
  }
  return ext ? `${ext.toUpperCase()} ${label}` : label
}

/** 可编辑的类别(其余为只读查看) —— executable/installer/脚本类绝不加入:双击语义是运行而非编辑 */
export const EDITABLE_CATEGORIES: Set<Category> = new Set(['text', 'code', 'markdown', 'csv', 'excel'])

/** 可启动类别:双击语义是运行(经主进程分级确认) */
export const LAUNCHABLE_CATEGORIES: Set<Category> = new Set(['executable', 'installer'])

/**
 * 默认打开方式可配置的"大类":比单个扩展名粗,比全部 Category 粒度更适合用户直觉,
 * 比如「视频都用 PotPlayer 打开」「PDF 用系统默认」。按列表顺序命中 entry 的第一个分类。
 */
export const OPEN_WITH_CATEGORIES: { id: string; label: string; cats: Category[] }[] = [
  { id: 'video', label: '视频', cats: ['video'] },
  { id: 'audio', label: '音频', cats: ['audio'] },
  { id: 'image', label: '图片', cats: ['image'] },
  { id: 'ebook', label: '电子书', cats: ['ebook'] },
  { id: 'document', label: '文档 (PDF/Word/PPT/MD)', cats: ['pdf', 'word', 'ppt', 'legacy', 'markdown'] },
  { id: 'sheet', label: '表格 (Excel/CSV)', cats: ['excel', 'csv'] },
  { id: 'zip', label: '压缩包', cats: ['zip'] },
  { id: 'text', label: '文本/代码', cats: ['text', 'code'] },
]

/** entry 分类 → 大类 id;不在任何可配置大类中返回 null */
export function openWithCategoryOf(cat: Category): string | null {
  for (const g of OPEN_WITH_CATEGORIES) {
    if (g.cats.includes(cat)) return g.id
  }
  return null
}

/** 脚本扩展名:保留在 code 类(可编辑),但双击语义按设置可改为运行 */
const SCRIPT_EXTS = new Set(['bat', 'cmd', 'ps1', 'sh', 'bash'])

export function isScriptEntry(entry: { kind: 'file' | 'directory'; name: string; ext: string }): boolean {
  if (entry.kind !== 'file') return false
  const ext = entry.ext || extFromName(entry.name)
  return SCRIPT_EXTS.has(ext)
}
