#!/usr/bin/env bun
import { existsSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import pkg from "../package.json" with { type: "json" };
import {
  emptyAuth,
  parseCookieString,
  parseHeaderArg,
  profileCookieFile,
  promptHidden,
  resolveProfile,
  type Auth,
} from "./auth.ts";
import { closeBrowser, loginInteractive } from "./browser.ts";
import { assertCurlAvailable } from "./curl.ts";
import { DEFAULTS, measureAll, type MeasureEvent, type Mode, type UrlReport } from "./measure.ts";

const NAME = "image-speed-meter";
const PASSWORD_ENV = "IMAGE_SPEED_METER_PASSWORD";

const USAGE = `Usage: ${NAME} [options] <url> [url ...]
       ${NAME} [options] '<json-array-of-urls>'
       ${NAME} [options] --file <path>
       ${NAME} login <url> [--profile <name|dir>]`;

const HELP = `${NAME} ${pkg.version} - measure how fast a file downloads.

${USAGE}

Makes N sequential requests to every URL (the next request starts only after
the previous response has been received completely), then prints the average
request time, the total amount of data downloaded and the download speed.
Any file works: images, archives, videos, PDFs, HTML pages, API responses.

Requests are made with curl. If curl is blocked (HTTP 403, 429 or 503,
an anti-bot page, or a curl error) and the mode is "auto", the URL is retried
in headless Chromium, which is reused for all remaining runs.

Arguments:
  <url>                  http(s) URL to measure; several URLs may be given
  <json-array-of-urls>   a JSON array of URLs, e.g. '["https://a/1.zip","https://b/2.png"]'

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

Authorization (applied to curl and to the browser):
  -u, --user <user[:password]>
                         HTTP Basic/Digest credentials; without ':password' the
                         password is read from $${PASSWORD_ENV}
                         or asked for in the terminal
  -H, --header <header>  extra request header, e.g. 'Authorization: Bearer <token>';
                         repeatable; '@file' reads one header per line
  -b, --cookie <cookies> cookies as 'name=value; name2=value2'; repeatable
  -c, --cookie-file <path>
                         cookie file in Netscape format (curl, browser extensions)
  -p, --profile <name|dir>
                         use a session saved with '${NAME} login'
  Credentials, headers and cookies are sent only to the host of the URL, not to
  hosts it redirects to. https://user:pass@host/ URLs work like --user.

Login (for sites with login forms, SSO or 2FA):
  ${NAME} login <url> [--profile <name|dir>]
                         opens a visible browser; sign in, then press Enter.
                         The session is saved to the profile (default name
                         "default") and reused with --profile.

Units:
  time     seconds (s)
  volume   megabytes, 1 MB = 1,000,000 bytes (exact byte count is shown too)
  speed    MB/s and Mbit/s = total bytes / total time of all requests

Environment:
  CHROME_PATH            path to a Chromium/Chrome executable for the browser mode
  ${PASSWORD_ENV}
                         password for --user when it is not given inline
  XDG_CONFIG_HOME        where named profiles live (default: ~/.config)

Exit status:
  0  every URL was measured successfully (or login succeeded)
  1  at least one URL failed (or login failed)
  2  invalid command-line arguments

Examples:
  ${NAME} https://upload.wikimedia.org/wikipedia/commons/3/3f/Fronalpstock_big.jpg
  ${NAME} -n 3 https://github.com/cli/cli/releases/download/v2.63.0/gh_2.63.0_linux_amd64.tar.gz
  ${NAME} -u alice https://example.com/private/report.pdf
  ${NAME} -H 'Authorization: Bearer <token>' https://api.example.com/export.csv
  ${NAME} login https://example.com/ && ${NAME} -p default https://example.com/files/big.zip

See also: man ${NAME}`;

class UsageError extends Error {}

interface MeasureCli {
  command: "measure";
  urls: string[];
  runs: number;
  mode: Mode;
  outDir: string | null;
  timeoutSec: number;
  json: boolean;
  quiet: boolean;
  auth: Auth;
  /** Password still to be obtained from the environment or the terminal. */
  needPassword: boolean;
}

interface LoginCli {
  command: "login";
  url: string;
  profile: string;
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

/** Runs a parser and turns its errors into usage errors. */
function usage<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    throw new UsageError((err as Error).message);
  }
}

