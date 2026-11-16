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
