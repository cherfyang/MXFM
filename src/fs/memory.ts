import type { FSProvider, FileEntry } from './types'
import { joinPath, parentOf, baseName, segments, altName } from '../utils/path'
import { extOf, mimeOf } from '../utils/format'
import { moveEntry } from './ops'
import * as XLSX from 'xlsx'
import { zipSync, strToU8 } from 'fflate'

interface MemNode {
  kind: 'file' | 'directory'
  name: string
  content?: Uint8Array
  children?: Map<string, MemNode>
  modified: number
}

function now() {
  return Date.now()
}

function newDir(name: string): MemNode {
  return { kind: 'directory', name, children: new Map(), modified: now() }
}

function newFile(name: string, content: Uint8Array | string): MemNode {
  const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content
  return { kind: 'file', name, content: bytes, modified: now() }
}

/** 演示模式的内存 Provider —— 无需任何授权即可体验全部功能 */
export class MemoryProvider implements FSProvider {
  kind = 'memory' as const
  private roots = new Map<string, MemNode>()

  addRoot(handle: unknown): void {
    const node = handle as MemNode
    this.roots.set(node.name, node)
  }

  removeRoot(name: string): void {
    this.roots.delete(name)
  }

  hasRoot(name: string): boolean {
    return this.roots.has(name)
  }

  listRootNames(): string[] {
    return [...this.roots.keys()]
  }

  private node(path: string): MemNode {
    const segs = segments(path)
    const root = this.roots.get(segs[0])
    if (!root) throw new Error(`未找到根目录「${segs[0]}」`)
    let n: MemNode = root
    for (let i = 1; i < segs.length; i++) {
      const child = n.children?.get(segs[i])
      if (!child) throw new Error(`路径不存在:${path}`)
      n = child
    }
    return n
  }

  private dir(path: string): MemNode {
    const n = this.node(path)
    if (n.kind !== 'directory') throw new Error(`不是文件夹:${path}`)
    return n
  }

  async list(path: string): Promise<FileEntry[]> {
    const d = this.dir(path)
    const out: FileEntry[] = []
    for (const [name, child] of d.children!) {
      out.push({
        name,
        path: joinPath(path, name),
        kind: child.kind,
        size: child.kind === 'file' ? child.content!.length : 0,
        modified: child.modified,
        ext: child.kind === 'file' ? extOf(name) : '',
      })
    }
    return out
  }

  async getFile(path: string): Promise<File> {
    const n = this.node(path)
    if (n.kind !== 'file') throw new Error(`不是文件:${path}`)
    // 拷贝为精确大小的 buffer,避免 File 持有底层大 buffer 的引用
    const exact = new Uint8Array(n.content!)
    const name = n.name
    return new File([exact.buffer as ArrayBuffer], name, { lastModified: n.modified, type: mimeOf(extOf(name)) })
  }

  async readBytes(path: string, start = 0, length?: number): Promise<Uint8Array> {
    const n = this.node(path)
    if (n.kind !== 'file') throw new Error(`不是文件:${path}`)
    const end = length != null ? start + length : undefined
    return n.content!.slice(start, end)
  }

  async writeText(path: string, content: string): Promise<void> {
    await this.writeBytes(path, new TextEncoder().encode(content))
  }

  async writeBytes(path: string, data: Uint8Array): Promise<void> {
    const d = this.dir(parentOf(path))
    const name = baseName(path)
    const existing = d.children!.get(name)
    if (existing && existing.kind === 'directory') throw new Error('同名文件夹已存在')
    d.children!.set(name, newFile(name, data))
  }

  async writeBlob(path: string, blob: Blob): Promise<void> {
    await this.writeBytes(path, new Uint8Array(await blob.arrayBuffer()))
  }

  async mkdir(path: string): Promise<void> {
    const d = this.dir(parentOf(path))
    const name = baseName(path)
    const existing = d.children!.get(name)
    if (existing) {
      if (existing.kind === 'directory') return
      throw new Error('同名文件已存在')
    }
    d.children!.set(name, newDir(name))
  }

  async createFile(path: string): Promise<void> {
    await this.writeBytes(path, new Uint8Array(0))
  }

  async remove(path: string, kind: 'file' | 'directory'): Promise<void> {
    const d = this.dir(parentOf(path))
    d.children!.delete(baseName(path))
  }

  async rename(path: string, kind: 'file' | 'directory', newName: string): Promise<string> {
    const parent = parentOf(path)
    const target = joinPath(parent, newName)
    if (await this.exists(target)) throw new Error('目标位置已存在同名项目')
    const entry: FileEntry = { name: baseName(path), path, kind, size: 0, modified: null, ext: extOf(baseName(path)) }
    await moveEntry(this, entry, target)
    return target
  }

