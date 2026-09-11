# CLAUDE.md

Roomline PMS — система бронирования для небольших отелей и баз отдыха. Desktop-программа
(Electron) со встроенным PostgreSQL и веб-стеком внутри; один ноутбук — хост, остальные
рабочие места подключаются к нему по локальной сети. Весь код — в подкаталоге **`hotel-booking/`**.
До 09.09.2026 продукт назывался Qonaq; внутренние имена (`hotel-booking-desktop`, `appId`,
база `hotel_booking`) переименованию не подлежат — см. `docs/decisions/interface.md`.

## Запуск и команды

Все команды — из `hotel-booking/` (корневые зависимости `concurrently`/`wait-on` ставятся
`npm install` там же).

| Команда | Что делает |
|---|---|
| `npm run dev` | Backend + frontend одновременно |
| `npm run dev:server` | Только backend (nodemon, порт 3001) |
| `npm run dev:client` | Только frontend (Vite, порт 5173, прокси `/api` и `/socket.io` на 3001) |
| `npm run dev:electron` | Backend + frontend + Electron-окно |
| `npm run build` | `build:client` (tsc + vite) → штамп `buildDate` → `build:electron` (electron-builder, NSIS) |
| `npm run db:migrate` | `prisma migrate dev` (создать и применить миграцию к своей базе) |
| `npm run db:migrate:create` | только файл миграции, без применения |
| `npm run db:migrate:deploy` | применить готовые миграции (так делает и установленная программа) |
| `npm run db:migrate:status` | состояние миграций |
| `npm run db:seed` | сид: **сбрасывает пароль главного администратора** — на базе с данными не запускать |
| `npm run db:studio` / `db:generate` | Prisma Studio / перегенерация клиента |
| `cd server && npm test` | тесты (vitest, ~73 файла / ~1380 тестов) |
| `cd client && npx tsc --noEmit` | проверка типов клиента |
| `cd electron && node test-host.mjs` | связка «встроенный Postgres + миграции + сервер» на временном кластере |

Конфигурации для панели браузера Claude Code — `.claude/launch.example.json` (скопировать в
`launch.json`, поправить пути; сам `launch.json` в git не входит). MCP-коннекторы —
`.mcp.json.example` → `.mcp.json` (с паролем, в git не входит).

**Порты 3001/5173 и dev-база `hotel_booking` — рабочие у владельца, их не трогать.**
Живые проверки — на клоне `hotel_booking_audit` (сервер 3012, клиент 5175), рецепт в
`hotel-booking/NOTES.md` → «Клон для проверки». Упакованную сборку проверять в изоляции:
`HOTEL_BOOKING_USERDATA=<временная папка>` (там же в NOTES).

## Стек

**Backend** (`hotel-booking/server`, CommonJS): Node + Express 4; Prisma 5 + PostgreSQL
(`prisma/schema.prisma`, 25 моделей, схема живёт только в `prisma/migrations/`); Socket.io;
JWT (`jsonwebtoken` + `bcryptjs`, версия сессии `Admin.tokenVersion`); helmet, express-rate-limit,
express-validator; node-cron 4 (ночная копия 03:00, чистка журнала 03:30); winston (ротация
5 МБ × 5, без значений query и без тел запросов в логах).

**Frontend** (`hotel-booking/client`, ESM + TypeScript): React 18 + Vite; Zustand
(`src/store/`: auth, grid, settings, roomFund, license, backupStatus, connection, realtime);
axios (`src/api/`); react-hook-form; date-fns; `@tanstack/react-virtual`; socket.io-client.

**Desktop** (`hotel-booking/electron`): Electron 44, electron-builder 26 (NSIS `perMachine`,
`installer.nsh` ставит правило брандмауэра по программе), `embedded-postgres` (PostgreSQL 18,
initdb с builtin-локалью `C.UTF-8`, порт — свободный от 5433, хранится в `cfg.dbPort`). `main.js` —
хост: запуск кластера, миграции через Prisma CLI, надзор за сервером и Postgres, копии, спутник
пароля базы; клиент: сторож адреса хоста (health каждые 15 с → поиск по UDP → `app.relaunch`);
`lib/` — чистые модули без `electron` (`config`, `migrations`, `disk`, `logs`, `ports`,
`discovery`; тестируются из `server/test`). Порты упакованной сборки: сервер **4780**
(dev — 3001), поиск хоста UDP **4781** (`DISCOVERY_PORT`).

## Структура

