import { create } from 'zustand'
import { nativeAppMeta, nativeLaunch, type ElectronProvider, type InstalledApp } from '../fs/electron'
import type { FSProvider, FileEntry } from '../fs/types'
import { useFs } from './fs'
import { useUi } from './ui'
import { baseName, segments } from '../utils/path'

/** 扫描结果缓存时长:5 分钟内不重复扫(force 可强制) */
const CACHE_MS = 5 * 60 * 1000
/** 读 .desktop 的并发上限:一次最多打出这么多 IPC,避免几百个文件同时读 */
const READ_CONCURRENCY = 8
/** 可当启动路径的扩展名(Win 侧用来判断 installLocation/iconPath 里存的是不是程序本体) */
const LAUNCHABLE_EXT = /\.(exe|com|bat|cmd)$/i
/** 卸载器/安装器:绝不能拿来当启动路径 */
const INSTALLER_NAME = /unins|uninstall|setup|install|卸载/i

/** 主页「应用程序」分类的一个条目(三平台统一形状) */
export interface AppEntry {
  /** 唯一键:win:注册表 id / app:虚拟路径 / desktop:虚拟路径 */
  id: string
  name: string
  version?: string
  publisher?: string
  /** 可启动路径(优先虚拟路径;不在任何已挂载根内时退化为本机路径) */
  path?: string
  /** 供 execIcon 使用的本机路径 */
  iconPath?: string
  sizeKB?: number
  /** YYYYMMDD */
  installDate?: string
  /** 卸载能力:由平台决定 */
  uninstall?: { app: InstalledApp } | 'moveToTrash' | null
}

interface AppsState {
  items: AppEntry[]
  loading: boolean
  error: string | null
  lastScanAt: number | null
  scan(force?: boolean): Promise<void>
  launch(app: AppEntry): Promise<void>
  uninstall(app: AppEntry): Promise<void>
  clear(): void
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** 平台标识:FSProvider 接口没有 platform 字段,ElectronProvider/CapacitorProvider 都有 */
function platformOf(p: FSProvider): string {
  return (p as unknown as { platform?: string }).platform ?? ''
}

/** 本机路径 → 虚拟路径;不在任何已挂载根内(或不支持转换)返回 null */
function toVirtual(p: FSProvider, nativePath: string): string | null {
  const ep = p as unknown as Partial<ElectronProvider>
  if (typeof ep.toVirtualPath !== 'function') return null
  try {
    return ep.toVirtualPath(nativePath)
  } catch {
    return null
  }
}

/**
 * AppEntry.path → 本机路径(喂 execRun)。
 * path 可能是虚拟路径(第一段的根名存在),也可能已是本机路径(Windows 的 C:\... )。
 */
function nativeOf(p: FSProvider, path: string): string | null {
  const segs = segments(path)
  if (segs.length && p.hasRoot(segs[0])) {
    const ep = p as unknown as Partial<ElectronProvider>
    if (typeof ep.toNativePath !== 'function') return null
    try {
      return ep.toNativePath(path)
    } catch {
      return null
    }
  }
  // 非虚拟路径:Windows 本机路径(C:\...)或转换失败的裸路径,直接原样用
  if (!path.startsWith('/')) return path
  return null
}

/** 家目录的本机路径:借特殊目录(桌面/下载…)反推,拿不到返回 null */
function homeNative(p: FSProvider): string | null {
  const ep = p as unknown as Partial<ElectronProvider>
  if (typeof ep.toNativePath !== 'function' || typeof ep.toVirtualPath !== 'function') return null
  for (const name of ['桌面', '下载', '文档', '图片', '音乐', '视频']) {
    let native: string
    try {
      native = ep.toNativePath('/' + name)
    } catch {
      continue
    }
    const i = native.lastIndexOf('/')
    if (i > 0) return native.slice(0, i)
  }
  return null
}

/** 本机目录候选 → 虚拟路径(去重,丢弃不在任何已挂载根内的候选) */
function virtualDirs(p: FSProvider, natives: string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const add = (v: string | null) => {
    if (v && !seen.has(v)) {
      seen.add(v)
      out.push(v)
    }
  }
  for (const n of natives) add(toVirtual(p, n))
  return out
}

/** 列举若干候选目录:单个目录失败不影响其它目录,失败原因收集起来给调用方兜底报错 */
async function listCandidates(
  p: FSProvider,
  dirs: string[]
): Promise<{ entries: FileEntry[]; failures: string[] }> {
  const entries: FileEntry[] = []
  const failures: string[] = []
  if (!dirs.length) return { entries, failures }
  const results = await Promise.all(
    dirs.map(async (dir) => {
      try {
        return { dir, entries: await p.list(dir), error: null as string | null }
      } catch (e) {
        return { dir, entries: [] as FileEntry[], error: errText(e) }
      }
    })
  )
  const seen = new Set<string>()
  for (const r of results) {
    if (r.error) {
      failures.push(`${r.dir}(${r.error})`)
      continue
    }
    for (const e of r.entries) {
      if (seen.has(e.path)) continue
      seen.add(e.path)
      entries.push(e)
    }
  }
  return { entries, failures }
}

/** 中文排序(数字按数值大小,不再出现 "10" 排在 "2" 前面) */
function byName(a: AppEntry, b: AppEntry): number {
  return a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true }) || a.id.localeCompare(b.id)
}

