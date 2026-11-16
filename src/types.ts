/** Download method used for a single request. */
export type Method = "curl" | "browser";

/** How the method is chosen: `auto` tries curl first and falls back to the browser. */
export type Mode = "auto" | Method;

/** Result of one fully completed HTTP request. */
export interface FetchResult {
  method: Method;
  /** Final HTTP status code (after redirects). */
  status: number;
  /** Value of the Content-Type response header, lower-cased, without parameters. */
  contentType: string;
  /** Number of body bytes received. */
  bytes: number;
  /** Time from sending the request until the last body byte arrived, in seconds. */
  timeSec: number;
  /** File name suggested by the server (Content-Disposition), if any. */
  fileName?: string;
  /** Returns the downloaded body (used to save the file). */
  body: () => Promise<Uint8Array>;
}

/** HTTP statuses that usually mean "a bot was blocked" rather than "the resource is missing". */
export const BLOCKED_STATUSES = new Set([401, 403, 429, 503]);

export class FetchError extends Error {
  constructor(
    message: string,
    readonly method: Method,
    readonly status?: number,
  ) {
    super(message);
    this.name = "FetchError";
  }
}

/** Strips parameters such as `; charset=utf-8` and lower-cases the media type. */
export function normalizeContentType(raw: string | undefined | null): string {
  return (raw ?? "").split(";")[0]!.trim().toLowerCase();
}

/**
 * Extracts the file name from a Content-Disposition header value.
 * Supports `filename*=UTF-8''name` (RFC 5987) and `filename="name"`.
 */
export function fileNameFromDisposition(header: string | undefined | null): string | undefined {
  if (!header) return undefined;
  const extended = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(header);
  if (extended) {
    try {
      return decodeURIComponent(extended[2]!.trim().replace(/^"|"$/g, ""));
    } catch {
      // Malformed percent-encoding: fall through to the plain parameter.
    }
  }
  const plain = /filename\s*=\s*("([^"]*)"|[^;]+)/i.exec(header);
  const name = (plain?.[2] ?? plain?.[1])?.trim();
  return name || undefined;
}
