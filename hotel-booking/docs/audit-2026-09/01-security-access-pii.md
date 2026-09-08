# Аудит 2026-09 · Направление 1 — Безопасность, доступ, персональные данные

- **Коммит:** `a39c57c` · **Дата аудита:** 2026-09-07 · **База для SQL:** `hotel_booking` (localhost:5432, только SELECT через MCP `postgres`)
- **Бюджет (что прочитано целиком):** все 23 файла `server/src/routes/*.js`; `middleware/{auth,audit,errorHandler,license,validate}.js`; `app.js`, `server.js`; `utils/{corsOrigin,passwordPolicy,sessions,license,logger,prisma}.js`; `controllers/{auth,setup,user,license,guest}Controller.js`; `socket/socketManager.js`; `electron/{preload,settings-preload}.js`, `electron/settings.html`; `electron/main.js` — конфиг и секреты (:1-130), env сервера (:350-400), окна (:489-550), обновления (:560-660), IPC (:660-870), жизненный цикл (:870-899); клиент — `api/client.ts`, `store/useAuthStore.ts`, `hooks/useSocket.ts`, `config.ts`, `index.html`, `App.tsx` (загрузка/гейт, :84-200), `Login/Login.tsx` (:1-60), `BookingGrid/BookingContextMenu.tsx`.
  **Фрагментами (целевые места):** `bookingController.js` (update/cancel/actual-times :395-640, `BOOKING_SELECT` :154-200, `list`), `paymentController.js` (debts/create/refund :182-352), `utils/backup.js` (модели :100-160, план и оценка :400-520, `readDump`/`restoreBackup` :555-700, `setval` :740-760), `utils/snapshot.js` (:70-90, :520-540), `occupancyController.js` (grid/поиск :20-140), `rateController.js` (:80-180), `roomFundController.js` (:225-260), `reportController.js` (:84-130), `bookingFlagController.js`, `categoryController.update`, `roomController.update`, `hotelController.get`, `reports/definitions/*.json` и `reports/datasets/*.js` (grep по полям гостя), `electron/package.json` (build), `prisma/seed.js`, `electron/db/seed.sql`, `.env.example`, `.gitignore`.
  Итого ≈ 6 000 строк кода + 6 SELECT к dev-базе + подсчёты по `server/logs/combined.log` (только `grep -c`, содержимое не выводилось) + офлайн-сверка хеша `admin` с известными паролями по умолчанию (`bcryptjs.compareSync`, без обращения к API).
- **Запреты плана соблюдены:** ни одной записи в репозиторий кроме этого файла; ни `db:seed`, ни `migrate`, ни `logout`/смены пароля, ни восстановления; сервер не запускался.
- **Сводка:** 21 находка — тяжесть **1: 1** (D1-001), **2: 4** (D1-002…D1-005), **3: 12** (D1-006…D1-017), **4: 4** (D1-018…D1-021).
  Главный вывод по модели прав: **всё, что клиент прячет от STAFF, сервер тоже запрещает** (расхождений «клиент прячет — сервер пускает» не найдено). Проблема обратная: сервер пускает STAFF к деньгам, возвратам, снимкам и массовой выгрузке ПД, и это нигде не записано как решение.

---

## 1. Находки (по убыванию тяжести)

### D1-001 · [Тяжесть 1] Публичный `POST /api/setup/complete` перезаписывает главного администратора, как только пропадает отметка `setupCompletedAt`
- Направление: 1 · Класс: доступ
- Окружение: оба
- Где: `server/src/controllers/setupController.js:53-54` (единственный гейт — `needsSetup`), `:71-74` (берётся SUPER_ADMIN с минимальным `id`, `isActive` не учитывается), `:114-117` (этой записи переписываются логин, имя и пароль), `:127-130` (выдаётся токен); `server/src/routes/setup.js:53-54` и `server/src/app.js:90` (без `authenticate`); `server/src/utils/backup.js:409-413` (таблица, которой нет в файле, → `rowsByTable[name] = []`), `:496-503` (`emptiedTables`), `:685-693` (`deleteMany` всех present-таблиц и вставка пустого списка); `client/src/App.tsx:104,190` («мастер важнее сохранённой сессии»).
- Что: защита публичного мастера — одно поле `HotelSettings.setupCompletedAt`. Любой сценарий, где оно становится `NULL` или строка `id=1` исчезает, открывает всем, кто видит порт 3001 в сети отеля, возможность одним POST без пароля переименовать существующего SUPER_ADMIN, задать ему свой пароль и получить рабочий токен.
- Сценарий (гипотеза): (а) SUPER_ADMIN восстанавливает копию, в которой нет таблицы `HotelSettings` (старый формат / файл другой версии): `restoreBackup` предупреждает про `emptiedTables`, после `allowDataLoss: true` строка удаляется → `needsSetup = true` → на всех рабочих местах вместо входа появляется мастер; кто первым его прошёл — или кто угодно в Wi-Fi с `curl` — становится владельцем учётки `id=1`; (б) база, настроенная до появления мастера (NOTES: dev, демо) — то же самое постоянно, пока мастер не пройден; (в) две параллельные отправки мастера: обе проходят `needsSetup`, вторая переписывает логин/пароль первой (блокировки нет).
- Проверка: `SELECT "setupCompletedAt" FROM "HotelSettings"` — dev сейчас `2026-09-03 08:54:54` (закрыт). На клоне (напр. 7): `UPDATE "HotelSettings" SET "setupCompletedAt" = NULL`, затем без токена `POST /api/setup/complete {"hotel":{"name":"x"},"mainAdmin":{"username":"attacker","name":"x","password":"Attacker12345"}}` → ожидается 201 с токеном и переименованный `Admin id=1`. Чтение кода: `setupController.js:71-74,114-117`.
- Последствия: захват программы из сети без пароля; законный владелец теряет вход (его логин переименован); мастер, показанный после восстановления законному пользователю, тоже перепишет его учётку, если он его пройдёт.
- Уже известно: нет (fix-waves «мастер имеет приоритет над сохранённой сессией» описывает поведение, но не риск)
- Связано с: D8 (восстановление копий, `emptiedTables`), D7 (прогон на клоне), D1-021
- Уверенность: подтверждено по коду; ветка «копия без `HotelSettings`» — предположение о том, какие именно файлы её не содержат (список таблиц формата v1 вёлся вручную)

### D1-002 · [Тяжесть 2] STAFF проводит возврат денег и «свободный возврат» без администратора
- Направление: 1 · Класс: доступ | деньги
- Окружение: оба
- Где: `server/src/routes/payments.js:22-34` (`POST /` без роли, `kind ∈ {payment, refund}`, `refundOfId` необязателен), `:36-46` (`POST /:id/refund` без роли), `:49-55` (роль только у `void`); `server/src/controllers/paymentController.js:242-297` (`create`: `kind:'refund'` без исходного платежа, сумма ничем не ограничена), `:300-352` (`refund`: ограничен остатком платежа); `client/src/components/Payments/BookingPaymentPanel.tsx:95-107,197-201` (кнопка «Возврат» видна всем ролям и создаёт `kind:'refund'` без `refundOfId`).
- Что: решение `docs/decisions/data-and-money.md:62-63` покрывает приём (STAFF можно) и отмену записи (только ADMIN); возврат не упомянут. Код пускает STAFF к обоим видам возврата, причём «свободный» возврат не ограничен ни суммой принятого, ни ролью.
- Сценарий: сотрудник стойки проводит «возврат 50 000» по брони гостя, который ничего не получал; касса смены сходится с наличными в ящике минус 50 000; в журнале запись есть (`POST /payments`), но подтверждения администратора нет.
- Проверка: под `audit-staff` на клоне `POST /api/payments {"bookingId":N,"amount":50000,"kind":"refund"}` → 201; `SELECT kind, amount, "refundOfId" FROM "Payment" ORDER BY id DESC LIMIT 1`.
- Последствия: деньги наружу под ответственность STAFF; «кто принял» записано, «кто разрешил» — нет.
- Уже известно: нет
- Связано с: D2 (инвариант «возврат ≤ принято» для `kind='refund'` без `refundOfId`), D5/D6 (кнопка «Возврат»)
- Уверенность: подтверждено

