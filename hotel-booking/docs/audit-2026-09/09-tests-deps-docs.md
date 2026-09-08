# 09 — Тесты, зависимости, документация, гигиена репозитория

- **Коммит:** `a39c57c` (2026-09-07 10:57 +05, `main` = `origin/main`, репозиторий `github.com/OralbekovAbzal/book_manager` — **private**, проверено `gh api … .private = true`).
- **Дата аудита:** 2026-09-07.
- **База для SQL:** не использовалась — направление статическое, MCP `postgres` не вызывался.
- **Бюджет (что прочитано целиком):** `CLAUDE.md`, `README.md`, `hotel-booking/NOTES.md` (616 строк), `docs/decisions/*.md` ×5, `docs/archive/*.md` ×2, `.claude/agents/*.md` ×4, `.claude/launch.json` (HEAD и рабочая копия), `.mcp.json`, `.gitignore` ×2, `package.json` ×4, `.env.example`, `server/vitest.config.mjs`, `server/test/helpers/{fakePrisma,loadCjs}.js`, `electron/db/README.md`, `client/vite.config.ts`, `client/tsconfig.json`, `server/src/utils/prisma.js`, `start-all.bat`. Тесты (17 файлов, 6 276 строк) — заголовки `describe`, харнесы загрузки (`loadCjs`/`stubs`), список загружаемых модулей; тела тестов не читал. Исходники контроллеров/утилит — только grep (они у направлений 1–8).
- **Прогоны (read-only):** `npm test` (server), `npx tsc --noEmit` (client), `npm audit` и `npm outdated` в `server/`, `client/`, `electron/`, `npm ls` в `hotel-booking/`, `npm view` для корневых devDeps, `git status/ls-files/log/check-ignore`, `gh api`. Ничего не устанавливалось, не собиралось, не мигрировалось.
- **Не считаю находками по условию задачи:** две временные конфигурации `audit 3012` в `.claude/launch.json` (` M` в `git status`) и папка `docs/audit-2026-09/`.

---

## 0. Результаты прогонов (дословно, обрезан только шум)

**Окружение:** `node v24.11.0`, `npm 11.6.1`, установленный `electron 31.7.7`.

**`cd hotel-booking/server && npm test`**
```
> hotel-booking-server@1.0.0 test
> vitest run
 RUN  v5.0.0 C:/Users/abzal/OneDrive/Desktop/Book_manager/hotel-booking/server
 Test Files  17 passed (17)
      Tests  402 passed (402)
   Duration  1.72s (tests 58%, transform 21%, import 19%, worker 2%)
EXIT=0
```

**`cd hotel-booking/client && npx tsc --noEmit`** — пустой вывод, `EXIT=0` (при `strict`, `noUnusedLocals`, `noUnusedParameters`).

**`cd hotel-booking && npm ls --depth=0`**
```
hotel-booking@1.0.0
+-- UNMET DEPENDENCY concurrently@^8.2.2
`-- UNMET DEPENDENCY wait-on@^7.2.0
npm error missing: concurrently@^8.2.2, required by hotel-booking@1.0.0
npm error missing: wait-on@^7.2.0, required by hotel-booking@1.0.0
```

**`npm audit` — сводка (`metadata.vulnerabilities`)**

| Пакет | total | critical | high | moderate | low | prod/dev deps |
|---|---|---|---|---|---|---|
| `server/` | 11 | 0 | 3 | 8 | 0 | 242 / 89 |
| `client/` | 11 | 0 | 8 | 2 | 1 | 48 / 104 |
| `electron/` | 13 | 1 | 11 | 1 | 0 | 31 / 315 |

`server/` (полный список advisories):
```
body-parser <=1.20.6            moderate  GHSA-v422-hmwv-36x6 (DoS при невалидном limit)     fix: npm audit fix
brace-expansion 3.0.0-5.0.8     high      GHSA-3jxr-9vmj-r5cp, GHSA-mh99-v99m-4gvg, GHSA-rgw5-rvv9-x895  fix: npm audit fix
qs 2.2.5-6.15.3                 moderate  GHSA-x5fp-wj9c-mxmx, GHSA-4mjr-xmp4-gh2g  (через express 4.22.2)  fix: npm audit fix
socket.io-parser 4.0.0-4.2.6    high      GHSA-2m8v-j782-fhvr (Zero-attachment Memory Exhaustion)  fix: npm audit fix
uuid <11.1.1                    moderate  GHSA-w5hq-g745-h8pq (через exceljs, node-cron 3.0.x)  fix: --force → node-cron@4.6.0 (breaking)
ws 8.0.0-8.20.1                 high      GHSA-58qx-3vcg-4xpx (uninitialized memory), GHSA-96hv-2xvq-fx4p (memory exhaustion DoS)
                                          через engine.io 6.6.7 / socket.io-adapter  fix: npm audit fix
11 vulnerabilities (8 moderate, 3 high)
```
Установлено фактически: `ws@8.18.3`, `engine.io@6.6.7`, `socket.io-parser@4.2.6`, `qs@6.15.2`, `body-parser@1.20.5`, `uuid@8.3.2`.

`client/`:
```
@babel/core <=7.29.0   (low)    GHSA-4x5r-pxfx-6jf8  build-time                       fix: npm audit fix
axios 1.0.0-1.17.0     high     10 advisories (prototype pollution, formToJSON DoS, maxBodyLength bypass, NO_PROXY, form-data CRLF)  fix: npm audit fix
browserslist <=4.28.6  high     GHSA-c83g-rgw3-j3cx, GHSA-73wf-gq98-2v4g  build-time     fix: npm audit fix
esbuild <=0.24.2       moderate GHSA-67mh-4wv8-2f99 (dev-server CORS)  через vite <=6.4.2  fix: --force → vite@8.2.2 (breaking)
form-data 4.0.0-4.0.5  high     GHSA-hmw2-7cc7-3qxx                                       fix: npm audit fix
nanoid <=3.3.17        high     GHSA-28wg-ghj8-5hjv, GHSA-2v37-7h3g-55p8  через postcss     fix: npm audit fix
postcss <=8.5.22       high     GHSA-fxqj-rqcc-2cmp, GHSA-r28c-9q8g-f849  build-time      fix: npm audit fix
socket.io-parser 4.2.6 high     GHSA-2m8v-j782-fhvr                                       fix: npm audit fix
ws 8.0.0-8.20.1        high     через engine.io-client                                    fix: npm audit fix
11 vulnerabilities (1 low, 2 moderate, 8 high)
```

`electron/`:
```
@xmldom/xmldom 0.9.0-0.9.11     moderate GHSA-6gmq-8vp8-gcm6                              fix: npm audit fix
app-builder-lib <=26.14.0        high    GHSA-7g7r-gx96-252g (+ builder-util, dmg-builder, electron-publish, tar)  fix: --force → electron-builder@26.15.3
brace-expansion                  high    ×3 (5 копий в дереве)                             fix: npm audit fix
builder-util-runtime <9.7.0      high    GHSA-p2f4-r6v6-j797 (утечка PRIVATE-TOKEN/Authorization при cross-origin redirect)  fix: --force
electron <=40.10.2 …             high    32 advisories (ASAR integrity bypass, contextBridge, UAF ×4, IPC spoof, protocol handlers, DevTools …)
                                         fix: --force → electron@44.2.0 (breaking)
extract-zip *                    high    GHSA-jmr9-qjv8-65gv (symlink traversal)            fix: --force
js-yaml 4.0.0-4.3.0              high    GHSA-52cp-r559-cp3m, GHSA-5p4m-2wfm-xmqj           fix: npm audit fix
tar <=7.5.20                     CRITICAL 12 advisories (path traversal, symlink poisoning, DoS)  fix: --force → electron-builder@26.15.3
13 vulnerabilities (1 moderate, 11 high, 1 critical)
```

**`npm outdated`**

`server/`:
```
Package             Current  Wanted       Latest
@prisma/client       5.22.0  5.22.0       7.10.0
bcryptjs              2.4.3   2.4.3        3.0.3
dotenv               16.6.1  16.6.1       17.4.2
express              4.22.2  4.22.2        5.2.1
express-rate-limit    7.5.1   7.5.1        8.7.0
helmet                7.2.0   7.2.0        8.3.0
node-cron             3.0.3   3.0.3        4.6.0
prisma               5.22.0  5.22.0  8.0.0-rc.13
```
(`vitest 5.0.0`, `socket.io`, `jsonwebtoken`, `winston`, `exceljs`, `docx`, `cors`, `express-validator`, `nodemon` — на последних версиях, в выводе отсутствуют.)

`client/`:
```
Package                          Current   Wanted   Latest
@fontsource-variable/geist         5.2.9    5.3.0    5.3.0
@fontsource-variable/geist-mono    5.2.8    5.3.0    5.3.0
@tanstack/react-virtual          3.13.24  3.14.10  3.14.10
@types/react                     18.3.28  18.3.31  19.2.18
@types/react-dom                  18.3.7   18.3.7   19.2.7
@vitejs/plugin-react               4.7.0    4.7.0    6.1.1
axios                             1.16.1   1.20.0   1.20.0
date-fns                           3.6.0    3.6.0    4.4.0
react                             18.3.1   18.3.1   19.2.8
react-dom                         18.3.1   18.3.1   19.2.8
react-hook-form                   7.76.0   7.87.0   7.87.0
typescript                         5.9.3    5.9.3    7.0.2
vite                              5.4.21   5.4.21    8.2.2
zustand                            4.5.7    4.5.7   5.0.15
```

`electron/`:
```
Package           Current   Wanted   Latest
electron           31.7.7   31.7.7   44.2.0
electron-builder  24.13.3  24.13.3  26.15.3
```

`hotel-booking/` (корень, пакеты не установлены — `npm view`): `concurrently` latest **10.0.5** (объявлен `^8.2.2`), `wait-on` latest **9.1.0** (объявлен `^7.2.0`).

---

## 1. Находки

### D9-001 · [Тяжесть 2] Уязвимые `ws`/`socket.io-parser` под Socket.io: неаутентифицированный клиент из LAN может исчерпать память сервера хоста
- Направление: 9 · Класс: доступность
- Окружение: оба (в упаковке — тот же `server/node_modules`)
- Где: `server/node_modules/ws@8.18.3` (через `engine.io@6.6.7`), `server/node_modules/socket.io-parser@4.2.6`; точка аутентификации сокета — `server/src/socket/socketManager.js:88-94` (`io.use` → `jwt.verify`), то есть **после** установления WebSocket-соединения на уровне engine.io/ws.
- Что: GHSA-96hv-2xvq-fx4p («memory exhaustion DoS from tiny fragments», `ws` ≤ 8.20.1) и GHSA-58qx-3vcg-4xpx срабатывают на транспортном уровне до `io.use`; GHSA-2m8v-j782-fhvr (`socket.io-parser`) — при разборе первого же пакета CONNECT, тоже до проверки JWT. `express-rate-limit` на `/socket.io/` upgrade-запросы не распространяется (Socket.io перехватывает путь на уровне http-сервера). Сервер слушает `HOST=0.0.0.0` (`.env.example:10`, план напр. 8), то есть порт 3001 виден любому устройству в сети отеля, включая гостевой Wi-Fi, если он не отделён от служебного.
- Сценарий (гипотеза): любое устройство в той же сети (гость, чужой ноутбук) открывает WebSocket на `http://<хост>:3001/socket.io/` и шлёт поток крошечных фрагментов → процесс Node растёт до OOM → падает; Electron перезапускает сервер один раз (fix-waves E2), второе падение — диалог и стойка без программы до ручного перезапуска.
- Проверка: `cd hotel-booking/server && npm ls ws socket.io-parser engine.io` (версии в диапазонах advisories); `grep -n "io.use" src/socket/socketManager.js` (строка 88 — аутентификация после соединения); `npm audit --json | node -e "…"` — для `ws`, `socket.io-parser` поле `fixAvailable` без `isSemVerMajor`, то есть закрывается обычным `npm audit fix` без смены мажора. Эксплойт не воспроизводился.
- Последствия: остановка всех рабочих мест отеля до перезапуска; данных не теряет.
- Уже известно: нет (план напр. 8 просил `npm audit` только для `electron/`).
- Связано с: D1 (CORS/LAN-политика, rate-limit только по HTTP), D8 (перезапуск сервера один раз, `HOST=0.0.0.0`), D9-014.
- Уверенность: предположение (диапазоны версий и точка аутентификации подтверждены; сам DoS не воспроизводился).

