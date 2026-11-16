# image-speed-meter

A console tool that measures how fast an image (or any other file) downloads.

For every URL it makes **N sequential requests** (10 by default). Each request starts only after the previous response has been received completely. It then prints:

- the **average request time**;
- the **total amount of data** downloaded;
- the **download speed**.

Requests are made with `curl`. If curl is blocked (HTTP 401/403/429/503, an HTML page instead of a file, or a curl error), the tool switches to **headless Chromium** for that URL.

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

Values under 1 get three decimal places, so small images do not show up as `0.00`:

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
Try 'image-speed-meter --help' for more information.
2
```

## Units

- **Time**: seconds (`s`), 3 decimal places.
- **Volume**: megabytes, **1 MB = 1,000,000 bytes** (decimal SI megabyte). The exact byte count is shown in parentheses.
- **Speed**: **MB/s** (megabytes per second) and **Mbit/s** (megabits per second, as ISPs advertise it; 1 Mbit/s = 1,000,000 bit/s). Speed = total bytes of all requests / total time of all requests.
- **Precision** of MB and speed values: 3 decimal places below 1, 2 decimal places from 1 to 100, and 1 decimal place above 100. In `--json` the numbers are raw: bytes, seconds rounded to microseconds, and speeds to 4 decimal places.

The size is the response body as received. With curl, time and size come from curl itself (`time_total`, `size_download`), so process start-up is not counted. With the browser, time runs from navigation start until the whole body is available. Browser start-up is not counted, and the browser cache is disabled so every run hits the network.

## How the fallback works

In `auto` mode, curl is replaced with headless Chromium for the remaining runs of a URL when:

1. the status is **401, 403, 429 or 503**;
2. a 2xx response is **`text/html`** where a file was expected (a typical anti-bot interstitial);
3. **curl fails** (connection reset, TLS error, and so on).

The request that triggered the switch is not counted. If the browser hits a JavaScript challenge page that redirects to the resource, the tool waits for the redirect and then repeats the run, so the challenge time is not counted. Chromium starts once and is reused for every URL.

## Exit status

- `0`: every URL was measured successfully
- `1`: at least one URL failed (the others are still measured)
- `2`: invalid command-line arguments

## Use as a library

```ts
import { measureAll } from "image-speed-meter";

const reports = await measureAll(["https://httpbin.org/image/png"], { runs: 3, outDir: null });
console.log(reports[0].speedMBps);
```

## Project layout

```
src/index.ts       CLI: argument parsing, --help, output
src/measure.ts     sequential runs, fallback logic, statistics, saving
src/curl.ts        curl subprocess wrapper
src/browser.ts     headless Chromium via puppeteer-core
src/types.ts       shared types
man/image-speed-meter.1   man page
```