### D1-003 · [Тяжесть 2] STAFF правит деньги брони напрямую и удаляет строки начислений; удаление не оставляет в журнале суммы
- Направление: 1 · Класс: доступ | деньги
- Окружение: оба
- Где: `server/src/routes/bookings.js:23` (`totalAmount/prepaidAmount/paidAmount` в PUT для всех), `:27` (`shiftId`), `:139` (PUT без роли), `:178-184` (CRUD начислений без роли); `server/src/controllers/bookingController.js:546-549` (суммы и смена пишутся как пришли), `:1227` (`tx.bookingCharge.delete` — строка удаляется физически, не помечается); `server/src/middleware/audit.js:98` (`details` = тело запроса; у DELETE тело пустое → деталей нет). Dev-база: запись `DELETE /bookings/140/charges/18` — `details = NULL`.
- Что: любой вошедший может выставить `paidAmount` / `totalAmount` / `discountPercent` / `shiftId` любым числом и удалить любую строку начисления, включая автоматическое «проживание». Клиент делает `paidAmount` read-only только при наличии платежей — роль здесь ни при чём.
- Сценарий: STAFF удаляет строку «Проживание 120 000», бронь становится «начислено 0 / долг 0»; в журнале — «DELETE /bookings/140/charges/18» без названия и суммы; восстановить, что именно удалили, можно только из снимка. Перенос брони в чужую смену (`shiftId`) искажает отчёт по сменам.
- Проверка: `SELECT action, details FROM "AuditLog" WHERE action LIKE 'DELETE /bookings/%/charges/%'` → `details` пуст. Под STAFF: `PUT /api/bookings/:id {"paidAmount": 999999}` → 200.
- Последствия: искажение долгов и кассы без следа.
- Уже известно: NOTES «Поле «Оплачено» в брони теперь только для чтения, если у брони есть платежи» — клиентская защита без роли; `docs/decisions/data-and-money.md:116-126` («возможность убрать строку» — по замыслу, но роль не оговорена)
- Связано с: D2 (`paidAmount` через PUT), D3 (`shiftId`), D5
- Уверенность: подтверждено

### D1-004 · [Тяжесть 2] Персональные данные в `combined.log` и `host-debug.log`: каждый запрос пишется с query-строкой, ротации нет
- Направление: 1 · Класс: ПД
- Окружение: оба (в упаковке `LOG_PATH = %APPDATA%\…\logs`, `main.js:358,375`; плюс stdout сервера целиком уходит в `host-debug.log` — `main.js:378-379`)
- Где: `server/src/app.js:44-47` (`logger.info(\`${req.method} ${req.url}\`)`), `server/src/middleware/errorHandler.js:4` (то же в `error.log`), `server/src/utils/logger.js:12-24` (Console + два File-транспорта без `maxsize`/ротации), `occupancyController.js:33` (`guestSearch`), `guestController.js:355` (`phone`), `paymentController.js:184` (`q`).
- Что: ФИО и телефоны гостей из поиска по шахматке, подстановки документа и поиска долгов навсегда оседают в открытых текстовых файлах. Dev: `server/logs/combined.log` — 2,3 МБ, 20 864 строки, из них 92 с `guestSearch=` и 12 с `lookup?phone=`.
- Сценарий: год работы стойки → десятки тысяч строк с именами и телефонами в двух логах, которые при обращении в поддержку пересылают разработчику целиком; файлы никогда не чистятся.
- Проверка: `grep -c "guestSearch=\|lookup?phone=\|debts?q=" server/logs/combined.log` (dev: 104); код `app.js:45`, `main.js:378`.
- Последствия: неучтённая копия ПД вне базы; пересылка логов = пересылка ПД.
- Уже известно: план аудита (зацепка); напр. 8 — «`combined.log`/`host-debug.log` без ротации» как эксплуатационная проблема
- Связано с: D8 (ротация логов), D9
- Уверенность: подтверждено

### D1-005 · [Тяжесть 2] Сокет переживает срок жизни токена и раздаёт документы гостей всем подключённым
- Направление: 1 · Класс: ПД | доступ
- Окружение: оба
- Где: `server/src/socket/socketManager.js:88-119` (проверка только на handshake), `:54-69` (перепроверка раз в 5 мин — `isActive` и `tokenVersion`, но не `exp` токена); `server/src/controllers/bookingController.js:154-167` (`BOOKING_SELECT` с `guestDocNumber`, `guestBirthDate` и комментарием «уходит в socket-события»), `socketManager.js:172-184` (broadcast всем в комнате `bookings`).
- Что: установленное соединение живёт, пока его не разорвут; истечение JWT (8 ч) его не закрывает. Все подключённые, любой роли, получают полный payload каждой изменённой брони, включая паспортные данные.
- Сценарий: токен скопирован (DevTools в проде — D1-011) → на другой машине открыт сокет → после истечения токена REST закрыт, а поток `booking:*` с ФИО, телефоном и номером документа идёт до выхода/смены пароля владельца токена или рестарта сервера.
- Проверка: на клоне выставить `JWT_EXPIRES_IN=20s`, открыть сокет, через минуту создать бронь — событие приходит.
- Последствия: обход срока действия токена для realtime-канала; документы гостей в широковещательной рассылке.
- Уже известно: нет (NOTES «Сокет не проверял `isActive`» — закрыт, про другое)
- Связано с: D3 (realtime), D1-011, D1-013
- Уверенность: подтверждено по коду (`exp` после handshake не проверяется); сценарий — предположение

### D1-006 · [Тяжесть 3] Массовые каналы ПД без роли и без следа: `GET /guests`, запуск/выгрузка отчётов, `GET /payments/debts`
- Направление: 1 · Класс: ПД
- Окружение: оба
- Где: `server/src/routes/guests.js:9-19` (комментарий «права не ограничиваем»), `server/src/controllers/guestController.js:168-183,255-258` (вся книга с `document` у каждого гостя за всю историю); `server/src/routes/reports.js:20-23` (`run`/`export` без роли), `server/src/middleware/audit.js:24` (`run`/`export` исключены из журнала); `server/src/reports/definitions/{bookings-registry,debts}.json:72-75` (`guestPhone` в колонках), `server/src/reports/datasets/bookings.js:36-37,74` (`guestPhone`, `notes` доступны конструктору); `server/src/routes/payments.js:12-18`.
- Что: STAFF одним запросом получает адресную книгу всех постояльцев с номерами документов и датами рождения; выгрузка «Реестра броней» с телефонами в xlsx нигде не фиксируется. Решение «смотреть и выгружать — все» (`reports.md:88-90`) принято 03.09 — до появления документов гостей (06.09).
- Сценарий: увольняющийся сотрудник выгружает реестр за три года; следа нет.
- Проверка: под STAFF `GET /api/guests` → `data.guests[].document.guestDocNumber`; `POST /api/reports/bookings-registry/export {"format":"xlsx"}` → 200; `SELECT count(*) FROM "AuditLog" WHERE action LIKE '%/export%'` → 0.
- Последствия: неотслеживаемая массовая выгрузка ПД любой ролью.
- Уже известно: `docs/decisions/reports.md:88-90` (решение, принятое до документов гостей); комментарий в `routes/guests.js`
- Связано с: D4 (экспорт), D6 (вкладка «Гости»)
- Уверенность: подтверждено

### D1-007 · [Тяжесть 3] `AuditLog.details` копит документы гостей без срока хранения
- Направление: 1 · Класс: ПД | гигиена
- Окружение: оба
- Где: `server/src/middleware/audit.js:26,38-48,98` (вырезаются только `password/currentPassword/newPassword`, остальное тело целиком — в `details`); `schema.prisma` `AuditLog` — TTL нет; `auditLog.deleteMany` в `server/src` отсутствует (grep пуст).
- Что: `guestDocNumber`, `guestBirthDate`, `guestPhone`, `notes` из каждого POST/PUT брони живут в журнале вечно. Dev-база: 189 записей (03.09–05.09), 4 с номером документа, 2 с датой рождения — документы вводили один день.
- Сценарий: ошибочно вписанный чужой документ исправлен в брони — в журнале остаётся; за сезон таблица становится второй базой паспортов.
- Проверка: `SELECT count(*) FROM "AuditLog" WHERE coalesce(details->>'guestDocNumber','') <> ''`.
- Последствия: копия ПД растёт без ретеншна и попадает в резервные копии.
- Уже известно: план аудита (зацепка)
- Связано с: D8 (ретеншн таблиц), D2
- Уверенность: подтверждено