### D9-002 · [Тяжесть 3] `.mcp.json` закоммичен с паролем базы и привязан к машине разработчика
- Направление: 9 · Класс: гигиена (доступ)
- Окружение: dev
- Где: `.mcp.json:15` — `postgresql://postgres:password@localhost:5432/hotel_booking` (в git с первого коммита `176805a` 2026-06-18, ни разу не менялся).
- Что: в репозитории лежит реальная строка подключения к dev-базе с **живыми данными гостей** (NOTES:27 «база рабочая, с живыми данными»). Пароль — тот же дефолтный `password`, что в `.env.example:4` и в открытом пункте NOTES:425 («Пароль БД `postgres:password`»), поэтому «секрет» условный; но файл ещё и машинно-специфичен (`cmd /c npx` — Windows), при этом `.claude/settings.local.json` в `.gitignore` есть, а `.mcp.json` — нет и шаблона `.mcp.json.example` нет.
- Сценарий: репозиторий приватный (проверено), утечка возможна только через доступ к GitHub-аккаунту или клон на чужой машине; тогда строка даёт готовый доступ к базе на dev-машине, если Postgres 5432 виден по сети (в dev он слушает localhost — не проверял `listen_addresses`).
- Проверка: `git log --format='%h %ad' -- .mcp.json` → один коммит; `grep -c 'postgres:password@' .mcp.json` → 1; `gh api repos/OralbekovAbzal/book_manager --jq .private` → true.
- Последствия: при смене пароля dev-базы (NOTES:425 просит это сделать) строка в git станет ещё и ложной; при публикации репозитория — учётные данные наружу.
- Уже известно: NOTES.md «Пароль БД `postgres:password` в dev-окружении» (открыт) — там про сам пароль, не про файл в git.
- Связано с: D1 (дефолтные секреты dev).
- Уверенность: подтверждено.

### D9-003 · [Тяжесть 3] `npm run dev` / `npm run dev:electron` из `hotel-booking/` не работают: `concurrently` и `wait-on` не установлены, корневого lock-файла нет
- Направление: 9 · Класс: гигиена
- Окружение: dev
- Где: `hotel-booking/package.json:6,9,25-26`; `hotel-booking/node_modules` отсутствует; `hotel-booking/package-lock.json` отсутствует (в `git ls-files` только три lock-файла: `server/`, `client/`, `electron/`); `CLAUDE.md:12,15` объявляет эти команды основным способом запуска.
- Что: `npm ls` в `hotel-booking/` даёт `UNMET DEPENDENCY concurrently@^8.2.2`, `wait-on@^7.2.0`; глобально их тоже нет (`npm ls -g` пуст). Значит первая строка таблицы «Запуск и команды» в CLAUDE.md падает с `'concurrently' is not recognized`. Скрипт `install:all` (`:22`) их бы поставил, но никогда не запускался на этой машине, и без lock-файла версии не зафиксированы.
- Сценарий: новый агент/разработчик читает CLAUDE.md, запускает `npm run dev` — ошибка; реально проект запускают через `.claude/launch.json` (NOTES:113-115) или `start-all.bat` (абсолютные пути этой машины).
- Проверка: `cd hotel-booking && npm ls --depth=0` (вывод в разделе 0); `ls hotel-booking/node_modules` → нет.
- Последствия: документация обещает нерабочий путь; на новой машине воспроизвести окружение по CLAUDE.md нельзя.
- Уже известно: NOTES.md «Стабильность dev-процессов» (открыт) — смежный пункт, не тот же.
- Связано с: D9-006, D9-016.
- Уверенность: подтверждено.

### D9-004 · [Тяжесть 3] devDependencies сервера попадают в установщик (~37 МБ инструментов сборки/тестов внутри программы)
- Направление: 9 · Класс: гигиена
- Окружение: упаковка
- Где: `electron/package.json:44-62` — `extraResources` копирует `../server` целиком с фильтром, исключающим только `node_modules/nodemon/**`, `test/**`, `vitest.config.mjs`, `.env*`, `logs/`, `backups/`, `scripts/`, `node_modules/.bin/**`. `server/package.json:36-39` — devDeps `nodemon`, `vitest`.
- Что: `vitest@5` тянет `vite`, `@rolldown` (20 МБ, нативный бинарник), `lightningcss-win32-x64-msvc` (10 МБ, нативный), `@vitest`, `@types` — всё это лежит в `server/node_modules` и по фильтру едет в `resources/server/node_modules` установщика (181 МБ `Система бронирования Setup 1.0.0.exe` от 06.09). Размеры: `@rolldown` 20 МБ, `lightningcss…` 10 МБ, `vitest` 3, `vite` 3, `@vitest` 1, `@types` 3 (`du -sm` по `server/node_modules`). Это не только вес: лишние нативные бинарники и `esbuild`-подобные инструменты — лишняя поверхность в каталоге программы у клиента.
- Сценарий: клиент получает установщик с тест-раннером и бандлером внутри; при обновлении устанавливается всё то же.
- Проверка: `du -sm hotel-booking/server/node_modules/{@rolldown,lightningcss-win32-x64-msvc,vitest,vite,@vitest}`; сверить `electron/package.json` фильтр (нет `!node_modules/vitest/**` и т. п.); распаковка установщика не делалась.
- Последствия: +~37 МБ к установщику и к `%ProgramFiles%`, сборка не воспроизводима без `npm ci --omit=dev` (которого в скриптах нет).
- Уже известно: нет.
- Связано с: D8 (состав сборки, `asar:false`).
- Уверенность: предположение (по фильтру и размерам на диске; установщик не вскрывал).

### D9-005 · [Тяжесть 3] `.claude/launch.json` закоммичен с 10 конфигурациями чужого проекта `diploma/` и абсолютными путями этой машины
- Направление: 9 · Класс: гигиена
- Окружение: dev
- Где: `.claude/launch.json` в HEAD (`git show HEAD:.claude/launch.json`): конфигурации «Gateway», «Auth Service», «Concert Service», «Musician Service», «Contract Service», «Loyalty Service», «Notification Service», «Analytics Service», «Chat Service», «Admin Panel» (11 упоминаний `diploma`), плюс 4 «Hotel …»; 16 вхождений `C:/Users/abzal/…`.
- Что: файл проекта хранит конфиги другого репозитория (`C:/Users/abzal/OneDrive/Desktop/diploma`, папка существует на диске) и конфликтует по портам: «Auth Service» 3001 против «Hotel Server» 3001, «Admin Panel» 5173 против «Hotel Client» 5173. Все пути абсолютные, на другой машине ни одна конфигурация не запустится. Коммиты: `176805a` (06.2026), `91c9b8f` (04.09), `7b18774` (07.09).
- Сценарий: коллега/агент открывает проект — Browser pane предлагает 14 конфигураций, 10 из них к отелю не относятся, 2 пары делят порты.
- Проверка: `git show HEAD:.claude/launch.json | grep -c diploma` → 11; `… | grep -oE '"port": [0-9]+' | sort | uniq -c` → 3001 ×2, 5173 ×2.
- Последствия: шум и риск запустить чужой сервис на порту отеля; невоспроизводимость.
- Уже известно: нет.
- Связано с: D9-003, D9-016 (`start-all.bat`, `.wsb` тоже с абсолютными путями — у напр. 8).
- Уверенность: подтверждено.

### D9-006 · [Тяжесть 3] `CLAUDE.md` устарел: 19 утверждений расходятся с кодом (агенты читают его первым)
- Направление: 9 · Класс: гигиена
- Окружение: dev
- Где: `CLAUDE.md` (изменён 04.09 15:23, тесты появились 04.09 — но утверждение «тестов нет» осталось). Построчно:

