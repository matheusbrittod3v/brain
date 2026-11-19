import { createHash, createHmac } from "node:crypto";
import { BrainError } from "@brain/core";

export const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024; // 8 MiB
export const ALLOWED_ARTIFACT_EXTENSIONS = new Set([
  ".json",
  ".md",
  ".txt",
  ".yaml",
  ".yml",
  ".csv",
  ".html",
  ".pdf",
  ".docx",
  ".pptx",
  ".xlsx",
  ".log",
  ".patch",
  ".diff",
  ".png",
  ".svg"
]);

export interface MinioUploadOptions {
  endpoint?: string;
  bucket?: string;
  accessKey?: string;
  secretKey?: string;
  region?: string;
  key: string;
  body: Buffer | string;
  contentType?: string;
  presignExpiresSeconds?: number;
}

export interface MinioUploadResult {
  uploaded: boolean;
  bucket: string;
  key: string;
  uri: string;
  presignedUrl: string;
  expiresInSeconds: number;
  status?: number;
}

export function validateSafeArtifactName(fileName: string): { safeName: string; extension: string } {
  const trimmed = fileName.trim();
  if (!trimmed || trimmed.length > 180) {
    throw new BrainError("BRAIN_ERR_INVALID_INPUT", "Nome de arquivo inválido ou acima de 180 caracteres.", 422);
  }
  if (/[/\\\0\r\n]/.test(trimmed) || trimmed.includes("..") || trimmed.startsWith(".")) {
    throw new BrainError("BRAIN_ERR_INVALID_INPUT", "Nome de arquivo contém caracteres de caminho proibidos.", 422);
  }
  const dotIdx = trimmed.lastIndexOf(".");
  const extension = dotIdx >= 0 ? trimmed.slice(dotIdx).toLowerCase() : "";
  if (!ALLOWED_ARTIFACT_EXTENSIONS.has(extension)) {
    throw new BrainError(
      "BRAIN_ERR_INVALID_INPUT",
      `Extensão '${extension || "(sem extensão)"}' não permitida para artefatos.`,
      422
    );
  }
  const safeName = trimmed.normalize("NFC").replace(/[^A-Za-z0-9._-]+/g, "-");
  return { safeName, extension };
}

function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function hmacSha256(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

function deriveSigningKey(secretKey: string, dateStamp: string, region: string): Buffer {
  const kDate = hmacSha256(`AWS4${secretKey}`, dateStamp);
  const kRegion = hmacSha256(kDate, region);
  const kService = hmacSha256(kRegion, "s3");
  return hmacSha256(kService, "aws4_request");
}

function signS3Request(params: {
  method: "PUT" | "HEAD" | "GET" | "DELETE";
  url: URL;
  payload: Buffer;
  contentType?: string;
  accessKey: string;
  secretKey: string;
  region: string;
}): Record<string, string> {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256Hex(params.payload);
  const host = params.url.host;

  const headers: Record<string, string> = {
    host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate
  };
  if (params.contentType) {
    headers["content-type"] = params.contentType;
  }

  const sortedHeaderKeys = Object.keys(headers).sort();
  const canonicalHeaders = sortedHeaderKeys.map((k) => `${k}:${headers[k]}\n`).join("");
  const signedHeaders = sortedHeaderKeys.join(";");
  const canonicalUri = params.url.pathname
    .split("/")
    .map((seg) => encodeURIComponent(decodeURIComponent(seg)))
    .join("/");

  const canonicalRequest = [
    params.method,
    canonicalUri || "/",
    "",
    canonicalHeaders,
    signedHeaders,
    payloadHash
  ].join("\n");

  const credentialScope = `${dateStamp}/${params.region}/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest)
  ].join("\n");

  const kSigning = deriveSigningKey(params.secretKey, dateStamp, params.region);
  const signature = createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");

  return {
    ...headers,
    Authorization: `AWS4-HMAC-SHA256 Credential=${params.accessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
  };
}

export function presignMinioGetUrl(options: {
  key: string;
  expiresInSeconds?: number;
  endpoint?: string;
  bucket?: string;
  accessKey?: string;
  secretKey?: string;
  region?: string;
}): string {
  const endpoint = (options.endpoint ?? process.env.MINIO_ENDPOINT ?? "http://localhost:9000").replace(/\/+$/, "");
  const bucket = options.bucket ?? process.env.MINIO_BUCKET ?? "brain-artifacts";
  const accessKey = options.accessKey ?? process.env.MINIO_ROOT_USER ?? "brain_minio";
  const secretKey = options.secretKey ?? process.env.MINIO_ROOT_PASSWORD ?? "brain_minio_password";
  const region = options.region ?? "us-east-1";
  const expires = Math.min(3600, Math.max(60, options.expiresInSeconds ?? 900));
  const cleanKey = options.key.replace(/^\/+/, "");

  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const credentialScope = `${dateStamp}/${region}/s3/aws4_request`;

  const baseUrl = new URL(`${endpoint}/${bucket}/${cleanKey}`);
  const canonicalUri = baseUrl.pathname
    .split("/")
    .map((seg) => encodeURIComponent(decodeURIComponent(seg)))
    .join("/");

  const queryParams: Array<[string, string]> = [
    ["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
    ["X-Amz-Credential", `${accessKey}/${credentialScope}`],
    ["X-Amz-Date", amzDate],
    ["X-Amz-Expires", String(expires)],
    ["X-Amz-SignedHeaders", "host"]
  ];
  queryParams.sort((a, b) => a[0].localeCompare(b[0]));
  const canonicalQueryString = queryParams
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");

  const canonicalRequest = [
    "GET",
    canonicalUri || "/",
    canonicalQueryString,
    `host:${baseUrl.host}\n`,
    "host",
    "UNSIGNED-PAYLOAD"
  ].join("\n");

  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest)
  ].join("\n");

  const kSigning = deriveSigningKey(secretKey, dateStamp, region);
  const signature = createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");

  return `${baseUrl.origin}${canonicalUri}?${canonicalQueryString}&X-Amz-Signature=${signature}`;
}

