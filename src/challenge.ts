/**
 * Detection of anti-bot interstitials (Cloudflare, DDoS-Guard, Imperva, PerimeterX, DataDome...).
 * An ordinary HTML page is a valid thing to measure; only these pages trigger the browser fallback.
 */

const MARKERS = new RegExp(
  [
    "challenge-platform",
    "cf-chl",
    "cf-browser-verification",
    "<title>Just a moment\\.\\.\\.</title>",
    "ddos-guard",
    "_Incapsula_Resource",
    "px-captcha",
    "captcha-delivery\\.com",
    "datadome",
    "Enable JavaScript and cookies to continue",
  ].join("|"),
  "i",
);

/** Only the beginning of the body is inspected. */
export const CHALLENGE_SAMPLE_BYTES = 1_000_000;

export interface ChallengeInput {
  contentType: string;
  /** Lower-cased response headers, if known. */
  headers?: Record<string, string>;
  /** Beginning of the response body, decoded as text. */
  body?: string;
}

export function isChallenge({ contentType, headers, body }: ChallengeInput): boolean {
  if (headers?.["cf-mitigated"]?.toLowerCase() === "challenge") return true;
  if (contentType !== "text/html" || !body) return false;
  // Chromium replaces empty error responses with its own error page; that is not a challenge.
  if (body.includes('id="main-frame-error"')) return false;
  return MARKERS.test(body);
}