| Строка | Утверждение | Факт (доказательство) | Исправление |
|---|---|---|---|
| :12 | `npm run dev` — backend + frontend (concurrently) | `concurrently` не установлен, команда падает (D9-003) | либо `npm install` в `hotel-booking/` + lock в git, либо убрать корневые скрипты и описать `launch.json` |
| :13 | `dev:server` — nodemon, порт 3001 | скрипт верен (`server/package.json:7`), но NOTES:113 — 3001 держит установленная программа, dev на 3011 через `API_TARGET` (`client/vite.config.ts:4-7`); NOTES:563 — «в dev обычный `node server.js`, не nodemon» | описать оба режима и порт 3011 |
| :15 | `dev:electron` | тот же `concurrently` + `wait-on` — не работает | — |
| :17-20 | четыре db-скрипта | в `package.json` ещё `db:migrate:create/status/baseline/deploy/prod`, `install:all` (`:14-18,22`) | дополнить; `db:migrate:prod` = `db:migrate:deploy` (дубль) |
| :19 | `db:seed` — «засев тестовых данных» | `seed.js` делает `admin.upsert` и сбрасывает пароль главного администратора (план аудита; NOTES:431) | предупредить: на базе с данными не запускать |
| :22 | `start-all.bat` поднимает backend и frontend | абсолютные пути `C:\Users\abzal\…` — только эта машина | — |
| :32 | node-cron — «бэкапы, снапшоты» | `cron.schedule` только в `utils/backup.js:787` (03:00); снимки — дебаунс после мутаций (`socketManager.js:172-184`), не cron | «ночная копия»; снимки по событиям |
| :33 | winston — `server/logs/` | `LOG_PATH=logs` относителен cwd: на диске `server/logs/` (2,3 МБ), `server/src/logs/` (пустые, 03.09), `hotel-booking/logs/` (04.09) | указать зависимость от cwd |
| :52 | контроллеры «booking, room, allotment, optimize, …» | 21 контроллер, в т. ч. `payment`, `report`, `license`, `guest`, `setup`, `user`, `roomFund` | — |
| :54 | middleware: auth, validate, errorHandler | ещё `audit.js`, `license.js` | дополнить |
| :56 | utils: overlap, businessDate, snapshot, backup, flagEffects | `overlap.js` мёртв с 04.09 (NOTES:332); 15 файлов, в т. ч. `availability`, `allotment`, `charges`, `bookingMoney`, `license`, `sessions`, `passwordPolicy`, `corsOrigin` | заменить `overlap` → `availability` |
| :57 | «14 моделей» | 25 моделей (`grep -c '^model ' schema.prisma`), 8 миграций | — |
| :49-57 | нет `src/reports/` | движок отчётов: 9 файлов + `datasets/` (5) + `definitions/` (5 JSON), свой язык формул | добавить (это ~1 700 строк) |
| :61 | сторы: auth, grid, settings | ещё `useRoomFundStore`, `useLicenseStore` | — |
| :68 | «Пересечения — `utils/overlap.js`» | реальная проверка: `utils/availability.js` → `findRoomBlock` в `bookingController` + constraint `booking_no_overlap`; `overlap.js` никто не `require`'ит | — |
| :72 | снапшоты и бэкапы «по расписанию через node-cron» | снимки не по расписанию (см. :32) | — |
| :74 | «Лицензии — `routes/license.js`, проверка против `LICENSE_SERVER_URL`» | офлайн Ed25519: `utils/license.js`, `middleware/license.js`; `LICENSE_SERVER_URL` выкинут 06.09 (`routes/license.js:7`, `.env.example:25-27`) | — |
| :86 | «Линтера и тестов в проекте нет» | 17 файлов vitest, 402 теста, `cd server && npm test` зелёный; линтера действительно нет | «тестов нет» → «тесты: `cd server && npm test`; клиентских нет» |
| :87 | «Секреты — в `server/.env`… Шаблон — `.env.example`» | шаблон лежит в `hotel-booking/.env.example`, а dotenv читает `server/.env` — копировать надо с переносом в другую папку | указать путь |

- Сценарий: четыре агента `.claude/agents/*` начинают с «прочитай CLAUDE.md» и наследуют: «тестов нет» (не прогоняют), «overlap.js — логика пересечений» (правят мёртвый модуль), «лицензия онлайн».
- Проверка: команды в таблице; `grep -rn "overlap')" server/src | grep require` → пусто.
- Последствия: неверные решения агентов, потерянное время; CLAUDE.md — единственный документ, который читают все.
- Уже известно: нет (план разведки называл 5 из 19).
- Связано с: D9-003, D9-007, D9-013.
- Уверенность: подтверждено.

### D9-007 · [Тяжесть 3] `.claude/agents/*` расходятся с реальной структурой и состоянием проекта
- Направление: 9 · Класс: гигиена
- Окружение: dev
- Где / Что:
  - `hotel-server.md:24` — «Пересечения броней — `utils/overlap.js` плюс exclusion-constraint» → модуль мёртв (NOTES:332-333), рабочая проверка в `utils/availability.js`.
  - `hotel-server.md:36` — «тесты покрывают overlap, бизнес-дату, квоты, буферы меток и оптимизатор» → 17 файлов, включая деньги, снимки, копии, лицензию, сессии, реквизиты, документ гостя (список — Приложение A).
  - `hotel-tests.md:24` — «около сотни тестов: `overlap`, `businessDate`, `allotment`, `flagEffects`, чистые функции оптимизатора» → 402 теста в 17 файлах.
  - `hotel-schema.md:17` — исключительная зона `electron/db/**` → там только `seed.sql` (данные: админ, категории, метки) и `README.md`; схемы нет, а `seed.sql` по смыслу дублирует `prisma/seed.js` (расхождение — у напр. 8).
  - `hotel-client.md:36`, `hotel-server.md:31`, `hotel-schema.md:31`, `hotel-tests.md:42` — «бэкенд на 3001 общий» → NOTES:113-115: 3001 занят установленной программой, dev на 3011/5174.
  - Все четыре — «прочитай CLAUDE.md» → наследуют D9-006.
  - `hotel-tests.md:18` требует помечать найденные ошибки `it.fails` — сейчас таких 0 (`grep -rnE "it\.(fails|skip|only|todo)" server/test` → пусто), правило соблюдено.
- Сценарий: агент `hotel-server` правит `overlap.js` под задачу о пересечениях; агент `hotel-schema` считает `electron/db/seed.sql` частью схемы.
- Проверка: строки выше; `ls electron/db` → `README.md seed.sql`.
- Последствия: те же, что D9-006.
- Уже известно: нет; NOTES:82-85 фиксирует только факт заведения агентов.
- Связано с: D9-006, D8 (`seed.js` ≠ `seed.sql`).
- Уверенность: подтверждено.

### D9-008 · [Тяжесть 3] NOTES.md: три открытых пункта уже закрыты кодом, один — самим журналом
- Направление: 9 · Класс: гигиена
- Окружение: dev
- Где / Что (файл:строка как доказательство):
  1. **NOTES:396-398 «Вкладка «Гости» в справочнике» `[ ]`** (и идея NOTES:170-184) — закрыто: `client/src/components/Reference/GuestsTab.tsx` (690 строк, коммит `9389097` 06.09); `server/src/controllers/guestController.js:47` `normalizePhone`, `:198` группировка `key = normalizePhone(b.guestPhone)`, `:355,:372` `lookup` по нормализованному телефону — ровно то, что пункт просил («ключ — телефон», «нормализация `+7`/`8`/скобок»). NOTES:54 сам ссылается на «карточку гостя» и `GET /guests/lookup`.
  2. **NOTES:399-400 «Пресет экстренных контактов» `[ ]`** (и NOTES:76 «после 1.0», идея NOTES:186-189) — закрыто: `server/src/controllers/contactController.js:101-116` `createDefaults` («Скорая помощь 103», «Пожарная 101», «Полиция 102» + аварийные), `routes/contacts.js:20` `POST /contacts/defaults`, `client/src/api/contacts.ts:36`, кнопка в `ReferenceWindow.tsx:169`.
  3. **NOTES:273-278 «Лицензирование — модель ВЫБРАНА» `[ ]`** (раздел «Мешают выпуску») — закрыто 06.09 самим журналом (NOTES:57 ✅ Ed25519, лимит номеров, гейт 402), подзадача «`routes/license.js` с `LICENSE_SERVER_URL` — выкинуть» выполнена (`routes/license.js:7`, `.env.example:25-27`). Также NOTES:34 «Лицензирование — не начинали» в карте волны 3 — устарело.
  4. NOTES:226-227 «из тридцати пунктов семнадцать закрыты» — с учётом трёх выше счёт другой.
- Не закрыто (правильно висит): NOTES:77/405 `overlap.js` + тест и `RoomFundSettings.tsx` — оба на месте (D9-013); NOTES:350 «107 броней» — решение; NOTES:368 льгота — решение; NOTES:401 бэктест — напр. 3; NOTES:443,446,449 — напр. 3/2/6; NOTES:451 — см. раздел 3.
- Проверка: `ls client/src/components/Reference/`; `grep -n "normalizePhone" server/src/controllers/guestController.js`; `grep -n "103\|createDefaults" server/src/controllers/contactController.js`; `grep -rn LICENSE_SERVER_URL server/src`.
- Последствия: раздел «Открытые проблемы» завышает долг; агенты могут повторно «сделать» готовое.
- Уже известно: нет.
- Связано с: D9-009.
- Уверенность: подтверждено.

### D9-009 · [Тяжесть 3] NOTES.md: внутренние противоречия и утверждения, устаревшие относительно кода
- Направление: 9 · Класс: гигиена
- Окружение: dev
- Где / Что:
  - **NOTES:502-505 «Порты: Backend 3001, Frontend 5173»** против NOTES:113-115 (3001 занят установленной программой, dev — 3011/5174) и `client/vite.config.ts:4-7`.
  - **NOTES:563 «Сервер в dev — обычный `node server.js`, не nodemon»** против `server/package.json:7` (`dev: nodemon server.js`) и CLAUDE.md:13; NOTES:581-582 тут же признаёт nodemon «при `npm run dev` в foreground». Верно оба — в зависимости от способа запуска, но читается как противоречие.
  - **NOTES:567-568 «`prisma/sql/booking_no_overlap.sql` … тот же текст в `init.sql`»** — `init.sql` удалён (NOTES:470, :521; `find . -name init.sql` → пусто). Одновременно NOTES:540-544 говорит, что constraint живёт в `0_init` — два источника одного SQL (`prisma/sql/` и миграция; кто прав — напр. 8).
  - **NOTES:60 «Открытыми остаются … «Сохранить PDF» внутри Electron»** против NOTES:55 «„Печать“ / „Сохранить PDF“ (Electron)» в графе ✅ того же раздела. Код: мост есть (`electron/main.js:820` `report:savePdf`, `preload.js:30`, `Print/PrintPreview.tsx:127`, `Reports/ReportsScreen.tsx:216`); работает ли в упаковке — напр. 7/8.
  - **NOTES:117-168** — 52 строки разведки отзыва JWT («Проблема», «Какой вариант правильный», «Где править код») лежат в «Активных идеях» после того, как пункт сделан (NOTES:87-115). По правилу NOTES:19 («разросся — вынеси») это кандидат в `docs/decisions/` или архив.
  - **NOTES:45, :57, :60** — ссылки на `Qonaq — документы/…` (спецификация 1.0, приватный ключ, отчёт 06.09): папка лежит вне репозитория (`../Qonaq — документы` на Desktop/OneDrive), из репо на неё ссылок нет — агенты и клон её не видят.
  - **NOTES:592-593** — отчёты бэктеста и `room-fund-*.json` в `backups/`, а `backups/` в `.gitignore` (`hotel-booking/.gitignore:6`): три `optimizer-backtest-*.md` (06.17, 06.18, 09.07) существуют только на этой машине.
