import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './App'
// Geist шрифты — бандлятся локально (offline-safe для упакованного Electron),
// не тянутся с Google Fonts CDN.
import '@fontsource-variable/geist'
import '@fontsource-variable/geist-mono'
import './theme.css'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
