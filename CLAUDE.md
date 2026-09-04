# CLAUDE.md

Система управления бронированием отеля (desktop-приложение на Electron + веб-стек).
Весь код находится в подкаталоге **`hotel-booking/`**.

## Запуск и команды

Все команды выполняются из `hotel-booking/`:

| Команда | Что делает |
|---|---|
| `npm run dev` | Backend + frontend одновременно (concurrently) |
| `npm run dev:server` | Только backend (nodemon, порт 3001) |
| `npm run dev:client` | Только frontend (Vite, порт 5173) |
| `npm run dev:electron` | Backend + frontend + Electron-окно |
| `npm run build` | `build:client` (tsc + vite) затем `build:electron` |
| `npm run db:migrate` | `prisma migrate dev` |
| `npm run db:studio` | Prisma Studio (просмотр БД) |
| `npm run db:seed` | Засев тестовых данных |
| `npm run db:generate` | Перегенерация Prisma Client |

Быстрый старт из корня репозитория: `start-all.bat` (поднимает backend и frontend в отдельных окнах).

## Стек

**Backend** (`hotel-booking/server`):
- Node + Express 4
- **Prisma 5 ORM + PostgreSQL** (схема: `server/prisma/schema.prisma`)
- Socket.io — realtime-обновления грида броней
- JWT-аутентификация (`jsonwebtoken` + `bcryptjs`)
- helmet, express-rate-limit, express-validator — безопасность/валидация
- node-cron — фоновые задачи (бэкапы, снапшоты)
- winston — логирование (`server/logs/`)

**Frontend** (`hotel-booking/client`):
- React 18 + **TypeScript** + Vite
- Zustand — глобальное состояние (`client/src/store/`)
- axios — HTTP (`client/src/api/`)
- react-hook-form — формы
- date-fns — работа с датами
- `@tanstack/react-virtual` — виртуализация грида броней
- socket.io-client — realtime

**Desktop** (`hotel-booking/electron`): Electron-обёртка.

## Структура

```
server/
  server.js                  # точка входа
  src/app.js                 # сборка Express-приложения
  src/controllers/           # бизнес-логика (booking, room, allotment, optimize, ...)
  src/routes/                # эндпоинты REST API
  src/middleware/            # auth, validate, errorHandler
  src/socket/socketManager.js# Socket.io
  src/utils/                 # overlap, businessDate, snapshot, backup, flagEffects
  prisma/schema.prisma       # 14 моделей: Room, Category, Booking, Allotment, Release, ...
client/
  src/api/                   # клиенты REST (по одному файлу на ресурс)
  src/components/            # UI; ключевой — BookingGrid/ и BookingModal/
  src/store/                 # Zustand-сторы (auth, grid, settings)
  src/types/index.ts         # общие типы
  src/utils/                 # calculator, sortRooms
```

## Доменные особенности (важно учитывать)

- **Пересечения броней** — логика в `server/src/utils/overlap.js`. Любые изменения дат/комнат должны проверяться на overlap.
- **Бизнес-дата** — `server/src/utils/businessDate.js`. Сутки в отеле не равны календарным; не сравнивай даты «в лоб».
- **Оптимизатор** размещения — `server/src/controllers/optimizeController.js` (самый сложный модуль). Бэктест: `server/scripts/optimizer-backtest.js`.
- **Аллотменты и релизы** (`Allotment`, `Release`) — квоты комнат для партнёров.
- **Снапшоты и бэкапы** — `utils/snapshot.js`, `utils/backup.js`, по расписанию через node-cron.
- **Realtime** — изменения броней рассылаются через Socket.io; при правках API проверяй, что соответствующее socket-событие тоже эмитится.
- **Лицензии** — `routes/license.js`, проверка против `LICENSE_SERVER_URL`.

## Конвенции

- Backend — CommonJS (`.js`), frontend — ESM + TypeScript (`"type": "module"`).
- На каждый ресурс: контроллер + роут на сервере и зеркальный файл в `client/src/api/`.
- Состояние UI — только через Zustand-сторы, не локальный useState для общих данных.
- Все ошибки сервера идут через `middleware/errorHandler.js`.

## Гочи / на что смотреть

- **`npm run build` падает на ошибках типов** — билд клиента это `tsc && vite build`. После правок в `client/` проверяй типы: `cd client && npx tsc --noEmit`.
- **Линтера и тестов в проекте нет** — изменения проверяй запуском приложения и typecheck'ом вручную.
- Секреты — в `server/.env` (в `.gitignore`). Шаблон — `.env.example`.
- **Журнал проекта:** живая часть — `hotel-booking/NOTES.md` (что делаем дальше,
  открытые проблемы, грабли, как запускать). Читать всегда.
  Принятые решения вынесены по областям в `hotel-booking/docs/decisions/`:
  `data-and-money` (схема, миграции, цены, начисления, платежи),
  `bookings` (брони, смены, метки, оптимизатор), `interface` (навигация, разделы),
  `desktop-and-ops` (Electron, эксплуатация), `reports` (движок отчётов).
  Исторические аудиты и отчёты по волнам починки — в `hotel-booking/docs/archive/`.
  Закрыл пункт — пометь `[x]` с датой, не удаляй.

## Подключённые MCP-коннекторы (`.mcp.json`)

- **postgres** — прямой доступ к схеме и данным локальной БД (read-only). Используй для проверки структуры таблиц и реальных данных вместо догадок.
- **context7** — актуальная документация библиотек под их версии (Prisma 5, react-virtual 3, socket.io 4 и т.д.). Вызывай при работе с API этих библиотек.