- Проверка: строки выше; `git check-ignore -v hotel-booking/backups`.
- Последствия: журнал — «читать всегда» (CLAUDE.md:89); противоречия стоят времени каждому читателю.
- Уже известно: нет.
- Связано с: D9-008, D9-010, D8.
- Уверенность: подтверждено.

### D9-010 · [Тяжесть 3] `docs/decisions/*` отстают от журнала: решения 04–07.09 не вынесены, три файла содержат утверждения, опровергнутые кодом
- Направление: 9 · Класс: гигиена
- Окружение: dev
- Где / Что:
  - **`desktop-and-ops.md`** — 19 строк, единственная запись от 2026-06-18. TODO в `:14-18` (base URL клиента, CORS, статический IP, брандмауэр) закрыты режимом хост/клиент (NOTES:482, fix-waves «Мастер первого запуска»), но не отмечены. Отсутствуют решения: хост/клиент в Electron (03.09), пароль сисадмина в `config.json` (fix-waves:86-92), встроенный Postgres + `migrate deploy` при старте (описано в `data-and-money.md:23-31`, не здесь), JSON-копии без `pg_dump` (fix-waves E1), «сервер обновлений не поднимаем» (NOTES:267-272), штамп `buildDate` (NOTES:57-58), `SNAPSHOT_KEEP_*`/`BACKUP_TZ`.
  - **`interface.md`** — последняя запись 2026-09-02. `:40-42` «„Тарифы и наличие“ и „Отчёты“ показывают заглушку … перед показом клиенту убрать из меню» — оба раздела реализованы (`Rates/RatesScreen.tsx` 721 строка, `Reports/ReportsScreen.tsx` 485). `:22-23` «таблицу пришлось дописать в `init.sql`» — датировано, но без пометки «устарело 04.09». Нет записей о разделах «Касса», «Справочник → Гости», печать, лицензия, окно «Аудит», диалог восстановления (`restoreUi.tsx`), контекстное меню `CHECKED_OUT` для ролей (NOTES:494-496).
  - **`reports.md:111`** — «`prisma/schema.prisma` + `electron/db/init.sql`»; `:158-160` «Финансовых отчётов пока нет и не может быть» — опровергнуто 06.09 (NOTES:56: датасеты `charges`/`payments`, три определения), записи о финансовых датасетах в `reports.md` нет.
  - **`data-and-money.md:147-148`** «схема + `init.sql`»; `:153-156` «Что осталось: экран „Тарифы“, генератор начислений, переделка `BookingModal`, услуги, перенос `PricingConfig`» — всё сделано (тот же файл `:77-105`, NOTES:479-481), не отмечено. Нет записей: шесть полей документа гостя на `Booking` («отдельной сущности намеренно нет — комментарий в схеме», NOTES:54), реквизиты в `HotelSettings` (NOTES:55), `utils/bookingMoney.js` как единый расчёт (NOTES:56), `Admin.tokenVersion` (NOTES:89).
  - **`bookings.md`** — нет записей: единая `utils/availability.js` (NOTES:318-333), деньги при сплите `move` (NOTES:475), `checkOut` день-в-день → `CANCELLED` (NOTES:473), фактическое время заезда/выезда (NOTES:485-498), обход квоты `allowAllotmentOverride` (NOTES:471), окно `findBufferConflict` (NOTES:439). Всё это живёт только в разделе «Закрыто» NOTES.
  - **`archive/audits-2026-06.md:3`** «отметки о закрытии проставлены» — 10 пунктов остались `[ ]`, хотя закрыты по NOTES: отзыв JWT (:37 ↔ NOTES:437), `exec()` в бэкапе (:33 ↔ :461), CORS (:39 ↔ :483), `checkOut` удалял бронь (:70 ↔ :473), `move` вне транзакции (:73 ↔ :334), сплит обнулял деньги (:76 ↔ :475), два ноута (:94 ↔ :482), метки из localStorage (:107 ↔ :484), особенности в localStorage (:109 ↔ :373), цены (:114 ↔ :479). Архив исторический — но план аудита требует перепроверки именно таких «заявлено».
  - **`archive/fix-waves-2026-09.md:8,60`** «не закоммичено» — закоммичено `91c9b8f` (04.09); исторически верно.
- Проверка: `wc -l docs/decisions/*.md` (156/45/55/19/166); grep по строкам выше.
- Последствия: агент напр. `hotel-client` читает `interface.md` и видит «Отчёты — заглушка»; правило CLAUDE.md:90-95 («решения вынесены по областям») выполнено только для решений до 04.09.
- Уже известно: нет.
- Связано с: D9-009, D9-006.
- Уверенность: подтверждено.

### D9-011 · [Тяжесть 3] Покрытие тестами: 11 из 21 контроллеров, 22 из 23 роутов, весь язык формул отчётов и валидация определений не загружаются ни одним тестом
- Направление: 9 · Класс: гигиена (риск на будущее)
- Окружение: dev
- Где: `server/test/*.test.js` (17 файлов) против `server/src/**` (карта — Приложение A).
- Что: по `grep -oE "'src/[^']+'"` в тестах не загружаются вовсе: контроллеры `allotment`, `bookingFlag`, `category`, `contact`, `occupancy` (грид, `$queryRaw`, кэш), `partner`, `payment` (приём/возврат/отмена/`recalcBookingPaid` — **деньги**), `rate` (`generate_series`/`ON CONFLICT`), `report`, `service`, `shift` (`nextDay`); утилиты `corsOrigin`, `passwordPolicy` (единственный источник правила пароля, «зеркало» на клиенте — тексты должны совпадать дословно, archive:26-27), `logger`; `reports/{expr,registry,export,options,vocab,dateUtils}.js` (парсер/интерпретатор формул, `validateDefinition`, CSV/xlsx/docx), `datasets/roomNights.js`, определения `occupancy.json`, `bookings-registry.json`; `routes/*` кроме `hotel.js` (значит цепочки `express-validator` и `requireRole` 22 роутов не проверяются); `app.js`, `server.js`; `prisma/seed.js`; `scripts/*`. Частично: `bookingController` (create/update/move/check-availability, документ гостя; **нет** `checkin/checkout/cancel/actual-times/charges*`), `optimizeController` (только чистые функции через `append`; **нет** `optimize()`/`apply()` с `DEFERRED`), `roomController` (только лимит лицензии в `create`), `setupController` (только `signToken`), `userController` (только `setPassword`), `charges.js` (только `buildAutoCharges`; **нет** `rebuildAutoCharges`/сохранения), `socketManager` (только версия сессии; **нет** `emitBookingEvent`/`gridCache`/авто-снимка). Клиентских тестов — 0 (в `client/package.json` нет тест-раннера); `calculator.ts` ↔ `charges.js` (напр. 5) не сверяется автоматически.
- Сценарий: правка в `paymentController.recalcBookingPaid` или в `expr.js` — тесты зелёные при любой ошибке.
- Проверка: `for f in server/test/*.test.js; do grep -oE "'src/[^']+'" $f; done | sort -u` — 27 модулей из ~75 в `server/src`.
- Последствия: зелёный прогон не покрывает деньги в кассе, отчёты и права на роутах.
- Уже известно: частично — `.claude/agents/hotel-tests.md` («что ценно проверять: деньги при делении сумм…»), план аудита.
- Связано с: D9-012, D2 (`paymentController`), D4 (`expr.js`), D1 (`validate`/`requireRole` на роутах).
- Уверенность: подтверждено.

### D9-012 · [Тяжесть 3] `fakePrisma` не воспроизводит транзакции, `onDelete`, уникальные и exclusion-constraint'ы, `@db.Date`, raw-SQL и половину операторов Prisma — целые классы ошибок тесты не поймают в принципе
- Направление: 9 · Класс: гигиена (риск на будущее)
- Окружение: dev
- Где: `server/test/helpers/fakePrisma.js` (209 строк), локальные мини-базы в `backup.test.js:~60-130`, `snapshot.test.js:~60-140`, `roomFund.test.js:73`.
- Что (семантика → что не ловится):
  1. **Транзакции** — `$transaction(fn)` = `fn(prisma)` (`fakePrisma.js:198-201`, «без отката: проверяем ПОРЯДОК»): нет отката при ошибке посередине, нет `timeout`/`maxWait` (P2028 при 5 с — план напр. 2), нет изоляции/гонок READ COMMITTED, нет `SET CONSTRAINTS … DEFERRED` (apply оптимизатора).
  2. **`onDelete` Cascade/SetNull/Restrict** — в общем фейке нет; в мини-базах `backup`/`snapshot` каскад дописан руками для `CASCADE_FROM_BOOKING` и `SET_NULL_FROM_ADMIN` (`backup.test.js:104-118`) — только эти связи. Не ловится: `Allotment.partner/room` Cascade, `Service → BookingService` Cascade, Restrict у `Booking.room/createdBy` (P2003).
  3. **Уникальность и exclusion** — `createMany` проверяет дубли только по `id/code/name` (`:146-155`), `create`/`update` — ничего. Не ловится: двойная бронь `booking_no_overlap` (23P01 → 409 через `errorHandler`), дубль `Shift.date`, `Admin.username`, `ReportDefinition.key`.
  4. **`@db.Date`** — фикстуры сами строят UTC-полночь (`d()`, `:206-209`); `Date` и `DateTime` не различаются; приведения/усечения времени нет. Не ловится: запись `checkIn` с временем ≠ 00:00Z, сравнение `@db.Date` с `DateTime`.
  5. **`$queryRaw` / `$executeRaw` / `$executeRawUnsafe`** — в общем фейке отсутствуют (модуль упадёт «not a function»); `backup`/`snapshot`/`roomFund` стабят как `async () => 0` (`backup.test.js:126`) — текст SQL не проверяется. Не ловится: `regexp_replace` (occupancy), `generate_series`/`ON CONFLICT` (rate), `array_replace` (roomFund), `setval` (backup/snapshot), `SET CONSTRAINTS` (optimize).
  6. **Нет операторов**: `upsert`, `aggregate`, `groupBy`, `deleteMany` (в общем фейке), `findFirstOrThrow`, вложенные `select`/`include` (только проверка наличия ключа — связи берутся «как в фикстуре»), `skip`/`take`/`distinct`, `mode: 'insensitive'`, `has/hasSome`, `startsWith/endsWith`, `path` по JSON, `connect`. Неизвестный оператор — исключение (правильно, честно), но следствие: модули с этими операторами (`payment`, `shift`, `bookingFlag`, `license.upsert`, `occupancy`, `routes/audit`) либо не тестируются, либо тестируются через свои стабы.
  7. **Express-цепочки** — поднимается только `routes/hotel.js`; `authenticate`/`requireRole`/`validate` остальных роутов не исполняются.
  8. **Побочные эффекты** — `emitBookingEvent` → массив (`bookingAvailability.test.js:150-157`), `invalidateGridCache`, авто-снимок, `logger` → `silentLogger`: ротация, PII в логах, сброс кэша не проверяются.
