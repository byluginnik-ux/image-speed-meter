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

### Examples

```sh
# one image, 10 requests
bun start https://upload.wikimedia.org/wikipedia/commons/3/3f/Fronalpstock_big.jpg

# several URLs as a JSON array
bun start '["https://httpbin.org/image/jpeg","https://httpbin.org/image/png"]'

# 5 requests through the headless browser only, without saving the file
bun start -n 5 --mode browser --no-save https://httpbin.org/image/png

# URLs from a file, summaries only, machine-readable output
bun start -q -f urls.txt
bun start --json https://httpbin.org/image/jpeg
```

### Sample output

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

When curl is blocked:

```
[1/1] https://upload.wikimedia.org/wikipedia/commons/3/3f/Fronalpstock_big.jpg
  ! curl was blocked (HTTP 429); switching to headless browser
  # 1  browser    21.148 s      14.68 MB      0.69 MB/s
  ...
```

## Units

- **Time**: seconds (`s`), 3 decimal places.
- **Volume**: megabytes, **1 MB = 1,000,000 bytes** (decimal SI megabyte). The exact byte count is shown in parentheses.
- **Speed**: **MB/s** (megabytes per second) and **Mbit/s** (megabits per second, as ISPs advertise it; 1 Mbit/s = 1,000,000 bit/s). Speed = total bytes of all requests / total time of all requests.

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
