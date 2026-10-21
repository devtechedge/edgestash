import { createHmac, timingSafeEqual } from "node:crypto";

export interface ClientTokenPayload {
  pathname?: string;
  validUntil?: number;
  allowedContentTypes?: string[];
  maximumSizeInBytes?: number;
  addRandomSuffix?: boolean;
  allowOverwrite?: boolean;
  cacheControlMaxAge?: number;
  ifMatch?: string;
  onUploadCompleted?: { callbackUrl: string; tokenPayload?: string | null };
}

/** `vercel_blob_rw_<storeId>_<secret>`: the SDK reads the store id from the 4th segment. */
export function storeIdFromToken(token: string): string {
  return token.split("_")[3] ?? "";
}

export const hmacHex = (data: string, key: string) => createHmac("sha256", key).update(data).digest("hex");

/**
 * Verify a client token minted by `generateClientTokenFromReadWriteToken`:
 * `vercel_blob_client_<storeId>_<base64("<hmacHex>.<base64(json)>")>`.
 */
export function verifyClientToken(token: string, readWriteToken: string): ClientTokenPayload | null {
  const encoded = token.split("_")[4];
  if (!encoded) return null;
  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  const dot = decoded.indexOf(".");
  if (dot < 0) return null;
  const sig = decoded.slice(0, dot);
  const payload = decoded.slice(dot + 1);
  const expected = hmacHex(payload, readWriteToken);
  if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    return JSON.parse(Buffer.from(payload, "base64").toString("utf8")) as ClientTokenPayload;
  } catch {
    return null;
  }
}