- Проверка: чтение `fakePrisma.js` (весь файл 209 строк) и указанных строк.
- Последствия: 402 зелёных теста доказывают правильность *запросов и порядка вызовов*, не поведение Postgres. Регрессии в constraint'ах, каскадах и транзакциях доедут до стойки.
- Уже известно: частично — комментарии в самих хелперах (`fakePrisma.js:196-197`, `backup.test.js:19-24`), `hotel-tests.md:30` («тесты не должны требовать живой базы… это замечание к архитектуре»).
- Связано с: D9-011, D2, D3, D8.
- Уверенность: подтверждено.

### D9-013 · [Тяжесть 3] Мёртвый код: `utils/overlap.js` + его 16 зелёных тестов, `RoomFundSettings.tsx` (416 строк), 7 функций API клиента
- Направление: 9 · Класс: гигиена
- Окружение: dev
- Где / Что:
  - `server/src/utils/overlap.js` (52 строки) — `grep -rn "overlap')" server/src | grep require` → пусто; `server/test/overlap.test.js` (148 строк, 16 тестов) — единственный потребитель. Тесты проверяют модуль, которого нет в рантайме, и создают ложное ощущение покрытия «пересечений» (см. `hotel-server.md:24,36`, CLAUDE.md:68).
  - `client/src/components/Settings/RoomFundSettings.tsx` (416 строк) — `grep -rn RoomFundSettings client/src` → только сам файл; со своим захардкоженным списком особенностей, противоречащим справочнику в БД (NOTES:405-408).
  - `client/src/api/allotments.ts:49` `createRelease`, `:54` `deleteRelease`; `api/bookingFlags.ts:24` `createBookingFlag`, `:29` `updateBookingFlag`, `:34` `deleteBookingFlag`; `api/payments.ts:133` `fetchShiftSummary`; `api/reports.ts:265` `fetchDatasets` — 0 импортов вне `api/` (проверено по каждому имени). `tsc` с `noUnusedLocals` этого не ловит — экспорты.
  - Побочно: `BookingFlagsSection.tsx` импортирует только `fetchBookingFlags` (`:3`) и ничего не мутирует — из интерфейса метки создать/изменить нельзя (вопрос владельцу, раздел 6; напр. 6).
- Проверка: команды выше.
- Последствия: ~620 строк, которые надо читать и поддерживать; ложное покрытие.
- Уже известно: NOTES.md «`utils/overlap.js` — мёртвый код (удалить с тестом) — после 1.0» (открыт, :77) и «Хвосты волны 3 → `RoomFundSettings.tsx`» (открыт, :405). Семь функций API — план разведки (напр. 5).
- Связано с: D5, D9-006, D9-007.
- Уверенность: подтверждено.

### D9-014 · [Тяжесть 3] Остальные advisories `npm audit` (35 всего): что реально достижимо в офлайн-десктопе, а что — только на машине сборки
- Направление: 9 · Класс: гигиена
- Окружение: оба
- Где: вывод `npm audit` ×3 (раздел 0).
- Что — по достижимости в отеле (без интернета, LAN, сервер `0.0.0.0:3001`, renderer грузит только свой бандл с `file://` при `contextIsolation`+`sandbox`):

| Пакет / advisory | Где исполняется | Достижимо в отеле? | Закрывается |
|---|---|---|---|
| `ws`, `socket.io-parser` (server) | рантайм сервера, до auth | **да** (D9-001) | `npm audit fix` |
| `qs` ×2, `body-parser` (server, via express 4.22.2) | рантайм, любой HTTP до auth | да, но DoS-класс и под `express-rate-limit`; `body-parser` — только при невалидном `limit` (в `app.js` не проверял) | `npm audit fix` |
| `uuid` <11.1.1 (server via `node-cron@3`, `exceljs`) | рантайм | нет — уязвимы v3/v5/v6 с `buf`, `node-cron`/`exceljs` используют v4 (предположение) | только `node-cron@4` (major) |
| `brace-expansion` (server, electron ×5) | glob/minimatch внутри инструментов | нет — нужен контролируемый паттерн | `npm audit fix` |
| `axios` ×10 (client) | renderer → только свой сервер | низко: prototype-pollution нужна предварительная порча прототипа, `form-data`/`NO_PROXY`/HTTP2 — Node-адаптер, в браузере не используется | `npm audit fix` (1.20.0) |
| `postcss`, `browserslist`, `@babel/core`, `nanoid`, `esbuild`/`vite` (client) | только `vite build`/dev-server на машине разработчика | нет | `npm audit fix` кроме `vite@8` (major) |
| `ws` via `engine.io-client` (client) | Node-only путь; в браузере нативный WebSocket | нет | `npm audit fix` |
| `electron@31.7.7` — 32 advisories | рантайм у клиента | **условно**: большинство требуют вредоносного веб-контента или macOS-API; в этом приложении путь — XSS через собственные данные (имена гостей в шаблонах печати — напр. 1/6) → `contextBridge`/IPC-обходы. Плюс `npm audit` **не показывает CVE Chromium 126** внутри Electron 31 — реальный список длиннее. Electron 31 вне поддержки (политика 3 последних мажоров; текущий 44) — точную дату EOL по сайту не проверял | только `electron@44` (13 мажоров; смена Node внутри → влияет на `embedded-postgres`, Prisma engines — напр. 8) |
| `tar` (critical ×12), `app-builder-lib`, `extract-zip`, `js-yaml`, `@xmldom` (electron) | только `electron-builder` на машине сборки; в установщик не входят (`files` — 5 файлов + `extraResources`) | нет | `electron-builder@26` (major) / `npm audit fix` для js-yaml, xmldom |
| `builder-util-runtime` <9.7.0 (via `electron-updater@6.8.9`) | рантайм: проверка обновлений через 30 с и раз в сутки | нет — утечка токена при cross-origin redirect, а `updateUrl` = placeholder `updates.example.invalid` (`electron/package.json:70`); станет актуально, если вписать адрес с токеном | `electron-builder@26` (тянет runtime 9.7) |

- Сценарий: см. D9-001 для единственного реально достижимого класса; остальное — гигиена перед следующей сборкой.
- Проверка: `npm audit --json` в каждом пакете, поле `fixAvailable.isSemVerMajor`.
- Последствия: без `npm audit fix` в `server/` и `client/` перед следующим установщиком к клиенту уедут все 22 advisories этих двух пакетов, хотя обычный `npm audit fix` (без `--force`) закрывает все группы, кроме `uuid`/`node-cron` на сервере и `esbuild`/`vite` на клиенте.
- Уже известно: нет.
- Связано с: D9-001, D8 (EOL Electron, Postgres 18 beta), D1.
- Уверенность: подтверждено (advisories), предположение (оценки достижимости).

### D9-015 · [Тяжесть 4] Major-отставания зависимостей
- Направление: 9 · Класс: гигиена
- Окружение: оба
- Где: `npm outdated` ×3 (раздел 0), `npm view` для корня.
- Что: `prisma`/`@prisma/client` 5.22 → 7.10 (два мажора; 6.x меняет минимум Node и `Decimal`/типы, 7.x — engines/driver adapters); `express` 4.22 → 5.2 (async-ошибки, `req.query` getter, `path-to-regexp` 8 — синтаксис путей); `helmet` 7 → 8; `express-rate-limit` 7 → 8; `node-cron` 3 → 4 (нужен ради `uuid`); `dotenv` 16 → 17; `bcryptjs` 2 → 3; `vite` 5.4 → 8.2 (три мажора, Node ≥ 20.19); `typescript` 5.9 → 7.0; `zustand` 4 → 5 (`persist`-API и `useStore` без селектора); `react`/`react-dom` 18 → 19; `date-fns` 3 → 4; `@vitejs/plugin-react` 4 → 6; `electron` 31 → 44; `electron-builder` 24 → 26; `concurrently` 8 → 10; `wait-on` 7 → 9. На последних: `vitest 5.0.0`, `socket.io 4.x`, `jsonwebtoken`, `winston`, `exceljs`, `docx`, `react-hook-form` (minor), `@tanstack/react-virtual` (minor).
- Что достижимо офлайн: обновления делаются на машине разработчика и уезжают установщиком — интернет в отеле не нужен ни для одного из них; ограничение — только тесты (D9-011) и объём ручной проверки. Наименее рискованные и полезные: `axios` 1.20 (patch), `helmet` 8, `express-rate-limit` 8, `node-cron` 4, `react-hook-form`/`react-virtual` (minor). Самые тяжёлые: `electron` (Node внутри, `embedded-postgres`), `prisma` 7, `express` 5, `vite` 8.
- Сценарий/Проверка: раздел 0.
- Последствия: чем дольше — тем дороже; «Prisma 5», «Express 4» зафиксированы в CLAUDE.md:27-28 как факт стека.
- Уже известно: нет.
- Связано с: D9-014, D8.
- Уверенность: подтверждено.

### D9-016 · [Тяжесть 4] Корень репозитория: README из одной строки, дубль скрипта, устаревший комментарий `.gitignore`, `.env.example` не рядом с `.env`
- Направление: 9 · Класс: гигиена
- Окружение: dev
- Где / Что:
  - `README.md` — 14 байт, `# book_manager`, с коммита `7020ce5` (18.06) не менялся; вся вводная живёт в `CLAUDE.md` (файл для агентов) и `NOTES.md`.
  - `hotel-booking/package.json:15-16` — `db:migrate:prod` и `db:migrate:deploy` идентичны; в CLAUDE.md ни один не описан.
  - `.gitignore:37-40` (корень) — «Пока проект на `db push`, миграций нет — но как только появятся…» — миграции есть с 04.09 (9 файлов в `git ls-files server/prisma/migrations`); комментарий вводит в заблуждение, правило при этом верное (миграции не игнорируются).
  - `hotel-booking/.env.example` при `dotenv` в `server/` (`server/.env` в `.gitignore`); CLAUDE.md:87 «Шаблон — `.env.example`» без пути. В `electron/package.json:49-50` фильтр `!**/.env`, `!**/.env.*` — `.env.example` в `hotel-booking/` в сборку и так не попадает (не в `../server`).
  - `start-all.bat` — абсолютные пути этой машины (напр. 8 тоже отмечает).
  - `hotel-booking/.gitignore` дублирует корневой (`node_modules/`, `dist/`, `build/`, `.env`, `logs/`, `backups/`, `backup_*.sql`, `*.dump`) — два места для одного правила.
