const { contextBridge, ipcRenderer } = require('electron')

// Адрес сервера приходит из main через аргумент запуска (--server-url=...).
const arg = process.argv.find((a) => a.startsWith('--server-url='))
const serverUrl = arg ? arg.slice('--server-url='.length) : ''

// Renderer (React-клиент) читает это в src/config.ts.
contextBridge.exposeInMainWorld('appConfig', {
  serverUrl,
  openSettings: () => ipcRenderer.send('open-settings'),
})
