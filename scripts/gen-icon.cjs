// 用 Electron 离屏渲染 SVG → 多尺寸 PNG → 手工打包 .ico / .icns
// 运行:npx electron scripts/gen-icon.cjs
const { app, BrowserWindow, nativeImage } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const OUT = path.join(ROOT, 'build')
const SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024]

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true })

  // SVG 以 data URL 内嵌,渲染进程不依赖任何 Node 能力
  const svg = fs.readFileSync(path.join(ROOT, 'assets', 'icon.svg'), 'utf8')
  const b64 = Buffer.from(svg, 'utf8').toString('base64')
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:transparent;overflow:hidden}img{display:block}</style></head><body><img id="i" width="1024" height="1024" src="data:image/svg+xml;base64,${b64}"></body></html>`

  const win = new BrowserWindow({
    width: 1024,
    height: 1024,
    show: false,
    frame: false,
    transparent: true,
    webPreferences: { offscreen: true },
  })
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))

  // 等 <img> 真正解码完成
  for (let i = 0; i < 50; i++) {
    const ok = await win.webContents
      .executeJavaScript('document.getElementById("i").complete && document.getElementById("i").naturalWidth > 0')
      .catch(() => false)
    if (ok) break
    await new Promise((r) => setTimeout(r, 100))
  }
  await new Promise((r) => setTimeout(r, 300))

  const big = await win.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 })
  const check = nativeImage.createFromBuffer(big.toPNG())
  if (check.isEmpty()) throw new Error('capture 为空')

  const pngs = {}
  for (const size of SIZES) {
    const img = size === 1024 ? check : nativeImage.createFromBuffer(check.toPNG()).resize({ width: size, height: size })
    pngs[size] = img.toPNG()
    fs.writeFileSync(path.join(OUT, `icon-${size}.png`), pngs[size])
  }

  // ---- ICO(Windows;256 的宽高字段写 0)----
  const icoSizes = [16, 24, 32, 48, 64, 128, 256]
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(icoSizes.length, 4)
  const entries = []
  let offset = 6 + 16 * icoSizes.length
  for (const s of icoSizes) {
    const e = Buffer.alloc(16)
    e.writeUInt8(s >= 256 ? 0 : s, 0)
    e.writeUInt8(s >= 256 ? 0 : s, 1)
    e.writeUInt8(0, 2)
    e.writeUInt8(0, 3)
    e.writeUInt16LE(1, 4)
    e.writeUInt16LE(32, 6)
    e.writeUInt32LE(pngs[s].length, 8)
    e.writeUInt32LE(offset, 12)
    offset += pngs[s].length
    entries.push(e)
  }
  const ico = Buffer.concat([header, ...entries, ...icoSizes.map((s) => pngs[s])])
  fs.writeFileSync(path.join(OUT, 'icon.ico'), ico)

  // ---- ICNS(macOS;PNG 载荷块)----
  const icnsTypes = [
    { type: 'ic07', size: 128 },
    { type: 'ic08', size: 256 },
    { type: 'ic09', size: 512 },
    { type: 'ic10', size: 1024 },
  ]
  const chunks = []
  let bodySize = 8
  for (const { type, size } of icnsTypes) {
    const c = Buffer.alloc(8)
    c.write(type, 0, 'ascii')
    c.writeUInt32LE(pngs[size].length + 8, 4)
    chunks.push(c, pngs[size])
    bodySize += pngs[size].length + 8
  }
  const head = Buffer.alloc(8)
  head.write('icns', 0, 'ascii')
  head.writeUInt32LE(bodySize, 4)
  fs.writeFileSync(path.join(OUT, 'icon.icns'), Buffer.concat([head, ...chunks]))

  console.log('ICONS_OK ->', OUT)
  app.exit(0)
})
