const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('settingsApi', {
  get: () => ipcRenderer.invoke('config:get'),
  test: (url) => ipcRenderer.invoke('config:test', url),
  apply: (payload) => ipcRenderer.invoke('config:apply', payload),
})
