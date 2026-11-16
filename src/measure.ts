import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyAuth, readProfileSession, type Auth } from "./auth.ts";
import { browserFetch, closeBrowser } from "./browser.ts";
import { isChallenge } from "./challenge.ts";
import { curlFetch, USER_AGENT, type CurlResult } from "./curl.ts";
import {
  BLOCKED_STATUSES,
  FetchError,
  type FetchResult,
  type Method,
  type Mode,
} from "./types.ts";

export type { Method, Mode } from "./types.ts";

export interface MeasureOptions {
  /** Number of sequential requests per URL. */
  runs: number;
  mode: Mode;
  /** Per-request timeout in seconds. */
  timeoutSec: number;
  /** Directory for the downloaded file, or `null` to skip saving. */
  outDir: string | null;
  /** Credentials, headers, cookies and saved login profile. */
  auth: Auth;
  /** Progress callback for human-readable output. */
  onEvent?: (event: MeasureEvent) => void;
}

export type MeasureEvent =
  | { type: "start"; url: string; index: number; total: number }
  | { type: "fallback"; url: string; reason: string }
  | { type: "challenge"; url: string }
  | { type: "run"; url: string; run: number; runs: number; result: FetchResult }
  | { type: "done"; url: string; report: UrlReport };

export interface RunRecord {
  run: number;
  method: Method;
  status: number;
  bytes: number;
  timeSec: number;
}

export interface UrlReport {
  url: string;
  ok: boolean;
  /** Set when `ok` is false. */
  error?: string;
  /** Methods used for the measured runs, in order of first use. */
  methods: Method[];
  runs: RunRecord[];
  /** Mean request time in seconds. */
  avgSec: number;
  /** Sum of all request times in seconds. */
  totalSec: number;
  /** Sum of body bytes over all runs. */
  totalBytes: number;
  /** totalBytes / totalSec / 10^6. */
  speedMBps: number;
  /** totalBytes * 8 / totalSec / 10^6. */
  speedMbps: number;
  /** Path of the saved file, if saving was enabled. */
  savedTo?: string;
}

export const DEFAULTS: Omit<MeasureOptions, "onEvent" | "auth"> = {
  runs: 10,
  mode: "auto",
  timeoutSec: 60,
  outDir: "downloads",
};

function isSuccess(r: FetchResult): boolean {
  return r.status >= 200 && r.status < 300;
}

/**
 * Decides whether a curl result should be retried in the browser; returns the reason or null.
 * An ordinary HTML page is a valid result; only anti-bot pages trigger the fallback.
 */
async function fallbackReason(r: CurlResult): Promise<string | null> {
  // 401 is an authorization problem, not bot blocking: the browser would get the same answer.
  if (r.status !== 401 && BLOCKED_STATUSES.has(r.status)) return `HTTP ${r.status}`;
  if (!isSuccess(r)) return null;
  const body = r.contentType === "text/html" ? await r.sample() : undefined;
  if (isChallenge({ contentType: r.contentType, headers: r.headers, body })) {
    return "got an anti-bot page";
  }
  return null;
}

/** Explains common failure statuses. */
function statusMessage(status: number, auth: Auth): string {
  const hasCredentials =
    auth.user || auth.headers.length || auth.cookies.length || auth.cookieFile || auth.profile;
  if (status === 401) {
    return hasCredentials ? "HTTP 401 (credentials were rejected)" : "HTTP 401 (authorization required, see --user/--header/--cookie)";
  }
  if (status === 403 && !hasCredentials) return "HTTP 403 (access denied; the site may need authorization)";
  return `HTTP ${status}`;
}

const EXT_BY_TYPE: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/svg+xml": "svg",
  "image/bmp": "bmp",
  "image/tiff": "tiff",
  "image/x-icon": "ico",
  "image/vnd.microsoft.icon": "ico",
  "text/html": "html",
  "text/plain": "txt",
  "text/csv": "csv",
  "text/css": "css",
  "text/xml": "xml",
  "text/javascript": "js",
  "application/javascript": "js",
  "application/json": "json",
  "application/xml": "xml",
  "application/pdf": "pdf",
  "application/zip": "zip",
  "application/gzip": "gz",
  "application/x-gzip": "gz",
  "application/x-tar": "tar",
  "application/x-xz": "xz",
  "application/x-bzip2": "bz2",
  "application/x-7z-compressed": "7z",
  "application/vnd.rar": "rar",
  "application/wasm": "wasm",
  "application/x-msdownload": "exe",
  "application/vnd.debian.binary-package": "deb",
  "application/x-rpm": "rpm",
  "application/x-iso9660-image": "iso",
  "audio/mpeg": "mp3",
  "audio/ogg": "ogg",
  "audio/wav": "wav",
  "audio/flac": "flac",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
  "video/x-matroska": "mkv",
  "font/woff2": "woff2",
};

/** How many times a run is repeated because its timing included an anti-bot challenge. */
const MAX_CHALLENGE_REPEATS = 2;

const usedNames = new Set<string>();

/**
 * Builds a safe, unique file name: the server's Content-Disposition name first,
 * then the last URL path segment, then the host name; an extension is added
 * from the content type if the name has none.
 */
