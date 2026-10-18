-- What each top-250 $ASDFASDFA wallet held at its last scan, for Settings' Pro Mode card ("it
-- takes N $ASDFASDFA to get in"). Nullable: rows from earlier scans fill in at the next scan.
ALTER TABLE "ProHolder" ADD COLUMN "heldRaw" TEXT;
