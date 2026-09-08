-- AlterTable
ALTER TABLE "Admin" ALTER COLUMN "role" SET DEFAULT 'ADMIN';

-- AlterTable
ALTER TABLE "Booking" ADD COLUMN     "accountBookingId" INTEGER,
ADD COLUMN     "allotmentOverride" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "Booking_accountBookingId_idx" ON "Booking"("accountBookingId");

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_accountBookingId_fkey" FOREIGN KEY ("accountBookingId") REFERENCES "Booking"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Перевод существующих STAFF в ADMIN (решение 2026-09-08, docs/decisions/interface.md).
-- Само значение STAFF из enum "AdminRole" НЕ удаляем: смена enum в Postgres — это
-- пересоздание типа со всеми зависимыми колонками ради значения, которым после этого
-- UPDATE никто не пользуется. Создание STAFF запрещается на сервере и в интерфейсе.
--
-- tokenVersion увеличиваем, чтобы принудительно разлогинить бывших STAFF: сервер берёт
-- роль из базы на каждом запросе и повысит их сразу, но КЛИЕНТ кэширует роль в
-- localStorage с момента входа — без перелогина сотрудник до истечения токена (8 ч)
-- видел бы интерфейс STAFF, уже имея права ADMIN.
UPDATE "Admin" SET role = 'ADMIN', "tokenVersion" = "tokenVersion" + 1 WHERE role = 'STAFF';
