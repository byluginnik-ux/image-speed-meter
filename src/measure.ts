import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browserFetch, closeBrowser } from "./browser.ts";
import { curlFetch } from "./curl.ts";
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

export const DEFAULTS: Omit<MeasureOptions, "onEvent"> = {
  runs: 10,
  mode: "auto",
  timeoutSec: 60,
  outDir: "downloads",
};

/** A 2xx HTML page where binary content was expected is most likely an anti-bot interstitial. */
function looksLikeChallengePage(r: FetchResult): boolean {
  return r.status >= 200 && r.status < 300 && r.contentType === "text/html";
}

function isSuccess(r: FetchResult): boolean {
  return r.status >= 200 && r.status < 300;
}

/** Decides whether a curl result should be retried in the browser; returns the reason or null. */
function fallbackReason(r: FetchResult): string | null {
  if (BLOCKED_STATUSES.has(r.status)) return `HTTP ${r.status}`;
  if (looksLikeChallengePage(r)) return "got an HTML page instead of a file";
  return null;
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
};

/** How many times a run is repeated because its timing included an anti-bot challenge. */
const MAX_CHALLENGE_REPEATS = 2;

const usedNames = new Set<string>();

/** Builds a safe, unique file name from the URL path and the content type. */
function fileNameFor(url: string, contentType: string): string {
  const { hostname, pathname } = new URL(url);
  const last = decodeURIComponent(pathname.split("/").filter(Boolean).pop() ?? "");
  let base = (last || hostname).replace(/[^\w.-]+/g, "_").slice(0, 120) || "download";
  if (!/\.[a-z0-9]{2,5}$/i.test(base)) {
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
  const opts = { ...DEFAULTS, ...options };
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
          result = await curlFetch(url, { outFile: curlOut, timeoutSec: opts.timeoutSec });
        } catch (err) {
          if (opts.mode !== "auto") throw err;
          switchToBrowser((err as Error).message);
          run--;
          continue;
        }
        const reason = opts.mode === "auto" ? fallbackReason(result) : null;
        if (reason) {
          switchToBrowser(`curl was blocked (${reason})`);
          run--;
          continue;
        }
      } else {
        const r = await browserFetch(url, opts.timeoutSec);
        if (r.challenged && isSuccess(r) && challenges++ < MAX_CHALLENGE_REPEATS) {
          // The timing includes the anti-bot challenge; the cookie is set now, so repeat the run.
          emit({ type: "challenge", url });
          run--;
          continue;
        }
        result = r;
      }

      if (!isSuccess(result)) {
        throw new FetchError(`HTTP ${result.status}`, result.method, result.status);
      }
      if (result.method === "browser" && looksLikeChallengePage(result) && opts.mode === "auto") {
        throw new FetchError("the browser also got an HTML page instead of a file", "browser");
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
      const target = join(opts.outDir, fileNameFor(url, last.contentType));
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
    for (const [i, url] of urls.entries()) {
      options.onEvent?.({ type: "start", url, index: i + 1, total: urls.length });
      const report = await measure(url, options);
      options.onEvent?.({ type: "done", url, report });
      reports.push(report);
    }
  } finally {
    await closeBrowser();
  }
  return reports;
}
