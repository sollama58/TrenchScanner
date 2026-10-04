import { describe, expect, it } from "vitest";
import { amzDate, s3PutObject, signV4 } from "./s3.js";

describe("signV4", () => {
  it("matches AWS's published GET Object example", () => {
    // https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html
    const emptyHash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    const auth = signV4({
      method: "GET",
      url: new URL("https://examplebucket.s3.amazonaws.com/test.txt"),
      headers: {
        host: "examplebucket.s3.amazonaws.com",
        range: "bytes=0-9",
        "x-amz-content-sha256": emptyHash,
        "x-amz-date": "20130524T000000Z",
      },
      payloadHash: emptyHash,
      region: "us-east-1",
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    });
    expect(auth).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, " +
        "SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, " +
        "Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
    );
  });

  it("formats x-amz-date", () => {
    expect(amzDate(new Date("2026-10-05T04:00:01.234Z"))).toBe("20261005T040001Z");
  });
});

describe("s3PutObject", () => {
  it("PUTs path-style to bucket/key with a signed request, and throws on an error status", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const ok = (async (url: URL, init: RequestInit) => {
      calls.push({ url: url.toString(), init });
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;
    const cfg = {
      endpoint: "https://acct.r2.cloudflarestorage.com/",
      bucket: "models",
      region: "auto",
      accessKeyId: "id",
      secretAccessKey: "secret",
    };
    await s3PutObject(
      cfg,
      "trenchscanner/model-backups/a b.json.gz",
      new Uint8Array([1, 2, 3]),
      "application/gzip",
      ok,
    );
    expect(calls[0]!.url).toBe(
      "https://acct.r2.cloudflarestorage.com/models/trenchscanner/model-backups/a%20b.json.gz",
    );
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=id\/\d{8}\/auto\/s3\/aws4_request/);
    expect(headers["content-type"]).toBe("application/gzip");

    const denied = (async () => new Response("AccessDenied", { status: 403 })) as unknown as typeof fetch;
    await expect(s3PutObject(cfg, "k", new Uint8Array([1]), undefined, denied)).rejects.toThrow(/403/);
  });
});
