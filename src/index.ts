#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import pkg from "../package.json" with { type: "json" };
import { closeBrowser } from "./browser.ts";
import { assertCurlAvailable } from "./curl.ts";
import { DEFAULTS, measureAll, type MeasureEvent, type Mode, type UrlReport } from "./measure.ts";

const NAME = "image-speed-meter";

const USAGE = `Usage: ${NAME} [options] <url> [url ...]
       ${NAME} [options] '<json-array-of-urls>'
       ${NAME} [options] --file <path>`;

const HELP = `${NAME} ${pkg.version} - measure how fast an image (or any file) downloads.

${USAGE}

Makes N sequential requests to every URL (the next request starts only after
the previous response has been received completely), then prints the average
request time, the total amount of data downloaded and the download speed.

Requests are made with curl. If curl is blocked (HTTP 401, 403, 429 or 503,
an HTML page instead of a file, or a curl error) and the mode is "auto", the
URL is retried in headless Chromium, which is reused for all remaining runs.

Arguments:
  <url>                  http(s) URL to measure; several URLs may be given
  <json-array-of-urls>   a JSON array of URLs, e.g. '["https://a/1.jpg","https://b/2.png"]'

Options:
  -n, --runs <N>         sequential requests per URL (default: ${DEFAULTS.runs})
  -m, --mode <mode>      auto | curl | browser (default: ${DEFAULTS.mode})
                           auto     curl first, headless browser if blocked
                           curl     curl only, never start a browser
                           browser  headless browser only
  -f, --file <path>      read URLs from a file, one per line ('#' starts a comment)
  -o, --out <dir>        save the downloaded file into <dir> (default: ./${DEFAULTS.outDir})
      --no-save          do not save the downloaded file
  -t, --timeout <sec>    timeout for a single request, in seconds (default: ${DEFAULTS.timeoutSec})
      --json             print results as JSON instead of text
  -q, --quiet            print only the summary, not every request
  -h, --help             show this help and exit
  -V, --version          show the version and exit

Units:
  time     seconds (s)
  volume   megabytes, 1 MB = 1,000,000 bytes (exact byte count is shown too)
  speed    MB/s and Mbit/s = total bytes / total time of all requests

Environment:
  CHROME_PATH            path to a Chromium/Chrome executable for the browser mode

Exit status:
  0  every URL was measured successfully
  1  at least one URL failed
  2  invalid command-line arguments

Examples:
  ${NAME} https://upload.wikimedia.org/wikipedia/commons/3/3f/Fronalpstock_big.jpg
  ${NAME} -n 5 --mode browser https://example.com/photo.jpg
  ${NAME} --json '["https://a.example/1.jpg","https://b.example/2.png"]'

See also: man ${NAME}`;

class UsageError extends Error {}

interface CliOptions {
  urls: string[];
  runs: number;
  mode: Mode;
  outDir: string | null;
  timeoutSec: number;
  json: boolean;
  quiet: boolean;
}

function parseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UsageError(`not a valid URL: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UsageError(`only http and https URLs are supported: ${raw}`);
  }
  return url.href;
}

/** A positional argument is either a single URL or a JSON array of URLs. */
function expandPositional(arg: string): string[] {
  const trimmed = arg.trim();
  if (!trimmed.startsWith("[")) return [trimmed];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    throw new UsageError(`invalid JSON array: ${(err as Error).message}`);
  }
  if (!Array.isArray(parsed) || !parsed.every((u) => typeof u === "string")) {
    throw new UsageError("the JSON argument must be an array of strings");
  }
  return parsed;
}

function readUrlFile(path: string): string[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new UsageError(`cannot read ${path}: ${(err as Error).message}`);
  }
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/#.*/, "").trim())
    .filter(Boolean);
}

function positiveNumber(raw: string, flag: string, integer: boolean): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || (integer && !Number.isInteger(n))) {
    throw new UsageError(`${flag} expects a positive ${integer ? "integer" : "number"}, got "${raw}"`);
  }
  return n;
}

function parseCli(argv: string[]): CliOptions | "help" | "version" {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        runs: { type: "string", short: "n" },
        mode: { type: "string", short: "m" },
        file: { type: "string", short: "f" },
        out: { type: "string", short: "o" },
        "no-save": { type: "boolean" },
        timeout: { type: "string", short: "t" },
        json: { type: "boolean" },
        quiet: { type: "boolean", short: "q" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "V" },
      },
    });
  } catch (err) {
    throw new UsageError((err as Error).message);
  }
  const { values, positionals } = parsed;

  if (values.help) return "help";
  if (values.version) return "version";

  const mode = (values.mode ?? DEFAULTS.mode) as Mode;
  if (!["auto", "curl", "browser"].includes(mode)) {
    throw new UsageError(`--mode must be auto, curl or browser, got "${values.mode}"`);
  }

  const runs = values.runs ? positiveNumber(values.runs, "--runs", true) : DEFAULTS.runs;
  const timeoutSec = values.timeout
    ? positiveNumber(values.timeout, "--timeout", false)
    : DEFAULTS.timeoutSec;

  const rawUrls = positionals.flatMap(expandPositional);
  if (values.file) rawUrls.push(...readUrlFile(values.file));
  if (rawUrls.length === 0) throw new UsageError("no URL given");

  return {
    urls: rawUrls.map(parseUrl),
    runs,
    mode,
    outDir: values["no-save"] ? null : (values.out ?? DEFAULTS.outDir),
    timeoutSec,
    json: values.json ?? false,
    quiet: values.quiet ?? false,
  };
}

/** Fixed-point with more decimals for small values, so 0.035 MB does not print as 0.04 or 0.00. */
const num = (n: number) => n.toFixed(n === 0 || n >= 100 ? 1 : n >= 1 ? 2 : 3);
const mb = (bytes: number) => num(bytes / 1e6);
const sec = (s: number) => s.toFixed(3);

function printEvent(e: MeasureEvent, quiet: boolean): void {
  switch (e.type) {
    case "start":
      console.log(`${e.index > 1 ? "\n" : ""}[${e.index}/${e.total}] ${e.url}`);
      break;
    case "fallback":
      console.log(`  ! ${e.reason}; switching to headless browser`);
      break;
    case "challenge":
      console.log("  ! passed an anti-bot challenge; repeating the request");
      break;
    case "run": {
      if (quiet) break;
      const r = e.result;
      const width = String(e.runs).length;
      const speed = r.timeSec > 0 ? r.bytes / r.timeSec / 1e6 : 0;
      console.log(
        `  #${String(e.run).padStart(width)}  ${r.method.padEnd(7)}  ${sec(r.timeSec).padStart(8)} s` +
          `  ${mb(r.bytes).padStart(9)} MB  ${num(speed).padStart(8)} MB/s`,
      );
      break;
    }
    case "done":
      printSummary(e.report);
      break;
  }
}

function printSummary(r: UrlReport): void {
  console.log("  " + "-".repeat(40));
  if (!r.ok) {
    console.log(`  error:       ${r.error}`);
    return;
  }
  console.log(`  method:      ${r.methods.join(" + ")}`);
  console.log(`  requests:    ${r.runs.length}`);
  console.log(`  avg time:    ${sec(r.avgSec)} s`);
  console.log(`  total data:  ${mb(r.totalBytes)} MB (${r.totalBytes} bytes)`);
  console.log(`  speed:       ${num(r.speedMBps)} MB/s (${num(r.speedMbps)} Mbit/s)`);
  if (r.savedTo) console.log(`  saved to:    ${r.savedTo}`);
}

async function main(argv: string[]): Promise<number> {
  let cli: ReturnType<typeof parseCli>;
  try {
    cli = parseCli(argv);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    console.error(`${NAME}: ${err.message}\n${USAGE}\nTry '${NAME} --help' for more information.`);
    return 2;
  }
  if (cli === "help") {
    console.log(HELP);
    return 0;
  }
  if (cli === "version") {
    console.log(`${NAME} ${pkg.version}`);
    return 0;
  }

  if (cli.mode !== "browser") {
    try {
      assertCurlAvailable();
    } catch (err) {
      if (cli.mode === "curl") {
        console.error(`${NAME}: ${(err as Error).message}`);
        return 1;
      }
      cli.mode = "browser";
    }
  }

  const reports = await measureAll(cli.urls, {
    runs: cli.runs,
    mode: cli.mode,
    outDir: cli.outDir,
    timeoutSec: cli.timeoutSec,
    onEvent: cli.json ? undefined : (e) => printEvent(e, cli.quiet),
  });

  if (cli.json) console.log(JSON.stringify(reports, null, 2));
  return reports.every((r) => r.ok) ? 0 : 1;
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void closeBrowser().finally(() => process.exit(130));
  });
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
