-- Marketr milestone 5: rank-tracking toggle on saved keywords.
ALTER TABLE "keywords" ADD COLUMN "tracked" BOOLEAN NOT NULL DEFAULT false;
