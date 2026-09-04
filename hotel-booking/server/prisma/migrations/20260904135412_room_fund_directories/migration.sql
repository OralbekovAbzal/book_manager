-- CreateTable
CREATE TABLE "Building" (
    "id" SERIAL NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "order" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Building_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RoomFeature" (
    "id" SERIAL NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "emoji" TEXT,
    "order" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RoomFeature_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RoomCapacity" (
    "id" SERIAL NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "value" INTEGER NOT NULL DEFAULT 0,
    "order" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RoomCapacity_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Building_code_key" ON "Building"("code");

-- CreateIndex
CREATE UNIQUE INDEX "Building_name_key" ON "Building"("name");

-- CreateIndex
CREATE INDEX "Building_order_idx" ON "Building"("order");

-- CreateIndex
CREATE UNIQUE INDEX "RoomFeature_code_key" ON "RoomFeature"("code");

-- CreateIndex
CREATE UNIQUE INDEX "RoomFeature_name_key" ON "RoomFeature"("name");

-- CreateIndex
CREATE INDEX "RoomFeature_order_idx" ON "RoomFeature"("order");

-- CreateIndex
CREATE UNIQUE INDEX "RoomCapacity_code_key" ON "RoomCapacity"("code");

-- CreateIndex
CREATE INDEX "RoomCapacity_order_idx" ON "RoomCapacity"("order");

-- ═══════════════════════════════════════════════════════════════════════════
-- ЗАСЕВ СПРАВОЧНИКОВ
--
-- Пустые таблицы после обновления означали бы, что у пользователя пропали
-- фильтры и выпадающие списки в разделе «Номера»: до этой миграции справочники
-- лежали в localStorage, и сервер про них ничего не знал. Поэтому засеваем
-- с двух сторон:
--   1) стандартный набор (он же — единственный источник для СВЕЖЕЙ установки,
--      где номеров ещё нет); названия/значки взяты из ROOM_FUND_DEFAULTS
--      в client/src/store/useSettingsStore.ts;
--   2) то, что РЕАЛЬНО стоит у существующих номеров — иначе корпус «КОРПУС A»
--      или особенность, заведённая руками, остались бы вне справочника
--      и выпали из фильтра.
-- Второй шаг пропускает всё, что уже добавлено первым, поэтому дублей нет.
--
-- Чего засев знать НЕ может: человеческое название и число мест для
-- вместимости, код которой встречается у номеров, но отсутствует в стандартном
-- наборе (такие коды клиент генерировал из Date.now()). Расшифровка осталась
-- в localStorage той машины, где её завели, — там её и заберёт разовый импорт
-- (POST /api/room-fund/import). До импорта такая строка живёт с подписью
-- «Вместимость <код>» и value = 0 («мест неизвестно»).
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── 1. Стандартный набор особенностей ──────────────────────────────────────
-- 'single_bed' в ROOM_FUND_DEFAULTS нет, но он нужен: библиотека меток
-- (bookingFlagController.LIBRARY) содержит метку only_single с эффектом
-- requireFeature = 'Односпальная кровать'. Без этой строки метка на свежей
-- установке ссылалась бы в пустоту.
INSERT INTO "RoomFeature" ("code", "name", "emoji", "order", "isActive", "createdAt", "updatedAt")
VALUES
    ('balcony',     'Балкон',               '🪟', 0, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('sea_view',    'Вид на море',          '🌊', 1, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('jacuzzi',     'Джакузи',              '🛁', 2, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('single_bed',  'Односпальная кровать', '🛌', 3, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('double_bed',  'Двуспальная кровать',  '🛏', 4, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('ac',          'Кондиционер',          '❄️', 5, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('fridge',      'Холодильник',          '🧊', 6, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('safe',        'Сейф',                 '🔒', 7, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT DO NOTHING;

-- ─── 2. Стандартный набор вместимостей ──────────────────────────────────────
INSERT INTO "RoomCapacity" ("code", "label", "value", "order", "isActive", "createdAt", "updatedAt")
VALUES
    ('single', 'Одноместный',    1, 0, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('double', 'Двухместный',    2, 1, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('triple', 'Трёхместный',    3, 2, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('quad',   'Четырёхместный', 4, 3, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT DO NOTHING;

-- ─── 3. Корпуса из существующих номеров ─────────────────────────────────────
-- Стандартного набора у корпусов нет: у каждого отеля они свои.
-- Связь с номером идёт по НАЗВАНИЮ (Room.building), код здесь — внутренний
-- идентификатор, поэтому он собирается из названия, а при совпадении слагов
-- дополняется порядковым номером.
WITH src AS (
    SELECT DISTINCT btrim("building") AS name
    FROM "Room"
    WHERE btrim(coalesce("building", '')) <> ''
), slugged AS (
    SELECT name,
           coalesce(nullif(btrim(regexp_replace(lower(name), '[^a-zа-яё0-9]+', '_', 'g'), '_'), ''), 'building') AS slug
    FROM src
), numbered AS (
    SELECT name, slug,
           row_number() OVER (PARTITION BY slug ORDER BY name) AS dup,
           row_number() OVER (ORDER BY name)                   AS pos,
           EXISTS (SELECT 1 FROM "Building" b WHERE b."code" = slug) AS taken
    FROM slugged
)
INSERT INTO "Building" ("code", "name", "description", "order", "isActive", "createdAt", "updatedAt")
SELECT CASE WHEN dup = 1 AND NOT taken THEN slug ELSE slug || '_' || pos END,
       name, NULL, pos, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM numbered
ON CONFLICT DO NOTHING;

-- ─── 4. Особенности из существующих номеров ─────────────────────────────────
-- Room.features хранит НАЗВАНИЯ, поэтому пропускаем те, что уже добавлены
-- стандартным набором, сравнивая имена без учёта регистра: две строки
-- «Балкон» и «балкон» в справочнике — это мусор, который потом придётся чистить
-- руками. Порядок 100+ — чтобы своё шло после стандартного.
WITH src AS (
    SELECT DISTINCT btrim(f) AS name
    FROM "Room", unnest("features") AS f
    WHERE btrim(coalesce(f, '')) <> ''
), unknown AS (
    SELECT s.name,
           coalesce(nullif(btrim(regexp_replace(lower(s.name), '[^a-zа-яё0-9]+', '_', 'g'), '_'), ''), 'feature') AS slug
    FROM src s
    WHERE NOT EXISTS (SELECT 1 FROM "RoomFeature" rf WHERE lower(rf."name") = lower(s.name))
), numbered AS (
    SELECT name, slug,
           row_number() OVER (PARTITION BY slug ORDER BY name) AS dup,
           row_number() OVER (ORDER BY name)                   AS pos,
           EXISTS (SELECT 1 FROM "RoomFeature" rf WHERE rf."code" = slug) AS taken
    FROM unknown
)
INSERT INTO "RoomFeature" ("code", "name", "emoji", "order", "isActive", "createdAt", "updatedAt")
SELECT CASE WHEN dup = 1 AND NOT taken THEN slug ELSE slug || '_' || pos END,
       name, NULL, 100 + pos, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM numbered
ON CONFLICT DO NOTHING;

-- ─── 5. Вместимости из существующих номеров ─────────────────────────────────
-- Здесь ключ связи — КОД (Room.capacity хранит 'single', 'double', …),
-- поэтому сравниваем по коду, а не по названию.
WITH src AS (
    SELECT DISTINCT btrim("capacity") AS code
    FROM "Room"
    WHERE btrim(coalesce("capacity", '')) <> ''
)
INSERT INTO "RoomCapacity" ("code", "label", "value", "order", "isActive", "createdAt", "updatedAt")
SELECT s.code,
       'Вместимость ' || s.code,
       0,
       100 + row_number() OVER (ORDER BY s.code),
       true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM src s
WHERE NOT EXISTS (SELECT 1 FROM "RoomCapacity" rc WHERE rc."code" = s.code)
ON CONFLICT DO NOTHING;
