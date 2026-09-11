const { contextBridge, ipcRenderer } = require('electron')

// Мост для окна «Настройка системы» (settings.html). Контракт IPC — в main.js.
contextBridge.exposeInMainWorld('settingsApi', {
  get: () => ipcRenderer.invoke('config:get'),
  pickFolder: (title) => ipcRenderer.invoke('config:pickFolder', title),
  test: (url) => ipcRenderer.invoke('config:test', url),
  // Поиск хоста в локальной сети (UDP-широковещание) — чтобы не искать IP руками
  discover: () => ipcRenderer.invoke('config:discover'),
  apply: (payload) => ipcRenderer.invoke('config:apply', payload),
  // Проверить прямо здесь, что копия в выбранную папку пишется
  backupNow: () => ipcRenderer.invoke('system:backupNow'),
})
