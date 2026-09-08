-- Поиск без учёта регистра по кириллице (аудит D8-001).
-- Встроенный Postgres упакованной программы создан с libc-локалью C: там lower()/ILIKE
-- сворачивают регистр только у латиницы, и «асель» не находит «Асель». Коллация pg_c_utf8
-- (встроенный провайдер PostgreSQL 17+, есть в любой UTF8-базе) сворачивает регистр по
-- Unicode, сортирует по кодовым точкам. Задаём её только колонкам, по которым ищут ILIKE /
-- mode: 'insensitive': Booking.guestName и Room.number. Индекс Room_number_key пересоздаётся
-- автоматически. На dev-базе (libc Russian_Kazakhstan.1251, UTF8) применяется так же.
-- Prisma коллацию колонок не моделирует: drift после этой миграции не возникает (проверено
-- `prisma migrate diff` 2026-09-08). Если когда-нибудь тип колонки меняется через миграцию,
-- COLLATE pg_c_utf8 надо повторить явно — иначе коллация молча сбросится на умолчание базы.
ALTER TABLE "Booking" ALTER COLUMN "guestName" TYPE TEXT COLLATE pg_c_utf8;
ALTER TABLE "Room"    ALTER COLUMN "number"    TYPE TEXT COLLATE pg_c_utf8;
