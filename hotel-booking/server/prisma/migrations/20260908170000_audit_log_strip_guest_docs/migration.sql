-- Журнал действий больше не хранит документы гостей (аудит D1-007): middleware/audit.js
-- вырезает эти поля из details при записи, а здесь чистим уже накопленное.
-- guestName/guestPhone остаются: без них запись «кто менял бронь кого» бессмысленна.
-- Колонка "details" — JSONB (0_init), поэтому операторы `-` и `?|` работают по ней напрямую.
UPDATE "AuditLog"
   SET details = details - 'guestCitizenship' - 'guestDocType' - 'guestDocNumber'
                          - 'guestDocExpiry' - 'guestBirthDate' - 'guestSex'
 WHERE jsonb_typeof(details) = 'object'
   AND details ?| ARRAY['guestCitizenship','guestDocType','guestDocNumber','guestDocExpiry','guestBirthDate','guestSex'];

-- Тело длиннее 2 КБ sanitizeBody не пишет целиком, а кладёт { _truncated, preview },
-- где preview — ОБРЕЗАННАЯ СТРОКА JSON. Документ может лежать внутри неё, а разобрать
-- обрывок как JSON нельзя (он почти всегда не закрыт) — поэтому строку заменяем целиком,
-- и только там, где документ действительно виден.
UPDATE "AuditLog"
   SET details = jsonb_set(details, '{preview}', to_jsonb('[обрезано; документ гостя удалён]'::text))
 WHERE jsonb_typeof(details) = 'object'
   AND details ? '_truncated'
   AND jsonb_typeof(details -> 'preview') = 'string'
   AND (details ->> 'preview' LIKE '%guestDocNumber%' OR details ->> 'preview' LIKE '%guestBirthDate%');

-- Ретеншн журнала удаляет по createdAt — индекс, чтобы ночная чистка не сканировала таблицу.
-- Индекс с тем же именем уже создаётся в 0_init (и объявлен в schema.prisma как
-- @@index([createdAt])), так что здесь это страховка на случай базы, где его снесли руками:
-- IF NOT EXISTS делает строку безвредной для всех остальных.
CREATE INDEX IF NOT EXISTS "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");
