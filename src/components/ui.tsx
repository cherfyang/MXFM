import type { ButtonHTMLAttributes } from 'react'

export function IconBtn({
  title,
  active,
  className = '',
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean }) {
  return (
    <button
      title={title}
      className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-txt transition-colors hover:bg-hover disabled:pointer-events-none disabled:opacity-35 ${
        active ? 'bg-hover text-acc' : ''
      } ${className}`}
      {...rest}
    >
      {children}
    </button>
  )
}

export function Btn({
  variant = 'default',
  className = '',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'default' | 'primary' | 'danger' }) {
  const styles = {
    default: 'bg-panel2 text-txt border border-brd hover:bg-hover',
    primary: 'bg-acc text-white hover:opacity-90 border border-transparent',
    danger: 'bg-danger text-white hover:opacity-90 border border-transparent',
  }
  return (
    <button
      className={`inline-flex h-8 items-center justify-center gap-1.5 rounded-md px-3 text-sm disabled:pointer-events-none disabled:opacity-40 ${styles[variant]} ${className}`}
      {...rest}
    />
  )
}
