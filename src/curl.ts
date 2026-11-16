import { file } from "bun";
import { rmSync } from "node:fs";
import { forOtherHosts, hasAuth, toCurlConfig, type Auth } from "./auth.ts";
import { CHALLENGE_SAMPLE_BYTES } from "./challenge.ts";
import {
  FetchError,
  fileNameFromDisposition,
  normalizeContentType,
  type FetchResult,
} from "./types.ts";

/** A desktop browser User-Agent: the default `curl/x.y` agent is blocked by many CDNs. */
export const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";

/**
 * Fields printed by `curl --write-out`, separated by tabs.
 * `%header{...}` needs curl 7.84+; older versions print it literally, which is treated as empty.
 */
const WRITE_OUT = [
  "%{http_code}",
  "%{content_type}",
  "%{size_download}",
  "%{time_total}",
  "%header{content-disposition}",
  "%header{cf-mitigated}",
  "%{redirect_url}",
].join("\\t");

/** Same limit as browsers. */
const MAX_REDIRECTS = 20;

export interface CurlOptions {
  /** Where curl writes the response body. The file is overwritten on every call. */
  outFile: string;
  /** Maximum time for the whole transfer, in seconds. */
  timeoutSec: number;
  auth: Auth;
  userAgent: string;
}

export interface CurlResult extends FetchResult {
  /** Selected lower-cased response headers. */
  headers: Record<string, string>;
  /** Beginning of the body as text, for anti-bot page detection. */
  sample: () => Promise<string>;
}

/** Throws if the `curl` binary is not available in PATH. */
export function assertCurlAvailable(): void {
  if (!Bun.which("curl")) {
    throw new FetchError("curl was not found in PATH", "curl");
  }
}

const headerValue = (raw: string | undefined) =>
  !raw || raw.startsWith("%header") ? "" : raw.trim();

/**
 * Downloads `url` with the system curl and waits for the full response.
 * Timing and size come from curl itself (`time_total`, `size_download`),
 * so process start-up is not included in the measurement.
 *
 * Without authorization, curl follows redirects itself. With authorization, redirects
 * are followed here hop by hop, because curl would send custom headers and cookie
 * strings to every host it is redirected to; credentials go only to the URL's host.
 * The reported time is the sum of all hops.
 */
export async function curlFetch(url: string, opts: CurlOptions): Promise<CurlResult> {
  if (!hasAuth(opts.auth)) return runCurl(url, opts, toCurlConfig(opts.auth), true);

  const targetHost = new URL(url).host;
  const jar = `${opts.outFile}.cookies`;
  rmSync(jar, { force: true });
  let current = url;
  let totalSec = 0;
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const auth = new URL(current).host === targetHost ? opts.auth : forOtherHosts(opts.auth);
      const result = await runCurl(current, opts, toCurlConfig(auth, jar), false);
      totalSec += result.timeSec;
      if (result.status >= 300 && result.status < 400 && result.redirectUrl) {
        current = result.redirectUrl;
        continue;
      }
      return { ...result, timeSec: totalSec };
    }
  } finally {
    rmSync(jar, { force: true });
  }
  throw new FetchError(`more than ${MAX_REDIRECTS} redirects`, "curl");
}

interface RawCurlResult extends CurlResult {
  redirectUrl: string;
}

/** Runs one curl process. Credentials are passed via `--config -` on stdin, never in argv. */
async function runCurl(
  url: string,
  opts: CurlOptions,
  config: string,
  followRedirects: boolean,
): Promise<RawCurlResult> {
  const proc = Bun.spawn(
    [
      "curl",
      ...(config ? ["--config", "-"] : []),
      "--silent",
      "--show-error",
      ...(followRedirects ? ["--location"] : []),
      "--compressed",
      "--max-time",
      String(opts.timeoutSec),
      "--user-agent",
      opts.userAgent,
      "--header",
      "Accept: */*",
      "--output",
      opts.outFile,
      "--write-out",
      WRITE_OUT,
      "--",
      url,
    ],
    { stdin: config ? new TextEncoder().encode(config) : "ignore", stdout: "pipe", stderr: "pipe" },
  );

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (exitCode !== 0) {
    const reason = stderr.trim().replace(/^curl: \(\d+\)\s*/, "") || `exit code ${exitCode}`;
    throw new FetchError(`curl failed: ${reason}`, "curl");
  }

  const [code, contentType, size, time, disposition, cfMitigated, redirectUrl] = stdout.split("\t");
  const outFile = opts.outFile;
  const headers: Record<string, string> = {};
  if (headerValue(disposition)) headers["content-disposition"] = headerValue(disposition);
  if (headerValue(cfMitigated)) headers["cf-mitigated"] = headerValue(cfMitigated);

  return {
    method: "curl",
    status: Number(code),
    contentType: normalizeContentType(contentType),
    bytes: Number(size),
    timeSec: Number(time),
    fileName: fileNameFromDisposition(headers["content-disposition"]),
    headers,
    body: async () => new Uint8Array(await file(outFile).arrayBuffer()),
    sample: () => file(outFile).slice(0, CHALLENGE_SAMPLE_BYTES).text(),
    redirectUrl: (redirectUrl ?? "").trim(),
  };
}
