/**
 * Loads the repo's single root .env file, explicitly, before anything else
 * runs. This MUST be the first import in index.ts - earlier than the
 * `@trenchscanner/core` import - because constructing PrismaClient (a
 * side effect of importing core) triggers Prisma's own auto-loading of any
 * .env file colocated with schema.prisma. dotenv does not override
 * already-set process.env values, so whichever loader runs first wins;
 * this file makes sure that's always us, always from one canonical place,
 * regardless of cwd or import order surprises.
 *
 * In production (Render), no .env file exists - env vars are injected
 * directly by the platform - so this is a harmless no-op there.
 */
import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
// src/bootstrap-env.ts (dev, via tsx) or dist/bootstrap-env.js (prod, via node) are both
// three levels below the repo root: apps/api/{src,dist} -> apps/api -> apps -> root.
config({ path: resolve(here, "../../../.env") });
