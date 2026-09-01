/**
 * 外挂字幕工具:目前只做 SRT → WebVTT 的纯文本转换。
 * .ass/.ssa 需要 WASM 渲染器,本轮不支持(VideoViewer 只给提示)。
 */

/**
 * SRT 文本 → WebVTT 文本:
 * - 去 BOM、统一换行
 * - 时间戳的逗号换成点(00:00:01,000 → 00:00:01.000),只匹配 HH:MM:SS,mmm 形态,正文不受影响
 * - SRT 的序号行是合法的 VTT cue 标识符,无需删除
 * - 若源文件本来就是 WEBVTT(扩展名骗人),原样返回
 */
export function srtToVtt(text: string): string {
  const body = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim()
  if (/^WEBVTT/i.test(body)) return `${body}\n`
  const cues = body.replace(/(\d{1,2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2')
  return `WEBVTT\n\n${cues}\n`
}
