import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Credentials and session data applied to every request (curl and browser alike). */
export interface Auth {
  /** HTTP Basic/Digest credentials; sent only to the host of the measured URL. */
  user?: { name: string; password: string };
  /** Extra request headers, e.g. `Authorization: Bearer ...`; sent only to the URL's host. */
  headers: [string, string][];
  /** Cookie strings such as `a=1; b=2`, set for the URL's host. */
  cookies: string[];
  /** Cookie file in Netscape format (as written by curl or browser export extensions). */
  cookieFile?: string;
  /** Directory of a session saved with `image-speed-meter login`. */
  profile?: string;
}

export const emptyAuth = (): Auth => ({ headers: [], cookies: [] });

/** True if any credential, header, cookie or profile is configured. */
export function hasAuth(auth: Auth): boolean {
  return Boolean(
    auth.user || auth.headers.length || auth.cookies.length || auth.cookieFile || auth.profile,
  );
}

/**
 * What may be sent to a host other than the measured URL's host after a redirect:
 * only domain-scoped cookies (cookie file, profile), which curl matches by domain itself.
 */
export function forOtherHosts(auth: Auth): Auth {
  return { headers: [], cookies: [], cookieFile: auth.cookieFile, profile: auth.profile };
}

/** Settings remembered by `login` and reused for requests made with the same profile. */
export interface ProfileSession {
  userAgent?: string;
}

const APP_DIR = "image-speed-meter";

/**
 * Resolves `--profile`: a value containing a path separator or starting with "." or "~"
 * is a directory; anything else is a profile name under the config directory.
 */
export function resolveProfile(value: string): string {
  if (value.startsWith("~")) return join(homedir(), value.slice(1));
  if (value.includes("/") || value.includes("\\") || value.startsWith(".")) return value;
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, APP_DIR, "profiles", value);
}

export const profileCookieFile = (profile: string) => join(profile, "cookies.txt");
export const profileChromeDir = (profile: string) => join(profile, "chromium");
export const profileSessionFile = (profile: string) => join(profile, "session.json");

export function readProfileSession(profile: string): ProfileSession {
  try {
    return JSON.parse(readFileSync(profileSessionFile(profile), "utf8")) as ProfileSession;
  } catch {
    return {};
  }
}

/** Parses `Name: value`. Throws on a malformed header. */
export function parseHeader(raw: string): [string, string] {
  const i = raw.indexOf(":");
  const name = raw.slice(0, i).trim();
  if (i <= 0 || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) {
    throw new Error(`invalid header "${raw.split(":")[0]}": expected "Name: value"`);
  }
  return [name, raw.slice(i + 1).trim()];
}

/** Parses one `-H` argument: a header, or `@file` with one header per line ('#' comments). */
export function parseHeaderArg(arg: string): [string, string][] {
  if (!arg.startsWith("@")) return [parseHeader(arg)];
  const text = readFileSync(arg.slice(1), "utf8");
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map(parseHeader);
}

/** Splits `a=1; b=2` into name/value pairs. */
export function parseCookieString(raw: string): { name: string; value: string }[] {
  return raw
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const i = part.indexOf("=");
      if (i <= 0) throw new Error(`invalid cookie "${part}": expected name=value`);
      return { name: part.slice(0, i).trim(), value: part.slice(i + 1).trim() };
    });
}

export interface NetscapeCookie {
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  /** Unix time in seconds; 0 for a session cookie. */
  expires: number;
  name: string;
  value: string;
}

/** Parses a Netscape cookie file (7 tab-separated fields; `#HttpOnly_` prefix allowed). */
export function parseNetscapeCookies(text: string): NetscapeCookie[] {
  const cookies: NetscapeCookie[] = [];
  for (let line of text.split(/\r?\n/)) {
    let httpOnly = false;
    if (line.startsWith("#HttpOnly_")) {
      httpOnly = true;
      line = line.slice("#HttpOnly_".length);
    } else if (line.startsWith("#") || !line.trim()) {
      continue;
    }
    const f = line.split("\t");
    if (f.length < 7) continue;
    cookies.push({
      domain: f[0]!,
      path: f[2]!,
      secure: f[3]!.toUpperCase() === "TRUE",
      expires: Number(f[4]) || 0,
      name: f[5]!,
      value: f.slice(6).join("\t"),
      httpOnly,
    });
  }
  return cookies;
}

/** Serialises cookies to the Netscape format understood by curl. */
export function formatNetscapeCookies(cookies: NetscapeCookie[]): string {
  const lines = cookies.map((c) =>
    [
      (c.httpOnly ? "#HttpOnly_" : "") + c.domain,
      c.domain.startsWith(".") ? "TRUE" : "FALSE",
      c.path || "/",
      c.secure ? "TRUE" : "FALSE",
      String(Math.max(0, Math.floor(c.expires))),
      c.name,
      c.value,
    ].join("\t"),
  );
  return `# Netscape HTTP Cookie File\n# Written by ${APP_DIR}. Contains secrets: keep it private.\n\n${lines.join("\n")}\n`;
}

/** Quotes a value for a curl config file. */
function curlQuote(value: string): string {
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
  return `"${escaped}"`;
}

/**
 * Builds a curl config (fed through `--config -` on stdin, so secrets never appear
 * in the process list). Redirects are followed by the caller hop by hop, so this
 * config is built per hop: see `forOtherHosts`.
 */
export function toCurlConfig(auth: Auth, cookieJar?: string): string {
  const lines: string[] = [];
  if (cookieJar) {
    // Cookies set by the server on one redirect hop are sent on the next one.
    lines.push(`cookie = ${curlQuote(cookieJar)}`, `cookie-jar = ${curlQuote(cookieJar)}`);
  }
  if (auth.user) {
    lines.push("anyauth");
    lines.push(`user = ${curlQuote(`${auth.user.name}:${auth.user.password}`)}`);
  }
  for (const [name, value] of auth.headers) lines.push(`header = ${curlQuote(`${name}: ${value}`)}`);
  if (auth.cookies.length) lines.push(`cookie = ${curlQuote(auth.cookies.join("; "))}`);
  if (auth.cookieFile) lines.push(`cookie = ${curlQuote(auth.cookieFile)}`);
  if (auth.profile && existsSync(profileCookieFile(auth.profile))) {
    lines.push(`cookie = ${curlQuote(profileCookieFile(auth.profile))}`);
  }
  return lines.length ? `${lines.join("\n")}\n` : "";
}

/** Reads a line from the terminal without echoing it. */
export async function promptHidden(question: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    throw new Error(
      "a password is needed: pass user:password, set IMAGE_SPEED_METER_PASSWORD, or run in a terminal",
    );
  }
  process.stderr.write(question);
  stdin.setRawMode(true);
  stdin.resume();
  return new Promise((resolve, reject) => {
    let value = "";
    const done = (err?: Error) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off("data", onData);
      process.stderr.write("\n");
      if (err) reject(err);
      else resolve(value);
    };
    const onData = (chunk: Buffer) => {
      for (const ch of chunk.toString("utf8")) {
        if (ch === "\r" || ch === "\n") return done();
        if (ch === "\u0003") return done(new Error("cancelled"));
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on("data", onData);
  });
}

/** Waits until the user presses Enter. */
export function waitForEnter(): Promise<void> {
  return new Promise((resolve) => {
    process.stdin.resume();
    process.stdin.once("data", () => {
      process.stdin.pause();
      resolve();
    });
    process.stdin.once("end", () => resolve());
  });
}
