/** 跨组件共享的内部拖拽数据(当前拖动的条目路径) */
let dragPayload: string[] | null = null

export function setDragPayload(paths: string[] | null) {
  dragPayload = paths
}

export function getDragPayload(): string[] | null {
  return dragPayload
}
