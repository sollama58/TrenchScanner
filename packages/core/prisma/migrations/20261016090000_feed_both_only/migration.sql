SET LOCAL lock_timeout = '5s';

-- Settings' "Only alerts both caught" switch (User.feedBothOnly). A constant default, so no rewrite.
ALTER TABLE "User" ADD COLUMN "feedBothOnly" BOOLEAN NOT NULL DEFAULT false;
