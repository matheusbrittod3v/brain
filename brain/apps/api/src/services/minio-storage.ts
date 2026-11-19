import { createHash, createHmac } from "node:crypto";

export interface MinioUploadOptions {
  endpoint?: string;
  bucket?: string;
  accessKey?: string;
  secretKey?: string;
  region?: string;
  key: string;
  body: Buffer | string;
  contentType?: string;
}

export interface MinioUploadResult {
  uploaded: boolean;
  bucket: string;
  key: string;
  uri: string;
  httpUrl: string;
  status?: number;
}

function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function hmacSha256(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

function signS3Request(params: {
  method: "PUT" | "HEAD" | "GET";
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

  const kDate = hmacSha256(`AWS4${params.secretKey}`, dateStamp);
  const kRegion = hmacSha256(kDate, params.region);
  const kService = hmacSha256(kRegion, "s3");
  const kSigning = hmacSha256(kService, "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");

  return {
    ...headers,
    Authorization: `AWS4-HMAC-SHA256 Credential=${params.accessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
  };
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
  const uri = `s3://${bucket}/${cleanKey}`;
  const httpUrl = `${endpoint}/${bucket}/${cleanKey}`;

  try {
    await ensureMinioBucket({ endpoint, bucket, accessKey, secretKey, region });
    const payload = typeof opts.body === "string" ? Buffer.from(opts.body, "utf8") : opts.body;
    const url = new URL(httpUrl);
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
      httpUrl,
      status: res.status
    };
  } catch {
    return {
      uploaded: false,
      bucket,
      key: cleanKey,
      uri,
      httpUrl
    };
  }
}
