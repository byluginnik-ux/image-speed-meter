import { file } from "bun";
import { FetchError, normalizeContentType, type FetchResult } from "./types.ts";

/** A desktop browser User-Agent: the default `curl/x.y` agent is blocked by many CDNs. */
export const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";

/** Fields printed by `curl --write-out`, separated by tabs. */
const WRITE_OUT = "%{http_code}\\t%{content_type}\\t%{size_download}\\t%{time_total}";

export interface CurlOptions {
  /** Where curl writes the response body. The file is overwritten on every call. */
  outFile: string;
  /** Maximum time for the whole transfer, in seconds. */
  timeoutSec: number;
}

/** Throws if the `curl` binary is not available in PATH. */
export function assertCurlAvailable(): void {
  if (!Bun.which("curl")) {
    throw new FetchError("curl was not found in PATH", "curl");
  }
}

/**
 * Downloads `url` with the system curl and waits for the full response.
 * Timing and size come from curl itself (`time_total`, `size_download`),
 * so process start-up is not included in the measurement.
 */
export async function curlFetch(url: string, opts: CurlOptions): Promise<FetchResult> {
  const proc = Bun.spawn(
    [
      "curl",
      "--silent",
      "--show-error",
      "--location",
      "--compressed",
      "--max-time",
      String(opts.timeoutSec),
      "--user-agent",
      USER_AGENT,
      "--header",
      "Accept: image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
      "--output",
      opts.outFile,
      "--write-out",
      WRITE_OUT,
      "--",
      url,
    ],
    { stdout: "pipe", stderr: "pipe" },
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

  const [code, contentType, size, time] = stdout.trim().split("\t");
  const outFile = opts.outFile;

  return {
    method: "curl",
    status: Number(code),
    contentType: normalizeContentType(contentType),
    bytes: Number(size),
    timeSec: Number(time),
    body: async () => new Uint8Array(await file(outFile).arrayBuffer()),
  };
}