### D1-008 · [Тяжесть 3] `authLimiter` 20/15 мин считает все `/api/auth/*`, включая `/auth/me` при каждом запуске
- Направление: 1 · Класс: доступность
- Окружение: упаковка (`NODE_ENV=production`, `main.js:373`)
- Где: `server/src/app.js:49-53,68`; `client/src/store/useAuthStore.ts:60-64` (`restore` → `/auth/me` при каждом старте и перезагрузке), `client/src/api/client.ts:60-63` (401 → `reload()` → снова `restore`).
- Что: лимит задуман против подбора пароля, но считает и успешные входы, `/me`, `/logout` (`skipSuccessfulRequests` по умолчанию выключен). 20 обращений с IP за 15 минут — это ~6 перезапусков программы плюс несколько неверных паролей на пересменке.
- Сценарий: сотрудник забыл пароль — 8 попыток; администратор входит проверить — 2; перезапуск программы — по `/me` на каждый… рабочее место получает 429 на `/auth/me` (токен остаётся, показывается вход) и на `/auth/login` на 15 минут.
- Проверка: 21 × `GET /api/auth/me` с одного IP при `NODE_ENV=production` → 429.
- Последствия: блокировка рабочего места на 15 минут в пиковый момент.
- Уже известно: план (зацепка); `audits-2026-06` «rate-limit на /api/auth (20/15мин в проде)» — как «ОК»
- Связано с: D5 (перезагрузка по 401), D7, D1-016
- Уверенность: подтверждено по коду; частота срабатывания — предположение

### D1-009 · [Тяжесть 3] Сотрудник не может сменить свой пароль: у `POST /auth/change-password` нет клиента; все пароли известны SUPER_ADMIN
- Направление: 1 · Класс: доступ | гигиена
- Окружение: оба
- Где: `server/src/routes/auth.js:23` (эндпоинт есть); `client/src` — вызовов `change-password`/`changePassword` нет (grep = 0); `server/src/routes/users.js:50` (`PATCH /users/:id/password` — единственный путь, только SUPER_ADMIN).
- Что: пароль сотруднику задаёт и знает главный администратор; журнал приписывает действия STAFF, но неотказуемости нет.
- Проверка: `grep -rn change-password client/src` → пусто.
- Последствия: «это не я, пароль знал админ» — журнал не защищает ни сотрудника, ни владельца.
- Уже известно: план (напр. 5, зацепка)
- Связано с: D5, D6, D1-013
- Уверенность: подтверждено

### D1-010 · [Тяжесть 3] Пробелы в проверке входных данных: TypeError → 500, строки без лимита
- Направление: 1 · Класс: гигиена
- Окружение: оба
- Где: `routes/categories.js:17` + `categoryController.js:42` (`name.trim()` без проверки типа); `routes/rooms.js:32` + `roomController.js:164-166` (`number.trim()`, `building.trim()`); `routes/partners.js:10-11`; `routes/allotments.js:10`; `routes/bookingFlags.js:8-10` (`effects` нормализуются, `label`/`color` без лимитов); `routes/services.js` (express-validator не подключён); `routes/snapshots.js:21` (`label` без лимита → `Snapshot.label` любого размера, доступно STAFF); `routes/occupancy.js:39-40` (`optimize`/`apply` — тело без схемы); `routes/auth.js:12` (`password` без `isString` → `bcrypt.compare` бросает на числе → 500).
- Что: там, где нет `validate`, число или объект вместо строки роняет обработчик в 500 «Внутренняя ошибка сервера», а строки без лимита уходят в базу как есть.
- Проверка: под ADMIN `PUT /api/categories/1 {"name": 5}` → 500; `POST /api/auth/login {"username":"admin","password":123}` → 500.
- Последствия: шум в `error.log`, невнятные ошибки в интерфейсе, раздувание таблиц.
- Уже известно: план (зацепка «Без validate»)
- Связано с: D9 (нет тестов на роуты)
- Уверенность: подтверждено

### D1-011 · [Тяжесть 3] Renderer Electron без CSP, с DevTools в проде, без `will-navigate`, `shell.openExternal` для любой схемы, перебор пароля сисадмина по IPC без лимита
- Направление: 1 · Класс: гигиена | доступ
- Окружение: упаковка
- Где: `client/index.html` (meta CSP нет; helmet на `file://` не действует); `electron/main.js:516` (`setWindowOpenHandler` → `shell.openExternal(url)` без проверки схемы), `:522-534` (F12 → DevTools и в проде), `will-navigate` не обрабатывается (grep по `main.js` пуст), `:806-812` (`system:openSettings` — без ограничения попыток; scrypt по умолчанию — десятки мс на попытку), `electron/package.json:64-71` (подписи кода нет, `publish` — placeholder).
- Что: слоёв защиты меньше, чем принято для Electron. Сегодня единственная преграда от XSS — экранирование React (это в порядке: `dangerouslySetInnerHTML|innerHTML|srcdoc|document.write` в `client/src` = 0, пользовательских `href` = 0). Если XSS появится (например, при будущем рендере отчётов/печати HTML-ом), из неё: чтение `localStorage.token`, перебор пароля сисадмина через IPC (~20 попыток/с), смена `updateUrl` → установка неподписанного «обновления» (electron-updater на Windows проверяет издателя только у подписанных сборок).
- Сценарий: сегодня — любой у рабочего места нажимает F12 и читает токен вошедшего (см. D1-013); в будущем — цепочка XSS → сисадмин → обновление.
- Проверка: в упакованной программе F12 → DevTools открываются; `Application → Local Storage → token`.
- Последствия: сегодня — копирование сессии; при XSS — до выполнения кода на хосте.
- Уже известно: план (зацепка «Electron: CSP нет…»)
- Связано с: D8 (обновления без подписи, EOL Electron 31), D6 (печать), D1-013
- Уверенность: подтверждено (отсутствие защит); цепочка — предположение

