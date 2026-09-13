/**
 * Сохранение файла на диск пользователя — одно место на всю программу.
 *
 * Почему нельзя обойтись `<a download>`: окно упакованной программы живёт на
 * `file://`, где загрузка по ссылке молча ничего не делает — в «Загрузках»
 * остаётся пустой `<guid>.tmp`, а на экране при этом бодрое «Сохранено»
 * (аудит 13.09, C13-001, подтверждено на стенде). Поэтому в Electron файл
 * отдаётся мосту `saveReportFile`: нативный диалог, и только его ответ знает,
 * сохранилось ли что-нибудь на самом деле.
 *
 * Успех/отказ/отмена различаются осознанно: «Отмена» в диалоге — не ошибка,
 * но и не повод писать «Сохранено».
 */

export interface SaveFileResult {
  /** Пользователь закрыл диалог сохранения. Ни успеха, ни ошибки. */
  canceled: boolean
  /** Куда сохранили. Только в Electron — в браузере путь неизвестен. */
  path?: string
}

/** Blob → base64 без префикса `data:…;base64,` (мост принимает голый base64). */
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('Не удалось прочитать файл'))
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '')
    reader.readAsDataURL(blob)
  })
}

/**
 * Сохранить файл: в Electron — диалогом, в браузере — ссылкой.
 * Бросает `Error` с текстом от main-процесса, если сохранить не удалось.
 */
export async function saveFileToUser(
  fileName: string,
  content: Blob | string,
  mime = 'application/json;charset=utf-8',
): Promise<SaveFileResult> {
  // Строку заворачиваем в Blob, а не кодируем сами: `btoa` не умеет кириллицу,
  // а FileReader даёт корректный UTF-8 без плясок с `unescape`.
  const blob = typeof content === 'string' ? new Blob([content], { type: mime }) : content

  const bridge = window.appConfig?.saveReportFile
  if (bridge) {
    const result = await bridge({ fileName, base64: await blobToBase64(blob) })
    if (result.canceled) return { canceled: true }
    if (!result.ok) throw new Error(result.error || 'Не удалось сохранить файл')
    return { canceled: false, path: result.path }
  }

  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  document.body.appendChild(a)
  a.click()
  a.remove()
  // Освобождаем с задержкой: синхронный revoke сразу после click() успевает
  // оборвать уже начавшуюся загрузку.
  setTimeout(() => URL.revokeObjectURL(url), 1000)
  return { canceled: false }
}
