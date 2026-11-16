# image-speed-meter

A console tool that measures how fast a file downloads: an image, an archive, a video, a PDF, an HTML page, an API response. Any URL works.

For every URL it makes **N sequential requests** (10 by default). Each request starts only after the previous response has been received completely. It then prints:

- the **average request time**;
- the **total amount of data** downloaded;
- the **download speed**.

Requests are made with `curl`. If curl is blocked (HTTP 403/429/503, an anti-bot page, or a curl error), the tool switches to **headless Chromium** for that URL.

Sites behind a login are supported: HTTP login and password, tokens and custom headers, cookies, and an **interactive browser login** whose session is saved and reused (see [Authorization](#authorization)).

## Requirements

- [Bun](https://bun.sh) ≥ 1.1
- `curl` in `PATH` (preinstalled on Linux, macOS and Windows 10+)
- Chromium or Google Chrome, needed only for the browser fallback. It is found automatically, or you can set `CHROME_PATH=/path/to/chrome`. The tool uses `puppeteer-core`, so no browser is downloaded during install.

## Install

```sh
git clone https://github.com/byluginnik-ux/image-speed-meter.git
cd image-speed-meter
bun install
```

Optionally, put the command in your `PATH` (this also makes `man image-speed-meter` work after `npm i -g .`):

```sh
bun link            # then run: image-speed-meter --help
```

## Usage

```sh
bun start <url> [url ...]
# or
./src/index.ts <url> [url ...]
```

```
Usage: image-speed-meter [options] <url> [url ...]
       image-speed-meter [options] '<json-array-of-urls>'
       image-speed-meter [options] --file <path>
       image-speed-meter login <url> [--profile <name|dir>]

Options:
  -n, --runs <N>         sequential requests per URL (default: 10)
  -m, --mode <mode>      auto | curl | browser (default: auto)
                           auto     curl first, headless browser if blocked
                           curl     curl only, never start a browser
                           browser  headless browser only
  -f, --file <path>      read URLs from a file, one per line ('#' starts a comment)
  -o, --out <dir>        save the downloaded file into <dir> (default: ./downloads)
      --no-save          do not save the downloaded file
  -t, --timeout <sec>    timeout for a single request, in seconds (default: 60)
      --json             print results as JSON instead of text
  -q, --quiet            print only the summary, not every request
  -h, --help             show this help and exit
  -V, --version          show the version and exit

Authorization (applied to curl and to the browser):
  -u, --user <user[:password]>
                         HTTP Basic/Digest credentials; without ':password' the
                         password is read from $IMAGE_SPEED_METER_PASSWORD
                         or asked for in the terminal
  -H, --header <header>  extra request header, e.g. 'Authorization: Bearer <token>';
                         repeatable; '@file' reads one header per line
  -b, --cookie <cookies> cookies as 'name=value; name2=value2'; repeatable
  -c, --cookie-file <path>
                         cookie file in Netscape format (curl, browser extensions)
  -p, --profile <name|dir>
                         use a session saved with 'image-speed-meter login'
  Credentials, headers and cookies are sent only to the host of the URL, not to
  hosts it redirects to. https://user:pass@host/ URLs work like --user.

Login (for sites with login forms, SSO or 2FA):
  image-speed-meter login <url> [--profile <name|dir>]
                         opens a visible browser; sign in, then press Enter.
                         The session is saved to the profile (default name
                         "default") and reused with --profile.
```

Full documentation is in the man page:

```sh
man ./man/image-speed-meter.1
```

## Examples

Every example below shows the command and the real output it produced. Speeds depend on your connection, so your numbers will differ.

### One image, default 10 requests

```sh
bun start https://images.unsplash.com/photo-1506744038136-46273834b3fb
```

```
[1/1] https://images.unsplash.com/photo-1506744038136-46273834b3fb
  # 1  curl        2.527 s       4.70 MB      1.86 MB/s
  # 2  curl        3.208 s       4.70 MB      1.46 MB/s
  # 3  curl        2.861 s       4.70 MB      1.64 MB/s
  # 4  curl        2.287 s       4.70 MB      2.05 MB/s
  # 5  curl        2.149 s       4.70 MB      2.19 MB/s
  # 6  curl        2.250 s       4.70 MB      2.09 MB/s
  # 7  curl        2.315 s       4.70 MB      2.03 MB/s
  # 8  curl        2.696 s       4.70 MB      1.74 MB/s
  # 9  curl        2.548 s       4.70 MB      1.84 MB/s
  #10  curl        2.093 s       4.70 MB      2.24 MB/s
  ----------------------------------------
  method:      curl
  requests:    10
  avg time:    2.493 s
  total data:  46.96 MB (46961180 bytes)
  speed:       1.88 MB/s (15.07 Mbit/s)
  saved to:    downloads/photo-1506744038136-46273834b3fb.jpg
```

Each request line shows its number, the method, the request time, the body size and the speed of that request.

### curl is blocked, so the headless browser takes over

Wikimedia answers curl with `429 Too Many Requests`. The tool switches to headless Chromium, and the blocked request is not counted.

```sh
bun start https://upload.wikimedia.org/wikipedia/commons/3/3f/Fronalpstock_big.jpg
```

```
[1/1] https://upload.wikimedia.org/wikipedia/commons/3/3f/Fronalpstock_big.jpg
  ! curl was blocked (HTTP 429); switching to headless browser
  # 1  browser    21.148 s      14.68 MB      0.69 MB/s
  # 2  browser     4.927 s      14.68 MB      2.98 MB/s
  # 3  browser     8.281 s      14.68 MB      1.77 MB/s
  # 4  browser     8.588 s      14.68 MB      1.71 MB/s
  # 5  browser     9.259 s      14.68 MB      1.59 MB/s
  # 6  browser     7.089 s      14.68 MB      2.07 MB/s
  # 7  browser     7.993 s      14.68 MB      1.84 MB/s
  # 8  browser     5.469 s      14.68 MB      2.68 MB/s
  # 9  browser     4.601 s      14.68 MB      3.19 MB/s
  #10  browser     4.246 s      14.68 MB      3.46 MB/s
  ----------------------------------------
  method:      browser
  requests:    10
  avg time:    8.160 s
  total data:  146.79 MB (146794740 bytes)
  speed:       1.80 MB/s (14.39 Mbit/s)
  saved to:    downloads/Fronalpstock_big.jpg
```

### Any file: a release archive

GitHub redirects release downloads to another host; the file name comes from the server's `Content-Disposition` header.

```sh
bun start -n 2 --mode curl https://github.com/cli/cli/releases/download/v2.63.0/gh_2.63.0_linux_amd64.tar.gz
```

```
[1/1] https://github.com/cli/cli/releases/download/v2.63.0/gh_2.63.0_linux_amd64.tar.gz
  #1  curl        9.793 s      13.07 MB      1.33 MB/s
  #2  curl        8.998 s      13.07 MB      1.45 MB/s
  ----------------------------------------
  method:      curl
  requests:    2
  avg time:    9.395 s
  total data:  26.14 MB (26136338 bytes)
  speed:       1.39 MB/s (11.13 Mbit/s)
  saved to:    downloads/gh_2.63.0_linux_amd64.tar.gz
```

The same archive through the headless browser gets the same number of bytes. The browser saves every response as a download, so archives, PDFs and videos work, and the time ends when the last byte is on disk:

```sh
bun start -n 2 --mode browser https://github.com/cli/cli/releases/download/v2.63.0/gh_2.63.0_linux_amd64.tar.gz
```

```
[1/1] https://github.com/cli/cli/releases/download/v2.63.0/gh_2.63.0_linux_amd64.tar.gz
  #1  browser    10.264 s      13.07 MB      1.27 MB/s
  #2  browser     7.953 s      13.07 MB      1.64 MB/s
  ----------------------------------------
  method:      browser
  requests:    2
  avg time:    9.108 s
  total data:  26.14 MB (26136338 bytes)
  speed:       1.43 MB/s (11.48 Mbit/s)
  saved to:    downloads/gh_2.63.0_linux_amd64.tar.gz
```

### An ordinary HTML page

An HTML page is measured with curl like any other file. Only anti-bot pages trigger the browser.

```sh
bun start -n 3 https://example.com/
```

```
[1/1] https://example.com/
  #1  curl        0.189 s    0.00033 MB     0.002 MB/s
  #2  curl        0.333 s    0.00033 MB     0.001 MB/s
  #3  curl        0.140 s    0.00033 MB     0.002 MB/s
  ----------------------------------------
  method:      curl
  requests:    3
  avg time:    0.221 s
  total data:  0.001 MB (1002 bytes)
  speed:       0.002 MB/s (0.012 Mbit/s)
  saved to:    downloads/example.com.html
```

### Several URLs as a JSON array

```sh
bun start -n 3 '["https://images.unsplash.com/photo-1501785888041-af3ef285b470","https://images.unsplash.com/photo-1441974231531-c6227db76b6e"]'
```

```
[1/2] https://images.unsplash.com/photo-1501785888041-af3ef285b470
  #1  curl        2.156 s       6.20 MB      2.88 MB/s
  #2  curl        2.681 s       6.20 MB      2.31 MB/s
  #3  curl        2.477 s       6.20 MB      2.50 MB/s
  ----------------------------------------
  method:      curl
  requests:    3
  avg time:    2.438 s
  total data:  18.60 MB (18602811 bytes)
  speed:       2.54 MB/s (20.35 Mbit/s)
  saved to:    downloads/photo-1501785888041-af3ef285b470.jpg

[2/2] https://images.unsplash.com/photo-1441974231531-c6227db76b6e
  #1  curl        0.896 s       1.45 MB      1.62 MB/s
  #2  curl        0.918 s       1.45 MB      1.58 MB/s
  #3  curl        0.924 s       1.45 MB      1.57 MB/s
  ----------------------------------------
  method:      curl
  requests:    3
  avg time:    0.913 s
  total data:  4.35 MB (4348212 bytes)
  speed:       1.59 MB/s (12.70 Mbit/s)
  saved to:    downloads/photo-1441974231531-c6227db76b6e.jpg
```

Several plain arguments work the same way: `bun start <url1> <url2>`.

### Headless browser only, without saving the file

```sh
bun start -n 5 --mode browser --no-save https://images.unsplash.com/photo-1470071459604-3b5ec3a7fe05
```

```
[1/1] https://images.unsplash.com/photo-1470071459604-3b5ec3a7fe05
  #1  browser     2.676 s       4.05 MB      1.51 MB/s
  #2  browser     2.621 s       4.05 MB      1.54 MB/s
  #3  browser     3.567 s       4.05 MB      1.13 MB/s
  #4  browser     2.244 s       4.05 MB      1.80 MB/s
  #5  browser     2.025 s       4.05 MB      2.00 MB/s
  ----------------------------------------
  method:      browser
  requests:    5
  avg time:    2.626 s
  total data:  20.24 MB (20236820 bytes)
  speed:       1.54 MB/s (12.33 Mbit/s)
```

### URLs from a file, summaries only

```sh
cat urls.txt
```

```
# images to measure
https://images.unsplash.com/photo-1470071459604-3b5ec3a7fe05
https://images.unsplash.com/photo-1441974231531-c6227db76b6e
```

```sh
bun start -q -n 3 -f urls.txt
```

```
[1/2] https://images.unsplash.com/photo-1470071459604-3b5ec3a7fe05
  ----------------------------------------
  method:      curl
  requests:    3
  avg time:    1.686 s
  total data:  12.14 MB (12142092 bytes)
  speed:       2.40 MB/s (19.20 Mbit/s)
  saved to:    downloads/photo-1470071459604-3b5ec3a7fe05.jpg

[2/2] https://images.unsplash.com/photo-1441974231531-c6227db76b6e
  ----------------------------------------
  method:      curl
  requests:    3
  avg time:    0.942 s
  total data:  4.35 MB (4348212 bytes)
  speed:       1.54 MB/s (12.30 Mbit/s)
  saved to:    downloads/photo-1441974231531-c6227db76b6e.jpg
```

### JSON output

```sh
bun start --json -n 2 --no-save https://images.unsplash.com/photo-1441974231531-c6227db76b6e
```

```json
[
  {
    "url": "https://images.unsplash.com/photo-1441974231531-c6227db76b6e",
    "ok": true,
    "methods": [
      "curl"
    ],
    "runs": [
      {
        "run": 1,
        "method": "curl",
        "status": 200,
        "bytes": 1449404,
        "timeSec": 0.953253
      },
      {
        "run": 2,
        "method": "curl",
        "status": 200,
        "bytes": 1449404,
        "timeSec": 0.939587
      }
    ],
    "avgSec": 0.94642,
    "totalSec": 1.89284,
    "totalBytes": 2898808,
    "speedMBps": 1.5315,
    "speedMbps": 12.2517
  }
]
```

The result is always an array, one object per URL. A failed URL has `"ok": false` and an `"error"` field.

### One URL fails, the others are still measured

```sh
bun start -n 3 --no-save https://httpbin.org/status/404 https://images.unsplash.com/photo-1441974231531-c6227db76b6e
echo $?
```

```
[1/2] https://httpbin.org/status/404
  ----------------------------------------
  error:       HTTP 404

[2/2] https://images.unsplash.com/photo-1441974231531-c6227db76b6e
  #1  curl        0.919 s       1.45 MB      1.58 MB/s
  #2  curl        1.011 s       1.45 MB      1.43 MB/s
  #3  curl        1.074 s       1.45 MB      1.35 MB/s
  ----------------------------------------
  method:      curl
  requests:    3
  avg time:    1.001 s
  total data:  4.35 MB (4348212 bytes)
  speed:       1.45 MB/s (11.58 Mbit/s)
1
```

### Small files

Small values get more decimal places, so small files do not show up as `0.00`:

```sh
bun start -n 2 --no-save https://httpbin.org/image/png
```

```
[1/1] https://httpbin.org/image/png
  #1  curl        0.642 s      0.008 MB     0.013 MB/s
  #2  curl        0.589 s      0.008 MB     0.014 MB/s
  ----------------------------------------
  method:      curl
  requests:    2
  avg time:    0.615 s
  total data:  0.016 MB (16180 bytes)
  speed:       0.013 MB/s (0.105 Mbit/s)
```

### Invalid arguments

```sh
bun start -n 0 https://httpbin.org/image/png
echo $?
```

```
image-speed-meter: --runs expects a positive integer, got "0"
Usage: image-speed-meter [options] <url> [url ...]
       image-speed-meter [options] '<json-array-of-urls>'
       image-speed-meter [options] --file <path>
       image-speed-meter login <url> [--profile <name|dir>]
Try 'image-speed-meter --help' for more information.
2
```

## Authorization

Every option works with both curl and the headless browser. The responses below come from [httpbin.org](https://httpbin.org), which echoes what it received, so the files are tiny.

### Login and password (HTTP Basic / Digest)

```sh
bun start -n 3 -u alice:s3cret https://httpbin.org/basic-auth/alice/s3cret
```

```
[1/1] https://httpbin.org/basic-auth/alice/s3cret
  #1  curl        0.873 s   0.000069 MB  0.000079 MB/s
  #2  curl        0.792 s   0.000069 MB  0.000087 MB/s
  #3  curl        0.779 s   0.000069 MB  0.000089 MB/s
  ----------------------------------------
  method:      curl
  requests:    3
  avg time:    0.815 s
  total data:  0.00021 MB (207 bytes)
  speed:       0.00010 MB/s (0.00070 Mbit/s)
  saved to:    downloads/s3cret.json
```

Keep the password out of the process list and the shell history: give only the user name, and the tool asks for the password (or reads `IMAGE_SPEED_METER_PASSWORD`):

```sh
bun start -u alice https://example.com/private/report.pdf
# Password for alice:
IMAGE_SPEED_METER_PASSWORD=s3cret bun start -u alice https://example.com/private/report.pdf
```

A wrong password is reported as such, and the tool does not fall back to the browser, which would get the same answer:

```sh
bun start -n 3 -u alice:wrong https://httpbin.org/basic-auth/alice/s3cret
```

```
[1/1] https://httpbin.org/basic-auth/alice/s3cret
  ----------------------------------------
  error:       HTTP 401 (credentials were rejected)
```

`https://alice:s3cret@host/path` works the same way, and the credentials are removed from all output.

### Token or any custom header

`-H` can be repeated. `-H @file` reads headers from a file, one per line, so the token does not end up in the shell history:

```sh
echo 'Authorization: Bearer my-token' > token.hdr
bun start -n 3 --mode browser -H @token.hdr https://httpbin.org/bearer
```

```
[1/1] https://httpbin.org/bearer
  #1  browser     0.722 s   0.000051 MB  0.000071 MB/s
  #2  browser     0.221 s   0.000051 MB   0.00023 MB/s
  #3  browser     0.223 s   0.000051 MB   0.00023 MB/s
  ----------------------------------------
  method:      browser
  requests:    3
  avg time:    0.389 s
  total data:  0.00015 MB (153 bytes)
  speed:       0.00010 MB/s (0.001 Mbit/s)
  saved to:    downloads/bearer.json
```

### Cookies

As a string with `-b`, or as a Netscape cookie file exported from a browser (for example with a "cookies.txt" extension) with `-c`:

```sh
bun start -n 2 -b 'session=abc; theme=dark' https://httpbin.org/cookies
cat downloads/cookies.json
```

```
[1/1] https://httpbin.org/cookies
  #1  curl        0.587 s   0.000065 MB   0.00011 MB/s
  #2  curl        0.623 s   0.000065 MB   0.00010 MB/s
  ----------------------------------------
  method:      curl
  requests:    2
  avg time:    0.605 s
  total data:  0.00013 MB (130 bytes)
  speed:       0.00010 MB/s (0.00090 Mbit/s)
  saved to:    downloads/cookies.json
{
  "cookies": {
    "session": "abc",
    "theme": "dark"
  }
}
```

```sh
bun start -c cookies.txt https://example.com/files/big.zip
```

### Interactive browser login (forms, SSO, 2FA)

For sites with a login form, single sign-on, two-factor authentication or a captcha, sign in once in a real browser window:

```sh
bun start login 'https://httpbin.org/cookies/set?session=from-login' --profile ./session-demo
```

```
A browser window has opened. Sign in there, then come back and press Enter here.
Saved 1 cookie to session-demo/cookies.txt
Use the session with: image-speed-meter --profile ./session-demo <url>
```

Then measure with the saved session. curl gets the exported cookies and the browser's user agent; the headless browser gets the whole profile:

```sh
bun start -n 2 --profile ./session-demo https://httpbin.org/cookies
cat downloads/cookies.json
```

```
[1/1] https://httpbin.org/cookies
  #1  curl        0.679 s   0.000051 MB  0.000075 MB/s
  #2  curl        0.585 s   0.000051 MB  0.000087 MB/s
  ----------------------------------------
  method:      curl
  requests:    2
  avg time:    0.632 s
  total data:  0.00010 MB (102 bytes)
  speed:       0.00010 MB/s (0.00060 Mbit/s)
  saved to:    downloads/cookies.json
{
  "cookies": {
    "session": "from-login"
  }
}
```

Without `--profile`, `login` uses the profile named `default` in `~/.config/image-speed-meter/profiles/` (use it with `-p default`). Run `login` again when the site's session expires.

### Where credentials are sent

- Credentials (`-u`), headers (`-H`) and cookie strings (`-b`) go **only to the host of the measured URL**. If it redirects to another host (a file server, a CDN), they are not sent there. With curl, redirects are then followed one hop at a time, and the reported time is the sum of all hops.
- Cookies from `-c` and from a profile follow the domains recorded in them.
- Secrets are never passed to curl on its command line: they go to its standard input (`--config -`). They are not printed in the output or the JSON.
- Cookie files and profiles give access to your accounts. Keep them private; `cookies.txt` and `*.cookies` are in `.gitignore`.

## Units

- **Time**: seconds (`s`), 3 decimal places.
- **Volume**: megabytes, **1 MB = 1,000,000 bytes** (decimal SI megabyte). The exact byte count is shown in parentheses.
- **Speed**: **MB/s** (megabytes per second) and **Mbit/s** (megabits per second, as ISPs advertise it; 1 Mbit/s = 1,000,000 bit/s). Speed = total bytes of all requests / total time of all requests.
- **Precision** of MB and speed values: 1 decimal place from 100, 2 from 1 to 100, 3 from 0.001 to 1, and two significant digits below 0.001. In `--json` the numbers are raw: bytes, seconds rounded to microseconds, and speeds to 4 decimal places.

The size is the response body as received. With curl, time and size come from curl itself (`time_total`, `size_download`), so process start-up is not counted. With the browser, every successful response is saved as a download; time runs from navigation start until the last byte is on disk. Browser start-up is not counted, and the browser cache is disabled so every run hits the network.

## How the fallback works

In `auto` mode, curl is replaced with headless Chromium for the remaining runs of a URL when:

1. the status is **403, 429 or 503**;
2. a 2xx response is an **anti-bot page** (Cloudflare, DDoS-Guard, Imperva, PerimeterX, DataDome and similar), detected by the `cf-mitigated` header and by markers in the HTML. An ordinary HTML page stays on curl;
3. **curl fails** (connection reset, TLS error, and so on).

HTTP 401 means "authorization required" and is reported as an error without switching, because the browser would get the same answer.

The request that triggered the switch is not counted. If the browser hits a JavaScript challenge page that redirects to the resource, the tool waits for the redirect and then repeats the run, so the challenge time is not counted. Chromium starts once and is reused for every URL.

## Exit status

- `0`: every URL was measured successfully, or the login succeeded
- `1`: at least one URL failed (the others are still measured), or the login failed
- `2`: invalid command-line arguments, or a password could not be obtained

## Use as a library

```ts
import { measureAll } from "image-speed-meter";

const reports = await measureAll(["https://httpbin.org/image/png"], { runs: 3, outDir: null });
console.log(reports[0].speedMBps);

// with authorization
await measureAll("https://example.com/file.zip", {
  auth: { headers: [["Authorization", "Bearer my-token"]], cookies: [] },
});
```

## Project layout

```
src/index.ts       CLI: argument parsing, --help, login subcommand, output
src/measure.ts     sequential runs, fallback logic, statistics, saving
src/curl.ts        curl subprocess wrapper, hop-by-hop redirects with auth
src/browser.ts     headless Chromium: forced downloads, auth interception, login
src/auth.ts        credentials, headers, cookies, profiles, curl config
src/challenge.ts   anti-bot page detection
src/types.ts       shared types
man/image-speed-meter.1   man page
```
