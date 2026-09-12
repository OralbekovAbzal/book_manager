-- AlterTable
ALTER TABLE "HotelSettings" ADD COLUMN     "trialStartedAt" TIMESTAMP(3);

-- Существующие установки: пробный период считаем с момента прохождения мастера
-- первого запуска (setupCompletedAt), а если его нет — с этого обновления.
-- У клиентов с ключом это ни на что не влияет: с действующим ключом гейт по
-- пробному периоду не смотрит.
UPDATE "HotelSettings" SET "trialStartedAt" = COALESCE("setupCompletedAt", NOW() AT TIME ZONE 'UTC') WHERE "id" = 1;
