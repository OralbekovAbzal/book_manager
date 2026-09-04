-- Защита от двойного бронирования на уровне БД (race condition, приоритет №1 из NOTES).
-- БД физически запрещает пересечение АКТИВНЫХ броней (CONFIRMED/CHECKED_IN) в одном номере.
-- Совпадает с логикой findOverlap: daterange [checkIn, checkOut) пересекается (&&).
-- CHECKED_OUT/CANCELLED/NO_SHOW исключены (WHERE) → освобождённые даты снова доступны.
--
-- DEFERRABLE INITIALLY IMMEDIATE: по умолчанию проверка на каждом INSERT/UPDATE (как раньше),
-- но транзакция может отложить её до COMMIT через `SET CONSTRAINTS booking_no_overlap DEFERRED`.
-- Это нужно оптимизатору: обмен броней A↔B по одной даёт временное пересечение, которое
-- неотложенное ограничение отклоняло на первом же UPDATE (любой план → 409).
--
-- Скрипт идемпотентен — можно применять повторно:
--   cd server && npx prisma db execute --file prisma/sql/booking_no_overlap.sql --schema prisma/schema.prisma
-- Откат: ALTER TABLE "Booking" DROP CONSTRAINT booking_no_overlap;

CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE "Booking" DROP CONSTRAINT IF EXISTS booking_no_overlap;

ALTER TABLE "Booking"
  ADD CONSTRAINT booking_no_overlap
  EXCLUDE USING gist (
    "roomId" WITH =,
    daterange("checkIn", "checkOut") WITH &&
  )
  WHERE (status IN ('CONFIRMED', 'CHECKED_IN'))
  DEFERRABLE INITIALLY IMMEDIATE;