```
server/
  server.js                   # точка входа (TZ=UTC, планировщики)
  src/app.js                  # Express + health (503 при лежащей базе)
  src/controllers/            # 22 контроллера: booking, payment, report, license, setup, user, service, rate…
  src/routes/                 # REST по ресурсам; setup — публичный мастер первого запуска
  src/middleware/             # auth, validate, errorHandler, audit (журнал действий), license (гейт 402)
  src/socket/socketManager.js # realtime, разрыв сокета по сроку токена, документы гостей вырезаны
  src/reports/                # движок отчётов: engine, expr (язык формул), export (csv/xlsx/docx), datasets/, definitions/
  src/utils/                  # availability (пересечения), businessDate, bookingMoney, charges, backup, snapshot,
                              # license (Ed25519 офлайн), sessions, hotelTz (местные сутки), setupState, guestDocFields…
  prisma/schema.prisma, prisma/migrations/   # 0_init + миграции; exclusion-constraint booking_no_overlap в 0_init
  scripts/license-issue.js    # выпуск лицензий (приватный ключ вне репозитория)
  test/                       # vitest; helpers/fakePrisma.js — in-memory Prisma для тестов без базы
client/
  src/api/                    # клиенты REST (файл на ресурс), client.ts — 401 → оверлей повторного входа
  src/components/             # BookingGrid/, BookingModal/, Payments/, Reports/, Rates/, Settings/, Setup/, ui/ConfirmDialog
  src/store/, src/hooks/useSocket.ts, src/types/index.ts, src/utils/
electron/
  main.js, lib/{config,migrations,disk,logs,ports,discovery}.js, installer.nsh, db/seed.sql (только данные), test-host.mjs, SANDBOX-CHECKLIST.md
```

## Доменные особенности

- **Пересечения броней** — `utils/availability.js` (`findRoomBlock`) плюс constraint
  `booking_no_overlap` в базе. Даты полуоткрытые: выезд в день заезда следующего — не пересечение.
- **Бизнес-дата** — `utils/businessDate.js`: сутки отеля ≠ календарные; `@db.Date` хранятся как
  UTC-полночь (`Date.UTC`, рендер с `timeZone: 'UTC'`). Моменты времени (`createdAt`, `paidAt`)
  переводятся в местные сутки через `utils/hotelTz.js` (`HOTEL_TZ`, задаёт Electron).
- **Деньги** — начисления (`BookingCharge`) и журнал платежей (`Payment`); `Booking.paidAmount` —
  кэш. Предпросмотр сумм считает сервер. Переезд (цепочка) — один счёт на голове.
- **Замок версии брони** — `PUT /bookings/:id` с `expectedUpdatedAt` → 409 `BOOKING_STALE`.
- **Оптимизатор** — `controllers/optimizeController.js`; бэктест `scripts/optimizer-backtest.js`.
- **Аллотменты и релизы** — квоты партнёров (предупреждение, `allotmentOverride`).
- **Снимки** — по событиям (дебаунс), **копии** — 03:00, при старте (если старше 20 ч), каждые
  4 ч и при выходе; папка копий — флешка, запасная — локальная.
- **Realtime** — любое изменение брони эмитит `booking:*`; при правке API проверяй событие.
- **Лицензия** — офлайн-ключ `ROOMLINE-…` с подписью Ed25519 (`utils/license.js`); ключи
  прежнего образца `QONAQ-…` принимаются навсегда (`LEGACY_KEY_PREFIXES`), гейт
  обслуживания по `buildDate` сборки (`middleware/license.js`).
- **Мастер первого запуска** — только на нетронутой базе (`utils/setupState.js`).
- **Личность хоста** — `HotelSettings.instanceId` + пара Ed25519 в базе (`utils/instanceIdentity.js`),
  `GET /api/health?nonce=…` возвращает `instance { id, publicKey, sig }`; ответчик поиска —
  `src/discovery/udpResponder.js` (протокол в шапке файла). `GET /api/hotel` — по белому списку
  `PUBLIC_FIELDS`, приватный ключ наружу не отдаётся никогда. Сервер на занятом порту завершается
  с кодом 3.

## Конвенции

- На каждый ресурс: контроллер + роут на сервере и файл в `client/src/api/`.
- Общее состояние UI — в Zustand-сторах, не в локальном `useState`.
- Ошибки сервера — через `middleware/errorHandler.js`; ошибки с `code` для клиента (`BOOKING_STALE`, `SETUP_DONE`, `SERVICE_IN_USE`).
- **Изменение схемы = `schema.prisma` + миграция в одном изменении**; `db push` не используем.
- Опасные действия в UI подтверждаются `ui/ConfirmDialog` с числом (сколько сотрёт).

## Гочи

- `npm run build` падает на ошибках типов — после правок в `client/` гоняй `tsc`.
- Линтера нет. Тесты есть — прогоняй; слой роутов (валидаторы) без supertest не покрыт.
- Сервер в dev — `node server.js`, правки не подхватывает: перезапускай (и фоновые задачи тоже).
- `prisma generate` падает с EPERM при запущенном сервере.
- `npm run build` штампует `buildDate` в `server/package.json` — после сборки вернуть файл.
- electron-builder 26 отсекает корневой `node_modules` у `extraResources` — сервер копируется
  двумя FileSet'ами (`electron/package.json`).
- Секреты — `server/.env` (шаблон `hotel-booking/.env.example`); приватный ключ лицензий —
  вне репозитория; `*.pem` игнорируется.
- **Журнал:** живая часть — `hotel-booking/NOTES.md` (точка входа, открытые проблемы, как
  запускать, клон, сборка). Решения по областям — `hotel-booking/docs/decisions/`
  (`data-and-money`, `bookings`, `interface`, `desktop-and-ops`, `reports`). Аудит 2026-09 —
  `docs/audit-2026-09/`, старое — `docs/archive/`. Закрыл пункт — пометь `[x]` с датой, не удаляй.

## MCP-коннекторы (`.mcp.json`)

- **postgres** — dev-база, только чтение: проверять структуру и реальные данные вместо догадок.
- **context7** — актуальная документация библиотек под их версии.