  async exists(path: string): Promise<boolean> {
    try {
      this.node(path)
      return true
    } catch {
      return false
    }
  }

  async uniqueName(dir: string, name: string): Promise<string> {
    const d = this.dir(dir)
    for (let i = 2; ; i++) {
      const cand = altName(name, i)
      if (!d.children!.has(cand)) return cand
    }
  }
}

// ---------- 演示数据 ----------

function canvasPng(width: number, height: number, draw: (ctx: CanvasRenderingContext2D) => void): Promise<Uint8Array> {
  return new Promise((resolve) => {
    const c = document.createElement('canvas')
    c.width = width
    c.height = height
    const ctx = c.getContext('2d')!
    draw(ctx)
    c.toBlob(async (b) => resolve(new Uint8Array(await b!.arrayBuffer())), 'image/png')
  })
}

function makeWav(): Uint8Array {
  const rate = 22050
  const notes = [523.25, 659.25, 783.99, 659.25] // C5 E5 G5 E5
  const noteDur = 0.35
  const total = Math.floor(rate * noteDur * notes.length)
  const buf = new ArrayBuffer(44 + total * 2)
  const v = new DataView(buf)
  const wstr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i))
  }
  wstr(0, 'RIFF')
  v.setUint32(4, 36 + total * 2, true)
  wstr(8, 'WAVE')
  wstr(12, 'fmt ')
  v.setUint32(16, 16, true)
  v.setUint16(20, 1, true)
  v.setUint16(22, 1, true)
  v.setUint32(24, rate, true)
  v.setUint32(28, rate * 2, true)
  v.setUint16(32, 2, true)
  v.setUint16(34, 16, true)
  wstr(36, 'data')
  v.setUint32(40, total * 2, true)
  for (let i = 0; i < total; i++) {
    const note = Math.floor(i / (rate * noteDur))
    const t = (i % Math.floor(rate * noteDur)) / rate
    const fade = Math.min(1, t * 20, (noteDur - t) * 12)
    v.setInt16(44 + i * 2, Math.sin(2 * Math.PI * notes[note] * t) * 12000 * fade, true)
  }
  return new Uint8Array(buf)
}

function makeXlsx(): Uint8Array {
  const wb = XLSX.utils.book_new()
  const sales = [
    ['月份', '产品', '数量', '单价', '金额'],
    ['1月', '键盘', 120, 299, 35880],
    ['1月', '鼠标', 200, 129, 25800],
    ['1月', '显示器', 45, 1299, 58455],
    ['2月', '键盘', 135, 299, 40365],
    ['2月', '鼠标', 180, 129, 23220],
    ['2月', '显示器', 52, 1299, 67548],
    ['3月', '键盘', 150, 299, 44850],
    ['3月', '鼠标', 220, 129, 28380],
    ['3月', '显示器', 60, 1299, 77940],
  ]
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sales), '销售数据')
  const budget = [
    ['部门', '预算', '实际', '差额'],
    ['研发', 500000, 462000, 38000],
    ['市场', 300000, 318000, -18000],
    ['运营', 200000, 189000, 11000],
  ]
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(budget), '部门预算')
  const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' })
  return new Uint8Array(out)
}

