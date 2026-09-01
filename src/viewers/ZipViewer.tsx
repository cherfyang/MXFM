import { useEffect, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { unzipSync } from 'fflate'
import { Archive, Download, Loader2, AlertTriangle, X, Folder, KeyRound } from 'lucide-react'
import type { ViewerProps } from './registry'
import { useFs } from '../stores/fs'
import { useUi } from '../stores/ui'
import { fmtBytes, extOf } from '../utils/format'
import { categoryOf } from '../utils/categories'
import { EntryIcon } from '../components/Icons'
import { baseName } from '../utils/path'

const SIZE_LIMIT = 200 * 1024 * 1024
/** 走 fflate 快速路径的扩展名(其余交给 libarchive) */
const ZIP_ONLY = new Set(['zip'])
const LIBARCHIVE_EXTS = new Set(['rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz'])

interface Entry {
  path: string
  name: string
  isDir: boolean
  size: number
  /** libarchive 的条目句柄(extract() 得到 File) */
  handle?: { extract(): Promise<File> }
}

/** libarchive.js 的 ArchiveReader 最小接口(Archive.open 的返回值) */
interface LibArchive {
  hasEncryptedData(): Promise<boolean | null>
  usePassword(password: string): Promise<void>
  getFilesArray(): Promise<{ file: unknown }[]>
  close?(): Promise<void>
}

/**
 * 读 zip 中央目录,查 general purpose bit flag 的 bit0(加密标志)。
 * 解析失败(找不到 EOCD/签名不符/疑似 zip64)一律返回 false,
 * 交回后续流程:unzipSync 抛错会回落 libarchive,由 hasEncryptedData() 兜底检测。
 */
function zipHasEncrypted(d: Uint8Array): boolean {
  const b2 = (p: number) => d[p] | (d[p + 1] << 8)
  const b4 = (p: number) => (d[p] | (d[p + 1] << 8) | (d[p + 2] << 16) | (d[p + 3] << 24)) >>> 0
  // 尾部找 EOCD 签名(注释最长 65535,留 22 字节头)
  let e = d.length - 22
  const min = Math.max(0, d.length - 65558)
  while (e >= min && b4(e) !== 0x06054b50) e--
  if (e < min) return false
  const count = b2(e + 8)
  let o = b4(e + 16)
  for (let i = 0; i < count && o + 46 <= d.length; i++) {
    if (b4(o) !== 0x02014b50) return false
    if (b2(o + 8) & 1) return true
    o += 46 + b2(o + 28) + b2(o + 30) + b2(o + 32)
  }
  return false
}

/** libarchive 条目映射为列表项(fullname 缺失时退回 name,与原实现一致) */
function mapLibItems(arr: { file: unknown }[]): Entry[] {
  return arr
    .map(({ file }) => {
      const f = file as { name: string; extract(): Promise<File>; fullname?: string; isDir?: boolean; size?: number }
      const p = f.fullname ?? f.name
      return {
        path: p,
        name: baseName(p.replace(/\/$/, '')) || p,
        isDir: !!f.isDir,
        size: f.size ?? 0,
        handle: f,
      }
    })
    .sort((x, y) => (x.isDir === y.isDir ? x.path.localeCompare(y.path) : x.isDir ? -1 : 1))
}

export function ZipViewer({ entry }: ViewerProps) {
  const [items, setItems] = useState<Entry[] | null>(null)
  const [zipData, setZipData] = useState<Record<string, Uint8Array> | null>(null)
  const isZip = ZIP_ONLY.has(entry.ext)
  const supported = isZip || LIBARCHIVE_EXTS.has(entry.ext)
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState<{ path: string; url?: string; text?: string } | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  // 加密压缩包:密码输入 overlay 与 libarchive 句柄
  const [needPw, setNeedPw] = useState(false)
  const [pw, setPw] = useState('')
  const [pwBusy, setPwBusy] = useState(false)
  const [pwError, setPwError] = useState(false)
  const [pwFails, setPwFails] = useState(0)
  const [libRoute, setLibRoute] = useState(false) // zip 也走了 libarchive(加密/fflate 解不动)
  const archRef = useRef<LibArchive | null>(null)
  const encryptedRef = useRef(false)

  useEffect(() => {
    let alive = true
    setItems(null)
    setZipData(null)
    setError(null)
    setPreview(null)
    setNeedPw(false)
    setPw('')
    setPwError(false)
    setPwFails(0)
    setLibRoute(false)
    encryptedRef.current = false
    if (!supported) {
      setError(`暂不支持「${entry.ext.toUpperCase()}」压缩格式(支持:ZIP / RAR / 7z / TAR / GZ / BZ2 / XZ)`)
      return
    }
    ;(async () => {
      try {
        const provider = useFs.getState().provider
        if (!provider) return
        const f = await provider.getFile(entry.path)
        if (!alive) return
        if (f.size > SIZE_LIMIT) {
          setError(`压缩包过大(${fmtBytes(f.size)}),超出预览上限`)
          return
        }
        const bytes = new Uint8Array(await f.arrayBuffer())
        if (!alive) return
        // zip 快速路径:先扫中央目录排掉加密包,未加密走 fflate;fflate 解不动再落 libarchive
        if (isZip && !zipHasEncrypted(bytes)) {
          try {
            const files = unzipSync(bytes)
            if (!alive) return
            setZipData(files)
            // fflate 按 UTF-8 强解文件名,含 U+FFFD 说明原名不是 UTF-8(如 GBK 打包),无法无损还原,给出提示
            const hasGarbled = Object.keys(files).some((p) => p.includes('\uFFFD'))
            if (hasGarbled && alive)
              useUi
                .getState()
                .toast('压缩包内部分文件名非 UTF-8 编码(常见于 Windows GBK 打包),名称可能显示异常', 'info')
            setItems(
              Object.entries(files)
                .filter(([p]) => !p.startsWith('__MACOSX'))
                .map(([p, data]) => ({
                  path: p,
                  name: baseName(p.replace(/\/$/, '')) || p,
                  isDir: p.endsWith('/'),
                  size: data.length,
                }))
                .sort((a, b) => (a.isDir === b.isDir ? a.path.localeCompare(b.path) : a.isDir ? -1 : 1))
            )
            return
          } catch {
            /* 罕见:fflate 不认的 zip,交给 libarchive(会顺带做加密检测) */
          }
        }
        if (isZip) setLibRoute(true)
        const { Archive } = await import('libarchive.js')
        if (!alive) return
        try {
          Archive.init({
            workerUrl: new URL('libarchive.js/dist/archive-worker.js', import.meta.url).href,
          })
        } catch {
          /* 已初始化过 */
        }
        const arch = (await Archive.open(f)) as LibArchive
        if (!alive) return
        archRef.current = arch
        let enc: boolean | null = null
        try {
          enc = await arch.hasEncryptedData()
        } catch {
          /* 个别格式探测会失败,按"未知"处理,继续尝试列目录 */
        }
        if (!alive) return
        if (enc === true) {
          encryptedRef.current = true
          setNeedPw(true)
          return
        }
        try {
          const arr = await arch.getFilesArray()
          if (!alive) return
          setItems(mapLibItems(arr))
        } catch (e) {
          // 头部加密的格式(如 7z)列目录时才报密码错误
          const msg = (e as Error).message || String(e)
          if (/passphrase|password|encrypt|decrypt/i.test(msg)) {
            encryptedRef.current = true
            setNeedPw(true)
          } else {
            setError(msg)
          }
        }
      } catch (e) {
        if (alive) setError((e as Error).message || String(e))
      }
    })()
    return () => {
      alive = false
      const arch = archRef.current
      archRef.current = null
      encryptedRef.current = false
      void arch?.close?.().catch(() => {
        /* worker 已终止等 */
      })
      // 切换压缩包/卸载时释放包内预览的 blob URL(唯一确认过的泄漏点)
      setPreview((prev) => {
        if (prev?.url) URL.revokeObjectURL(prev.url)
        return null
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry.path])

  /** 提交密码:usePassword 后重新列目录。zip 只加密数据时列目录不校验密码,错密码要到提取单个文件时才会暴露 */
  const submitPassword = async () => {
    const arch = archRef.current
    if (!arch || !pw || pwBusy) return
    setPwBusy(true)
    setPwError(false)
    encryptedRef.current = true
    try {
      await arch.usePassword(pw)
      const arr = await arch.getFilesArray()
      if (archRef.current !== arch) return // 已切换到别的压缩包
      setItems(mapLibItems(arr))
      setNeedPw(false)
    } catch {
      if (archRef.current === arch) {
        setPwError(true)
        setPwFails((n) => n + 1)
      }
    } finally {
      setPwBusy(false)
    }
  }

  const cancelPassword = () => {
    setNeedPw(false)
    setPw('')
    // 还没列出内容时取消 → 回到提示态;列表已在(提取时弹回的场景)则回到列表态
    if (!items) setError('已取消输入密码,加密压缩包未打开')
  }

  const virt = useVirtualizer({
    count: items?.length ?? 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 30,
    overscan: 20,
  })

  /** 取包内文件的字节(zip 从缓存;libarchive 现场解包) */
  const readItem = async (item: Entry): Promise<Blob | null> => {
    if (isZip && zipData) {
      const bytes = zipData[item.path]
      return bytes ? new Blob([bytes as BlobPart]) : null
    }
    const file = await item.handle?.extract()
    return file ?? null
  }

  const openItem = async (item: Entry) => {
    if (item.isDir) return
    try {
      const blob = await readItem(item)
      if (!blob) return
      const cat = categoryOf({ kind: 'file', name: item.name, ext: extOf(item.name) })
      if (cat === 'image' || cat === 'video' || cat === 'audio') {
        // 换预览前先释放上一个 blob URL
        setPreview((prev) => {
          if (prev?.url) URL.revokeObjectURL(prev.url)
          return { path: item.path, url: URL.createObjectURL(blob) }
        })
      } else if (cat === 'binary') {
        setPreview({ path: item.path, text: `二进制文件,共 ${fmtBytes(blob.size)},不支持预览` })
      } else {
        setPreview({ path: item.path, text: await blob.slice(0, 512 * 1024).text() })
      }
    } catch (e) {
      if (encryptedRef.current && archRef.current) {
        // 加密包提取失败大概率是密码错误(zip 只加密数据时,错误密码要到这一步才暴露),弹回密码框
        setPwError(true)
        setPwFails((n) => n + 1)
        setNeedPw(true)
      } else {
        useUi.getState().toast(`读取失败:${(e as Error).message}`, 'error')
      }
    }
  }

  const extractAll = async () => {
    if (!items || !isZip || !zipData) return
    const s = useFs.getState()
    const dir = entry.path.slice(0, entry.path.length - entry.name.length - 1)
    const base = entry.name.replace(/\.zip$/i, '')
    const destName = (await s.provider!.exists(`${dir}/${base}`)) ? await s.provider!.uniqueName(dir, base) : base
    const destDir = `${dir}/${destName}`
    try {
      await s.provider!.mkdir(destDir)
      const fileItems = items.filter((i) => !i.isDir)
      const dirs = new Set<string>()
      for (const item of fileItems) {
        const segs = item.path.split('/').slice(0, -1)
        let cur = destDir
        for (const seg of segs) {
          cur = `${cur}/${seg}`
          dirs.add(cur)
        }
      }
      for (const d of [...dirs].sort((a, b) => a.length - b.length)) {
        await s.provider!.mkdir(d)
      }
      let n = 0
      for (const item of fileItems) {
        await s.provider!.writeBytes(`${destDir}/${item.path}`, zipData[item.path])
        n++
      }
      useUi.getState().toast(`已解压 ${n} 个文件到「${destDir.split('/').pop()}」`, 'success')
      await s.refresh()
    } catch (e) {
      useUi.getState().toast(e instanceof Error ? e.message : String(e), 'error')
    }
  }

  return (
    <div className="relative flex h-full flex-col">
      {/* 密码错误抖动动画(只能内联:全局样式文件不在本轮改动范围) */}
      <style>{`@keyframes zip-shake{10%,90%{transform:translateX(-1px)}20%,80%{transform:translateX(2px)}30%,50%,70%{transform:translateX(-3px)}40%,60%{transform:translateX(3px)}}.zip-shake{animation:zip-shake .4s ease}`}</style>
      {error ? (
        <div className="flex h-full flex-col items-center justify-center gap-2 text-txt2">
          <AlertTriangle className="h-8 w-8 text-amber-500" />
          <div className="text-sm">{error}</div>
        </div>
      ) : !items ? (
        <div className="flex h-full items-center justify-center text-txt2">
          <Loader2 className="mr-2 h-5 w-5 animate-spin" /> 读取压缩包…
        </div>
      ) : (
        <>
          <div className="flex h-9 shrink-0 items-center gap-2 border-b border-brd bg-panel px-3">
            <Archive className="h-4 w-4 text-amber-400" />
            <span className="text-xs text-txt2">
              {items.filter((i) => !i.isDir).length} 个文件 · 共 {fmtBytes(items.reduce((a, i) => a + i.size, 0))}
              {(!isZip || libRoute) && ' · libarchive'}
            </span>
            <span className="flex-1" />
            <button
              onClick={() => void extractAll()}
              disabled={!zipData}
              className="flex h-7 items-center gap-1.5 rounded-md bg-acc px-2.5 text-xs text-white hover:opacity-90 disabled:opacity-40"
              title={zipData ? '解压到当前文件夹' : '一键解压仅支持未加密 ZIP;加密包与 RAR/7z 可在包内浏览预览'}
            >
              <Download className="h-3.5 w-3.5" /> 全部解压
            </button>
          </div>
          <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto">
            <div style={{ height: virt.getTotalSize(), position: 'relative' }}>
              {virt.getVirtualItems().map((vi) => {
                const item = items[vi.index]
                return (
                  <div
                    key={item.path}
                    onClick={() => void openItem(item)}
                    className={`absolute left-0 top-0 flex h-[30px] w-full cursor-default items-center gap-2 px-3 text-[13px] hover:bg-hover ${
                      preview?.path === item.path ? 'bg-sel' : ''
                    }`}
                    style={{ transform: `translateY(${vi.start}px)` }}
                    title={item.path}
                  >
                    {item.isDir ? (
                      <Folder className="h-4 w-4 shrink-0 text-acc" />
                    ) : (
                      <EntryIcon category={categoryOf({ kind: 'file', name: item.name, ext: extOf(item.name) })} />
                    )}
                    <span className="min-w-0 flex-1 truncate">{item.path}</span>
                    <span className="shrink-0 text-xs text-txt2">{item.isDir ? '' : fmtBytes(item.size)}</span>
                  </div>
                )
              })}
            </div>
          </div>
        </>
      )}

      {/* 包内文件预览 */}
      {preview && (
        <div className="absolute inset-0 z-20 flex flex-col bg-panel shadow-2xl">
          <div className="flex h-10 shrink-0 items-center gap-2 border-b border-brd px-3">
            <span className="min-w-0 flex-1 truncate text-[13px]">{preview.path}</span>
            <button
              onClick={() => {
                if (preview.url) URL.revokeObjectURL(preview.url)
                setPreview(null)
              }}
              className="rounded p-1.5 text-txt2 hover:bg-hover hover:text-txt"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-auto p-4">
            {preview.url ? (
              /\.(mp4|webm|mkv)$/i.test(preview.path) ? (
                <video src={preview.url} controls className="max-h-full max-w-full" />
              ) : /\.(mp3|wav|ogg|flac|m4a)$/i.test(preview.path) ? (
                <audio src={preview.url} controls className="w-full" />
              ) : (
                <img src={preview.url} alt="" className="mx-auto max-w-full" />
              )
            ) : (
              <pre className="whitespace-pre-wrap break-all font-mono text-[13px]">{preview.text}</pre>
            )}
          </div>
        </div>
      )}

      {/* 密码输入 overlay */}
      {needPw && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/40">
          <div
            key={pwFails}
            className={`mx-fade w-80 rounded-xl border border-brd bg-panel p-4 shadow-2xl ${pwError ? 'zip-shake' : ''}`}
          >
            <div className="mb-1 flex items-center gap-2 text-sm text-txt">
              <KeyRound className="h-4 w-4 text-amber-400" /> 该压缩包已加密
            </div>
            <div className="mb-3 text-xs text-txt2">{entry.name}</div>
            {pwError && <div className="mb-2 text-xs text-danger">密码错误或文件损坏,请重试</div>}
            <input
              autoFocus
              type="password"
              value={pw}
              onChange={(e) => {
                setPw(e.target.value)
                if (pwError) setPwError(false)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submitPassword()
              }}
              placeholder="输入密码"
              className={`mb-3 h-9 w-full rounded-md border bg-panel2 px-2.5 text-sm text-txt outline-none ${
                pwError ? 'border-danger' : 'border-brd focus:border-acc'
              }`}
            />
            <div className="flex justify-end gap-2">
              <button onClick={cancelPassword} className="h-8 rounded-md px-3 text-xs text-txt2 hover:bg-hover">
                取消
              </button>
              <button
                onClick={() => void submitPassword()}
                disabled={!pw || pwBusy}
                className="flex h-8 items-center rounded-md bg-acc px-3 text-xs text-white hover:opacity-90 disabled:opacity-40"
              >
                {pwBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : '确定'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
