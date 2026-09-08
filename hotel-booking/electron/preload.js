const { contextBridge, ipcRenderer } = require('electron')

// Адрес сервера и версия приложения приходят из main аргументами запуска
// (--server-url=..., --app-version=...; см. additionalArguments в createMainWindow).
function argValue(name) {
  const prefix = `--${name}=`
  const arg = process.argv.find((a) => a.startsWith(prefix))
  return arg ? arg.slice(prefix.length) : ''
}
const serverUrl = argValue('server-url')
const appVersion = argValue('app-version')

// Renderer (React-клиент) читает это в src/config.ts.
// openSystemSettings(password) → Promise<{ ok: boolean; error?: string }>:
// окно «Настройка системы» открывается только по паролю сисадмина
// (хранится локально в config.json, сервер для этого не нужен).
// checkForUpdates / downloadUpdate / installUpdate — обновления (IPC update:* в main.js);
// onUpdateStatus(cb) подписывает на 'update:status' и возвращает функцию отписки.
contextBridge.exposeInMainWorld('appConfig', {
  serverUrl,
  isElectron: true,
  appVersion,
  openSystemSettings: (password) => ipcRenderer.invoke('system:openSettings', password),
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  // Отчёты: PDF печатается из этого же окна (те же @media print стили),
  // готовые xlsx/docx/csv сохраняются через диалог main-процесса — на file://
  // обычная загрузка по ссылке не работает.
  saveReportPdf: (options) => ipcRenderer.invoke('report:savePdf', options),
  saveReportFile: (payload) => ipcRenderer.invoke('report:saveFile', payload),
  // Перенос на новый ноутбук: выбор файла копии нативным диалогом.
  // В браузере тот же экран берёт файл через <input type="file"> — здесь так
  // нельзя: File из Electron не отдаёт путь, а имя файла нужно серверу.
  // → { path, name, content } | null (отмена или файл больше 200 МБ)
  pickBackupFile: () => ipcRenderer.invoke('backup:pickFile'),
  onUpdateStatus: (cb) => {
    const handler = (_event, status) => cb(status)
    ipcRenderer.on('update:status', handler)
    return () => ipcRenderer.removeListener('update:status', handler)
  },
})
