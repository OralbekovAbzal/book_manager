-- AlterTable
ALTER TABLE "Booking" ADD COLUMN     "guestBirthDate" DATE,
ADD COLUMN     "guestCitizenship" TEXT,
ADD COLUMN     "guestDocExpiry" DATE,
ADD COLUMN     "guestDocNumber" TEXT,
ADD COLUMN     "guestDocType" TEXT,
ADD COLUMN     "guestSex" TEXT;