const ensuredBuckets = new Set<string>();

export async function ensureMinioBucket(options: {
  endpoint?: string;
  bucket?: string;
  accessKey?: string;
  secretKey?: string;
  region?: string;
} = {}): Promise<boolean> {
  const endpoint = (options.endpoint ?? process.env.MINIO_ENDPOINT ?? "http://localhost:9000").replace(/\/+$/, "");
  const bucket = options.bucket ?? process.env.MINIO_BUCKET ?? "brain-artifacts";
  const cacheKey = `${endpoint}/${bucket}`;
  if (ensuredBuckets.has(cacheKey)) return true;

  const accessKey = options.accessKey ?? process.env.MINIO_ROOT_USER ?? "brain_minio";
  const secretKey = options.secretKey ?? process.env.MINIO_ROOT_PASSWORD ?? "brain_minio_password";
  const region = options.region ?? "us-east-1";

  try {
    const url = new URL(`${endpoint}/${bucket}`);
    const emptyBuf = Buffer.alloc(0);
    const headers = signS3Request({
      method: "PUT",
      url,
      payload: emptyBuf,
      accessKey,
      secretKey,
      region
    });
    const res = await fetch(url, {
      method: "PUT",
      headers,
      signal: AbortSignal.timeout(2500)
    });
    if (res.ok || res.status === 409) {
      ensuredBuckets.add(cacheKey);
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

export async function uploadObjectToMinio(opts: MinioUploadOptions): Promise<MinioUploadResult> {
  const endpoint = (opts.endpoint ?? process.env.MINIO_ENDPOINT ?? "http://localhost:9000").replace(/\/+$/, "");
  const bucket = opts.bucket ?? process.env.MINIO_BUCKET ?? "brain-artifacts";
  const accessKey = opts.accessKey ?? process.env.MINIO_ROOT_USER ?? "brain_minio";
  const secretKey = opts.secretKey ?? process.env.MINIO_ROOT_PASSWORD ?? "brain_minio_password";
  const region = opts.region ?? "us-east-1";
  const cleanKey = opts.key.replace(/^\/+/, "");
  const expiresInSeconds = Math.min(3600, Math.max(60, opts.presignExpiresSeconds ?? 900));
  const uri = `s3://${bucket}/${cleanKey}`;
  const presignedUrl = presignMinioGetUrl({
    key: cleanKey,
    expiresInSeconds,
    endpoint,
    bucket,
    accessKey,
    secretKey,
    region
  });

  try {
    await ensureMinioBucket({ endpoint, bucket, accessKey, secretKey, region });
    const payload = typeof opts.body === "string" ? Buffer.from(opts.body, "utf8") : opts.body;
    const url = new URL(`${endpoint}/${bucket}/${cleanKey}`);
    const headers = signS3Request({
      method: "PUT",
      url,
      payload,
      contentType: opts.contentType ?? "application/octet-stream",
      accessKey,
      secretKey,
      region
    });
    const res = await fetch(url, {
      method: "PUT",
      headers,
      body: payload,
      signal: AbortSignal.timeout(4000)
    });
    return {
      uploaded: res.ok,
      bucket,
      key: cleanKey,
      uri,
      presignedUrl,
      expiresInSeconds,
      status: res.status
    };
  } catch {
    return {
      uploaded: false,
      bucket,
      key: cleanKey,
      uri,
      presignedUrl,
      expiresInSeconds
    };
  }
}

export async function listMinioObjects(
  prefix: string,
  options: {
    endpoint?: string;
    bucket?: string;
    accessKey?: string;
    secretKey?: string;
    region?: string;
  } = {}
): Promise<string[]> {
  const endpoint = (options.endpoint ?? process.env.MINIO_ENDPOINT ?? "http://localhost:9000").replace(/\/+$/, "");
  const bucket = options.bucket ?? process.env.MINIO_BUCKET ?? "brain-artifacts";
  const accessKey = options.accessKey ?? process.env.MINIO_ROOT_USER ?? "brain_minio";
  const secretKey = options.secretKey ?? process.env.MINIO_ROOT_PASSWORD ?? "brain_minio_password";
  const region = options.region ?? "us-east-1";

  const url = new URL(`${endpoint}/${bucket}`);
  url.searchParams.set("list-type", "2");
  if (prefix) url.searchParams.set("prefix", prefix);

  const emptyBuf = Buffer.alloc(0);
  const headers = signS3Request({
    method: "GET",
    url,
    payload: emptyBuf,
    accessKey,
    secretKey,
    region
  });
  const res = await fetch(url, {
    method: "GET",
    headers,
    signal: AbortSignal.timeout(3000)
  });
  if (res.status === 404) return [];
  if (!res.ok) {
    throw new Error(`MinIO listObjects retornou HTTP ${res.status}`);
  }
  const xml = await res.text();
  const keys: string[] = [];
  const keyRegex = /<Key>([^<]+)<\/Key>/g;
  let match: RegExpExecArray | null;
  while ((match = keyRegex.exec(xml)) !== null) {
    if (match[1]) keys.push(match[1]);
  }
  return keys;
}

export async function deleteMinioObject(
  key: string,
  options: {
    endpoint?: string;
    bucket?: string;
    accessKey?: string;
    secretKey?: string;
    region?: string;
  } = {}
): Promise<boolean> {
  const endpoint = (options.endpoint ?? process.env.MINIO_ENDPOINT ?? "http://localhost:9000").replace(/\/+$/, "");
  const bucket = options.bucket ?? process.env.MINIO_BUCKET ?? "brain-artifacts";
  const accessKey = options.accessKey ?? process.env.MINIO_ROOT_USER ?? "brain_minio";
  const secretKey = options.secretKey ?? process.env.MINIO_ROOT_PASSWORD ?? "brain_minio_password";
  const region = options.region ?? "us-east-1";
  const cleanKey = key.replace(/^\/+/, "");

  const url = new URL(`${endpoint}/${bucket}/${cleanKey}`);
  const emptyBuf = Buffer.alloc(0);
  const headers = signS3Request({
    method: "DELETE",
    url,
    payload: emptyBuf,
    accessKey,
    secretKey,
    region
  });
  const res = await fetch(url, {
    method: "DELETE",
    headers,
    signal: AbortSignal.timeout(3000)
  });
  return res.ok || res.status === 204 || res.status === 404;
}

export async function eraseMinioObjectsForSubject(input: {
  tenantId: string;
  projectId: string;
  subjectId: string;
  endpoint?: string;
  bucket?: string;
  accessKey?: string;
  secretKey?: string;
}): Promise<{ ok: boolean; reachable: boolean; deletedCount: number; failedCount: number }> {
  const endpoint = (input.endpoint ?? process.env.MINIO_ENDPOINT ?? "http://localhost:9000").replace(/\/+$/, "");
  try {
    const health = await fetch(`${endpoint}/minio/health/live`, { signal: AbortSignal.timeout(1500) });
    if (!health.ok) {
      return { ok: false, reachable: false, deletedCount: 0, failedCount: 0 };
    }
  } catch {
    return { ok: false, reachable: false, deletedCount: 0, failedCount: 0 };
  }

  try {
    const prefixes = [
      `${input.tenantId}/${input.projectId}/`,
      `documents/${input.projectId}/`,
      `${input.projectId}/`
    ];
    const allKeys = new Set<string>();
    for (const prefix of prefixes) {
      const found = await listMinioObjects(prefix, {
        endpoint,
        bucket: input.bucket,
        accessKey: input.accessKey,
        secretKey: input.secretKey
      });
      for (const k of found) allKeys.add(k);
    }

    const needle = input.subjectId.toLowerCase();
    const matchingKeys = [...allKeys].filter((k) => k.toLowerCase().includes(needle));
    let deletedCount = 0;
    let failedCount = 0;
    for (const key of matchingKeys) {
      const deleted = await deleteMinioObject(key, {
        endpoint,
        bucket: input.bucket,
        accessKey: input.accessKey,
        secretKey: input.secretKey
      });
      if (deleted) deletedCount += 1;
      else failedCount += 1;
    }
    return { ok: failedCount === 0, reachable: true, deletedCount, failedCount };
  } catch {
    return { ok: false, reachable: true, deletedCount: 0, failedCount: 1 };
  }
}
