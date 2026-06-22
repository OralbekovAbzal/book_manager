-- Защита от двойного бронирования на уровне БД (race condition, приоритет №1 из NOTES).
-- БД физически запрещает пересечение АКТИВНЫХ броней (CONFIRMED/CHECKED_IN) в одном номере.
-- Совпадает с логикой findOverlap: daterange [checkIn, checkOut) пересекается (&&).
-- CHECKED_OUT/CANCELLED/NO_SHOW исключены (WHERE) → освобождённые даты снова доступны.
-- Откат: ALTER TABLE "Booking" DROP CONSTRAINT booking_no_overlap;

CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE "Booking"
  ADD CONSTRAINT booking_no_overlap
  EXCLUDE USING gist (
    "roomId" WITH =,
    daterange("checkIn", "checkOut") WITH &&
  )
  WHERE (status IN ('CONFIRMED', 'CHECKED_IN'));
