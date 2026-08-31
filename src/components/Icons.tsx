import {
  BookOpen,
  Folder,
  FileText,
  FileCode,
  FileSpreadsheet,
  FileImage,
  Film,
  Music,
  FileArchive,
  FileType,
  Presentation,
  Binary,
  type LucideIcon,
} from 'lucide-react'
import type { Category } from '../utils/categories'

const MAP: Record<Category, { C: LucideIcon; color: string }> = {
  folder: { C: Folder, color: 'text-acc' },
  image: { C: FileImage, color: 'text-emerald-500' },
  video: { C: Film, color: 'text-violet-400' },
  audio: { C: Music, color: 'text-pink-400' },
  markdown: { C: FileText, color: 'text-sky-400' },
  pdf: { C: FileType, color: 'text-red-400' },
  csv: { C: FileSpreadsheet, color: 'text-green-500' },
  excel: { C: FileSpreadsheet, color: 'text-green-500' },
  word: { C: FileType, color: 'text-blue-400' },
  ppt: { C: Presentation, color: 'text-orange-400' },
  legacy: { C: FileType, color: 'text-amber-400' },
  zip: { C: FileArchive, color: 'text-amber-400' },
  ebook: { C: BookOpen, color: 'text-teal-400' },
  code: { C: FileCode, color: 'text-cyan-400' },
  text: { C: FileText, color: 'text-txt2' },
  binary: { C: Binary, color: 'text-txt2' },
}

export function EntryIcon({ category, className = 'h-4 w-4' }: { category: Category; className?: string }) {
  const { C, color } = MAP[category]
  return <C className={`${className} shrink-0 ${color}`} strokeWidth={1.8} />
}