/**
 * 同名去重(保留先出现的那个)。
 * mac 上 /Applications 与 ~/Applications(以及「应用程序」这个别名根)常装同一款应用,
 * Linux 上系统级与用户级 .desktop 也常常同名 —— 主页只应出现一项。
 */
function dedupeByName(items: AppEntry[]): AppEntry[] {
  const seen = new Set<string>()
  const out: AppEntry[] = []
  for (const it of items) {
    const k = it.name.toLowerCase()
    if (seen.has(k)) continue
    seen.add(k)
    out.push(it)
  }
  return out
}

/** 小并发 map:失败项由调用方在 fn 内部消化(返回 null),不让单个坏文件拖垮整批 */
async function mapPool<T>(items: T[], n: number, fn: (it: T) => Promise<AppEntry | null>): Promise<AppEntry[]> {
  const out: (AppEntry | null)[] = new Array(items.length).fill(null)
  let cursor = 0
  const worker = async () => {
    for (;;) {
      const i = cursor++
      if (i >= items.length) return
      out[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, worker))
  return out.filter((x): x is AppEntry => x !== null)
}

/* ---------------- Windows:注册表卸载列表 ---------------- */

/**
 * 从 installLocation / iconPath 推启动路径。
 * 两者语义都不保证:installLocation 多数是目录,少数安装器会写完整 exe 路径;
 * iconPath 常常就是程序本体,但也可能是 .ico/.dll。
 * 只有「看起来是可执行文件 + 名字不像卸载器」才认,否则留空 ——
 * 启动失败只是提示,拿 UninstallString/卸载器去启动是危险错误。
 */
function winLaunchPath(app: InstalledApp): string | null {
  for (const cand of [app.iconPath, app.installLocation]) {
    if (!cand) continue
    const n = cand.replace(/\\/g, '/')
    if (!LAUNCHABLE_EXT.test(n)) continue
    if (INSTALLER_NAME.test(baseName(n))) continue
    return cand
  }
  return null
}

async function scanWindows(p: FSProvider): Promise<AppEntry[]> {
  const meta = nativeAppMeta()
  if (!meta) throw new Error('当前版本主进程不支持读取已安装程序列表')
  const r = await meta.execUninstallList()
  if (r.unsupported) throw new Error('当前平台不支持读取已安装程序列表')
  if (r.error) throw new Error(r.error)
  const out: AppEntry[] = []
  const seen = new Set<string>()
  for (const it of r.items ?? []) {
    if (!it?.name) continue
    let id = 'win:' + it.id
    // 32/64 位两个注册表视图可能撞 id,加序号保证唯一
    if (seen.has(id)) id += '@' + out.length
    seen.add(id)
    const launch = winLaunchPath(it)
    out.push({
      id,
      name: it.name,
      version: it.version,
      publisher: it.publisher,
      path: launch ? toVirtual(p, launch) ?? launch : undefined,
      iconPath: it.iconPath || undefined,
      sizeKB: it.estimatedSize,
      installDate: it.installDate,
      uninstall: { app: it },
    })
  }
  return out
}

/* ---------------- macOS:/Applications 目录列举 ---------------- */

async function scanMac(p: FSProvider): Promise<AppEntry[]> {
  const natives = ['/Applications']
  const home = homeNative(p)
  if (home) natives.push(`${home}/Applications`)
  const dirs = virtualDirs(p, natives)
  // 有些环境把 /Applications 直接挂成根(或以「应用程序」为根名),补两个虚拟候选
  for (const v of ['/Applications', '/应用程序']) {
    if (p.hasRoot(segments(v)[0]) && !dirs.includes(v)) dirs.push(v)
  }
  const { entries, failures } = await listCandidates(p, dirs)
  if (!entries.length) {
    throw new Error(
      failures.length
        ? `无法读取应用程序目录:${failures.join(';')}`
        : '未找到已安装的应用程序'
    )
  }
  const out: AppEntry[] = []
  for (const e of entries) {
    if (e.kind !== 'directory' || !e.name.endsWith('.app')) continue
    if (e.name.startsWith('.')) continue
    out.push({
      id: 'app:' + e.path,
      name: e.name.replace(/\.app$/, ''),
      // .app 本身就可运行(execRun 认 bundle);sizeKB 绝不递归求和(太慢),留空
      path: e.path,
      iconPath: nativeOf(p, e.path) ?? undefined,
      uninstall: 'moveToTrash',
    })
  }
  return dedupeByName(out)
}

/* ---------------- Linux:.desktop 文件 ---------------- */

interface DesktopInfo {
  name: string
  comment?: string
  icon?: string
  exec?: string
}

/** 取带本地化的键:Name[zh_CN] > Name[zh] > Name */
function localized(kv: Record<string, string>, key: string): string | undefined {
  return kv[`${key}[zh_CN]`] || kv[`${key}[zh]`] || kv[key] || undefined
}

/** 解析 .desktop:只认 [Desktop Entry] 段,跳过隐藏/非 Application 条目 */
function parseDesktop(text: string): DesktopInfo | null {
  const kv: Record<string, string> = {}
  let inEntry = false
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    if (line.startsWith('[')) {
      inEntry = /^\[Desktop Entry\]$/i.test(line)
      continue
    }
    if (!inEntry) continue
    const i = line.indexOf('=')
    if (i <= 0) continue
    const k = line.slice(0, i).trim()
    // 同名键取第一个(后出现的通常是别的语言环境的重复段)
    if (!(k in kv)) kv[k] = line.slice(i + 1).trim()
  }
  if (kv.NoDisplay === 'true' || kv.Hidden === 'true') return null
  if (kv.Type && kv.Type !== 'Application') return null
  const name = localized(kv, 'Name')
  if (!name) return null
  return { name, comment: localized(kv, 'Comment'), icon: kv.Icon, exec: kv.Exec }
}

