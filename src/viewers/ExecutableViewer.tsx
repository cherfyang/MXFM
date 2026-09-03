import { useEffect, useState, type ReactNode } from 'react'
import {
  Play,
  Loader2,
  AlertTriangle,
  ShieldAlert,
  ShieldQuestion,
  BadgeCheck,
  Globe,
  TerminalSquare,
} from 'lucide-react'
import type { ViewerProps } from './registry'
import { useFs } from '../stores/fs'
import { useUi } from '../stores/ui'
import { fmtBytes, fmtDate } from '../utils/format'
import { nativeAppMeta, nativeLaunch, type ExecMeta, type ExecProbeResult } from '../fs/electron'

/** exe 的 PE 头解析:SubSystem 在 Optional Header +68(e_lfanew 固定偏移),2=GUI 3=控制台 */
function peSubsystem(bytes: Uint8Array): number | null {
  try {
    if (bytes.length < 0x100 || bytes[0] !== 0x4d || bytes[1] !== 0x5a) return null // MZ
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const e_lfanew = dv.getUint32(0x3c, true)
    if (e_lfanew + 4 + 20 + 96 > bytes.length) return null
    if (bytes[e_lfanew] !== 0x50 || bytes[e_lfanew + 1] !== 0x45) return null // PE\0\0
    return dv.getUint16(e_lfanew + 24 + 68, true)
  } catch {
    return null
  }
}

/** ELF 头的 e_machine:3=x86 40=ARM 62=x86-64 183=AArch64 */
function elfArch(bytes: Uint8Array): string | null {
  try {
    if (bytes.length < 20 || bytes[0] !== 0x7f || bytes[1] !== 0x45) return null // \x7fELF
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const machine = dv.getUint16(18, true)
    return { 3: 'x86', 40: 'ARM', 62: 'x86-64', 183: 'AArch64' }[machine] ?? `machine:${machine}`
  } catch {
    return null
  }
}

/** Mach-O cputype(魔数 0xfeedface/0xfeedfacf):7=x86 7+0x1000000=x86-64 12=ARM 12+0x1000000=AArch64 */
function machoArch(bytes: Uint8Array): string | null {
  try {
    if (bytes.length < 8) return null
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const magic = dv.getUint32(0, false)
    const cpu = dv.getUint32(4, true)
    if (magic !== 0xfeedface && magic !== 0xfeedfacf && magic !== 0xcafebabe && magic !== 0xcffaedfe) return null
    const base: Record<number, string> = { 7: 'x86', 12: 'ARM' }
    const arch = base[cpu & 0xffffff] ?? `cpu:${cpu}`
    return cpu & 0x01000000 ? `${arch}-64` : arch
  } catch {
    return null
  }
}