### D1-012 · [Тяжесть 3] Открытый HTTP между клиентами и хостом в Wi-Fi отеля
- Направление: 1 · Класс: ПД | доступ
- Окружение: упаковка (режим «клиент»)
- Где: `electron/main.js:369` (`HOST: '0.0.0.0'` всегда), `:685-689` (`normalizeServerUrl` подставляет `http://`), `electron/settings.html:109-112` (подсказка «http://192.168.1.50:3001»), `client/src/config.ts` (`API_BASE`/`SOCKET_URL` без TLS), `client/src/api/client.ts:28-31` (Bearer в заголовке).
- Что: JWT (живёт 8 ч) и все данные гостей ходят открытым текстом. `docs/decisions/desktop-and-ops.md:6-9` — «только внутри LAN/Wi-Fi гостиницы»; что гости в этой сети не сидят, нигде не записано, установщик об этом не спрашивает.
- Сценарий: гостевой и служебный Wi-Fi — одна сеть (типично для базы отдыха); ноутбук гостя с Wireshark/ARP-spoof видит токен администратора и паспорта соседей по корпусу.
- Проверка: Wireshark на клиентской машине: `Authorization: Bearer …` и JSON броней в открытом виде.
- Последствия: перехват сессии и ПД без взлома программы.
- Уже известно: `docs/decisions/desktop-and-ops.md` (LAN-модель — решение)
- Связано с: D8 (сеть, брандмауэр, `listen_addresses` Postgres)
- Уверенность: подтверждено (архитектура); устройство сети отеля — вопрос владельцу

### D1-013 · [Тяжесть 3] Общее рабочее место: токен на весь origin, автовход, нет блокировки по бездействию
- Направление: 1 · Класс: доступ
- Окружение: оба
- Где: `client/src/store/useAuthStore.ts:36,60-66` (`restore` по сохранённому токену), `client/src/api/client.ts:28-31`; в Electron у всего приложения один origin `file://`; `electron/main.js:522-534` (F12).
- Что: если предыдущий сотрудник не нажал «Выйти», следующий работает под его учёткой до 8 ч; администратор, отошедший от стойки, оставляет на общем ноутбуке сессию ADMIN; DevTools позволяют унести токен на другую машину (до выхода владельца — отзыв сессий сделан 07.09 и работает).
- Сценарий: утренний STAFF садится за ноутбук, где ночью работал ADMIN → правит тарифы/отменяет платежи под именем ADMIN.
- Проверка: войти ADMIN, закрыть окно без выхода, открыть снова → шахматка без входа.
- Последствия: журнал действий приписывает действия не тому человеку.
- Уже известно: план (зацепка про `localStorage`); NOTES «Отзыв JWT» (выход гасит все сессии — если нажать)
- Связано с: D1-009, D1-011, D5, D7
- Уверенность: подтверждено

### D1-014 · [Тяжесть 3] Журнал действий не видит смену/сброс пароля, лицензию, услуги и питание, контакты, метки, ручные снимки
- Направление: 1 · Класс: гигиена | доступ
- Окружение: оба
- Где: `server/src/middleware/audit.js:16-19` (`TRACKED_PREFIXES`), `:33-34` (добавки только `optimize/apply`, `shifts/next-day`, `snapshots/:id/restore`). Не отслеживаются: `POST /auth/change-password`, `POST /auth/logout`, `POST /license` (ввод ключа), `/services` и `/services/meal-plans`, `/contacts`, `/booking-flags`, `/setup`, `POST /snapshots`, `DELETE /snapshots/:id`. `PATCH /users/:id/password` попадает (префикс `/users`) — без деталей, как и должно.
- Что: изменение цен услуг и питания, меток с эффектами буфера (влияют на «свободно» и оптимизатор), удаление снимков и ввод лицензии не оставляют записи «кто и когда».
- Проверка: под ADMIN `PUT /api/services/1 {"price":0}` → в `AuditLog` записи нет.
- Последствия: спор «кто обнулил цену завтрака / удалил снимок» не разрешить.
- Уже известно: план (зацепка)
- Связано с: D2 (цены услуг), D3 (эффекты меток), D1-015
- Уверенность: подтверждено

### D1-015 · [Тяжесть 3] STAFF создаёт ручные снимки и вытесняет чужие точки отката; откат снимков — ADMIN, откат копий — только SUPER_ADMIN
- Направление: 1 · Класс: данные | доступ
- Окружение: оба
- Где: `server/src/routes/snapshots.js:19-25` (POST без роли), `server/src/utils/snapshot.js:72-97` (`pruneByKind`, ручных хранится 20), `client/src/components/Snapshots/SnapshotsModal.tsx:247` (кнопка «Создать снимок» видна всем); `routes/snapshots.js:43` (`restore` c `allowMoneyLoss` — ADMIN+) против `routes/system.js:63` (`backup/restore` — только SUPER_ADMIN).
- Что: 20 нажатий «Создать снимок» под STAFF удаляют все ручные точки отката администратора; операция в журнал не пишется (D1-014). Два «отката всей базы» имеют разную планку прав.
- Проверка: `SELECT kind, count(*) FROM "Snapshot" GROUP BY kind` до и после 21 × `POST /api/snapshots` под STAFF.
- Последствия: потеря точек отката; ADMIN может откатить кассу (с галочкой), хотя копию восстановить не может.
- Уже известно: нет
- Связано с: D8 (снимки/копии)
- Уверенность: подтверждено

### D1-016 · [Тяжесть 3] Логин при входе не приводится к нижнему регистру, а при создании — приводится
- Направление: 1 · Класс: доступность
- Окружение: оба
- Где: `server/src/routes/auth.js:11` (`trim()` без `toLowerCase()`), `server/src/controllers/authController.js:21` (`findUnique({ where: { username } })`), `server/src/routes/users.js:21` и `routes/setup.js:16` (`.toLowerCase()` при создании), `client/src/components/Login/Login.tsx:14,105` (поле как есть).
- Что: «Aigerim» или Caps Lock → «Неверный логин или пароль», хотя учётка `aigerim` существует; сотрудник решает, что пароль сбросили, и жжёт лимит D1-008.
- Проверка: `POST /api/auth/login {"username":"ADMIN","password":<верный>}` → 401.
- Последствия: ложные отказы во входе.
- Уже известно: нет
- Связано с: D5/D6 (экран входа), D1-008
- Уверенность: подтверждено

### D1-017 · [Тяжесть 3] Тайминг входа выдаёт существование логина
- Направление: 1 · Класс: доступ
- Окружение: оба
- Где: `server/src/controllers/authController.js:21-29` (нет пользователя → ответ до `bcrypt.compare`; есть → ~250 мс на cost 12).
- Что: текст ответа одинаков (это в порядке, `audits-2026-06`), но время — нет: перебор логинов возможен по задержке; в проде ограничен лимитером 20/15 мин.
- Проверка: замерить `POST /auth/login` для `nouser` и `admin` с неверным паролем — разница на порядок.
- Последствия: подтверждение логинов сотрудников из сети; практическая ценность низкая (LAN, лимитер).
- Уже известно: `audits-2026-06` — «логин не различает «нет юзера»/«неверный пароль»» верно по тексту, не по времени
- Связано с: D1-008
- Уверенность: подтверждено по коду

### D1-018 · [Тяжесть 4] `JWT_SECRET` не проверяется при старте
- Направление: 1 · Класс: гигиена
- Окружение: dev
- Где: `server/src/controllers/authController.js:12`, `setupController.js:15` (`jwt.sign(…, undefined)` бросает), `middleware/auth.js:17` (`jwt.verify` → 401), `server/server.js` (проверки нет); `electron/main.js:47` (в упаковке генерируется).
- Что: без секрета сервер стартует, вход отвечает 500 «Внутренняя ошибка сервера», обхода нет. Наблюдение.
- Проверка: запустить сервер без `JWT_SECRET` → `/auth/login` 500.
- Уже известно: план (зацепка)
- Уверенность: подтверждено

### D1-019 · [Тяжесть 4] Статус известного (dev): пароль `admin` в dev-базе — по-прежнему `admin123`; `.mcp.json` с паролем БД закоммичен
- Направление: 1 · Класс: гигиена
- Окружение: dev
- Где: dev-база `Admin id=1` — офлайн-сверка хеша `bcryptjs.compareSync`: `admin123` → true, `admin` → false; NOTES 🟡 «Дефолтная учётка admin / admin123 продолжает работать» (открыт); `JWT_SECRET` и `postgres:password` — по NOTES (`server/.env` не читал); корневой `.mcp.json` в git (`git ls-files` → tracked) с `postgresql://postgres:<пароль>@localhost:5432/hotel_booking`.
- Что: всё — dev-окружение; в упаковке секреты генерируются (`ensureSecrets`, `main.js:44-52`). Учётки dev: `admin` (SUPER_ADMIN, `tokenVersion` 3), `abzal` (ADMIN), `claude` (SUPER_ADMIN); все активны, регистр логинов нормальный.
- Уже известно: NOTES 🟡 (три открытых пункта); напр. 9 (`.mcp.json`)
- Уверенность: подтверждено

### D1-020 · [Тяжесть 4] IPC-обработчики окна настроек не проверяют отправителя; `normalizeServerUrl` принимает любую схему
- Направление: 1 · Класс: гигиена
- Окружение: упаковка
- Где: `electron/main.js:661-700,706-798` (`config:get/pickFolder/test/apply` — без проверки `event.sender`), `:685-689` (`ftp://`, `file://` проходят; `new URL()` на `:745` проверяет только синтаксис), `:691-701` (`config:test` делает `fetch` по любому адресу — только от сисадмина).
- Что: практической дыры нет — главный renderer получает только `preload.js` без `settingsApi`, а `sandbox:true` + `contextIsolation:true` не дают добраться до `ipcRenderer`. Рекомендация Electron «validate sender» не выполнена — задел на будущее.
- Проверка: `main.js:661` — обработчик без `e.sender`.
- Уже известно: план (зацепка)
- Уверенность: подтверждено

### D1-021 · [Тяжесть 4] `GET /api/setup/status` и `GET /api/health` — публичные
- Направление: 1 · Класс: гигиена
- Окружение: оба
- Где: `server/src/routes/setup.js:53`, `server/src/app.js:93-95`.
- Что: любой в сети узнаёт название отеля и не пройден ли мастер (это же — разведка для D1-001). `/health` нужен Electron для старта хоста.
- Уверенность: подтверждено

---

## 1а. Матрица «роль × эндпоинт» (все файлы `server/src/routes/*.js`)

Обозначения: ✔ — доступно; — — 403 (`requireRole`); ✔* — роль проверяется в контроллере (403 при условии из примечания); **пуб.** — без `authenticate`. Колонка «Клиент прячет от STAFF» — по grep ролей в `client/src` (файлы перечислены после таблицы). Все `/api/*`, кроме `/health`, `/license`, `/auth/login`, закрыты гейтом 402 при `expired` (`middleware/license.js:24`).

| Эндпоинт | Без входа | STAFF | ADMIN | SUPER_ADMIN | Клиент прячет от STAFF | Примечание |
|---|---|---|---|---|---|---|
| `GET /api/health` | **пуб.** | ✔ | ✔ | ✔ | — | только статус/время |
| `POST /auth/login` | **пуб.** | | | | | `authLimiter` 20/15 мин (prod) — D1-008 |
| `POST /auth/logout` | — | ✔ | ✔ | ✔ | нет | отзыв всех сессий; не в журнале (D1-014) |
| `GET /auth/me` | — | ✔ | ✔ | ✔ | нет | считается лимитером — D1-008 |
| `POST /auth/change-password` | — | ✔ | ✔ | ✔ | **клиента нет** | D1-009; не в журнале |
| `GET /setup/status` | **пуб.** | ✔ | ✔ | ✔ | — | название отеля — D1-021 |
| `POST /setup/complete` | **пуб., пока `setupCompletedAt IS NULL`** | | | | — | **D1-001** |
| `GET/POST /users`, `PUT /users/:id`, `PATCH /users/:id/password` | — | — | — | ✔ | да (раздел только SUPER_ADMIN) | самодеактивация и последний SUPER_ADMIN защищены |
| `GET /license` | — | ✔ | ✔ | ✔ | нет (полоса всем) | ключ наружу не отдаётся |
| `POST /license` | — | — | — | ✔ | да (`licenseUi.tsx:79-93`) | не в журнале (D1-014) |
| `GET /system/status` | — | ✔ | ✔ | ✔ | нет | `SELECT 1` |
| `GET /system/backups`, `POST /system/backup`, `GET /system/backups/:fileName/impact` | — | — | ✔ | ✔ | да (`BackupSection.tsx:357`) | `fileName` — маска + `basename` (в порядке) |
| `POST /system/backup/restore` | — | — | — | ✔ | да (`:358`) | в журнале |
| `GET /snapshots` | — | ✔ | ✔ | ✔ | нет | без `data` |
| `POST /snapshots` | — | ✔ | ✔ | ✔ | **нет** (кнопка всем) | **D1-015**; не в журнале |
| `GET /snapshots/:id/impact`, `POST /snapshots/:id/restore`, `DELETE /snapshots/:id` | — | — | ✔ | ✔ | да (`SnapshotsModal.tsx:99`) | restore ADMIN против backup/restore SUPER — D1-015 |
| `GET /audit/log` | — | — | ✔ | ✔ | да (`AuditWindow.tsx:547`) | `details` с ПД — D1-007 |
| `GET /audit` (сводка денег) | — | ✔ | ✔ | ✔ | нет | `new Date()` локальная — см. §4 |
| `GET /hotel` | — | ✔ | ✔ | ✔ | нет | реквизиты (БИН/IBAN) всем — нужно для печати счёта |
| `PUT /hotel` | — | — | ✔ | ✔ | да (`HotelSection.tsx:85`) | в журнале (16 записей в dev) |
| `GET /bookings`, `GET /bookings/:id` | — | ✔ | ✔ | ✔ | нет | с документами гостя (`BOOKING_SELECT`) |
| `POST /bookings`, `POST /bookings/check-availability` | — | ✔ | ✔ | ✔ | нет | работа стойки |
| `PUT /bookings/:id` | — | ✔* | ✔ | ✔ | частично | 403 STAFF только за `actualCheckInAt/OutAt` (`:419`); деньги/`shiftId` — **D1-003**; закрытая бронь — 400 всем |
| `DELETE /bookings/:id` (= отмена) | — | ✔* | ✔ | ✔ | да (`BookingContextMenu.tsx:52`) | 403 STAFF для `CHECKED_IN` (`:588`) — совпадает с клиентом |
| `PATCH /bookings/:id/checkin`, `/checkout` | — | ✔ | ✔ | ✔ | нет | работа стойки |
| `PATCH /bookings/:id/actual-times` | — | — (контроллер `:617`) | ✔ | ✔ | да (`BookingModal.tsx:847`) | совпадает |
| `POST /bookings/:id/move` | — | ✔ | ✔ | ✔ | нет | стойка |
| `GET /bookings/:id/charges` | — | ✔ | ✔ | ✔ | нет | |
| `POST /bookings/:id/charges`, `PUT/DELETE /:id/charges/:chargeId`, `POST /:id/charges/rebuild` | — | ✔ | ✔ | ✔ | **нет** | **D1-003** (удаление физическое, без деталей в журнале) |
| `GET /allotments` | — | ✔ | ✔ | ✔ | нет | |
| `POST/PUT/DELETE /allotments…`, `POST /allotments/:id/releases`, `DELETE /allotments/releases/:id` | — | — | ✔ | ✔ | (раздел настроек) | POST без `validate` — D1-010 |
| `GET /booking-flags` | — | ✔ | ✔ | ✔ | нет | |
| `POST/PUT/DELETE /booking-flags…` | — | — | ✔ | ✔ | (раздел настроек) | не в журнале — D1-014 |
| `GET /categories` | — | ✔ | ✔ | ✔ | нет | |
| `POST/PUT /categories…` | — | — | ✔ | ✔ | (раздел настроек) | PUT без `validate` — D1-010 |
| `DELETE /categories/:id` | — | — | — | ✔ | | |
| `GET /contacts` | — | ✔ | ✔ | ✔ | нет | телефоны сотрудников — по решению `interface.md:11` |
| `POST /contacts/defaults`, `POST/PUT/DELETE /contacts…` | — | — | ✔ | ✔ | да (`ReferenceWindow.tsx:75`) | не в журнале — D1-014 |
| `GET /guests`, `GET /guests/lookup` | — | ✔ | ✔ | ✔ | нет | вся книга с документами — **D1-006**; `phone` в URL → логи — D1-004 |
| `GET /occupancy/grid`, `/stats`, `/today`, `/availability` | — | ✔ | ✔ | ✔ | нет | `guestSearch` в URL → логи — D1-004 |
| `POST /occupancy/optimize` (расчёт) | — | ✔ | ✔ | ✔ | нет (кнопка-палочка всем) | тяжёлый расчёт по всему фонду, `settings`/`flagEffects` из тела — вопрос §6 |
| `POST /occupancy/optimize/apply` | — | — | ✔ | ✔ | да (`OptimizeModal.tsx:37`) | совпадает; в журнале |
| `GET /partners` | — | ✔ | ✔ | ✔ | нет | |
| `POST/PUT /partners…` | — | — | ✔ | ✔ | (раздел настроек) | без `validate` — D1-010 |
| `DELETE /partners/:id` | — | — | — | ✔ | | каскад квот (напр. 2) |
| `GET /payments/debts`, `/booking/:id`, `/shift/current/summary`, `/shift/:id/summary`, `/shift/:id` | — | ✔ | ✔ | ✔ | нет | `q` в URL → логи — D1-004 |
| `POST /payments` (приём; `kind` может быть `refund`) | — | ✔ | ✔ | ✔ | нет | приём — решение; **свободный возврат — D1-002** |
| `POST /payments/:id/refund` | — | ✔ | ✔ | ✔ | **нет** | **D1-002** |
| `POST /payments/:id/void` | — | — | ✔ | ✔ | да (`canVoid`) | совпадает |
| `GET /rates` | — | ✔ | ✔ | ✔ | нет | |
| `PUT /rates`, `DELETE /rates`, `POST /rates/cells`, `DELETE /rates/cells` | — | — | ✔ | ✔ | (раздел «Тарифы») | тегированный `$executeRaw` (в порядке) |
| `GET /reports`, `/reports/datasets`, `/reports/:id`, `/reports/:id/definition` | — | ✔ | ✔ | ✔ | нет | |
| `POST /reports/:id/run`, `POST /reports/:id/export` | — | ✔ | ✔ | ✔ | нет | **D1-006**; не в журнале (по решению) |
| `GET /reports/meta`, `POST /reports/validate`, `/preview`, `/import`, `POST /reports`, `PUT/DELETE /reports/:id` | — | — | ✔ | ✔ | да (`ReportsScreen.tsx:34,62`) | совпадает |
| `GET /room-fund`, `/buildings`, `/features`, `/capacities` | — | ✔ | ✔ | ✔ | нет | |
| `POST /room-fund/import`, `POST/PUT/DELETE …/buildings|features|capacities` | — | — | ✔ | ✔ | да (`*Section.tsx`) | совпадает; при 403 localStorage не чистится (NOTES) |
| `GET /rooms`, `GET /rooms/availability` | — | ✔ | ✔ | ✔ | нет | |
| `POST /rooms` | — | — | ✔ | ✔ | (раздел настроек) | лимит лицензии (403 с телом) |
| `PUT /rooms/:id`, `DELETE /rooms/:id` (деактивация) | — | — | ✔ | ✔ | (раздел настроек) | PUT без `validate` — D1-010 |
| `GET /services`, `GET /services/meal-plans` | — | ✔ | ✔ | ✔ | нет | |
| `POST /services/defaults`, `POST/PUT/DELETE /services…`, `…/meal-plans…` | — | — | ✔ | ✔ | (раздел «Тарифы») | express-validator не подключён; не в журнале — D1-010, D1-014 |
| `GET /shifts`, `GET /shifts/current` | — | ✔ | ✔ | ✔ | нет | |
| `POST /shifts/next-day` | — | — | ✔ | ✔ | да (`AuditWindow.tsx:163`) | совпадает; в журнале |

**Где клиент прячет (файлы):** `BookingGrid/BookingContextMenu.tsx:50-52`, `BookingModal/BookingViewModal.tsx:182-183`, `BookingModal/BookingModal.tsx:847`, `Optimize/OptimizeModal.tsx:37`, `Payments/{BookingPaymentPanel,PaymentsScreen}.tsx` (`canVoid`), `Reference/ReferenceWindow.tsx:75`, `Reports/ReportsScreen.tsx:34,62`, `Settings/sections/{BackupSection:357-358, BuildingsSection:19, CapacitiesSection:27, FeaturesSection:25, HotelSection:85}.tsx`, `Audit/AuditWindow.tsx:163,547-548,578`, `License/{licenseUi:79-93, MaintenanceGateScreen:40}.tsx`, `Snapshots/SnapshotsModal.tsx:99`.

**Итог по модели STAFF.** Расхождений «клиент прячет — сервер пускает» **нет**: у каждого клиентского `isAdmin`/`canEdit` есть зеркало в `requireRole` или в контроллере. Расхождения только обратные — сервер (и клиент вместе с ним) пускают STAFF туда, где решения не записано: возвраты (D1-002), суммы/скидка/смена/строки начислений (D1-003), ручные снимки (D1-015), вся книга гостей с документами и выгрузка отчётов (D1-006), расчёт оптимизатора.

## 1б. Матрица «персональные данные × канал»

Строки — категории данных; столбцы — каналы. В ячейке: где именно (файл:строка) или «нет». «REST без роли» = любой вошедший (STAFF).

| Данные | REST без роли | Сокет (все подключённые) | `combined.log` / `error.log` / `host-debug.log` | `AuditLog.details` | Экспорт отчётов (csv/xlsx/docx) | Снимки (`Snapshot.data`) | Копии (`backup_*.json`) | Печать | Прочее |
|---|---|---|---|---|---|---|---|---|---|
| ФИО гостя | `GET /bookings*`, `/occupancy/grid` (`occupancyController.js:120-125`), `/guests`, `/payments/debts` (`:207`), `/payments/booking/:id` | да — `BOOKING_SELECT` в `emitBookingEvent` | **да**: `guestSearch=` и `debts?q=` в URL (`app.js:45`; stdout → `main.js:378`) | да — тело POST/PUT `/bookings` | да — `bookings-registry.json:74`, `debts.json:71`, группировки в `revenue`/`cash-register`, `roomNights` | да (`snapshot.js:152`) | да (все модели) | да — `BookingConfirmation.tsx:87`, `BookingInvoice.tsx:75,91` | — |
| Телефон | те же + `GET /guests/lookup` | да | **да**: `lookup?phone=`, `guestSearch=`, `debts?q=` | да | да — `bookings-registry.json:75`, `debts.json:72`; поле `guestPhone` в датасетах `bookings/charges/payments` | да | да | да — `BookingConfirmation.tsx:88` | — |
| Документ (тип, номер, срок), гражданство, пол, дата рождения | `GET /bookings`, `/bookings/:id` (`BOOKING_SELECT`), **`GET /guests` целиком** (`guestController.js:255-258`), `/guests/lookup` | **да** — `booking:*` всем (D1-005) | нет (идут в теле, не в URL) | **да** (D1-007) | **нет** — датасеты не отдают `guestDoc*` (`datasets/bookings.js` — только `guestName/guestPhone/notes`) | да (`snapshot.js:155`) | да | нет (подтверждение — ФИО и телефон; счёт — плательщик) | grid (`occupancyController.js:120-140`) документы **не** отдаёт |
| Заметки (`notes`) | `/bookings*`, `/occupancy/grid` | да | нет | да | да — поле `notes` датасета `bookings` (`:74`) | да | да | нет | — |
| Реквизиты объекта (БИН/ИИН, IBAN, банк, подписант) | `GET /hotel` — всем (`hotelController.js:57-61`) | нет | нет | да — `PUT /hotel` (16 записей в dev) | нет | нет | да | да (по назначению) | — |
| Телефоны сотрудников/подрядчиков (`Contact`) | `GET /contacts` — всем (решение) | нет | нет | нет (`/contacts` не отслеживается) | нет | нет | да | печать списка (`ReferenceWindow`) | — |
| Пароли | нигде (`me`/`users` без `password`) | нет | нет (`stripSecrets`; dev: 0 записей с «password») | нет | нет | нет | **хеши bcrypt** (`Admin` в копии) | нет | хеш `admin` в `electron/db/seed.sql:12`; scrypt сисадмина в `config.json` |
| JWT | заголовок `Authorization` — **открытый HTTP в LAN** (D1-012) | `handshake.auth.token` (не в URL → не логируется) | нет | нет | нет | нет | нет | нет | `localStorage.token` на origin (D1-013); DevTools в проде (D1-011) |
| `JWT_SECRET`, `dbPassword`, `DATABASE_URL` | нет | нет | нет | нет | нет | нет | нет | нет | `config.json` открытым текстом и env дочернего процесса (напр. 8); dev — `.env`, `.mcp.json` (D1-019) |
| Ключ лицензии | нет (`describeLicense` без `key`) | нет | нет | нет (`/license` не отслеживается) | нет | нет | да (`License` в копии — переезжает вместе с ней, напр. 8) | нет | — |
| IP рабочего места | `GET /audit/log` (ADMIN) | нет | нет | `ip: req.ip` | нет | нет | да | нет | — |

**Выводы по матрице.** (1) Два незапланированных хранилища ПД — логи (URL) и `AuditLog.details`; ни у одного нет ротации/ретеншна. (2) Документы гостей не попадают в экспорт и печать — хорошо; но попадают в широковещательный сокет и в `GET /guests` целиком. (3) Все хранилища (база, снимки внутри базы, копии, логи) — открытым текстом на диске хоста; шифрования нет нигде (копии — напр. 8; у разработчика `hotel-booking/backups/backup_2026-09-05_12-38.json`, 207 КБ, лежит в папке OneDrive). (4) Единственный сетевой канал ПД — открытый HTTP.

---

## 2. Что в порядке (`файл:функция` — что именно проверено)

- `middleware/auth.js:authenticate` — разбор `Bearer`; `jwt.verify` со строковым секретом (jsonwebtoken 9: `alg: none` отвергается, по умолчанию только HS*); битый/просроченный токен → 401, сбой БД → 503 (токен на клиенте не стирается); `isActive`; `tokenVersion` (`payload.tv ?? 0`); роль на каждом запросе берётся из БД, а не из токена — понижение действует сразу.
- `middleware/auth.js:requireRole` — 403 «Недостаточно прав»; стоит во всех роутах, где заявлено (таблица §1а сверена построчно).
- `socket/socketManager.js:io.use` — handshake повторяет REST-проверки (подпись, `isActive`, `tokenVersion`); токен в `handshake.auth`, не в query (в логи не попадает); `disconnectAdmin` шлёт `auth:revoked` и рвёт; `recheckConnectedAdmins` раз в 5 мин ловит выключение/отзыв мимо API. (Не проверяется только `exp` — D1-005.)
- `utils/sessions.js:revokeSessions` — хеш пароля и инкремент версии одной записью; сбой сокета запрос не роняет. Зовётся из `auth.logout`, `auth.changePassword`, `users.setPassword` — все три места сверены.
- `controllers/authController.js:login` — единый текст 401 для «нет пользователя» и «неверный пароль»; bcrypt cost 12; в ответе `id/username/name/role`, без пароля; `me` — без пароля и без `tokenVersion`.
- `controllers/authController.js:changePassword` — сверка текущего пароля; политика через `passwordRule`; отзыв всех сессий, включая свою (осознанно, NOTES).
- `controllers/userController.js:update` — нельзя деактивировать себя (`:52`); нельзя снять роль/деактивировать последнего активного SUPER_ADMIN (`:57-66`, считаются только активные, `NOT: { id }`); смена роли себе разрешена, если есть другой SUPER_ADMIN — корректно; при деактивации рвутся сокеты. `setPassword` — отзыв сессий. `list/create` — `PUBLIC_FIELDS` без пароля.
- `routes/users.js` — `authenticate + requireRole('SUPER_ADMIN')` на весь роутер; логин `trim().toLowerCase()` + `^[a-z0-9._-]+$`; роль из списка; `isActive` → boolean.
- `utils/passwordPolicy.js` — единый источник (≥10, буква, цифра, без пробелов по краям, ≤72); подключён в `auth.js:17`, `users.js:28,44`, `setup.js:44,49`; на входе не применяется (осознанно).
- `controllers/setupController.js:complete` — валидация тела (`setup.js:29-51`), уникальность логинов в запросе и в базе, bcrypt до транзакции, `P2002` → 409, роли сотрудников только ADMIN/STAFF. (Кроме самого гейта — D1-001.)
- `controllers/licenseController.js:activate` — подпись проверяется ДО записи: мусорный ключ → 400, строка `License` не трогается, гейт 402 «плохим» ключом не снимается; кэш сбрасывается после записи; `get` ключ не отдаёт. `utils/license.js:parseLicenseKey` — строгий base64url, подпись до разбора полей, публичный ключ не из env. `middleware/license.js:maintenanceGate` — `ALLOWED` сверяется как `path === p || path.startsWith(p + '/')` (`/api/licenseX` не проходит), OPTIONS пропускается, сбой БД → пропуск.
- `middleware/audit.js:stripSecrets/sanitizeBody` — пароли вырезаются на глубину ≤5 (у отслеживаемых эндпоинтов вложенности >5 нет; dev: 0 записей с «password»); лимит 2 КБ; запись асинхронная с `catch`; нет `req.admin` → записи нет (публичный `/setup`).
- `middleware/errorHandler.js` — 5xx без деталей; для <500 наружу уходит только `err.message` из `createError`/валидатора/body-parser («Unexpected token … in JSON at position N» — без содержимого); `23P01`/`exclusion constraint` → 409; `P2003`/`P2010(23503)` → 400; стек — только в `error.log`.
- `utils/corsOrigin.js` — граница безопасности — Bearer в заголовке, cookie нет; поэтому `credentials: true`, «без Origin» и приватные диапазоны не дают чужой странице токена. Единая политика для REST и socket.io.
- `utils/backup.js:readDump` — `FILE_RE = /^backup_[0-9A-Za-z_-]+\.json$/` + `path.basename(name) === name` → traversal через `GET /system/backups/:fileName/impact` и `POST /system/backup/restore` невозможен; `listBackupFiles` — только по маске. `exec()`/`pg_dump` в `backup.js` отсутствуют (июньский пункт закрыт).
- Raw SQL — инъекций нет: `occupancyController.js:77` (тегированный `$queryRaw`, параметры биндятся), `rateController.js:97,162` (тегированный `$executeRaw`, массивы через `unnest`), `roomFundController.js:241` (тегированный), `backup.js:750` и `snapshot.js:530` (`$executeRawUnsafe`, но имена таблиц из DMMF/константного списка, не из запроса), `optimizeController.js:822` (константа `SET CONSTRAINTS … DEFERRED`), `routes/system.js:12` (`SELECT 1`).
- `controllers/bookingController.js:update/cancel/updateActualTimes` — 403 для STAFF за фактическое время (`:419`, `:617`) и отмену заселённого (`:588`); закрытая бронь — 400 всем; клиент прячет ровно то же (`BookingContextMenu.tsx:49-52`).
- `routes/bookings.js` — POST и PUT с одинаковыми правилами; поля документа — enum-контракт (`passport/id_card/other`, `m/f`), даты `strictMode`; `flags.*` ≤60; `services.*` ограничены.
- `controllers/guestController.js:lookup` — телефон нормализуется той же функцией, что и в `list`; `query('phone')` ≤30; ничего не пишет.
- `controllers/reportController.js:exportFile` — имя файла: `translit()` в `filename` и `encodeURIComponent` в `filename*` (`export.js:242-274`) — заголовок не ломается кавычками/переводами строк из названия отчёта.
- Electron: `main.js:509,543` — `contextIsolation:true, nodeIntegration:false, sandbox:true` в обоих окнах; `preload.js` — 8 узких методов, `settings-preload.js` — 4; `config:get` (`:661-671`) отдаёт конфиг без `dbPassword/jwtSecret/sysadmin`; пароль сисадмина — scrypt + `timingSafeEqual` (`:62-74`); `report:savePdf/saveFile` — путь только из `showSaveDialog` (`:830-836`, `:850-856`), renderer путь не задаёт; `updateUrl` — только `http(s):` (`:750-758`); `dataDir/backupDir` — абсолютные и разные (`:731-740`); splash `data:` URL — статичный текст; `requestSingleInstanceLock`; `settings.html` — динамика только через `textContent`/`createElement` (`:156,175-187`), `innerHTML` один раз для константы (`:204`).
- Клиент: `dangerouslySetInnerHTML|innerHTML|srcdoc|document.write|insertAdjacentHTML` в `client/src` = 0; пользовательских `href`/`window.open` = 0; `client.ts` — 402 не смешивается с 401, `/auth/login|logout|/setup/` исключены из перезагрузки; `useAuthStore.restore` стирает токен только на 401/403; `useSocket` — `auth:revoked` → `logout(reason)` с пояснением.
- `routes/snapshots.js:GET /` — без тела `data`; `routes/payments.js` — `DELETE` платежа отсутствует намеренно; `void` — только ADMIN+ и с причиной.
- Известное из плана, статус «в порядке»: `DELETE /bookings/:id` — отмена статусом (`bookingController.js:574-599`), физического удаления брони через API нет; `POST /payments` (приём) для STAFF — принятое решение; `webPreferences` и `preload` — как заявлено.

---

## 3. Проверка закрытых пунктов (NOTES.md `[x]` и «сделано» из `fix-waves-2026-09.md`) — по коду

| Пункт | Где заявлено | Статус по коду |
|---|---|---|
| Отзыв JWT — `Admin.tokenVersion`, `revokeSessions`, проверка в auth и сокете, `payload.tv ?? 0` | NOTES 2026-09-07 | **Закрыто.** `auth.js:42`, `socketManager.js:114`, `sessions.js:14-25`; три вызова на месте. *Сверх плана пункта:* сокет не проверяет `exp` (D1-005). |
| Сокет не проверял `isActive`; `disconnectAdmin`; перепроверка раз в 5 мин | NOTES 2026-09-04 | **Закрыто.** `socketManager.js:99-118,54-69`; `userController.js:73-75`. |
| Слабая парольная политика — единый модуль в четырёх точках | NOTES 2026-09-04, `audits-2026-06` | **Закрыто.** `passwordRule` в `auth.js`, `users.js` (×2), `setup.js` (×2). |
| `optimize/apply` не проверял роль | NOTES 2026-09-03 | **Закрыто.** `occupancy.js:40`. |
| C3 «Права»: `next-day`, `apply`, отмена заселённого — только ADMIN/SUPER_ADMIN; клиент прячет пункты | fix-waves | **Закрыто.** `shifts.js:10`, `occupancy.js:40`, `bookingController.js:588`; `BookingContextMenu.tsx:49-52`, `OptimizeModal.tsx:37`, `AuditWindow.tsx:163`. |
| Управление пользователями: только SUPER_ADMIN, без удаления, нельзя деактивировать себя и последнего SUPER_ADMIN | fix-waves | **Закрыто.** `users.js:10`, `userController.js:52-66`. «Смена роли себе» — разрешена при наличии другого SUPER_ADMIN (корректно). |
| E4 журнал действий: мутации броней, смен, оптимизатора, снимков, пользователей, фонда, тарифов, бэкапов; «без паролей» | fix-waves | **Частично.** Заявленный список покрыт (`audit.js:16-19,33-34`); снимки — только `restore`, не `POST/DELETE`; пароли вырезаются. Не покрыты `/auth`, `/license`, `/services`, `/contacts`, `/booking-flags` (D1-014). |
| Платежи в журнале; «в детали идут только bookingId, сумма, способ, комментарий» | NOTES 2026-09-04 | **Закрыто.** `/payments` в `TRACKED_PREFIXES`; детали = тело запроса, утверждение верно потому, что в теле ничего другого нет. |
| CORS в проде — единая политика (`utils/corsOrigin.js`) | NOTES | **Закрыто.** Подключена в `app.js:40` и `socketManager.js:78-81`. |
| Мастер первого запуска: `POST /setup/complete` публичный до завершения, потом 403; мастер важнее сохранённой сессии | fix-waves | **Закрыто как описано** — и именно это механизм D1-001. |
| C1 вход: 401 vs 503; `restore()` стирает токен только на 401/403; перехватчик не трогает вход/мастер | fix-waves | **Закрыто.** `auth.js:22-33`, `useAuthStore.ts:66-75`, `client.ts:58-63`. |
| Сид кладёт `admin / admin` (`seed.js`, `seed.sql`) | NOTES 2026-09-07 | **Закрыто.** `seed.js:65`, `seed.sql:3,11-13`. |
| «Дефолтная учётка `admin / admin123` продолжает работать» (открыт) | NOTES 🟡 | **Открыт, подтверждено:** хеш `admin` в dev-базе соответствует `admin123` (D1-019). |
| `JWT_SECRET` предсказуем, `postgres:password` (dev) | NOTES 🟡, `audits-2026-06` | **Открыты** (по NOTES; `.env` не читал). В упаковке — генерируются (`main.js:44-52`). |
| `exec()` со строковой склейкой в бэкапе | `audits-2026-06` | **Закрыто.** `child_process`/`pg_dump` в `backup.js` нет (`:12` — комментарий, что pg_dump не используется). |
| «rate-limit на /api/auth (20/15мин в проде)» — как ОК | `audits-2026-06` | **Работает, но считает и успешные `/me`/`/logout`** — D1-008. |
| «логин не различает «нет юзера»/«неверный пароль»» | `audits-2026-06` | **По тексту — да; по времени — нет** (D1-017). |
| «все API-роуты и Socket.io под `authenticate`» | `audits-2026-06` | **Верно** для всех, кроме намеренно публичных `/health`, `/setup/*`, `/auth/login` (§1а). |
| `$executeRawUnsafe` в `snapshot.js` — статическая строка | `audits-2026-06` | **Верно**, и для `backup.js:750` (имена таблиц из DMMF). |
| `LICENSE_SERVER_URL` выкинуть (пункт «Лицензирование») | NOTES 🔴 | **Сделано по коду:** `routes/license.js:7-10` — онлайн-активации нет; в NOTES сам пункт не помечен `[x]` (ключ отмечен только в таблице 1.0). |

---

## 4. Код ↔ `docs/decisions`

| Решение | Код | Оценка |
|---|---|---|
| `data-and-money.md:62-63` — «принимать оплату может и STAFF; отменять запись — только ADMIN/SUPER_ADMIN» | Возврат (`POST /payments/:id/refund`, `POST /payments {kind:'refund'}`) — тоже STAFF, в решении не упомянут | Не противоречие, а пробел решения — D1-002 |
| `reports.md:88-90` — «смотреть и выгружать — все; настройка доступа к каждому отчёту — следующий шаг» | Совпадает (`reports.js:20-23`) | Решение принято 03.09, до документов гостей (06.09) и финансовых отчётов — D1-006, вопрос §6 |
| `reports.md:99-100` — «`/reports` в журнале, `run/export/preview/validate` исключены» | Совпадает (`audit.js:18,24`) | — |
| `interface.md:11` — контакты: «читают все, правят ADMIN и SUPER_ADMIN» | Совпадает (`contacts.js`) | — |
| `desktop-and-ops.md:6-9` — «наружу ничего не выставляется, только LAN/Wi-Fi гостиницы» | `HOST=0.0.0.0`, без TLS, без ограничения по подсети | Соответствует при условии изолированной сети; условие не зафиксировано — D1-012 |
| `bookings.md:5-9` — «нигде не берём дату устройства для бизнес-логики» | `routes/audit.js:46-55` (`GET /api/audit`, сводка денег): `now = new Date()`, `getFullYear/getMonth/getDate` — у сервера в `TZ=UTC` «сегодня» = UTC-сутки | Противоречие (мягкое: только сводка «за сегодня/месяц»); зона напр. 3/2 |
| `data-and-money.md:55` — «`DELETE` в API [платежей] нет вовсе» | Совпадает | — |
| `data-and-money.md:116-119` — «строку можно поправить, удалить или добавить свою (`manual` + причина + автор)» | Удаление авто-строки — любой ролью, физическое, без деталей в журнале | Роль и след решением не оговорены — D1-003 |
| NOTES «Отзыв JWT»: «смена роли версию не поднимает — роль берётся из базы» | Совпадает (`auth.js:28,46`) | — |
| NOTES «Пароль сисадмина в `config.json` (scrypt)» | Совпадает (`main.js:54-74`) | — |

---

## 5. Не проверено (бюджет)

- `bookingController.js` целиком — прочитаны только `update/cancel/updateActualTimes`, `BOOKING_SELECT`, `list`, `removeCharge`; `create`, `move`, `checkIn/checkOut`, `addCharge/updateCharge/rebuild` — нет (напр. 3).
- `optimizeController.js` кроме `:518-545` и `:822`; `reports/{engine,expr,registry}.js` (напр. 4) — доступ проверен только на уровне роутов.
- `utils/backup.js` — прочитаны `:1-45` (grep), `:100-160`, `:400-520`, `:555-700`, `:740-760`; `createBackup`, ротация, `dataLossMessage` — нет (напр. 8). `utils/snapshot.js` — только `:70-97`, `:123-140`, `:150-175`, `:520-540`.
- `electron/main.js` `:130-225` (Postgres), `:260-350` (миграции), `:400-480` (`waitForHealth`, `stopHostProcesses`) — напр. 8.
- Клиент: `BookingModal.tsx` (2 844 строки) — только grep ролей; `Settings/sections/UsersSection.tsx`, `Setup/SetupWizard.tsx` и шаги, `Print/*` (только grep полей), `Reports/*`, `Audit/AuditWindow.tsx` (только grep ролей).
- Живые HTTP-заголовки helmet/CORS/`Content-Disposition` — сервер не запускался; лимитер не прогонялся.
- `server/.env` — не читал (секреты); статус — по NOTES.
- Реконнект socket.io на клиенте после `Server unavailable` (напр. 3/5).
- Права NTFS на `%APPDATA%\hotel-booking-desktop\` (`config.json`, `logs`, `backups`, `pgdata`) и `listen_addresses`/`pg_hba.conf` встроенного Postgres — напр. 8.
- `server/test/*` — покрытие auth/ролей (напр. 9).
- Версии зависимостей на CVE (`npm audit`) — напр. 9; здесь сверено только, что `jsonwebtoken ^9.0.2` (безопасные алгоритмы по умолчанию), `express-rate-limit ^7.3.1`, `helmet ^7.1.0`, `bcryptjs ^2.4.3`.

---

## 6. Вопросы владельцу (тяжесть 4)

1. **Модель прав STAFF — зафиксировать решением.** Должен ли сотрудник стойки: (а) проводить возвраты, в том числе «свободные», без администратора (D1-002); (б) править `totalAmount/paidAmount/discountPercent/shiftId` и удалять автоматические строки начислений (D1-003); (в) видеть документы всех гостей списком и выгружать реестры в файл без следа (D1-006); (г) создавать ручные снимки (D1-015); (д) запускать расчёт оптимизатора по всему фонду. Сейчас всё это «да» по умолчанию, и клиент честно это показывает.
2. **Срок хранения ПД.** Сколько лет хранить документы гостей в `Booking`, `AuditLog.details`, снимках и копиях; нужна ли анонимизация старых броней (D1-007). Для eQonaq/МВД требуется история — какая глубина?
3. **Логи.** Убрать query-строку из `combined.log`/`host-debug.log` (или маскировать `guestSearch/phone/q`) и ввести ротацию — да/нет (D1-004). Логи пересылаются в поддержку — это надо учитывать.
4. **Сеть отеля.** Гостевой Wi-Fi отделён от служебного у «Дорожника»/«Турана»? Если нет — нужен хотя бы отдельный VLAN, иначе токены и паспорта видны любому гостю (D1-012).
5. **Учётки: персональные или общие?** «Выход = отзыв всех сессий» (07.09) означает, что два ноутбука под одним логином будут выбивать друг друга. Это желаемое поведение (тогда каждому сотруднику — своя учётка и экран смены пароля, D1-009) или нужен режим «общая учётка стойки»?
6. **Блокировка по бездействию** на общем рабочем месте: нужен ли авто-выход через N минут / повторный ввод пароля (D1-013)?
7. **Два отката с разной планкой** — снимки (ADMIN, с галочкой на потерю денег) и копии (SUPER_ADMIN): уравнять или это осознанно (D1-015)?
8. **F12 в проде** — оставить для поддержки, убрать или открывать по паролю сисадмина (D1-011)?
9. **Подпись сборки (code signing)** — планируется ли до появления сервера обновлений? Без неё `electron-updater` не проверяет издателя установщика (D1-011, напр. 8).
10. **`GET /guests` с документами** — оставить «книгу с паспортами» всем ролям или отдавать документ только через `lookup` по конкретному телефону при заселении (D1-006)?