- Проверка: `wc -c README.md`; `sed -n 37,40p .gitignore`; `git ls-files hotel-booking/server/prisma/migrations | wc -l` → 9.
- Последствия: минимальные; кандидат на уборку одним коммитом.
- Уже известно: нет.
- Связано с: D9-003, D9-006.
- Уверенность: подтверждено.

### D9-017 · [Тяжесть 4] Артефакты в рабочем дереве (игнорируются git, но лежат в OneDrive-синхронизируемом каталоге)
- Направление: 9 · Класс: гигиена
- Окружение: dev
- Где (`git status --ignored --porcelain`, без `node_modules`): `Редизайн интерфейса бронирования (1).zip` (444 КБ) и `… код.zip` (33 КБ), `_design_code/`, `_design_import/` (июньские дизайн-хендоффы, NOTES их не упоминает); `.vite/deps_temp_f9c0d839/` в **корне репозитория** (создан 07.09 10:52 — Vite запущен с cwd = корень); `hotel-booking/.logs/` (логи detached-запусков с 18.06); `hotel-booking/logs/` (807 Б, 04.09) и `hotel-booking/server/src/logs/` (пустые, 03.09) — следы плавающего cwd при `LOG_PATH=logs`; `server/server.log`, `server/server.err`; `hotel-booking/backups/backup_2026-09-05_12-38.json` (207 КБ данных гостей — напр. 8) и три `optimizer-backtest-*.md`, `room-fund-2026-06-17.json`; `client/dist/` (06.09 03:25) и `electron/dist/` — установщик 181 МБ от 06.09 03:28, **до** коммита отзыва JWT `7b18774` (07.09) — сборка устарела (напр. 8, NOTES:264-266 признаёт для волны 4); `.claude/settings.local.json`.
- Проверка: `git status --ignored --porcelain | grep '^!!'`.
- Последствия: не в git — не потеряются, но и не уберутся сами; `.vite` в корне — признак запуска Vite не из `client/`.
- Уже известно: частично (NOTES:264, план напр. 8 про `backups/` в OneDrive).
- Связано с: D8.
- Уверенность: подтверждено.

### D9-018 · [Тяжесть 4] Нет ESLint при четырёх `eslint-disable`, нет CI, нет `engines`/`.nvmrc`: тесты гоняются на Node 24, программа работает на Node из Electron 31
- Направление: 9 · Класс: гигиена
- Окружение: dev
- Где: `client/src/components/Reference/ReferenceWindow.tsx:108`, `Settings/sections/BookingFlagsSection.tsx:24`, `ui/DatePicker.tsx:37` (`react-hooks/exhaustive-deps`), `electron/main.js:662` (`no-unused-vars`) — комментарии-обманки: правило никем не проверяется (в `devDependencies` ни одного из четырёх пакетов нет ESLint). `.github/`, `.gitlab-ci.yml` — отсутствуют. `engines` нет ни в одном из четырёх `package.json`, `.nvmrc` нет; dev — `node v24.11.0`, сервер в сборке исполняется через `ELECTRON_RUN_AS_NODE` (`data-and-money.md:31`) под Node из Electron 31 (20.x — точную minor не проверял), т. е. `npm test`/`tsc` подтверждают поведение не на той мажорной версии, на которой работает клиент.
- Проверка: `grep -rn "eslint-disable" client/src electron/*.js`; `grep -n '"engines"' */package.json`.
- Последствия: расхождения Node 20/24 всплывут только в упаковке (напр. 8 отмечает старт сервера 16 с против 1 с); `exhaustive-deps` не проверяется вовсе.
- Уже известно: план разведки («3 `eslint-disable` без ESLint» — на деле 4).
- Связано с: D5, D8.
- Уверенность: подтверждено.

### D9-019 · [Тяжесть 4] Top-10 файлов по строкам — кандидаты на разделение (без рекомендаций по коду)
- Направление: 9 · Класс: гигиена
- Окружение: dev
- Где (`wc -l`, исключая `node_modules`/`dist`; всего `server/src` 13 397, `client/src` 25 956, `electron` 1 454, `server/test` 6 276):

| # | Файл | Строк | Байт |
|---|---|---|---|
| 1 | `client/src/components/BookingModal/BookingModal.tsx` | 2 844 | 140 521 |
| 2 | `server/src/controllers/bookingController.js` | 1 262 | 67 602 |
| 3 | `electron/main.js` | 899 | 46 396 |
| 4 | `client/src/components/Reference/ReferenceWindow.tsx` | 867 | |
| 5 | `server/src/controllers/optimizeController.js` | 847 | |
| 6 | `server/src/utils/backup.js` | 808 | 42 521 |
| 7 | `client/src/components/Audit/AuditWindow.tsx` | 780 | |
| 8 | `client/src/components/Rates/RatesScreen.tsx` | 721 | |
| 9 | `client/src/components/Settings/sections/BackupSection.tsx` | 707 | |
| 10 | `client/src/components/Reference/GuestsTab.tsx` | 690 | |

Следом: `roomFundController.js` 685, `snapshot.js` 579, `OptimizeModal.tsx` 553, `BookingBlock.tsx` 551, `engine.js` 522, `GridRow.tsx` 517, `types/index.ts` 513, `ReportsScreen.tsx` 485, `expr.js` 464, `SnapshotsModal.tsx` 461; мёртвый `RoomFundSettings.tsx` 416.
- Уже известно: план аудита (BookingModal 2 844).
- Связано с: D5, D6, D3, D8.
- Уверенность: подтверждено.

---

## 2. Что в порядке

- `server/test/**` — `npm test`: 17 файлов, 402 теста, зелёный, 1,72 с; `it.fails/skip/only/todo`, `describe.skip/only` — 0 (grep); `vitest.config.mjs` `include: test/**/*.test.js` подхватывает все 17 файлов на диске (18-го нет — в `test/` ровно 17 `*.test.js` + `helpers/`).
- `client/` — `npx tsc --noEmit` без ошибок при `strict`, `noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch` (`tsconfig.json`).
- `server/test/helpers/fakePrisma.js:matchWhere/matchField` — неизвестный оператор или поле вне фикстуры → исключение, а не «пусто»; `update/delete` несуществующей записи → P2025 как у Prisma; `createMany skipDuplicates` по `id/code/name`; `applyData` умеет `{ increment }` (NOTES:110 подтверждён).
- `server/test/helpers/loadCjs.js` — свежий экземпляр CJS-модуля на каждый вызов, `stubs` по строке `require`, `silentLogger` — тесты не пишут в `server/logs/`.
- `.gitignore` ×2 — `server/.env` не в git (`git ls-files` → только `hotel-booking/.env.example`); `*.pem`, `*.key` игнорируются (страховка приватного ключа лицензий); `backup_*.sql`, `*.dump`, `backups/`, `logs/`, `*.log` — игнорируются; миграции Prisma **отслеживаются** (9 файлов); `electron/` в git (12 файлов: `main.js`, `preload.js`, `settings-preload.js`, `settings.html`, `package.json`+lock, `db/seed.sql`, `db/README.md`, `migrate-data.mjs`, `test-host.mjs`, `sandbox-test.wsb`, `SANDBOX-CHECKLIST.md`); `init.sql` отсутствует везде (`find`).
- `git` — рабочее дерево чисто, кроме оговорённого; `main` = `origin/main` (`a39c57c`); репозиторий приватный; в HEAD `server/package.json` нет `buildDate` (NOTES:58 соблюдён); самые большие отслеживаемые файлы — три lock-файла (165/152/77 КБ), бинарников и дампов в истории нет (`git ls-files | xargs du -b | sort -rn | head`).
- `hotel-booking/package.json:12` — `build:electron` штампует `buildDate` перед сборкой (`scripts/stamp-build-date.js`), как описано в NOTES:57.
- `electron/package.json:47-61` — из сборки исключены `.env`, `.env.*`, `test/**`, `scripts/**`, `logs/**`, `backups/**`, `node_modules/nodemon/**`, `vitest.config.mjs`, `server.log/err`.
- `.env.example` — описывает `QONAQ_BUILD_DATE`, `BACKUP_PATH/KEEP/TZ`, `SNAPSHOT_*`, `LOG_PATH`, честно помечает `LICENSE_SERVER_URL` удалённым и объясняет `TZ=UTC`.
- `electron/db/README.md` — согласован с `docs/decisions/data-and-money.md:20-22` и NOTES:552-553 (только данные, схема — в миграциях).
- `docs/decisions/*` — все 18 проверенных путей к файлам существуют (`sectionUi.tsx`, `restoreUi.tsx`, `BookingPaymentPanel.tsx`, `ServicesTab.tsx`, `Reports/editor/deferred.tsx`, `reports/{registry,vocab,options,export,dateUtils,engine,expr}.js`, `calculator.ts`, `sortRooms.ts`, `corsOrigin.js`, `passwordPolicy.js`, `sessions.js`).
- Конвенция CLAUDE.md:79 «контроллер + роут + зеркальный файл в `client/src/api/`» — 23 роута ↔ 25 файлов API (плюс `client.ts`, `charges.ts`, `roomsAdmin.ts`); попарное соответствие имён не сверял.
- `.mcp.json:context7` — без секретов; `postgres` через `@modelcontextprotocol/server-postgres` — read-only по дизайну сервера (CLAUDE.md:99 верен).
- `.claude/agents/*.md` — 4 файла, frontmatter валиден (`name/description/model/maxTurns`, у `hotel-tests` — `tools`), состав соответствует NOTES:82-85.
- `server/vitest.config.mjs` — `restoreMocks: true`, `environment: node`.
- `hotel-booking/NOTES.md:110` «18 юнит-тестов в `sessions.test.js`» — 18 `it(` в файле; `fakePrisma` `{ increment }` — `fakePrisma.js:104-110`.
- `.claude/launch.json` — конфигурации 3011/5174 из NOTES:113-115 действительно в HEAD.

## 3. Проверка закрытых пунктов (только пункты без области)

