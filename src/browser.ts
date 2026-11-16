import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser, CDPSession, HTTPResponse, Page, Protocol } from "puppeteer-core";
import {
  formatNetscapeCookies,
  parseCookieString,
  parseNetscapeCookies,
  profileChromeDir,
  profileCookieFile,
  profileSessionFile,
  readProfileSession,
  waitForEnter,
  type Auth,
} from "./auth.ts";
import { isChallenge } from "./challenge.ts";
import {
  BLOCKED_STATUSES,
  FetchError,
  fileNameFromDisposition,
  normalizeContentType,
  type FetchResult,
} from "./types.ts";

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

const LAUNCH_ARGS = [
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-blink-features=AutomationControlled",
];

/** How long to wait for an anti-bot challenge page to hand over to the real resource. */
const CHALLENGE_WAIT_MS = 20_000;

/** How long to wait for the download event after Chromium aborted the navigation. */
const DOWNLOAD_START_WAIT_MS = 5_000;

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

interface Session {
  browser: Browser;
  page: Page;
  /** CDP session of the page: request interception (Fetch domain). */
  pageCdp: CDPSession;
  /** Browser-level CDP session: downloads and cookies. */
  browserCdp: CDPSession;
  mainFrameId: string;
  downloadDir: string;
  lastDownload?: string;
  /** Cookie sources already loaded into the browser. */
  appliedCookies: Set<string>;
}

/** The request currently being measured; read by the interception handlers. */
interface Current {
  target: URL;
  auth: Auth;
  /** Main-document response, as seen by the interceptor. */
  mainResponse?: { status: number; contentType: string; headers: Record<string, string> };
  authAttempts: number;
}

let sessionPromise: Promise<Session> | undefined;
let current: Current | null = null;

const lowerHeaders = (list: Protocol.Fetch.HeaderEntry[] = []) =>
  Object.fromEntries(list.map((h) => [h.name.toLowerCase(), h.value]));

/** Turns any Content-Disposition into `attachment`, keeping the server's file name. */
function forceAttachment(existing: string | undefined): string {
  const params = existing?.includes(";") ? existing.slice(existing.indexOf(";")) : "";
  return `attachment${params}`;
}

async function onRequestPaused(s: Session, e: Protocol.Fetch.RequestPausedEvent): Promise<void> {
  const isMain = e.frameId === s.mainFrameId && e.resourceType === "Document" && current !== null;
  const atResponse = e.responseStatusCode !== undefined || e.responseErrorReason !== undefined;

  if (!atResponse) {
    // Request stage: add auth headers, but only for the host the user gave credentials for.
    const extra = isMain && new URL(e.request.url).host === current!.target.host ? current!.auth.headers : [];
    if (extra.length === 0) {
      await s.pageCdp.send("Fetch.continueRequest", { requestId: e.requestId });
      return;
    }
    const names = new Set(extra.map(([n]) => n.toLowerCase()));
    const headers = Object.entries(e.request.headers)
      .filter(([name]) => !names.has(name.toLowerCase()))
      .map(([name, value]) => ({ name, value }));
    headers.push(...extra.map(([name, value]) => ({ name, value })));
    await s.pageCdp.send("Fetch.continueRequest", { requestId: e.requestId, headers });
    return;
  }

  const status = e.responseStatusCode ?? 0;
  if (isMain && status && !e.responseErrorReason) {
    const headers = lowerHeaders(e.responseHeaders);
    current!.mainResponse = { status, contentType: normalizeContentType(headers["content-type"]), headers };
    if (status >= 200 && status < 300) {
      // Make Chromium save the body as a download instead of rendering it. This works for
      // any file type, and timing ends when the last byte is on disk, with no CDP transfer.
      const responseHeaders = (e.responseHeaders ?? []).filter(
        (h) => h.name.toLowerCase() !== "content-disposition",
      );
      responseHeaders.push({
        name: "Content-Disposition",
        value: forceAttachment(headers["content-disposition"]),
      });
      await s.pageCdp.send("Fetch.continueResponse", {
        requestId: e.requestId,
        responseCode: status,
        responseHeaders,
      });
      return;
    }
  }
  // Redirects, errors and challenge pages pass through unchanged so their scripts can run.
  await s.pageCdp.send("Fetch.continueRequest", { requestId: e.requestId });
}

