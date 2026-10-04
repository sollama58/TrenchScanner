import { createHash, createHmac } from "node:crypto";

/**
 * Just enough of the S3 API to keep off-site copies of the model backups: a signed PUT and GET of
 * one object, path-style, against any S3-compatible service (Cloudflare R2, Backblaze B2, AWS S3,
 * MinIO). AWS Signature Version 4 is a few HMACs; signing it here keeps the AWS SDK and its
 * dependency tree out of the worker for two calls a week.
 */

export interface S3Config {
  /** Base URL of the service, e.g. https://<account>.r2.cloudflarestorage.com - no bucket in it. */
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

const sha256Hex = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
const hmac = (key: string | Buffer, data: string) => createHmac("sha256", key).update(data).digest();

/** S3's URI encoding: RFC 3986 unreserved characters pass, everything else is %XX. */
function encodeSegment(segment: string): string {
  return encodeURIComponent(segment).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** "20130524T000000Z" for a Date. */
export function amzDate(d: Date): string {
  return d.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

/**
 * The Authorization header for one request (SigV4, header-signed, no query string). `headers`
 * must already hold every header to sign, lower-cased, including host, x-amz-date and
 * x-amz-content-sha256.
 */
export function signV4(input: {
  method: string;
  url: URL;
  headers: Record<string, string>;
  payloadHash: string;
  region: string;
  service?: string;
  accessKeyId: string;
  secretAccessKey: string;
}): string {
  const service = input.service ?? "s3";
  const date = input.headers["x-amz-date"]!;
  const day = date.slice(0, 8);
  const names = Object.keys(input.headers)
    .map((h) => h.toLowerCase())
    .sort();
  const canonicalHeaders = names
    .map((h) => `${h}:${input.headers[h]!.trim().replace(/\s+/g, " ")}\n`)
    .join("");
  const signedHeaders = names.join(";");
  const canonicalRequest = [
    input.method,
    input.url.pathname,
    "",
    canonicalHeaders,
    signedHeaders,
    input.payloadHash,
  ].join("\n");
  const scope = `${day}/${input.region}/${service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", date, scope, sha256Hex(canonicalRequest)].join("\n");
  const key = hmac(
    hmac(hmac(hmac(`AWS4${input.secretAccessKey}`, day), input.region), service),
    "aws4_request",
  );
  const signature = createHmac("sha256", key).update(toSign).digest("hex");
  return `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

function objectUrl(cfg: S3Config, key: string): URL {
  const base = cfg.endpoint.replace(/\/+$/, "");
  const path = [cfg.bucket, ...key.split("/")].map(encodeSegment).join("/");
  return new URL(`${base}/${path}`);
}

async function send(
  cfg: S3Config,
  method: "PUT" | "GET",
  key: string,
  body?: Uint8Array,
  contentType?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const url = objectUrl(cfg, key);
  const payloadHash = sha256Hex(body ?? "");
  const headers: Record<string, string> = {
    host: url.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate(new Date()),
  };
  if (contentType) headers["content-type"] = contentType;
  const authorization = signV4({
    method,
    url,
    headers,
    payloadHash,
    region: cfg.region,
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
  });
  const { host: _host, ...sent } = headers;
  const res = await fetchImpl(url, {
    method,
    headers: { ...sent, authorization },
    body,
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`S3 ${method} ${key} answered ${res.status}: ${text.slice(0, 300)}`);
  }
  return res;
}

export async function s3PutObject(
  cfg: S3Config,
  key: string,
  body: Uint8Array,
  contentType = "application/octet-stream",
  fetchImpl?: typeof fetch,
): Promise<void> {
  const res = await send(cfg, "PUT", key, body, contentType, fetchImpl);
  await res.arrayBuffer().catch(() => undefined);
}

export async function s3GetObject(cfg: S3Config, key: string, fetchImpl?: typeof fetch): Promise<Buffer> {
  const res = await send(cfg, "GET", key, undefined, undefined, fetchImpl);
  return Buffer.from(await res.arrayBuffer());
}
