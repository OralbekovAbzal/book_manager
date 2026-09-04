-- CreateTable
CREATE TABLE "BookingService" (
    "id" SERIAL NOT NULL,
    "bookingId" INTEGER NOT NULL,
    "serviceId" INTEGER NOT NULL,
    "adults" INTEGER NOT NULL DEFAULT 0,
    "children" INTEGER NOT NULL DEFAULT 0,
    "quantity" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BookingService_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BookingService_bookingId_idx" ON "BookingService"("bookingId");

-- CreateIndex
CREATE INDEX "BookingService_serviceId_idx" ON "BookingService"("serviceId");

-- CreateIndex
CREATE UNIQUE INDEX "BookingService_bookingId_serviceId_key" ON "BookingService"("bookingId", "serviceId");

-- AddForeignKey
ALTER TABLE "BookingService" ADD CONSTRAINT "BookingService_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingService" ADD CONSTRAINT "BookingService_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── Перенос старых броней ───────────────────────────────────────────────────
-- До этой таблицы «кому начислять питание» жило в счётчиках гостей «с питанием»,
-- а «что начислять» — в глобальном флаге Service."includedByDefault". Чтобы старые
-- брони считались ТОЧНО так же, как считались вчера, переносим ту же связь строками:
-- каждой броне, где кто-то был «с питанием», подключаем услуги, начислявшиеся
-- по умолчанию, с тем же числом едоков (доп. место с питанием — тоже едок,
-- по взрослой цене, как и в старом генераторе).
--
-- Бронь, где «с питанием» никого не было, строк не получает: вчера ей питание
-- тоже не начислялось. Услуги вне питания (kind <> 'meal') на момент миграции
-- в includedByDefault не значились ни одной; если такая появится позже, она
-- подставляется в НОВЫЕ брони формой, а не задним числом.
INSERT INTO "BookingService" ("bookingId", "serviceId", "adults", "children", "quantity", "createdAt", "updatedAt")
SELECT b."id",
       s."id",
       b."adultsWithMeals" + b."extraBedsWithMeals",
       b."childrenWithMeals",
       1,
       CURRENT_TIMESTAMP,
       CURRENT_TIMESTAMP
FROM "Booking" b
CROSS JOIN "Service" s
WHERE s."isActive"
  AND s."includedByDefault"
  AND s."kind" = 'meal'
  AND (b."adultsWithMeals" + b."extraBedsWithMeals" + b."childrenWithMeals") > 0
ON CONFLICT ("bookingId", "serviceId") DO NOTHING;