async function onAuthRequired(s: Session, e: Protocol.Fetch.AuthRequiredEvent): Promise<void> {
  const user = current?.auth.user;
  // Credentials go only to the origin of the measured URL, and only once: a second
  // challenge means they were rejected, so let the 401 through.
  const provide =
    user !== undefined &&
    e.authChallenge.source !== "Proxy" &&
    e.authChallenge.origin === current!.target.origin &&
    current!.authAttempts++ === 0;
  await s.pageCdp.send("Fetch.continueWithAuth", {
    requestId: e.requestId,
    authChallengeResponse: provide
      ? { response: "ProvideCredentials", username: user!.name, password: user!.password }
      : { response: "CancelAuth" },
  });
}

/** Starts headless Chromium once (optionally with a saved login profile) and reuses it. */
function getSession(profile: string | undefined): Promise<Session> {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      const { default: puppeteer } = await import("puppeteer-core");
      const browser = await puppeteer.launch({
        executablePath: findChrome(),
        headless: true,
        args: LAUNCH_ARGS,
        ...(profile ? { userDataDir: profileChromeDir(profile) } : {}),
      });
      try {
        const page = await browser.newPage();
        const savedAgent = profile ? readProfileSession(profile).userAgent : undefined;
        await page.setUserAgent(savedAgent ?? (await browser.userAgent()).replace("HeadlessChrome", "Chrome"));
        // Every request must hit the network, otherwise runs 2..N would be served from cache.
        await page.setCacheEnabled(false);

        const downloadDir = mkdtempSync(join(tmpdir(), "image-speed-meter-dl-"));
        const browserCdp = await browser.target().createCDPSession();
        await browserCdp.send("Browser.setDownloadBehavior", {
          behavior: "allowAndName",
          downloadPath: downloadDir,
          eventsEnabled: true,
        });

        const pageCdp = await page.createCDPSession();
        const { frameTree } = await pageCdp.send("Page.getFrameTree");
        const s: Session = {
          browser,
          page,
          pageCdp,
          browserCdp,
          mainFrameId: frameTree.frame.id,
          downloadDir,
          appliedCookies: new Set(),
        };
        pageCdp.on("Fetch.requestPaused", (e) => void onRequestPaused(s, e).catch(() => {}));
        pageCdp.on("Fetch.authRequired", (e) => void onAuthRequired(s, e).catch(() => {}));
        await pageCdp.send("Fetch.enable", {
          handleAuthRequests: true,
          patterns: [
            { urlPattern: "*", resourceType: "Document", requestStage: "Request" },
            { urlPattern: "*", resourceType: "Document", requestStage: "Response" },
          ],
        });
        return s;
      } catch (err) {
        await browser.close().catch(() => {});
        throw err;
      }
    })();
    // Allow a retry on the next call if start-up failed.
    sessionPromise.catch(() => {
      sessionPromise = undefined;
    });
  }
  return sessionPromise;
}

/** Closes the shared browser and removes its download directory. Safe to call more than once. */
export async function closeBrowser(): Promise<void> {
  const pending = sessionPromise;
  sessionPromise = undefined;
  if (!pending) return;
  try {
    const s = await pending;
    await s.browser.close();
    rmSync(s.downloadDir, { recursive: true, force: true });
  } catch {
    // The browser failed to start or is already gone: nothing to close.
  }
}

/** Loads cookies from `--cookie` (for the URL's host) and `--cookie-file` into the browser. */
async function applyCookies(s: Session, url: string, auth: Auth): Promise<void> {
  const cookies: Protocol.Network.CookieParam[] = [];
  const target = new URL(url);
  const stringKey = `str:${target.origin}`;
  if (auth.cookies.length && !s.appliedCookies.has(stringKey)) {
    s.appliedCookies.add(stringKey);
    for (const raw of auth.cookies) {
      for (const { name, value } of parseCookieString(raw)) {
        cookies.push({ name, value, url: `${target.origin}/` });
      }
    }
  }
  // Session cookies (no expiry) are not persisted in the Chromium profile, so the
  // profile's exported cookies.txt is loaded as well.
  const files = [auth.cookieFile, auth.profile && profileCookieFile(auth.profile)].filter(
    (f): f is string => Boolean(f) && existsSync(f!) && !s.appliedCookies.has(`file:${f}`),
  );
  for (const path of files) {
    s.appliedCookies.add(`file:${path}`);
    for (const c of parseNetscapeCookies(readFileSync(path, "utf8"))) {
      const base = {
        name: c.name,
        value: c.value,
        path: c.path,
        secure: c.secure,
        httpOnly: c.httpOnly,
        ...(c.expires > 0 ? { expires: c.expires } : {}),
      };
      // A leading dot means "this domain and its subdomains"; otherwise the cookie is host-only.
      cookies.push(
        c.domain.startsWith(".")
          ? { ...base, domain: c.domain }
          : { ...base, url: `${c.secure ? "https" : "http"}://${c.domain}${c.path || "/"}` },
      );
    }
  }
  if (cookies.length) await s.browserCdp.send("Storage.setCookies", { cookies });
}

