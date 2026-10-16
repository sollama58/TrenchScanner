SET LOCAL lock_timeout = '5s';

-- Settings' "Only alerts both caught" switch (User.feedBothOnly). A constant default, so no rewrite;
-- IF NOT EXISTS so a partly-applied run can be re-run.
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "feedBothOnly" BOOLEAN NOT NULL DEFAULT false;
