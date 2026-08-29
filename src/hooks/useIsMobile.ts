import { useEffect, useState } from 'react'

/** 触屏/窄屏判定(响应式) */
export function useIsMobile(breakpoint = 820): boolean {
  const [mobile, setMobile] = useState(() => window.innerWidth < breakpoint)
  useEffect(() => {
    const on = () => setMobile(window.innerWidth < breakpoint)
    window.addEventListener('resize', on)
    return () => window.removeEventListener('resize', on)
  }, [breakpoint])
  return mobile
}