| Пункт | Где заявлено | Статус по коду |
|---|---|---|
| «Стабильность dev-процессов» | NOTES:451 `[ ]`; archive/audits-2026-06:111 `[ ]` | **Не закрыто.** Частично смягчено конфигурациями «Hotel Server/Client (+3011)» в `.claude/launch.json` (запуск из Claude Code), но `npm run dev` сломан (D9-003), `start-all.bat` — абсолютные пути; варианты из пункта (Task Scheduler / статика с бэкенда) не реализованы. |
| «`electron/` не в git, `init.sql` под `*.sql`» | NOTES:469-470 `[x]` 02.09 | **Закрыто.** 12 файлов `electron/` в `git ls-files`; в `.gitignore` нет `*.sql` (только `backup_*.sql`); `init.sql` удалён. Хвост: комментарий `.gitignore:37-40` устарел (D9-016). |
| «Журнал разделён по областям» | NOTES:1-19; CLAUDE.md:88-95 | **Частично.** Структура есть (5 файлов + `archive/`), но решения 04–07.09 в файлы областей не перенесены, `desktop-and-ops.md` — 19 строк июня (D9-010). |
| «Агенты заведены в `.claude/agents/`» | NOTES:82-85 | **Закрыто** по факту; содержимое устарело (D9-007). |
| «В `.claude/launch.json` добавлены 3011/5174» | NOTES:113-115 | **Закрыто** (`7b18774`). |
| «`buildDate` … в репозитории поля быть не должно» | NOTES:58 | **Соблюдено** (`git show HEAD:hotel-booking/server/package.json | grep -c buildDate` → 0). |
| «Список выверен 04.09 по коду: из 30 — 17 закрыты» | NOTES:226-227 | **Устарело:** ещё 3 открытых закрыты кодом (D9-008). |
| «18 юнит-тестов `sessions.test.js`, `fakePrisma` научился `{ increment }`» | NOTES:110 | **Закрыто.** |
| «Не закоммичено — лежат в рабочей копии» | fix-waves:8, :60 | **Закоммичено** `91c9b8f` (04.09); архив исторический, отметки нет. |
| «Отметки о закрытии проставлены» | archive/audits-2026-06:3 | **Частично:** 10 пунктов `[ ]` при закрытии по NOTES (список в D9-010). |
| «Линтера и тестов в проекте нет» | CLAUDE.md:86 | **Регресс документа:** тесты есть с 04.09. |
| «`prisma/sql/booking_no_overlap.sql` идемпотентный … тот же текст в `init.sql`» | NOTES:567-568 | Файл `prisma/sql/booking_no_overlap.sql` в git есть; `init.sql` — нет. Где constraint фактически применяется (миграция `0_init` или `prisma/sql/`) — решает напр. 8. |

## 4. Код ↔ `docs/decisions` (согласованность документов между собой)

Противоречия/пробелы собраны в D9-010; здесь — сводно, что документу противоречит код или другой документ:

1. `interface.md:40-42` «„Тарифы и наличие“ и „Отчёты“ — заглушки, убрать из меню» ↔ код: `Rates/RatesScreen.tsx` (721), `Reports/ReportsScreen.tsx` (485), NOTES:56.
2. `interface.md:22-23`, `reports.md:111`, `data-and-money.md:147-148` — ссылки на `electron/db/init.sql` ↔ `data-and-money.md:20-22`, `electron/db/README.md`, NOTES:521: файл удалён 04.09. Записи датированы, но без пометки «устарело».
3. `reports.md:158-160` «финансовых отчётов нет и не может быть» ↔ NOTES:56 (три отчёта, датасеты `charges`/`payments`, тест `financeReports.test.js` 19 тестов).
4. `data-and-money.md:153-156` «что осталось» ↔ тот же файл `:77-105` и NOTES:479-481: всё сделано.
5. `desktop-and-ops.md:14-18` TODO ↔ NOTES:482 (хост/клиент сделан 03.09), fix-waves «Мастер первого запуска».
6. `bookings.md:28` «двигает только … не оплачено» — проверка по коду оптимизатора у напр. 3; в документе не отражены решения NOTES:318-333 (единая `availability.js`), :471-476, :485-498.
7. `hotel-server.md:24` / CLAUDE.md:68 «`utils/overlap.js`» ↔ NOTES:332-333 «стал мёртвым».
8. `hotel-tests.md:24` «около сотни тестов» ↔ 402; CLAUDE.md:86 «тестов нет» ↔ 17 файлов.
9. NOTES:502-505 порты ↔ NOTES:113-115, `vite.config.ts:4-7`.
10. NOTES:563 «не nodemon» ↔ `server/package.json:7`, CLAUDE.md:13.
11. NOTES:60 «Сохранить PDF — открыто» ↔ NOTES:55 «Сохранить PDF (Electron)» ✅.
12. `archive/audits-2026-06.md` — 10 незакрытых `[ ]`, закрытых по NOTES (перечень в D9-010).
13. `.gitignore:37-40` «миграций нет» ↔ `server/prisma/migrations/` (9 файлов в git).

## 5. Не проверено (бюджет)

- Тела тестов (только `describe`-заголовки, харнесы и список `src/`-путей) — поэтому «частичное покрытие» контроллеров описано по заголовкам, а не по каждому `it`.
- Сами исходники `server/src/**`, `client/src/**`, `electron/main.js` — только grep по фактам, нужным для NOTES/CLAUDE.md (их читают напр. 1–8).
- Установщик `electron/dist/*.exe` не распаковывал — D9-004 выведена из фильтра `extraResources` и размеров `server/node_modules`.
- Эксплуатируемость advisories не воспроизводил; оценка достижимости (D9-014) — по месту исполнения пакета и точке аутентификации; версия `builder-util-runtime` в `electron/node_modules` не смотрел.
- Дата EOL Electron 31 и версия Node внутри Electron 31.7.7 — по памяти о политике поддержки, не по сайту.
- `npm outdated` в корне `hotel-booking/` невозможен (нет `node_modules`) — заменён `npm view`.
- `.claude/settings.local.json` — содержимое не читал (игнорируется git).
- `server/logs/combined.log` (2,3 МБ) и `error.log` (299 КБ) — содержимое не читал (PII — напр. 1/8).
- `hotel-booking/backups/backup_2026-09-05_12-38.json` — не открывал.
- Папку `../Qonaq — документы` (спецификация 1.0, ключи, отчёты) — не открывал; только факт существования вне репозитория.
- `electron/db/seed.sql` ↔ `prisma/seed.js`, `migrate-data.mjs`, `clear.js`, `sandbox-test.wsb`, `SANDBOX-CHECKLIST.md` — у напр. 8.
- Соответствие имён `routes/*.js` ↔ `client/src/api/*.ts` попарно и мёртвые эндпоинты без клиента (напр. 5: `GET /rooms/availability`, `/occupancy/stats`, `/system/status`, `/payments/shift/:id`, `GET /room-fund/*`) — не сверял.
- Синхронизацию OneDrive для `hotel-booking/backups` (реально ли уезжает в облако) — не проверял.
- Бэктест оптимизатора — напр. 3 (в `backups/` уже лежит `optimizer-backtest-2026-09-07.md`).

## 6. Вопросы владельцу (тяжесть 4)

1. **`utils/overlap.js` + `overlap.test.js`** — NOTES:77 откладывал удаление «после 1.0»; 1.0 достигнут 06.09. Удалять сейчас (и убрать упоминания из CLAUDE.md:56,68 и `hotel-server.md:24`)?
2. **Корневой `hotel-booking/package.json`** — оставить как оркестратор (тогда `npm install` в `hotel-booking/`, закоммитить `package-lock.json`, обновить `concurrently`/`wait-on` до 10/9) или убрать `dev*`-скрипты и описать в CLAUDE.md только `launch.json`/`start-all.bat`?
3. **`.mcp.json`** — оставить в git (репозиторий приватный, пароль dev) или вынести строку подключения в переменную окружения (`DATABASE_URL`), файл — в `.gitignore`, рядом `.mcp.json.example`? Связано с открытым NOTES:425 (смена пароля БД сделает строку ложной).
4. **Метки броней в интерфейсе** — `BookingFlagsSection.tsx` только показывает список (`fetchBookingFlags`), функции `create/update/deleteBookingFlag` в `api/bookingFlags.ts` никем не вызываются. Это принятое решение «пресеты вместо настройки» (NOTES:192-203) или незакрытая функция? (Напр. 6.)
5. **Node-версия** — зафиксировать `engines` / `.nvmrc` под Node из Electron 31 и гонять `npm test` на ней, чтобы dev (24) и клиент (20) не расходились?
6. **Перенос решений 04–07.09** из NOTES («Закрыто», «Отзыв JWT» :87-168) в `docs/decisions/*` и архив — кто и когда; `desktop-and-ops.md` — писать заново?
7. **Отчёты бэктеста** (`backups/optimizer-backtest-*.md`) — переложить в `docs/` (сейчас вне git)?
8. **ESLint/CI** для одного разработчика — нужны ли (4 `eslint-disable` без ESLint — либо поставить, либо убрать комментарии)? Минимальный CI = `npm test` + `tsc --noEmit` на push.
9. **Спецификация 1.0 и отчёты** в `../Qonaq — документы` (OneDrive) — положить копию/ссылку в `docs/`, чтобы агенты и клон репозитория их видели?
10. **`npm audit fix` без `--force`** в `server/` и `client/` перед следующей сборкой (закрывает `ws`/`socket.io-parser`/`qs`/`body-parser`/`axios`/`postcss`…) — делать сейчас или вместе с мажорами?

---

## Приложение A. Карта покрытия `server/src/**` → тесты → что фейк не воспроизводит

Обозначения: ✔ загружается тестом и проверяется по заголовкам `describe`; ◐ загружается частично (перечислено, что именно); ✗ не загружается ни одним тестом. Числа в скобках у тестов — количество `it(` в файле по grep (сумма 380); vitest считает 402, разница — параметризованные/циклические `it`. Колонка «фейк не воспроизводит» — какие семантики Postgres/Prisma нужны модулю, но отсутствуют в `fakePrisma` (см. D9-012); «не поймают» — класс ошибок, невидимый тестам даже при 100 % покрытии на фейке.