export function ExecutableViewer({ entry }: ViewerProps) {
  const [icon, setIcon] = useState<string | null>(null)
  const [probe, setProbe] = useState<ExecProbeResult | null>(null)
  const [arch, setArch] = useState<string | null>(null)
  const [meta, setMeta] = useState<ExecMeta | null>(null)
  const [metaLoading, setMetaLoading] = useState(false)
  const [running, setRunning] = useState(false)

  // 图标:桌面版走系统提取(主进程缓存),失败回退通用图标
  useEffect(() => {
    let alive = true
    setIcon(null)
    setProbe(null)
    setArch(null)
    setMeta(null)
    setMetaLoading(false)
    ;(async () => {
      const launch = nativeLaunch()
      const metaApi = nativeAppMeta()
      const provider = useFs.getState().provider
      if (!provider) return
      // 架构/子系统:读前 4096 字节解析 PE/ELF/Mach-O 头,无需额外 IPC
      try {
        const bytes = await provider.readBytes(entry.path, 0, 4096)
        if (!alive) return
        const sub = peSubsystem(bytes)
        if (sub !== null) setArch(sub === 2 ? 'Windows GUI' : sub === 3 ? 'Windows 控制台' : `子系统:${sub}`)
        else setArch(elfArch(bytes) ?? machoArch(bytes))
      } catch {
        /* 读不到就不显示 */
      }
      if (!launch && !metaApi) return

      let native: string
      try {
        native = (provider as unknown as { toNativePath(p: string): string }).toNativePath(entry.path)
      } catch {
        return // 虚拟路径(压缩包内等)没有本机文件可查元数据
      }

      // 标识/安全:只在桌面版 + 新版 preload 下可用;失败静默降级,不弹错误
      if (metaApi) {
        setMetaLoading(true)
        void metaApi
          .execMeta(native)
          .then((m) => {
            if (!alive) return
            setMetaLoading(false)
            if (m && !m.error) setMeta(m)
          })
          .catch(() => {
            if (alive) setMetaLoading(false)
          })
      }

      if (!launch) return
      try {
        const [results, iconUrl] = await Promise.all([
          launch.execProbe([native]).then((r) => r[0] ?? null),
          launch.execIcon({ path: native, size: 'large' }),
        ])
        if (!alive) return
        setProbe(results)
        setIcon(iconUrl)
      } catch {
        /* 探测失败保持静默,基础信息仍可用 */
      }
    })()
    return () => {
      alive = false
    }
  }, [entry.path])

  const run = async () => {
    setRunning(true)
    try {
      const launch = nativeLaunch()
      const s = useFs.getState()
      if (!launch || s.provider?.kind !== 'native') return
      const native = (s.provider as unknown as { toNativePath(p: string): string }).toNativePath(entry.path)
      const r = await launch.execRun({ path: native })
      if (r.mode === 'denied') useUi.getState().toast(r.reason || '已取消', 'info')
      else useUi.getState().toast(`已启动 ${entry.name}`, 'success')
    } catch (e) {
      useUi.getState().toast(String((e as Error).message || e), 'error')
    } finally {
      setRunning(false)
    }
  }

  const cat = useFs.getState()
  const isNative = cat.provider?.kind === 'native'
  const levelLabel =
    probe?.level === 2 ? '危险脚本' : probe?.level === 3 ? '快捷方式' : probe?.level === 1 ? '程序' : null

  // 标识四行全空时整组不显示(不占位的「—」)
  const hasIdentity = !!meta && !!(meta.productName || meta.version || meta.publisher || meta.description)
  const showIdentityGroup = metaLoading || hasIdentity

  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 overflow-auto p-8">
      {/* 头部:图标 + 名称 */}
      <div className="flex flex-col items-center gap-2">
        {icon ? (
          <img src={icon} alt="" className="h-16 w-16 rounded-xl" />
        ) : (
          <div className="flex h-16 w-16 items-center justify-center rounded-xl bg-panel2">
            <Loader2 className="h-6 w-6 animate-spin text-txt2" />
          </div>
        )}
        <div className="text-base font-semibold">{entry.name}</div>
        <div className="flex items-center gap-1.5 text-xs text-txt2">
          <span className="rounded bg-panel2 px-1.5 py-0.5">{(entry.ext || 'exec').toUpperCase()} {probe?.level === 1 ? '应用程序' : probe?.level === 2 ? '脚本' : probe?.kind === 'installer' ? '安装包' : '可执行文件'}</span>
          {levelLabel && (
            <span className="rounded bg-panel2 px-1.5 py-0.5">{levelLabel}</span>
          )}
        </div>
      </div>

      {/* 风险提示条 */}
      {probe?.risky && probe.risky.length > 0 && (
        <div className="flex w-full max-w-md items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-500">
          <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <div className="flex flex-wrap gap-x-3 gap-y-1">
            {probe.risky.map((r) => (
              <span key={r}>· {r}</span>
            ))}
          </div>
        </div>
      )}

      {/* 信息区 */}
      <div className="w-full max-w-md divide-y divide-brd rounded-xl border border-brd bg-panel text-[13px]">
        <Row label="类型" value={probe?.kind ? KIND_LABEL[probe.kind] ?? probe.kind : '可执行文件'} />
        <Row label="大小" value={fmtBytes(entry.size)} />
        <Row label="修改时间" value={fmtDate(entry.modified)} />
        {arch && <Row label="架构 / 子系统" value={arch} />}

        {/* 标识:来自主进程的版本资源,取不到(或 error)整组不显示 */}
        {showIdentityGroup && <GroupLabel>标识</GroupLabel>}
        {metaLoading && (
          <div className="flex items-center gap-2 px-4 py-2 text-[12px] text-txt2">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> 正在读取标识与安全信息…
          </div>
        )}
        {meta?.productName && <Row label="产品名" value={meta.productName} />}
        {meta?.version && <Row label="版本" value={meta.version} />}
        {meta?.publisher && <Row label="发布者" value={meta.publisher} />}
        {meta?.description && <Row label="文件说明" value={meta.description} />}

        {/* 安全:签名状态 + 互联网来源标记 */}
        {meta && (
          <>
            <GroupLabel>安全</GroupLabel>
            <Row
              label="签名"
              value={
                <span className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                  {meta.signed === true ? (
                    <>
                      <BadgeCheck className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
                      <span className="text-emerald-500">已签名</span>
                    </>
                  ) : meta.signed === false ? (
                    <>
                      <ShieldAlert className="h-3.5 w-3.5 shrink-0 text-amber-500" />
                      <span className="text-amber-500">未签名</span>
                    </>
                  ) : (
                    <>
                      <ShieldQuestion className="h-3.5 w-3.5 shrink-0 text-txt2" />
                      <span className="text-txt2">未检测</span>
                    </>
                  )}
                  {meta.signer && <span className="break-all text-txt2">{meta.signer}</span>}
                </span>
              }
            />
            {meta.motw && (
              <Row
                label="来源"
                value={
                  <span className="inline-flex items-start gap-1.5 text-amber-500">
                    <Globe className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span>
                      来自互联网,系统可能已阻止首次运行。可在系统文件属性的「安全 / 常规」中解除锁定,本应用暂不支持一键解除。
                    </span>
                  </span>
                }
              />
            )}
          </>
        )}

        <Row label="路径" value={entry.path} mono />
        {probe?.executable === false && (
          <Row label="状态" value="缺少可执行权限,可能无法直接运行" />
        )}
      </div>

      {/* 操作区 */}
      {isNative && (
        <div className="flex items-center gap-2">
          <button
            onClick={() => void run()}
            disabled={running}
            className="flex h-9 items-center gap-2 rounded-lg bg-acc px-5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
          >
            {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
            {probe?.kind === 'installer' ? '安装' : '运行'}
          </button>
          {probe?.kind === 'script' && (
            <div className="flex items-center gap-1 text-[11px] text-txt2">
              <TerminalSquare className="h-3.5 w-3.5" /> 脚本将在终端/关联程序中运行
            </div>
          )}
        </div>
      )}
      {!isNative && (
        <div className="flex items-center gap-2 text-xs text-txt2">
          <AlertTriangle className="h-4 w-4" /> 浏览器版不支持运行程序,仅展示信息
        </div>
      )}
      <div className="text-[11px] leading-relaxed text-txt2 opacity-70">
        运行前会进行安全确认;按住 Alt 双击可随时回到本页
      </div>
    </div>
  )
}

const KIND_LABEL: Record<string, string> = {
  exe: '可执行程序',
  msi: 'Windows 安装包',
  script: '脚本',
  lnk: '快捷方式',
  url: 'URL 快捷方式',
  desktop: '启动器入口',
  app: '应用 Bundle',
  installer: '安装包',
  elf: '可执行文件',
  dir: '目录',
  other: '文件',
}

function Row({ label, value, mono }: { label: string; value: ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-start gap-3 px-4 py-2">
      <span className="w-24 shrink-0 text-txt2">{label}</span>
      <span className={`min-w-0 flex-1 break-all ${mono ? 'font-mono text-xs' : ''}`}>{value}</span>
    </div>
  )
}

/** 信息区的小分组标题(标识 / 安全) */
function GroupLabel({ children }: { children: ReactNode }) {
  return <div className="bg-panel2/50 px-4 py-1 text-[11px] text-txt2">{children}</div>
}