function makeDocx(): Uint8Array {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const p = (text: string, bold = false) =>
    `<w:p><w:r>${bold ? '<w:rPr><w:b/></w:rPr>' : ''}<w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
${p('MX 文件管理器', true)}
${p('这是一份用于演示 Word 预览能力的文档。它由演示模式在本地动态生成,不依赖任何网络服务。')}
${p('功能要点:', true)}
${p('1. 点击文件即可直接预览')}
${p('2. 文本、Markdown、CSV、Excel 支持编辑并保存')}
${p('3. 视频、音频点击后直接进入内置播放器')}
</w:body></w:document>`
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`
  return zipSync({
    '[Content_Types].xml': strToU8(contentTypes),
    '_rels/.rels': strToU8(rels),
    'word/document.xml': strToU8(documentXml),
  })
}

const README_MD = `# MX 文件管理器 · 演示项目

欢迎!这个文件夹是**演示模式**在内存中生成的,你可以随意增删改,刷新后即恢复。

## 它能做什么

- 点击任意文件,主区域直接切换成对应的查看器/编辑器
- 文本、代码、Markdown、CSV、Excel 支持**编辑并保存**(Ctrl+S)
- 图片可缩放旋转,视频/音频直接进入内置播放器
- ZIP 可以浏览包内文件、直接预览甚至解压
- 支持新建、重命名、删除、复制、剪切、粘贴、拖拽移动和撤销

## 支持的格式

| 类别 | 格式 | 能力 |
| --- | --- | --- |
| 图片 | PNG / JPG / GIF / SVG / WebP | 查看、缩放、旋转 |
| 视频 | MP4 / WebM / MKV | 内置播放器 |
| 音频 | MP3 / WAV / FLAC | 内置播放器 |
| 文本 | 50+ 种扩展名 | 编辑 + 语法高亮 |
| 表格 | CSV / XLSX | 编辑 + 保存 |
| 文档 | DOCX / PDF | 预览 |

> 试着双击进入「图片」文件夹看看,或者打开「文档/数据.csv」直接编辑。
`

const APP_TS = `interface Task {
  id: number
  title: string
  done: boolean
}

const tasks: Task[] = []

export function addTask(title: string): Task {
  const task: Task = { id: tasks.length + 1, title, done: false }
  tasks.push(task)
  return task
}

export function toggle(id: number): void {
  const t = tasks.find((t) => t.id === id)
  if (t) t.done = !t.done
}

export function pending(): Task[] {
  return tasks.filter((t) => !t.done)
}
`

const APP_PY = `"""演示用 Python 文件 —— 支持语法高亮"""
from dataclasses import dataclass


@dataclass
class Point:
    x: float
    y: float

    def dist(self, other: "Point") -> float:
        return ((self.x - other.x) ** 2 + (self.y - other.y) ** 2) ** 0.5


def main():
    a, b = Point(0, 0), Point(3, 4)
    print(f"A 到 B 的距离: {a.dist(b)}")


if __name__ == "__main__":
    main()
`

const CONFIG_JSON = `{
  "name": "mx-file-manager",
  "version": "0.1.0",
  "features": {
    "viewer": ["image", "video", "audio", "pdf", "office"],
    "editor": ["text", "markdown", "csv", "xlsx"]
  },
  "shortcuts": {
    "open": "单击",
    "preview": "空格",
    "save": "Ctrl+S",
    "rename": "F2",
    "undo": "Ctrl+Z"
  }
}
`

function makeCsv(rows: number): string {
  const lines = ['订单号,产品,客户,数量,单价,金额,下单日期']
  const products = ['机械键盘', '无线鼠标', '显示器', 'USB-C 扩展坞', '降噪耳机', '摄像头']
  const customers = ['华信科技', '蓝海贸易', '星河传媒', '远航物流', '极光软件']
  for (let i = 1; i <= rows; i++) {
    const p = products[i % products.length]
    const c = customers[i % customers.length]
    const qty = ((i * 7) % 19) + 1
    const price = [299, 129, 1299, 399, 899, 259][i % 6]
    const amount = qty * price
    const day = String((i % 28) + 1).padStart(2, '0')
    lines.push(`SO-2026${String(i).padStart(4, '0')},${p},${c},${qty},${price},${amount},2026-08-${day}`)
  }
  return lines.join('\n')
}

function makeLog(lines: number): string {
  const levels = ['INFO', 'WARN', 'INFO', 'INFO', 'ERROR', 'DEBUG']
  const msgs = [
    'request completed in {n}ms',
    'cache hit ratio 0.{n}',
    'user session refreshed',
    'background job "sync" finished',
    'failed to reach upstream, retrying',
    'gc pause {n}ms',
  ]
  const out: string[] = []
  for (let i = 0; i < lines; i++) {
    out.push(
      `2026-08-29 ${String(i % 24).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:${String(i % 60).padStart(2, '0')} [${levels[i % levels.length]}] ${msgs[i % msgs.length].replace('{n}', String((i * 13) % 997))}`
    )
  }
  return out.join('\n')
}

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 200 200">
  <rect width="200" height="200" rx="24" fill="#1f2937"/>
  <path d="M40 60h40l12 12h68a10 10 0 0 1 10 10v58a10 10 0 0 1-10 10H40a10 10 0 0 1-10-10V70a10 10 0 0 1 10-10z" fill="#3574f0"/>
  <text x="100" y="150" text-anchor="middle" fill="#e5e7eb" font-size="16" font-family="sans-serif">MX FM</text>
</svg>
`

export async function buildDemoRoot(): Promise<MemNode> {
  const root = newDir('演示项目')

  const docs = newDir('文档')
  docs.children!.set('README.md', newFile('README.md', README_MD))
  docs.children!.set('会议纪要.txt', newFile('会议纪要.txt', '项目周会纪要\n\n时间:2026-08-28 10:00\n\n一、本周进展\n1. 文件浏览核心完成\n2. 内置查看器覆盖 12 类格式\n\n二、下周计划\n1. 性能优化(虚拟滚动压测)\n2. 首次引导页\n\n三、风险\n无。'))
  docs.children!.set('数据.csv', newFile('数据.csv', makeCsv(80)))
  docs.children!.set('预算表.xlsx', newFile('预算表.xlsx', makeXlsx()))
  docs.children!.set('项目介绍.docx', newFile('项目介绍.docx', makeDocx()))
  root.children!.set('文档', docs)

  const code = newDir('代码')
  code.children!.set('main.ts', newFile('main.ts', APP_TS))
  code.children!.set('geometry.py', newFile('geometry.py', APP_PY))
  code.children!.set('config.json', newFile('config.json', CONFIG_JSON))
  code.children!.set('index.html', newFile('index.html', '<!doctype html>\n<html>\n  <head>\n    <meta charset="utf-8" />\n    <title>Hello</title>\n    <link rel="stylesheet" href="style.css" />\n  </head>\n  <body>\n    <h1>Hello, MX File Manager</h1>\n  </body>\n</html>\n'))
  code.children!.set('style.css', newFile('style.css', ':root {\n  --accent: #3574f0;\n}\n\nbody {\n  font-family: system-ui, sans-serif;\n  display: grid;\n  place-items: center;\n  min-height: 100vh;\n}\n\nh1 {\n  color: var(--accent);\n}\n'))
  root.children!.set('代码', code)

  const imgs = newDir('图片')
  imgs.children!.set(
    '渐变风景.png',
    newFile(
      '渐变风景.png',
      await canvasPng(960, 600, (ctx) => {
        const g = ctx.createLinearGradient(0, 0, 960, 600)
        g.addColorStop(0, '#0f2027')
        g.addColorStop(0.5, '#203a43')
        g.addColorStop(1, '#2c5364')
        ctx.fillStyle = g
        ctx.fillRect(0, 0, 960, 600)
        ctx.fillStyle = 'rgba(255,255,255,0.9)'
        ctx.beginPath()
        ctx.arc(760, 130, 56, 0, Math.PI * 2)
        ctx.fill()
        ctx.fillStyle = '#12222b'
        ctx.beginPath()
        ctx.moveTo(0, 600)
        ctx.lineTo(200, 340)
        ctx.lineTo(380, 600)
        ctx.closePath()
        ctx.fill()
        ctx.beginPath()
        ctx.moveTo(240, 600)
        ctx.lineTo(480, 280)
        ctx.lineTo(720, 600)
        ctx.closePath()
        ctx.fill()
        ctx.fillStyle = 'rgba(255,255,255,0.92)'
        ctx.font = '600 44px system-ui, sans-serif'
        ctx.fillText('MX File Manager', 60, 96)
        ctx.font = '24px system-ui, sans-serif'
        ctx.fillStyle = 'rgba(255,255,255,0.7)'
        ctx.fillText('演示图片 · 点击工具栏可缩放 / 旋转', 60, 140)
      })
    )
  )
  imgs.children!.set(
    '图标.png',
    newFile(
      '图标.png',
      await canvasPng(256, 256, (ctx) => {
        ctx.fillStyle = '#3574f0'
        ctx.beginPath()
        ctx.roundRect(16, 16, 224, 224, 40)
        ctx.fill()
        ctx.fillStyle = '#ffffff'
        ctx.fillRect(60, 92, 60, 52)
        ctx.beginPath()
        ctx.moveTo(60, 92)
        ctx.lineTo(88, 68)
        ctx.lineTo(96, 92)
        ctx.closePath()
        ctx.fill()
        ctx.fillRect(116, 132, 80, 52)
      })
    )
  )
  imgs.children!.set('矢量图.svg', newFile('矢量图.svg', SVG))
  root.children!.set('图片', imgs)

  const media = newDir('媒体')
  media.children!.set('示例音频.wav', newFile('示例音频.wav', makeWav()))
  root.children!.set('媒体', media)

  const archives = newDir('压缩包')
  archives.children!.set(
    '示例.zip',
    newFile(
      '示例.zip',
      zipSync({
        '说明.txt': strToU8('这个 ZIP 由演示模式生成。\n你可以在预览器里浏览包内文件,也可以一键解压到当前文件夹。'),
        '配置/config.json': strToU8('{"theme": "dark", "lang": "zh-CN"}'),
        '网页/index.html': strToU8('<!doctype html><html><body><h1>来自 ZIP 内部的网页</h1></body></html>'),
      })
    )
  )
  root.children!.set('压缩包', archives)

  const big = newDir('大文件测试')
  big.children!.set('server.log', newFile('server.log', makeLog(20000)))
  root.children!.set('大文件测试', big)

  root.children!.set('空文件夹', newDir('空文件夹'))
  return root
}