/** A rendered (not downloaded) response that is an anti-bot page running scripts. */
async function isChallengeResponse(response: HTTPResponse): Promise<boolean> {
  const headers = response.headers();
  if (headers["content-length"] === "0") return false;
  let body = "";
  try {
    body = await response.text();
  } catch {
    return false;
  }
  const contentType = normalizeContentType(headers["content-type"]);
  if (isChallenge({ contentType, headers, body })) return true;
  // Unknown vendors: a blocked status plus an HTML page with scripts (not Chromium's error page).
  return /<script[\s>]/i.test(body) && !body.includes('id="main-frame-error"');
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/** Resolves to the promise's value, or `undefined` if it does not settle within `ms`. */
async function within<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((r) => (timer = setTimeout(() => r(undefined), Math.max(0, ms))));
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export interface BrowserFetchResult extends FetchResult {
  /** True if an anti-bot challenge had to be passed; the timing then includes it. */
  challenged: boolean;
}

/** Result for a page that was rendered instead of downloaded (an error or block page). */
function renderedResult(response: HTTPResponse, started: number, challenged: boolean): BrowserFetchResult {
  const headers = response.headers();
  return {
    method: "browser",
    status: response.status(),
    contentType: normalizeContentType(headers["content-type"]),
    bytes: Number(headers["content-length"]) || 0,
    timeSec: (performance.now() - started) / 1000,
    challenged,
    body: async () => new Uint8Array(await response.content()),
  };
}

export interface BrowserFetchOptions {
  timeoutSec: number;
  auth: Auth;
}

/**
 * Downloads `url` in headless Chromium and waits until the whole body is on disk.
 * Every successful response is turned into a download, so images, archives, PDFs and
 * HTML pages are all handled the same way. If the first response is a block page
 * with a JS challenge, waits for the challenge to hand over to the real resource.
 */
export async function browserFetch(url: string, opts: BrowserFetchOptions): Promise<BrowserFetchResult> {
  const s = await getSession(opts.auth.profile);
  await applyCookies(s, url, opts.auth);
  if (s.lastDownload) {
    rmSync(s.lastDownload, { force: true });
    s.lastDownload = undefined;
  }

  const timeout = opts.timeoutSec * 1000;
  current = { target: new URL(url), auth: opts.auth, authAttempts: 0 };
  let guid: string | undefined;
  const begun = deferred<true>();
  const finished = deferred<Protocol.Browser.DownloadProgressEvent>();
  const onBegin = (e: Protocol.Browser.DownloadWillBeginEvent) => {
    if (guid) return;
    guid = e.guid;
    begun.resolve(true);
  };
  const onProgress = (e: Protocol.Browser.DownloadProgressEvent) => {
    if (e.guid === guid && e.state !== "inProgress") finished.resolve(e);
  };
  s.browserCdp.on("Browser.downloadWillBegin", onBegin);
  s.browserCdp.on("Browser.downloadProgress", onProgress);

  const started = performance.now();
  const remaining = () => timeout - (performance.now() - started);
  try {
    const navigation = s.page.goto(url, { waitUntil: "load", timeout }).then(
      (response) => ({ response, error: undefined as Error | undefined }),
      (error: Error) => ({ response: null as HTTPResponse | null, error }),
    );
    const first = await Promise.race([begun.promise.then(() => null), navigation]);

    let challenged = false;
    if (first && !guid) {
      const { response, error } = first;
      if (error && !error.message.includes("ERR_ABORTED")) {
        throw new FetchError(`browser failed: ${error.message}`, "browser");
      }
      if (error) {
        // A download aborts the navigation; its start event may arrive slightly later.
        if (!(await within(begun.promise, DOWNLOAD_START_WAIT_MS))) {
          throw new FetchError("browser navigation was aborted", "browser");
        }
      } else if (!response) {
        throw new FetchError("browser received no response", "browser");
      } else if (BLOCKED_STATUSES.has(response.status()) && (await isChallengeResponse(response))) {
        challenged = true;
        if (!(await within(begun.promise, Math.min(CHALLENGE_WAIT_MS, remaining())))) {
          return renderedResult(response, started, challenged);
        }
      } else {
        return renderedResult(response, started, challenged);
      }
    }

    const progress = await within(finished.promise, remaining());
    if (!progress) {
      await s.browserCdp.send("Browser.cancelDownload", { guid: guid! }).catch(() => {});
      throw new FetchError(`download timed out after ${opts.timeoutSec} s`, "browser");
    }
    const timeSec = (performance.now() - started) / 1000;
    const filePath = join(s.downloadDir, guid!);
    s.lastDownload = filePath;
    if (progress.state !== "completed") {
      throw new FetchError("the browser canceled the download", "browser");
    }

    const main = current.mainResponse;
    return {
      method: "browser",
      status: main?.status ?? 200,
      contentType: main?.contentType ?? "",
      bytes: progress.receivedBytes,
      timeSec,
      challenged,
      fileName: fileNameFromDisposition(main?.headers["content-disposition"]),
      body: async () => new Uint8Array(await Bun.file(filePath).arrayBuffer()),
    };
  } finally {
    s.browserCdp.off("Browser.downloadWillBegin", onBegin);
    s.browserCdp.off("Browser.downloadProgress", onProgress);
    current = null;
  }
}

/**
 * Opens a visible browser with a persistent profile so the user can sign in by hand
 * (login forms, SSO, 2FA, captchas). Cookies are exported to `<profile>/cookies.txt`
 * for curl every 2 seconds and once more when the user presses Enter.
 * Returns the number of cookies saved.
 */
export async function loginInteractive(
  url: string,
  profile: string,
  log: (line: string) => void,
): Promise<number> {
  if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    throw new Error("login needs a graphical display, but DISPLAY and WAYLAND_DISPLAY are not set");
  }
  mkdirSync(profile, { recursive: true, mode: 0o700 });
  chmodSync(profile, 0o700);

  const { default: puppeteer } = await import("puppeteer-core");
  const browser = await puppeteer.launch({
    executablePath: findChrome(),
    headless: false,
    userDataDir: profileChromeDir(profile),
    defaultViewport: null,
    args: LAUNCH_ARGS,
    // Without this flag, sites see a normal browser rather than an automated one.
    ignoreDefaultArgs: ["--enable-automation"],
  });

  const cookieFile = profileCookieFile(profile);
  let saved = 0;
  const cdp = await browser.target().createCDPSession();
  const save = async () => {
    const { cookies } = await cdp.send("Storage.getCookies");
    writeFileSync(
      cookieFile,
      formatNetscapeCookies(
        cookies.map((c) => ({
          domain: c.domain,
          path: c.path,
          secure: c.secure,
          httpOnly: c.httpOnly,
          expires: c.session ? 0 : c.expires,
          name: c.name,
          value: c.value,
        })),
      ),
      { mode: 0o600 },
    );
    saved = cookies.length;
  };

  try {
    // Remember the real user agent: some sessions are tied to it.
    writeFileSync(profileSessionFile(profile), JSON.stringify({ userAgent: await browser.userAgent() }, null, 2), {
      mode: 0o600,
    });
    const page = (await browser.pages())[0] ?? (await browser.newPage());
    void page.goto(url).catch(() => {});
    log("A browser window has opened. Sign in there, then come back and press Enter here.");

    const timer = setInterval(() => void save().catch(() => {}), 2000);
    const closed = new Promise<"closed">((r) => browser.once("disconnected", () => r("closed")));
    const outcome = await Promise.race([waitForEnter().then(() => "enter" as const), closed]);
    clearInterval(timer);
    process.stdin.pause();
    if (outcome === "enter") await save();
    else log("The browser was closed before Enter; using the cookies saved up to that moment.");
  } finally {
    if (browser.connected) await browser.close();
  }
  return saved;
}
