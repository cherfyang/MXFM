import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'

// 开发期:把未被捕获的错误直接渲染到页面,便于自动化排查
if (import.meta.env.DEV) {
  const show = (msg: string) => {
    let el = document.getElementById('__errbox')
    if (!el) {
      el = document.createElement('pre')
      el.id = '__errbox'
      el.style.cssText =
        'position:fixed;top:0;left:0;right:0;z-index:99999;background:#7a1010;color:#fff;font-size:11px;white-space:pre-wrap;max-height:45vh;overflow:auto;margin:0;padding:8px'
      document.body.appendChild(el)
    }
    el.textContent += msg + '\n\n'
  }
  window.addEventListener('error', (e) => show('ERR: ' + e.message + '\n' + (e.error?.stack ?? '')))
  window.addEventListener('unhandledrejection', (e) =>
    show('REJ: ' + String((e.reason && ((e.reason as Error).stack || (e.reason as Error).message)) || e.reason))
  )
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