function fileNameFor(url: string, contentType: string, serverName?: string): string {
  const { hostname, pathname } = new URL(url);
  let last = "";
  try {
    last = decodeURIComponent(pathname.split("/").filter(Boolean).pop() ?? "");
  } catch {
    last = pathname.split("/").filter(Boolean).pop() ?? "";
  }
  const fromServer = serverName?.split(/[\\/]/).pop();
  const named = fromServer || last;
  let base = (named || hostname).replace(/[^\w.-]+/g, "_").replace(/^\.+/, "").slice(0, 120) || "download";
  // A bare host name such as "example.com" already "has an extension", so always add one.
  if (!named || !/\.[a-z0-9]{2,5}$/i.test(base)) {
    base += `.${EXT_BY_TYPE[contentType] ?? "bin"}`;
  }
  let name = base;
  for (let i = 2; usedNames.has(name); i++) {
    name = base.replace(/(\.[^.]+)?$/, `-${i}$1`);
  }
  usedNames.add(name);
  return name;
}

const round = (n: number, digits: number) => Number(n.toFixed(digits));

function failedReport(url: string, error: string, runs: RunRecord[], methods: Method[]): UrlReport {
  return {
    url,
    ok: false,
    error,
    methods,
    runs,
    avgSec: 0,
    totalSec: 0,
    totalBytes: 0,
    speedMBps: 0,
    speedMbps: 0,
  };
}

/**
 * Makes `opts.runs` sequential requests to `url`, each one waiting for the full body,
 * and returns the timing and volume statistics.
 */
export async function measure(
  url: string,
  options: Partial<MeasureOptions> = {},
): Promise<UrlReport> {
  const opts = { ...DEFAULTS, auth: emptyAuth(), ...options };
  const userAgent = (opts.auth.profile && readProfileSession(opts.auth.profile).userAgent) || USER_AGENT;
  const emit = opts.onEvent ?? (() => {});
  const tmp = mkdtempSync(join(tmpdir(), "image-speed-meter-"));
  const curlOut = join(tmp, "body");

  let method: Method = opts.mode === "browser" ? "browser" : "curl";
  const methods: Method[] = [];
  const runs: RunRecord[] = [];
  let last: FetchResult | undefined;
  let challenges = 0;

  const switchToBrowser = (reason: string) => {
    method = "browser";
    emit({ type: "fallback", url, reason });
  };

  try {
    for (let run = 1; run <= opts.runs; run++) {
      let result: FetchResult;

      if (method === "curl") {
        try {
          result = await curlFetch(url, {
            outFile: curlOut,
            timeoutSec: opts.timeoutSec,
            auth: opts.auth,
            userAgent,
          });
        } catch (err) {
          if (opts.mode !== "auto") throw err;
          switchToBrowser((err as Error).message);
          run--;
          continue;
        }
        const reason = opts.mode === "auto" ? await fallbackReason(result as CurlResult) : null;
        if (reason) {
          switchToBrowser(`curl was blocked (${reason})`);
          run--;
          continue;
        }
      } else {
        const r = await browserFetch(url, { timeoutSec: opts.timeoutSec, auth: opts.auth });
        if (r.challenged && isSuccess(r) && challenges++ < MAX_CHALLENGE_REPEATS) {
          // The timing includes the anti-bot challenge; the cookie is set now, so repeat the run.
          emit({ type: "challenge", url });
          run--;
          continue;
        }
        result = r;
      }

      if (!isSuccess(result)) {
        throw new FetchError(statusMessage(result.status, opts.auth), result.method, result.status);
      }

      if (!methods.includes(result.method)) methods.push(result.method);
      runs.push({
        run,
        method: result.method,
        status: result.status,
        bytes: result.bytes,
        timeSec: round(result.timeSec, 6),
      });
      last = result;
      emit({ type: "run", url, run, runs: opts.runs, result });
    }

    const totalSec = runs.reduce((s, r) => s + r.timeSec, 0);
    const totalBytes = runs.reduce((s, r) => s + r.bytes, 0);
    const report: UrlReport = {
      url,
      ok: true,
      methods,
      runs,
      avgSec: round(totalSec / runs.length, 6),
      totalSec: round(totalSec, 6),
      totalBytes,
      speedMBps: totalSec > 0 ? round(totalBytes / totalSec / 1e6, 4) : 0,
      speedMbps: totalSec > 0 ? round((totalBytes * 8) / totalSec / 1e6, 4) : 0,
    };

    if (opts.outDir && last) {
      await mkdir(opts.outDir, { recursive: true });
      const target = join(opts.outDir, fileNameFor(url, last.contentType, last.fileName));
      await writeFile(target, await last.body());
      report.savedTo = target;
    }
    return report;
  } catch (err) {
    return failedReport(url, (err as Error).message, runs, methods);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Moves `user:password@` out of a URL. */
export function splitUserInfo(raw: string): { url: string; user?: Auth["user"] } {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { url: raw };
  }
  if (!parsed.username && !parsed.password) return { url: raw };
  const user = {
    name: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
  };
  parsed.username = "";
  parsed.password = "";
  return { url: parsed.href, user };
}

/**
 * Measures one URL or a list of URLs one after another.
 * A failure on one URL does not stop the others. The browser is closed at the end.
 */
export async function measureAll(
  input: string | string[],
  options: Partial<MeasureOptions> = {},
): Promise<UrlReport[]> {
  const urls = Array.isArray(input) ? input : [input];
  const reports: UrlReport[] = [];
  try {
    for (const [i, rawUrl] of urls.entries()) {
      // Credentials embedded in the URL (https://user:pass@host/) become --user for that URL
      // and are removed from the URL, so they never show up in the output.
      const { url, user } = splitUserInfo(rawUrl);
      const auth = { ...emptyAuth(), ...options.auth };
      if (user) auth.user = user;
      options.onEvent?.({ type: "start", url, index: i + 1, total: urls.length });
      const report = await measure(url, { ...options, auth });
      options.onEvent?.({ type: "done", url, report });
      reports.push(report);
    }
  } finally {
    await closeBrowser();
  }
  return reports;
}