/** Exec 行 → 绝对路径:去掉 %f/%U 等字段码后取第一段;只认绝对路径(PATH 里的裸命令无法定位) */
function execToPath(exec: string | undefined): string | null {
  if (!exec) return null
  const cleaned = exec.replace(/%[a-zA-Z]/g, '').trim()
  const m = cleaned.match(/^"([^"]+)"|^'([^']+)'|^\S+/)
  const bin = (m?.[1] ?? m?.[2] ?? m?.[0] ?? '').trim()
  return bin.startsWith('/') ? bin : null
}

async function scanLinux(p: FSProvider): Promise<AppEntry[]> {
  const natives = ['/usr/share/applications']
  const home = homeNative(p)
  if (home) natives.push(`${home}/.local/share/applications`)
  const dirs = virtualDirs(p, natives)
  const { entries, failures } = await listCandidates(p, dirs)
  const files = entries.filter((e) => e.kind === 'file' && e.name.endsWith('.desktop'))
  if (!files.length) {
    throw new Error(
      failures.length
        ? `无法读取应用程序目录:${failures.join(';')}`
        : '未在 /usr/share/applications 中找到 .desktop 文件'
    )
  }
  const items = await mapPool(files, READ_CONCURRENCY, async (f) => {
    try {
      const text = await (await p.getFile(f.path)).text()
      const info = parseDesktop(text)
      if (!info) return null
      const bin = execToPath(info.exec)
      return {
        id: 'desktop:' + f.path,
        name: info.name,
        // Comment 常是程序自述,publisher 在 .desktop 里没有对应字段,留空
        path: bin ? toVirtual(p, bin) ?? bin : undefined,
        // Icon 可能是图标主题名(如 "firefox")而非路径,只有绝对路径才喂 execIcon
        iconPath: info.icon?.startsWith('/') ? info.icon : undefined,
        uninstall: null,
      } satisfies AppEntry
    } catch {
      // 单个 .desktop 损坏/无权限不影响其它条目
      return null
    }
  })
  return dedupeByName(items)
}

