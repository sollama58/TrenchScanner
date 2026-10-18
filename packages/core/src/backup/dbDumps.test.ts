import { describe, expect, it } from "vitest";
import { dbDumpDownload, dumpStampTime, listDbDumps } from "./dbDumps.js";

const cfg = {
  endpoint: "https://acct.r2.cloudflarestorage.com",
  bucket: "dumps",
  region: "auto",
  accessKeyId: "id",
  secretAccessKey: "s",
  prefix: "trenchscanner/",
};

const SHA = "a".repeat(64);

/** A bucket holding `keys` (each 100 bytes), answering ListObjectsV2 and GETs of .sha256 files. */
function bucket(keys: string[]) {
  return (async (url: URL) => {
    const prefix = url.searchParams.get("prefix");
    if (url.searchParams.get("list-type") === "2") {
      const xml = keys
        .filter((k) => k.startsWith(prefix ?? ""))
        .map((k) => `<Contents><Key>${k}</Key><Size>100</Size></Contents>`)
        .join("");
      return new Response(`<ListBucketResult><IsTruncated>false</IsTruncated>${xml}</ListBucketResult>`);
    }
    if (url.pathname.endsWith(".sha256")) return new Response(`${SHA}  x.dump\n`);
    return new Response("", { status: 404 });
  }) as unknown as typeof fetch;
}

describe("dumpStampTime", () => {
  it("reads backup.sh's stamp", () => {
    expect(dumpStampTime("trenchscanner-20261018T023000Z.dump")).toBe("2026-10-18T02:30:00Z");
    expect(dumpStampTime("other.dump")).toBeNull();
  });
});

describe("listDbDumps", () => {
  it("lists only complete dumps, newest first, from both folders", async () => {
    const fetchImpl = bucket([
      "trenchscanner/db-dumps/trenchscanner-20261016T023000Z.dump",
      "trenchscanner/db-dumps/trenchscanner-20261016T023000Z.sha256",
      "trenchscanner/db-dumps/trenchscanner-20261017T023000Z.dump",
      "trenchscanner/db-dumps/trenchscanner-20261017T023000Z.sha256",
      // Still uploading: no .sha256 yet.
      "trenchscanner/db-dumps/trenchscanner-20261018T023000Z.dump",
      "trenchscanner/db-dumps-pre-restore/trenchscanner-20261016T120000Z.dump",
      "trenchscanner/db-dumps-pre-restore/trenchscanner-20261016T120000Z.sha256",
    ]);
    const dumps = await listDbDumps(cfg, fetchImpl);
    expect(dumps.map((d) => [d.name, d.kind])).toEqual([
      ["trenchscanner-20261017T023000Z.dump", "nightly"],
      ["trenchscanner-20261016T120000Z.dump", "pre-restore"],
      ["trenchscanner-20261016T023000Z.dump", "nightly"],
    ]);
  });
});

describe("dbDumpDownload", () => {
  const fetchImpl = bucket([
    "trenchscanner/db-dumps/trenchscanner-20261017T023000Z.dump",
    "trenchscanner/db-dumps/trenchscanner-20261017T023000Z.sha256",
    "trenchscanner/db-dumps/trenchscanner-20261018T023000Z.dump",
  ]);

  it("signs a link to a complete dump and returns its recorded sha256", async () => {
    const d = await dbDumpDownload(
      cfg,
      "trenchscanner-20261017T023000Z.dump",
      fetchImpl,
      new Date("2026-10-18T22:00:00Z"),
    );
    expect(d?.sha256).toBe(SHA);
    expect(d?.url).toContain("/dumps/trenchscanner/db-dumps/trenchscanner-20261017T023000Z.dump?");
    expect(d?.url).toContain("X-Amz-Signature=");
    expect(d?.expiresAt).toBe("2026-10-18T22:15:00.000Z");
  });

  it("refuses an incomplete dump and any name that isn't a dump", async () => {
    expect(await dbDumpDownload(cfg, "trenchscanner-20261018T023000Z.dump", fetchImpl)).toBeNull();
    expect(await dbDumpDownload(cfg, "../model-backups/x.json.gz", fetchImpl)).toBeNull();
  });
});
