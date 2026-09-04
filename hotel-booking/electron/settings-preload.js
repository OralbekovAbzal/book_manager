const { contextBridge, ipcRenderer } = require('electron')

// Мост для окна «Настройка системы» (settings.html). Контракт IPC — в main.js.
contextBridge.exposeInMainWorld('settingsApi', {
  get: () => ipcRenderer.invoke('config:get'),
  pickFolder: (title) => ipcRenderer.invoke('config:pickFolder', title),
  test: (url) => ipcRenderer.invoke('config:test', url),
  apply: (payload) => ipcRenderer.invoke('config:apply', payload),
})
