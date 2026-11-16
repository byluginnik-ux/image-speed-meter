import { existsSync } from "node:fs";
import type { Browser, HTTPResponse, Page } from "puppeteer-core";
import { USER_AGENT } from "./curl.ts";
import { BLOCKED_STATUSES, FetchError, normalizeContentType, type FetchResult } from "./types.ts";

const CANDIDATE_BINARIES = [
  "chromium-browser",
  "chromium",
  "google-chrome-stable",
  "google-chrome",
  "chrome",
  "microsoft-edge",
];

const CANDIDATE_PATHS = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
];

/** How long to wait for an anti-bot challenge page to redirect to the real resource. */
const CHALLENGE_WAIT_MS = 20_000;

/** Finds a Chromium-based browser: `$CHROME_PATH` first, then PATH, then well-known locations. */
export function findChrome(): string {
  const fromEnv = process.env.CHROME_PATH;
  if (fromEnv) {
    if (!existsSync(fromEnv)) {
      throw new FetchError(`CHROME_PATH points to a missing file: ${fromEnv}`, "browser");
    }
    return fromEnv;
  }
  for (const name of CANDIDATE_BINARIES) {
    const found = Bun.which(name);
    if (found) return found;
  }
  for (const path of CANDIDATE_PATHS) {
    if (existsSync(path)) return path;
  }
  throw new FetchError(
    "no Chromium/Chrome executable found; install one or set CHROME_PATH",
    "browser",
  );
}

let browserPromise: Promise<Browser> | undefined;
let pagePromise: Promise<Page> | undefined;

/** Starts headless Chromium once and reuses it for every request. */
async function getPage(): Promise<Page> {
  if (!pagePromise) {
    pagePromise = (async () => {
      const { default: puppeteer } = await import("puppeteer-core");
      browserPromise = puppeteer.launch({
        executablePath: findChrome(),
        headless: true,
        args: [
          "--no-first-run",
          "--no-default-browser-check",
          "--disable-blink-features=AutomationControlled",
        ],
      });
      const browser = await browserPromise;
      const page = await browser.newPage();
      await page.setUserAgent(USER_AGENT);
      // Every request must hit the network, otherwise runs 2..N would be served from cache.
      await page.setCacheEnabled(false);
      return page;
    })();
    // Allow a retry on the next call if start-up failed.
    pagePromise.catch(() => {
      pagePromise = undefined;
      browserPromise = undefined;
    });
  }
  return pagePromise;
}

/** Closes the shared browser, if it was started. Safe to call more than once. */
export async function closeBrowser(): Promise<void> {
  const pending = browserPromise;
  browserPromise = undefined;
  pagePromise = undefined;
  if (!pending) return;
  try {
    await (await pending).close();
  } catch {
    // The browser failed to start or is already gone: nothing to close.
  }
}

/**
 * A JS challenge page is a non-empty HTML response that runs scripts.
 * Chromium substitutes its own error page (which also has scripts) for an empty
 * error response, so empty bodies and Chromium's error page are ruled out first.
 */
async function looksLikeChallenge(response: HTTPResponse): Promise<boolean> {
  if (response.headers()["content-length"] === "0") return false;
  try {
    const html = await response.text();
    return /<script[\s>]/i.test(html) && !html.includes('id="main-frame-error"');
  } catch {
    return false;
  }
}

export interface BrowserFetchResult extends FetchResult {
  /** True if an anti-bot challenge had to be passed; the timing then includes it. */
  challenged: boolean;
}

/**
 * Opens `url` in headless Chromium and waits until the whole body is received.
 * If the first response is a block page (401/403/429/503), waits for the page
 * to navigate on its own, which is how JS challenges hand over to the resource.
 */
export async function browserFetch(url: string, timeoutSec: number): Promise<BrowserFetchResult> {
  const page = await getPage();
  const timeout = timeoutSec * 1000;

  const started = performance.now();
  let response: HTTPResponse | null;
  try {
    response = await page.goto(url, { waitUntil: "load", timeout });
  } catch (err) {
    throw new FetchError(`browser failed: ${(err as Error).message}`, "browser");
  }
  if (!response) {
    throw new FetchError("browser received no response", "browser");
  }

  let challenged = false;
  if (BLOCKED_STATUSES.has(response.status()) && (await looksLikeChallenge(response))) {
    challenged = true;
    try {
      const next = await page.waitForNavigation({
        waitUntil: "load",
        timeout: Math.min(CHALLENGE_WAIT_MS, timeout),
      });
      if (next) response = next;
    } catch {
      // No navigation happened: keep the block response and report its status.
    }
  }

  let body: Uint8Array;
  try {
    body = await response.content();
  } catch (err) {
    throw new FetchError(`browser could not read the body: ${(err as Error).message}`, "browser");
  }
  const timeSec = (performance.now() - started) / 1000;

  return {
    method: "browser",
    status: response.status(),
    contentType: normalizeContentType(response.headers()["content-type"]),
    bytes: body.byteLength,
    timeSec,
    challenged,
    body: async () => body,
  };
}
