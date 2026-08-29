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
  | 'code'
  | 'text'
  | 'legacy'
  | 'binary'

const EXT_MAP: Record<Exclude<Category, 'folder' | 'binary'>, string[]> = {
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif', 'ico'],
  video: ['mp4', 'm4v', 'webm', 'mkv', 'mov', 'ogv'],
  audio: ['mp3', 'wav', 'ogg', 'oga', 'flac', 'm4a', 'aac', 'opus', 'weba'],
  markdown: ['md', 'markdown'],
  pdf: ['pdf'],
  csv: ['csv', 'tsv'],
  excel: ['xlsx', 'xls', 'xlsm'],
  word: ['docx'],
  ppt: ['pptx'],
  legacy: ['doc', 'dot', 'ppt', 'pot', 'pps', 'rtf'],
  zip: ['zip'],
  code: [
    'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'json', 'jsonc', 'py', 'rb', 'go', 'rs', 'java',
    'c', 'h', 'cpp', 'hpp', 'cc', 'cxx', 'cs', 'php', 'swift', 'kt', 'kts', 'dart',
    'sh', 'bash', 'bat', 'cmd', 'ps1', 'sql', 'html', 'htm', 'css', 'scss', 'less', 'vue',
    'svelte', 'xml', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'env', 'proto', 'graphql',
    'makefile', 'cmake', 'dockerfile', 'gradle', 'prisma', 'vue2',
  ],
  text: ['txt', 'log', 'nfo', 'srt', 'ass', 'ssa', 'lrc', 'properties', 'license', 'readme'],
}

const LOOKUP = new Map<string, Category>()
for (const [cat, exts] of Object.entries(EXT_MAP)) {
  for (const e of exts) LOOKUP.set(e, cat as Category)
}

export function categoryOf(entry: { kind: 'file' | 'directory'; name: string; ext: string }): Category {
  if (entry.kind === 'directory') return 'folder'
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
  excel: 'Excel 工作簿',
  word: 'Word 文档',
  ppt: 'PPT 演示文稿',
  legacy: '旧版 Office 文档',
  zip: 'ZIP 压缩包',
  code: '源代码',
  text: '文本文档',
  binary: '文件',
}

export function describeType(entry: { kind: 'file' | 'directory'; name: string; ext: string }): string {
  if (entry.kind === 'directory') return '文件夹'
  const ext = entry.ext || extFromName(entry.name)
  const label = LABELS[categoryOf(entry)]
  return ext ? `${ext.toUpperCase()} ${label}` : label
}

/** 可编辑的类别(其余为只读查看) */
export const EDITABLE_CATEGORIES: Set<Category> = new Set(['text', 'code', 'markdown', 'csv', 'excel'])
