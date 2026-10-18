import { describe, expect, it } from "vitest";
import { amzDate, presignV4, s3ListObjects, s3PresignedGetUrl, s3PutObject, signV4 } from "./s3.js";

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

  it("matches AWS's published GET Bucket (list objects) example, query string included", () => {
    // https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html
    const emptyHash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    const auth = signV4({
      method: "GET",
      url: new URL("https://examplebucket.s3.amazonaws.com/?max-keys=2&prefix=J"),
      headers: {
        host: "examplebucket.s3.amazonaws.com",
        "x-amz-content-sha256": emptyHash,
        "x-amz-date": "20130524T000000Z",
      },
      payloadHash: emptyHash,
      region: "us-east-1",
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    });
    expect(auth).toMatch(/Signature=34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7$/);
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

describe("presignV4", () => {
  it("matches AWS's published presigned URL example", () => {
    // https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-query-string-auth.html
    const url = presignV4({
      url: new URL("https://examplebucket.s3.amazonaws.com/test.txt"),
      region: "us-east-1",
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      expiresSeconds: 86400,
      now: new Date("2013-05-24T00:00:00Z"),
    });
    expect(url.searchParams.get("X-Amz-Signature")).toBe(
      "aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404",
    );
    expect(url.searchParams.get("X-Amz-Credential")).toBe(
      "AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request",
    );
  });

  it("signs a download file name and encodes its spaces and quotes as S3 reads them", () => {
    const link = s3PresignedGetUrl(
      {
        endpoint: "https://acct.r2.cloudflarestorage.com",
        bucket: "dumps",
        region: "auto",
        accessKeyId: "id",
        secretAccessKey: "s",
      },
      "trenchscanner/db-dumps/trenchscanner-20261018T023000Z.dump",
      900,
      "trenchscanner-20261018T023000Z.dump",
      new Date("2026-10-18T22:00:00Z"),
    );
    expect(link).toMatch(/^https:\/\/acct\.r2\.cloudflarestorage\.com\/dumps\/trenchscanner\/db-dumps\//);
    expect(link).toContain(
      "response-content-disposition=attachment%3B%20filename%3D%22trenchscanner-20261018T023000Z.dump%22",
    );
    expect(link).toContain("X-Amz-Expires=900");
    expect(link).not.toContain("+");
  });
});

describe("s3ListObjects", () => {
  it("reads every page of a ListObjectsV2 answer", async () => {
    const urls: string[] = [];
    const pages = [
      `<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>t&amp;2</NextContinuationToken>
        <Contents><Key>p/a.dump</Key><LastModified>2026-10-17T02:40:00.000Z</LastModified><Size>123</Size></Contents>
      </ListBucketResult>`,
      `<ListBucketResult><IsTruncated>false</IsTruncated>
        <Contents><Key>p/a&amp;b.sha256</Key><Size>80</Size></Contents>
      </ListBucketResult>`,
    ];
    const fetchImpl = (async (url: URL) => {
      urls.push(url.toString());
      return new Response(pages[urls.length - 1], { status: 200 });
    }) as unknown as typeof fetch;
    const cfg = {
      endpoint: "https://acct.r2.cloudflarestorage.com",
      bucket: "b",
      region: "auto",
      accessKeyId: "id",
      secretAccessKey: "s",
    };
    const objects = await s3ListObjects(cfg, "p/", fetchImpl);
    expect(objects).toEqual([
      { key: "p/a.dump", sizeBytes: 123, lastModified: new Date("2026-10-17T02:40:00.000Z") },
      { key: "p/a&b.sha256", sizeBytes: 80, lastModified: null },
    ]);
    expect(urls[0]).toBe("https://acct.r2.cloudflarestorage.com/b?list-type=2&prefix=p%2F");
    expect(urls[1]).toBe(
      "https://acct.r2.cloudflarestorage.com/b?continuation-token=t%262&list-type=2&prefix=p%2F",
    );
  });
});