/* ---------------- store ---------------- */

export const useApps = create<AppsState>()((set, get) => ({
  items: [],
  loading: false,
  error: null,
  lastScanAt: null,

  async scan(force = false) {
    const s = get()
    if (s.loading) return // 并发去重:正在扫时重复调用直接返回
    // 缓存命中(有结果且 5 分钟内)直接复用;上次是空/失败则允许重扫,不让用户卡死
    if (!force && s.items.length && s.lastScanAt && Date.now() - s.lastScanAt < CACHE_MS) return

    const provider = useFs.getState().provider
    if (!provider) {
      set({ loading: false, error: '文件系统尚未就绪' })
      return
    }
    if (provider.kind !== 'native') {
      set({ items: [], loading: false, error: '浏览器版不支持应用列表', lastScanAt: Date.now() })
      return
    }

    set({ loading: true, error: null })
    try {
      const plat = platformOf(provider)
      let items: AppEntry[]
      if (plat === 'win32') items = await scanWindows(provider)
      else if (plat === 'darwin') items = await scanMac(provider)
      else items = await scanLinux(provider)
      items.sort(byName)
      set({ items, loading: false, error: null, lastScanAt: Date.now() })
    } catch (e) {
      set({ items: [], loading: false, error: errText(e), lastScanAt: Date.now() })
    }
  },

  async launch(app) {
    const ui = useUi.getState()
    const provider = useFs.getState().provider
    const launch = nativeLaunch()
    if (!provider || provider.kind !== 'native' || !launch) {
      ui.toast('当前环境不支持启动程序', 'error')
      return
    }
    // 没有可启动路径时绝不能拿 UninstallString 顶上 —— 那会把卸载程序跑起来
    const native = app.path ? nativeOf(provider, app.path) : null
    if (!native) {
      ui.toast('该程序未提供启动路径', 'error')
      return
    }
    try {
      // 分级确认框由主进程 exec:run 内部弹出,渲染层不画
      const r = await launch.execRun({ path: native })
      if (r.mode === 'denied') {
        ui.toast(r.reason || '已取消启动', 'info')
        return
      }
      ui.toast(`已启动 ${app.name}`, 'success')
    } catch (e) {
      ui.toast(errText(e), 'error')
    }
  },

  async uninstall(app) {
    const ui = useUi.getState()
    const provider = useFs.getState().provider
    if (!provider) return
    if (!app.uninstall) {
      ui.toast('该程序不支持卸载', 'info')
      return
    }
    // mac:没有标准卸载入口,把 .app 移到废纸篓(二次确认由 UI 负责)
    if (app.uninstall === 'moveToTrash') {
      if (!app.path) {
        ui.toast('该程序没有可定位的位置,无法移到废纸篓', 'error')
        return
      }
      try {
        // remove 走系统废纸篓;该位置不支持回收站时主进程会 throw,这里如实告知
        await provider.remove(app.path, 'directory')
        ui.toast(`已将 ${app.name} 移到废纸篓`, 'success')
        await get().scan(true)
      } catch (e) {
        ui.toast(`无法移动到废纸篓:${errText(e)}`, 'error')
      }
      return
    }
    const meta = nativeAppMeta()
    if (!meta) {
      ui.toast('当前版本主进程不支持卸载程序', 'error')
      return
    }
    try {
      // 确认框由主进程原生弹出,渲染层不画;用户取消走 error='已取消'
      const r = await meta.execUninstall({ app: app.uninstall.app })
      if (!r.ok) {
        ui.toast(r.error || '卸载失败', r.error === '已取消' ? 'info' : 'error')
        return
      }
      ui.toast(`已启动「${app.name}」的卸载程序`, 'success')
    } catch (e) {
      ui.toast(errText(e), 'error')
    }
  },

  clear() {
    set({ items: [], loading: false, error: null, lastScanAt: null })
  },
}))
