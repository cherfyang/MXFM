import { create } from 'zustand'

export type ToastKind = 'info' | 'success' | 'error'

export interface Toast {
  id: number
  kind: ToastKind
  msg: string
}

export interface ConfirmDialog {
  type: 'confirm'
  title: string
  message: string
  danger?: boolean
  okText?: string
  onOk(): void
}

export interface PromptDialog {
  type: 'prompt'
  title: string
  label: string
  initial: string
  okText?: string
  validate?(value: string): string | null
  onOk(value: string): void
}

export interface ConflictDialog {
  type: 'conflict'
  count: number
  onChoose(mode: 'overwrite' | 'skip' | 'keepBoth'): void
}

export interface MemoryDialog {
  type: 'memory'
}

export interface ShortcutsDialog {
  type: 'shortcuts'
}

/** 回收站对话框(内容由 TrashDialog 组件渲染,store 只负责开关) */
export interface TrashDialog {
  type: 'trash'
}

export type DialogState = ConfirmDialog | PromptDialog | ConflictDialog | MemoryDialog | ShortcutsDialog | TrashDialog

export type MenuItem =
  | { sep: true }
  | {
      sep?: false
      label: string
      icon?: React.ReactNode
      danger?: boolean
      disabled?: boolean
      /** 有子菜单时 onClick 可省略(渲染层负责展开) */
      children?: MenuItem[]
      onClick?(): void
    }

interface UiState {
  toasts: Toast[]
  dialog: DialogState | null
  menu: { x: number; y: number; items: MenuItem[] } | null
  toast(msg: string, kind?: ToastKind): void
  dismissToast(id: number): void
  showDialog(d: DialogState): void
  closeDialog(): void
  openMenu(x: number, y: number, items: MenuItem[]): void
  closeMenu(): void
}

let toastSeq = 1

export const useUi = create<UiState>()((set, get) => ({
  toasts: [],
  dialog: null,
  menu: null,
  toast: (msg, kind = 'info') => {
    const id = toastSeq++
    set({ toasts: [...get().toasts, { id, kind, msg }] })
    setTimeout(() => get().dismissToast(id), 3200)
  },
  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
  showDialog: (dialog) => set({ dialog }),
  closeDialog: () => set({ dialog: null }),
  openMenu: (x, y, items) => set({ menu: { x, y, items } }),
  closeMenu: () => set({ menu: null }),
}))