function parseAuth(values: {
  user?: string;
  header?: string[];
  cookie?: string[];
  "cookie-file"?: string;
  profile?: string;
}): { auth: Auth; needPassword: boolean } {
  const auth = emptyAuth();
  let needPassword = false;

  if (values.user !== undefined) {
    const i = values.user.indexOf(":");
    const name = i === -1 ? values.user : values.user.slice(0, i);
    if (!name) throw new UsageError("--user expects user[:password]");
    auth.user = { name, password: i === -1 ? "" : values.user.slice(i + 1) };
    needPassword = i === -1;
  }
  for (const h of values.header ?? []) auth.headers.push(...usage(() => parseHeaderArg(h)));
  for (const c of values.cookie ?? []) {
    usage(() => parseCookieString(c));
    auth.cookies.push(c);
  }
  if (values["cookie-file"]) {
    if (!existsSync(values["cookie-file"])) {
      throw new UsageError(`cookie file not found: ${values["cookie-file"]}`);
    }
    auth.cookieFile = values["cookie-file"];
  }
  if (values.profile) {
    const dir = resolveProfile(values.profile);
    if (!existsSync(dir)) {
      throw new UsageError(`profile not found: ${dir} (create it with '${NAME} login <url> --profile ${values.profile}')`);
    }
    if (!existsSync(profileCookieFile(dir))) {
      console.error(`${NAME}: warning: ${profileCookieFile(dir)} is missing; curl will run without the saved cookies`);
    }
    auth.profile = dir;
  }
  return { auth, needPassword };
}

function parseCli(argv: string[]): MeasureCli | LoginCli | "help" | "version" {
  const { values, positionals } = usage(() =>
    parseArgs({
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
        user: { type: "string", short: "u" },
        header: { type: "string", short: "H", multiple: true },
        cookie: { type: "string", short: "b", multiple: true },
        "cookie-file": { type: "string", short: "c" },
        profile: { type: "string", short: "p" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "V" },
      },
    }),
  );

  if (values.help) return "help";
  if (values.version) return "version";

  if (positionals[0] === "login") {
    if (positionals.length !== 2) throw new UsageError("login expects exactly one URL");
    return {
      command: "login",
      url: parseUrl(positionals[1]!),
      profile: resolveProfile(values.profile ?? "default"),
    };
  }

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
  const urls = rawUrls.map(parseUrl);

  const { auth, needPassword } = parseAuth(values);

  return {
    command: "measure",
    urls,
    runs,
    mode,
    outDir: values["no-save"] ? null : (values.out ?? DEFAULTS.outDir),
    timeoutSec,
    json: values.json ?? false,
    quiet: values.quiet ?? false,
    auth,
    needPassword,
  };
}

/** Prints a URL without any user:password part. */
function safeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.username = "";
    u.password = "";
    return u.href;
  } catch {
    return raw;
  }
}

/** More decimals for small values, so 0.035 MB does not print as 0.04 and 577 bytes not as 0.000. */
const num = (n: number) =>
  n === 0 || n >= 100 ? n.toFixed(1) : n >= 1 ? n.toFixed(2) : n >= 0.001 ? n.toFixed(3) : n.toPrecision(2);
const mb = (bytes: number) => num(bytes / 1e6);
const sec = (s: number) => s.toFixed(3);

function printEvent(e: MeasureEvent, quiet: boolean): void {
  switch (e.type) {
    case "start":
      console.log(`${e.index > 1 ? "\n" : ""}[${e.index}/${e.total}] ${safeUrl(e.url)}`);
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

async function runLogin(cli: LoginCli): Promise<number> {
  try {
    const count = await loginInteractive(cli.url, cli.profile, (line) => console.error(line));
    console.error(`Saved ${count} cookie${count === 1 ? "" : "s"} to ${profileCookieFile(cli.profile)}`);
    console.error(`Use the session with: ${NAME} --profile ${cli.profile} <url>`);
    return 0;
  } catch (err) {
    console.error(`${NAME}: login failed: ${(err as Error).message}`);
    return 1;
  }
}

async function runMeasure(cli: MeasureCli): Promise<number> {
  if (cli.needPassword && cli.auth.user) {
    const fromEnv = process.env[PASSWORD_ENV];
    try {
      cli.auth.user.password = fromEnv ?? (await promptHidden(`Password for ${cli.auth.user.name}: `));
    } catch (err) {
      console.error(`${NAME}: ${(err as Error).message}`);
      return 2;
    }
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
    auth: cli.auth,
    onEvent: cli.json ? undefined : (e) => printEvent(e, cli.quiet),
  });

  if (cli.json) console.log(JSON.stringify(reports, null, 2));
  return reports.every((r) => r.ok) ? 0 : 1;
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
  return cli.command === "login" ? runLogin(cli) : runMeasure(cli);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void closeBrowser().finally(() => process.exit(130));
  });
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