| Модуль | Тест(ы) | Статус | Фейк не воспроизводит | Тесты не поймают |
|---|---|---|---|---|
| **controllers/** | | | | |
| `bookingController.js` (1 262) | `bookingAvailability` (26), `guestDocument` (20) | ◐ create/update/move/check-availability, документ гостя | `$transaction` без отката/таймаута, `booking_no_overlap` (23P01), `skipDuplicates` | двойную бронь при гонке, P2028 на медленном хосте, `checkin/checkout/cancel/actual-times/charges*` целиком |
| `optimizeController.js` (847) | `optimizer` (36) | ◐ только чистые функции через `append` | `$executeRawUnsafe SET CONSTRAINTS DEFERRED`, транзакция | устаревший план при `apply`, сообщение 409/23P01 пользователю |
| `guestController.js` | `guestDocument` | ✔ list, lookup | — | — |
| `hotelController.js` | `hotelRequisites` (25) | ✔ GET/PUT, нормализация, БИН/IBAN | — | — |
| `licenseController.js` | `license` (50) | ✔ | `upsert` (стаб) | — |
| `roomController.js` | `license` | ◐ только лимит в `create` | `$transaction` в лимите (проверка :110 → create :126 без транзакции, напр. 2) | гонку двух `POST /rooms` на границе лимита |
| `roomFundController.js` (685) | `roomFund` (28) | ✔ list/seed/rename ×3/hide/import/code/двойники | `$executeRaw array_replace` (стаб), `$transaction` | ошибку SQL `array_replace`, регистр при переименовании |
| `authController.js` | `sessions` (18) | ◐ logout/changePassword/signToken | — | login (лимитер, 401/503) |
| `setupController.js` | `sessions` | ◐ `signToken` | `upsert`, транзакция | гонку двух `setup/complete` (напр. 1) |
| `userController.js` | `sessions` | ◐ `setPassword` | — | деактивацию себя/последнего SUPER_ADMIN (заявлено в fix-waves — напр. 1) |
| `paymentController.js` (421) | — | ✗ | `aggregate`, `mode: insensitive`, `take`, `$transaction` | **все деньги кассы**: возврат возврата, void с возвратами, `recalcBookingPaid` при параллельных платежах, `businessDate` |
| `occupancyController.js` | — | ✗ | `$queryRaw regexp_replace`, `distinct`, `has`, `mode`, `$transaction`, кэш | грид, поиск по телефону, ключ кэша без роли |
| `rateController.js` | — | ✗ | `$executeRaw generate_series/ON CONFLICT`, `deleteMany` | календарь цен целиком |
| `shiftController.js` | — | ✗ | `upsert`, `take`, снимок после upsert | `nextDay` при просроченных выездах, две смены в день |
| `reportController.js` | — | ✗ | — | 400/500 при невалидном определении из БД |
| `allotmentController.js` | — | ✗ (утилита `allotment.js` — ✔) | без транзакции (:9 → :79) | две квоты на номер |
| `bookingFlagController.js` | — | ✗ | `upsert` | — |
| `categoryController.js` | — | ✗ | `$transaction`, Restrict | удаление категории с номерами |
| `contactController.js` | — | ✗ | — | идемпотентность `createDefaults` |
| `partnerController.js` | — | ✗ | Cascade `Allotment.partner` | удаление партнёра стирает квоты |
| `serviceController.js` | — | ✗ | Cascade `Service → BookingService`, без транзакции (:108 → :114) | удаление услуги стирает историю броней |
| **middleware/** | | | | |
| `audit.js` | `audit` (12) | ✔ isTracked/extractId/sanitizeBody | — | глубину `stripSecrets` ≤ 5 (напр. 1) — если не покрыто отдельным `it` |
| `auth.js` | `sessions` | ✔ версия сессии, isActive | — | 503 при сбое БД (fix-waves C1) |
| `errorHandler.js` | зависимость 3 тестов | ◐ маппинг 409/400 | — | текст `err.message` наружу (напр. 1) |
| `license.js` | `license` | ✔ гейт 402 | — | — |
| `validate.js` | `hotelRequisites` | ✔ на одном роуте | — | остальные 22 роута |
| **routes/** | | | | |
| `hotel.js` | `hotelRequisites` | ✔ | — | — |
| остальные 22 | — | ✗ | Express-цепочки | отсутствие `validate`/`requireRole`, порядок `/defaults` до `/:id` |
| **socket/** `socketManager.js` | `sessions` | ◐ handshake/версия | — | `emitBookingEvent` → кэш/снимок, `recheckConnectedAdmins` |
| **utils/** | | | | |
| `allotment.js` | `allotment` (18), `bookingAvailability` | ✔ квота, релизы, сообщение | — | — |
| `availability.js` | `bookingAvailability` | ✔ overlap → buffer → allotment | `booking_no_overlap` | гонку READ COMMITTED (известно, принято) |
| `backup.js` (808) | `backup` (21) — своя мини-база | ✔ состав, порядок, восстановление, старый формат | `$executeRawUnsafe setval` (стаб), каскад только для 4 таблиц, транзакция 300 с | ошибку SQL, FK при восстановлении на живой схеме |
| `bookingMoney.js` | `bookingMoney` (10), `financeReports` | ✔ слагаемые, деньги брони | `groupBy` (не вызывается — `prisma: {}`) | сумму по базе |
| `businessDate.js` | `businessDate` (9) | ✔ getCurrentBusinessDate/todayUTC/ensureCurrentShift | `@db.Date` | `todayUTC` в UTC+5 (NOTES:443 — известно) |
| `charges.js` | `charges` (14) | ◐ `buildAutoCharges`: проживание, питание, услуги, скидка, ручные | `deleteMany`, `createMany`, транзакция | `rebuildAutoCharges` (что сохраняет из ручных, брони без строк) |
| `flagEffects.js` | `flagEffects` (29), `optimizer`, `bookingAvailability` | ✔ буферы, исключения, окно | — | — |
| `license.js` | `license` | ✔ подпись, дата сборки, состояние, лимит | — | — |
| `sessions.js` | `sessions` | ✔ revokeSessions | — | — |
| `snapshot.js` (579) | `snapshot` (29) — своя мини-база | ✔ снимок/список/восстановление/кэши/битые FK/гейт денег | `$queryRaw`/`$executeRawUnsafe` (стаб), транзакция 120 с | FK на живой схеме, sequence |
| `overlap.js` | `overlap` (16) | ✔ **мёртвый модуль** | — | ничего: код не исполняется в рантайме |
| `corsOrigin.js`, `passwordPolicy.js`, `logger.js`, `prisma.js` | — | ✗ | — | расхождение текстов с `accountRules.ts`, CORS-политику, ротацию логов |
| **reports/** | | | | |
| `engine.js` (522) | `financeReports` (19) | ◐ через 3 определения | — | `MAX_ROWS`, `roomNights`-развёртку |
| `datasets/{bookings,charges,payments}.js` | `financeReports` | ✔ | `findMany` за период | — |
| `datasets/roomNights.js`, `index.js` | — / стаб | ✗ | — | загрузку, лимит 400 дней |
| `expr.js` (464) | — | ✗ | — | **парсер/интерпретатор формул**: глубину рекурсии, арность, `null`-арифметику |
| `registry.js`, `vocab.js`, `options.js`, `export.js`, `dateUtils.js` | — | ✗ | — | `validateDefinition`, CSV/xlsx-инъекцию, `filename*`, часовой пояс параметров |
| `definitions/{revenue,cash-register,debts}.json` | `financeReports` | ✔ | — | — |
| `definitions/{occupancy,bookings-registry}.json` | — | ✗ | — | — |
| **`app.js`, `server.js`, `prisma/seed.js`, `scripts/*`** | — | ✗ | — | порядок middleware, `TZ=UTC`, cron, seed `admin.upsert` |

Итого: 27 модулей из ~75 загружаются тестами; из 21 контроллера — 10 (из них 5 частично); из 23 роутов — 1; из 15 утилит — 11 (одна мёртвая, одна частично); из 9 файлов движка отчётов — 1 частично.

## Приложение B. Зависимости: версии, отставания, CVE, достижимость

| Пакет | Пакет-владелец | Текущая | Latest | Мажоров | CVE (npm audit) | Достижимо в отеле | Закрытие |
|---|---|---|---|---|---|---|---|
| express | server | 4.22.2 | 5.2.1 | 1 | qs ×2 moderate, body-parser moderate | HTTP до auth, DoS-класс | `npm audit fix` (patch) |
| socket.io (engine.io 6.6.7, ws 8.18.3, parser 4.2.6) | server | latest | — | 0 | ws high ×2, parser high | **да, до auth** (D9-001) | `npm audit fix` |
| @prisma/client / prisma | server | 5.22.0 | 7.10.0 (8 rc) | 2 | — | — | major |
| helmet | server | 7.2.0 | 8.3.0 | 1 | — | — | major |
| express-rate-limit | server | 7.5.1 | 8.7.0 | 1 | — | — | major |
| node-cron (uuid 8.3.2) | server | 3.0.3 | 4.6.0 | 1 | uuid moderate | нет (v4) | major |
| exceljs (uuid) | server | 4.4.0 | latest | 0 | uuid moderate | нет | — |
| dotenv | server | 16.6.1 | 17.4.2 | 1 | — | — | major |
| bcryptjs | server | 2.4.3 | 3.0.3 | 1 | — | — | major |
| brace-expansion | server, electron | — | — | — | high ×3 | нет | `npm audit fix` |
| vitest | server (dev) | 5.0.0 | 5.0.0 | 0 | — | не должен быть в сборке (D9-004) | — |
| axios | client | 1.16.1 | 1.20.0 | 0 | high ×10 | низко (renderer → свой сервер) | `npm audit fix` |
| vite (esbuild) | client (dev) | 5.4.21 | 8.2.2 | 3 | esbuild moderate | нет (dev-server) | major |
| postcss, browserslist, @babel/core, nanoid | client (dev) | — | — | — | high/low | нет (build-time) | `npm audit fix` |
| socket.io-client (engine.io-client, ws) | client | latest | — | 0 | parser high, ws high | нет (браузерный WebSocket) | `npm audit fix` |
| react / react-dom | client | 18.3.1 | 19.2.8 | 1 | — | — | major |
| zustand | client | 4.5.7 | 5.0.15 | 1 | — | — | major |
| date-fns | client | 3.6.0 | 4.4.0 | 1 | — | — | major |
| typescript | client (dev) | 5.9.3 | 7.0.2 | 2 | — | — | major |
| @vitejs/plugin-react | client (dev) | 4.7.0 | 6.1.1 | 2 | — | — | major |
| @types/react(-dom) | client (dev) | 18.3.x | 19.2.x | 1 | — | — | с React 19 |
| electron | electron (dev, но это рантайм) | 31.7.7 | 44.2.0 | 13 | high ×32 (+ CVE Chromium 126 вне audit) | условно (нужен XSS в своём UI) | major; меняет Node внутри |
| electron-builder (tar, app-builder-lib, extract-zip, js-yaml, xmldom) | electron (dev) | 24.13.3 | 26.15.3 | 2 | critical ×12 (tar), high | нет (машина сборки) | major / `npm audit fix` для js-yaml, xmldom |
| electron-updater (builder-util-runtime) | electron | 6.8.9 | latest | 0 | high (утечка токена при redirect) | нет (updateUrl — placeholder) | с electron-builder 26 |
| embedded-postgres | electron | 18.4.0-beta.17 | ? | — | не в audit | — | напр. 8 |
| concurrently / wait-on | корень | не установлены (^8 / ^7) | 10.0.5 / 9.1.0 | 2 / 2 | — | — | D9-003 |
