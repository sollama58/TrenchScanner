import { createHash, createHmac } from "node:crypto";

/**
 * Just enough of the S3 API to keep off-site copies of the model backups and to hand out the
 * nightly database dumps: a signed PUT and GET of one object, a listing, and a presigned GET link,
 * path-style, against any S3-compatible service (Cloudflare R2, Backblaze B2, AWS S3, MinIO). AWS
 * Signature Version 4 is a few HMACs; signing it here keeps the AWS SDK and its dependency tree
 * out of the worker and the API for a handful of calls.
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

/** The canonical query string: every parameter URI-encoded, sorted by name then value. */
function canonicalQuery(url: URL): string {
  return [...url.searchParams]
    .map(([k, v]) => [encodeSegment(k), encodeSegment(v)] as const)
    .sort(([ak, av], [bk, bv]) => (ak < bk ? -1 : ak > bk ? 1 : av < bv ? -1 : av > bv ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
}

/** The SigV4 signature (hex) of one canonical request, and its credential scope. */
function signatureFor(input: {
  method: string;
  url: URL;
  headers: Record<string, string>;
  payloadHash: string;
  date: string;
  region: string;
  service: string;
  secretAccessKey: string;
}): { signature: string; scope: string; signedHeaders: string } {
  const day = input.date.slice(0, 8);
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
    canonicalQuery(input.url),
    canonicalHeaders,
    signedHeaders,
    input.payloadHash,
  ].join("\n");
  const scope = `${day}/${input.region}/${input.service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", input.date, scope, sha256Hex(canonicalRequest)].join("\n");
  const key = hmac(
    hmac(hmac(hmac(`AWS4${input.secretAccessKey}`, day), input.region), input.service),
    "aws4_request",
  );
  return { signature: createHmac("sha256", key).update(toSign).digest("hex"), scope, signedHeaders };
}

/**
 * The Authorization header for one request (SigV4, header-signed). `headers` must already hold
 * every header to sign, lower-cased, including host, x-amz-date and x-amz-content-sha256.
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
  const { signature, scope, signedHeaders } = signatureFor({
    ...input,
    date: input.headers["x-amz-date"]!,
    service: input.service ?? "s3",
  });
  return `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

/**
 * A presigned GET of `url` (SigV4 query auth): anyone holding the link can fetch the object until
 * it expires, with no key of their own. `url` may carry response-* overrides (e.g.
 * response-content-disposition); they are signed with the rest.
 */
export function presignV4(input: {
  url: URL;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  expiresSeconds: number;
  now?: Date;
}): URL {
  const url = new URL(input.url);
  const date = amzDate(input.now ?? new Date());
  const scope = `${date.slice(0, 8)}/${input.region}/s3/aws4_request`;
  url.searchParams.set("X-Amz-Algorithm", "AWS4-HMAC-SHA256");
  url.searchParams.set("X-Amz-Credential", `${input.accessKeyId}/${scope}`);
  url.searchParams.set("X-Amz-Date", date);
  url.searchParams.set("X-Amz-Expires", String(Math.round(input.expiresSeconds)));
  url.searchParams.set("X-Amz-SignedHeaders", "host");
  const { signature } = signatureFor({
    method: "GET",
    url,
    headers: { host: url.host },
    payloadHash: "UNSIGNED-PAYLOAD",
    date,
    region: input.region,
    service: "s3",
    secretAccessKey: input.secretAccessKey,
  });
  // Re-encoded the way S3 reads it: URLSearchParams writes a space as "+", S3 wants %20.
  const query = canonicalQuery(url);
  return new URL(`${url.origin}${url.pathname}?${query}&X-Amz-Signature=${signature}`);
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
  url: URL = objectUrl(cfg, key),
): Promise<Response> {
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

export interface S3ObjectInfo {
  key: string;
  sizeBytes: number;
  lastModified: Date | null;
}

const xmlText = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");

/** Every object under `prefix` (ListObjectsV2, all pages), in the service's order (by key). */
export async function s3ListObjects(
  cfg: S3Config,
  prefix: string,
  fetchImpl?: typeof fetch,
  maxPages = 20,
): Promise<S3ObjectInfo[]> {
  const out: S3ObjectInfo[] = [];
  let token: string | null = null;
  for (let page = 0; page < maxPages; page++) {
    const url = new URL(`${cfg.endpoint.replace(/\/+$/, "")}/${encodeSegment(cfg.bucket)}`);
    url.searchParams.set("list-type", "2");
    url.searchParams.set("prefix", prefix);
    if (token) url.searchParams.set("continuation-token", token);
    // The query is signed as canonicalQuery encodes it, so it is sent the same way.
    const sent = new URL(`${url.origin}${url.pathname}?${canonicalQuery(url)}`);
    const res = await send(cfg, "GET", `?list ${prefix}`, undefined, undefined, fetchImpl, sent);
    const xml = await res.text();
    for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const body = m[1]!;
      const key = /<Key>([\s\S]*?)<\/Key>/.exec(body)?.[1];
      if (key === undefined) continue;
      const size = Number(/<Size>(\d+)<\/Size>/.exec(body)?.[1] ?? 0);
      const modified = /<LastModified>([^<]+)<\/LastModified>/.exec(body)?.[1];
      out.push({ key: xmlText(key), sizeBytes: size, lastModified: modified ? new Date(modified) : null });
    }
    const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
    const next = /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(xml)?.[1];
    if (!truncated || !next) break;
    token = xmlText(next);
  }
  return out;
}

/**
 * A link that downloads `key` for `expiresSeconds`, saved as `fileName` when given. The browser
 * fetches the object from the bucket itself, so nothing of it passes through this process.
 */
export function s3PresignedGetUrl(
  cfg: S3Config,
  key: string,
  expiresSeconds: number,
  fileName?: string,
  now?: Date,
): string {
  const url = objectUrl(cfg, key);
  if (fileName) url.searchParams.set("response-content-disposition", `attachment; filename="${fileName}"`);
  return presignV4({
    url,
    region: cfg.region,
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
    expiresSeconds,
    now,
  }).toString();
}
