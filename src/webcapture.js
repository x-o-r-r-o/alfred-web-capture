#!/usr/bin/osascript -l JavaScript
// Web Capture for Alfred: web page → Markdown, full-page screenshots, ray.so code images, YouTube transcripts.
// Usage: osascript -l JavaScript webcapture.js <command> [query]
// Data (URLs, page content, transcripts) only ever travels as argv, environment or files: never as code.
ObjC.import("Foundation");
ObjC.import("AppKit");
ObjC.import("CoreGraphics");

const ENV = $.NSProcessInfo.processInfo.environment;
function env(name, fallback) {
  const v = ENV.objectForKey(name);
  return v.isNil() ? fallback : v.js;
}

const FM = $.NSFileManager.defaultManager;
function readFile(path) {
  const s = $.NSString.stringWithContentsOfFileEncodingError(path, $.NSUTF8StringEncoding, $());
  return s.isNil() ? null : s.js;
}
function writeFile(path, text) {
  return $(text).writeToFileAtomicallyEncodingError(path, true, $.NSUTF8StringEncoding, $());
}
function exists(path) {
  return FM.fileExistsAtPath(path);
}
function mkdirs(dir) {
  FM.createDirectoryAtPathWithIntermediateDirectoriesAttributesError(dir, true, $(), $());
  return dir;
}
function ageSeconds(path) {
  const a = FM.attributesOfItemAtPathError(path, $());
  if (a.isNil()) return Infinity;
  return (Date.now() - a.fileModificationDate.timeIntervalSince1970 * 1000) / 1000;
}
function expandHome(p) {
  return p.replace(/^~(?=\/|$)/, $.NSHomeDirectory().js);
}

// markdown.js holds the parser, the content extraction and the Markdown converter (plain JS).
function scriptDir() {
  const args = $.NSProcessInfo.processInfo.arguments;
  for (let i = 0; i < args.count; i++) {
    const a = args.objectAtIndex(i).js;
    if (/webcapture\.js$/.test(a)) {
      const dir = $(a).stringByDeletingLastPathComponent.js;
      return dir.startsWith("/") ? dir : `${FM.currentDirectoryPath.js}/${dir || "."}`;
    }
  }
  return FM.currentDirectoryPath.js;
}
(0, eval)(readFile(`${scriptDir()}/lib/markdown.js`));
const MD = this.WCMarkdown;

// ---------- settings ----------

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const LARGE = 50000; // Script Filter JSON stays small: larger results go through the cache
const MAX_HTML = 8 * 1024 * 1024;
const FULL_PAGE_MAX = 2 * 1024 * 1024; // larger pages get only the extracted article

function timeout() {
  const n = parseInt(env("fetch_timeout", "20"), 10);
  return isNaN(n) ? 20 : Math.min(120, Math.max(3, n));
}
function saveFolder() {
  return expandHome(env("save_folder", "") || "~/Downloads");
}
function cacheDir() {
  return mkdirs(env("alfred_workflow_cache", `${$.NSTemporaryDirectory().js}web-capture`));
}

// ---------- output helpers ----------

function info(title, subtitle, icon = "info", extra = {}) {
  return Object.assign({ title: oneLine(title, 200), subtitle: oneLine(subtitle || "", 300), valid: false, icon: { path: `icons/${icon}.png` } }, extra);
}
function output(items, extra = {}) {
  return JSON.stringify(Object.assign({ skipknowledge: true, items }, extra));
}
// Display strings: no control characters or bidi overrides (page titles can carry them), and never cut
// inside an emoji (a lone surrogate makes Alfred reject the JSON). The real value stays in arg.
function oneLine(s, max = 120) {
  const t = String(s).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").replace(/[\u202a-\u202e\u2066-\u2069\ufeff]/g, "")
    .replace(/[\ud800-\udbff][\udc00-\udfff]|[\ud800-\udfff]/g, (m) => (m.length === 2 ? m : "\ufffd")).replace(/\s+/g, " ").trim();
  return t.length > max ? cutText(t, max - 1) + "…" : t;
}
function cutText(s, n) {
  return s.length > n && /[\ud800-\udbff]/.test(s[n - 1]) ? s.slice(0, n - 1) : s.slice(0, n);
}
// Lookups of strings from users or servers: never through Object.prototype ("constructor", "__proto__").
function own(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined;
}
function plural(n, word) {
  return `${n.toLocaleString("en-US")} ${word}${n === 1 ? "" : "s"}`;
}
// FNV-1a: short, stable cache keys (not for security)
function hashKey(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}
function safeFileName(s, ext) {
  const clean = String(s).replace(/[\u202a-\u202e\u2066-\u2069]/g, "").replace(/[\/\\:*?"<>|\u0000-\u001f\u007f]+/g, " ").replace(/^[.\s]+/, "").replace(/\s+/g, " ").trim();
  const base = Array.from(clean).slice(0, 120).join("").trim() || "Untitled"; // never split an emoji
  return `${base}.${ext}`;
}
// Large values are written to the cache; resolve.sh reads them back after selection. Named by content:
// with a counter, a newer keystroke's run overwrote the file behind the results still on screen.
function largeArg(value, tag) {
  if (value.length <= LARGE) return value;
  const path = `${cacheDir()}/result-${tag}-${hashKey(value)}-${value.length.toString(36)}.txt`;
  if (!exists(path)) writeFile(path, value);
  return `wcfile:${path}`;
}

// Converted pages, transcripts and large results older than a day are removed (checked at most hourly).
function pruneCache() {
  const dir = cacheDir();
  const stamp = `${dir}/pruned`;
  if (ageSeconds(stamp) < 3600) return;
  writeFile(stamp, "");
  const list = FM.contentsOfDirectoryAtPathError(dir, $());
  if (list.isNil()) return;
  for (let i = 0; i < list.count; i++) {
    const name = list.objectAtIndex(i).js;
    if (!/^(md-|yt-|result-|fetch-)/.test(name)) continue;
    const path = `${dir}/${name}`;
    if (ageSeconds(path) > 86400) FM.removeItemAtPathError(path, $());
  }
}
function textField(value) {
  if (value.length > LARGE) return { copy: "Result too large for ⌘C: press ↩ to copy it", largetype: cutText(value, 5000) + "…" };
  return { copy: value, largetype: value.length > 5000 ? cutText(value, 5000) + "…" : value };
}

// ---------- processes ----------

// Run a command with arguments (never through a shell). Returns {status, out (NSData), err}.
function execute(path, args, input) {
  const task = $.NSTask.alloc.init;
  task.executableURL = $.NSURL.fileURLWithPath(path);
  task.arguments = args;
  const outP = $.NSPipe.pipe, errP = $.NSPipe.pipe;
  task.standardOutput = outP;
  task.standardError = errP;
  if (input !== undefined) {
    const inP = $.NSPipe.pipe;
    task.standardInput = inP;
    if (!task.launchAndReturnError($())) return { status: -1, out: $.NSData.data, err: "launch failed" };
    inP.fileHandleForWriting.writeData($(input).dataUsingEncoding($.NSUTF8StringEncoding));
    inP.fileHandleForWriting.closeFile;
  } else {
    task.standardInput = $.NSFileHandle.fileHandleWithNullDevice;
    if (!task.launchAndReturnError($())) return { status: -1, out: $.NSData.data, err: "launch failed" };
  }
  const out = outP.fileHandleForReading.readDataToEndOfFile;
  const err = errP.fileHandleForReading.readDataToEndOfFile;
  task.waitUntilExit;
  return { status: task.terminationStatus, out, err: $.NSString.alloc.initWithDataEncoding(err, $.NSUTF8StringEncoding).js || "" };
}

function dataToString(data, encoding = $.NSUTF8StringEncoding) {
  const s = $.NSString.alloc.initWithDataEncoding(data, encoding);
  return s.isNil() ? null : s.js;
}

// ---------- HTTP (curl ships with macOS) ----------

const CURL_ERRORS = {
  3: "The URL is malformed",
  5: "Could not resolve the proxy",
  6: "Could not find the server: check the address or your internet connection",
  7: "Could not connect to the server",
  28: "The server took too long to respond",
  35: "The secure connection failed",
  47: "Too many redirects",
  52: "The server sent an empty reply",
  56: "The connection was interrupted",
  60: "The server’s certificate is not trusted",
  63: "The page is too large",
  1: "Unsupported protocol",
};

// GET (or POST with a JSON body) through curl. The URL and body go in argv / a temp file.
// -g (--globoff): curl otherwise reads [ ] { } in a URL as a range or set (?filter[tag]=x failed as malformed).
function fetchURL(url, opts = {}) {
  const dir = cacheDir();
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const bodyFile = `${dir}/fetch-${id}.body`;
  const args = ["-sS", "-g", "-L", "--max-redirs", "10", "--compressed", "--proto", "=http,https", "--proto-redir", "=http,https",
    "-m", String(opts.timeout || timeout()), "--connect-timeout", "10", "--max-filesize", String(opts.maxBytes || 20 * 1024 * 1024),
    "-A", opts.ua || UA, "-H", `Accept: ${opts.accept || "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"}`,
    "-H", "Accept-Language: en-US,en;q=0.9", "-o", bodyFile,
    "-w", "%{http_code}\\n%{content_type}\\n%{url_effective}\\n"];
  for (const h of opts.headers || []) args.push("-H", h);
  let postFile = null;
  if (opts.json !== undefined) {
    postFile = `${dir}/fetch-${id}.json`;
    writeFile(postFile, JSON.stringify(opts.json));
    args.push("-X", "POST", "-H", "Content-Type: application/json", "--data-binary", `@${postFile}`);
  }
  args.push("--url", url);
  const r = execute("/usr/bin/curl", args);
  const meta = (dataToString(r.out) || "").split("\n");
  const data = $.NSData.dataWithContentsOfFile(bodyFile);
  FM.removeItemAtPathError(bodyFile, $());
  if (postFile) FM.removeItemAtPathError(postFile, $());
  const status = parseInt(meta[0], 10) || 0;
  if (r.status !== 0) {
    return { ok: false, status, curl: r.status, error: CURL_ERRORS[r.status] || `Network error (curl ${r.status})` };
  }
  return { ok: status >= 200 && status < 300, status, contentType: (meta[1] || "").toLowerCase(), finalURL: meta[2] || url, data: data.isNil() ? $.NSData.data : data };
}

function httpError(status) {
  if (status === 401 || status === 403) return `Access denied (HTTP ${status})`;
  if (status === 404 || status === 410) return `Page not found (HTTP ${status})`;
  if (status === 429) return "Too many requests (HTTP 429): try again later";
  if (status >= 500) return `The server had an error (HTTP ${status})`;
  return `The server answered HTTP ${status}`;
}

// Labels that browsers decode with a superset encoding (WHATWG Encoding Standard). Decoding a GBK page as
// strict GB2312 fails on the first GBK-only character, and the whole page then came out as mojibake.
const CHARSET_ALIASES = [
  [/^(iso-8859-1|iso8859-1|latin-?1|l1|us-ascii|ascii|cp819|ibm819|iso_8859-1(:1987)?)$/, "windows-1252"],
  [/^(gb2312|gbk|x-gbk|chinese|csgb2312|gb_2312(-80)?|iso-ir-58|csiso58gb231280)$/, "gb18030"],
  [/^(shift[_-]jis|sjis|x-sjis|ms_kanji|ms932|csshiftjis|windows-31j)$/, "windows-31j"],
  [/^(euc-kr|ks_c_5601-19(87|89)|korean|csksc56011987|iso-ir-149|ksc_?5601|windows-949|cseuckr)$/, "windows-949"],
  [/^(big5|x-x-big5|cn-big5|csbig5)$/, "big5-hkscs"],
  [/^(iso-8859-9|iso8859-9|latin5|l5)$/, "windows-1254"],
  [/^(iso-8859-11|iso8859-11|tis-620|dos-874)$/, "windows-874"],
];
function charsetAlias(name) {
  for (const [re, to] of CHARSET_ALIASES) if (re.test(name)) return to;
  return name;
}

// Decode bytes using the charset from the header, a BOM or <meta>; fall back to UTF-8, then Windows-1252.
function decodeHTML(data, contentType) {
  const len = Number(data.length);
  const bytes = (n) => {
    const b = [];
    const s = dataToString(data.subdataWithRange($.NSMakeRange(0, Math.min(n, len))), $.NSISOLatin1StringEncoding) || "";
    for (let i = 0; i < s.length; i++) b.push(s.charCodeAt(i));
    return { b, s };
  };
  const head = bytes(32768); // <meta charset> can follow long comments or inline scripts
  let charset = "";
  if (head.b[0] === 0xef && head.b[1] === 0xbb && head.b[2] === 0xbf) charset = "utf-8";
  else if (head.b[0] === 0xff && head.b[1] === 0xfe) charset = "utf-16le";
  else if (head.b[0] === 0xfe && head.b[1] === 0xff) charset = "utf-16be";
  if (!charset) charset = (/charset\s*=\s*["']?([\w:.-]+)/i.exec(contentType || "") || [])[1] || "";
  if (!charset) {
    const headEnd = head.s.search(/<\/head\b|<body\b/i);
    const m = /<meta[^>]+charset\s*=\s*["']?\s*([\w:.-]+)/i.exec(headEnd > 0 ? head.s.slice(0, headEnd) : head.s);
    // a page that declares UTF-16 in <meta> is ASCII-compatible, so it is really UTF-8 (as browsers do)
    if (m) charset = /^utf-?16/i.test(m[1]) ? "utf-8" : m[1];
  }
  charset = charsetAlias(charset.toLowerCase());
  let enc = $.NSUTF8StringEncoding;
  if (charset && !/^utf-?8$/.test(charset)) {
    const cf = $.CFStringConvertIANACharSetNameToEncoding($(charset));
    if (cf !== 0xffffffff && cf !== -1) enc = $.CFStringConvertEncodingToNSStringEncoding(cf);
  }
  let s = dataToString(data, enc);
  if (s === null && enc !== $.NSUTF8StringEncoding) s = dataToString(data, $.NSUTF8StringEncoding); // wrong label
  if (s === null) s = lossyUTF8(data);
  if (s === null) s = dataToString(data, 12 /* Windows-1252 */);
  if (s === null) s = dataToString(data, $.NSISOLatin1StringEncoding) || "";
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  return { text: s, charset: charset || "utf-8" };
}

// UTF-8 with a few bad bytes: replace them with U+FFFD (as browsers do) instead of reading the whole
// page as Windows-1252. Decoded by hand: Foundation has no lossy UTF-8 initializer usable from JXA.
function lossyUTF8(data) {
  const b = dataToString(data, $.NSISOLatin1StringEncoding) || "";
  const out = [];
  let chunk = "";
  for (let i = 0; i < b.length; ) {
    const c = b.charCodeAt(i);
    let cp = -1, need = 0;
    if (c < 0x80) { cp = c; need = 0; }
    else if (c >= 0xc2 && c <= 0xdf) { cp = c & 0x1f; need = 1; }
    else if (c >= 0xe0 && c <= 0xef) { cp = c & 0x0f; need = 2; }
    else if (c >= 0xf0 && c <= 0xf4) { cp = c & 0x07; need = 3; }
    let j = 1;
    for (; j <= need; j++) {
      const d = b.charCodeAt(i + j);
      if (!(d >= 0x80 && d <= 0xbf)) break;
      cp = (cp << 6) | (d & 0x3f);
    }
    if (cp < 0 || j <= need || (need === 2 && cp < 0x800) || (need === 3 && (cp < 0x10000 || cp > 0x10ffff)) || (cp >= 0xd800 && cp <= 0xdfff)) {
      chunk += "\uFFFD";
      i += Math.max(1, j === 1 ? 1 : j);
    } else {
      chunk += String.fromCodePoint(cp);
      i += need + 1;
    }
    if (chunk.length > 8192) {
      out.push(chunk);
      chunk = "";
    }
  }
  out.push(chunk);
  const s = out.join("");
  // only if it really is mostly UTF-8
  return (s.match(/\uFFFD/g) || []).length < s.length / 50 + 1 ? s : null;
}

// ---------- URL sources ----------

function asURL(s) {
  const t = String(s || "").trim();
  if (!t || /\s/.test(t)) return null;
  if (/^https?:\/\/[^\s/?#]+/i.test(t)) return asciiURL(t);
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(t)) return asciiURL(`http://${t}`);
  if (/^(www\.)?[\p{L}\p{N}-]+(\.[\p{L}\p{N}-]+)*\.[\p{L}]{2,}(:\d+)?([/?#]\S*)?$/u.test(t)) return asciiURL(`https://${t}`);
  return null;
}

// URLs as typed or copied can hold Unicode, spaces, [ ] { } | and stray %. macOS 13's NSURL rejects them
// (WebKit then said "Invalid URL"), and the curl in macOS has no IDN support and treats [ ] { } as globs.
// Percent-encode those characters and turn an international host name into Punycode (as browsers do).
function asciiURL(u) {
  const m = /^(https?:\/\/)([^/?#]*)([\s\S]*)$/i.exec(u);
  if (!m) return u;
  const at = m[2].lastIndexOf("@");
  const userinfo = m[2].slice(0, at + 1);
  let host = m[2].slice(at + 1);
  const hp = /^([^:]*)(:\d*)?$/.exec(host);
  if (hp && /[^\x00-\x7f]/.test(hp[1])) {
    host = hp[1].split(/[.\u3002\uff0e\uff61]/).map((l) => (/[^\x00-\x7f]/.test(l) ? `xn--${punycode(l.normalize("NFC").toLowerCase())}` : l)).join(".") + (hp[2] || "");
  }
  return m[1] + encodeInvalid(userinfo) + host + encodeInvalid(m[3]);
}
function encodeInvalid(s) {
  return s.replace(/%(?![0-9A-Fa-f]{2})|[^\x21-\x7e]|["<>\\^`{|}[\]]/gu, (c) => {
    try {
      return encodeURIComponent(c);
    } catch (e) {
      return "%EF%BF%BD"; // a lone surrogate
    }
  });
}
// RFC 3492 Punycode encoding of one host label.
function punycode(label) {
  const BASE = 36, TMIN = 1, TMAX = 26;
  const cps = Array.from(label).map((c) => c.codePointAt(0));
  let out = cps.filter((c) => c < 128).map((c) => String.fromCharCode(c)).join("");
  const b = out.length;
  let n = 128, delta = 0, bias = 72, h = b;
  if (b) out += "-";
  const digit = (d) => String.fromCharCode(d + 22 + (d < 26 ? 75 : 0));
  const adapt = (d, num, first) => {
    d = first ? Math.floor(d / 700) : d >> 1;
    d += Math.floor(d / num);
    let k = 0;
    for (; d > ((BASE - TMIN) * TMAX) >> 1; k += BASE) d = Math.floor(d / (BASE - TMIN));
    return k + Math.floor(((BASE - TMIN + 1) * d) / (d + 38));
  };
  while (h < cps.length) {
    const m = Math.min(...cps.filter((c) => c >= n));
    delta += (m - n) * (h + 1);
    n = m;
    for (const c of cps) {
      if (c < n) delta++;
      if (c !== n) continue;
      let q = delta;
      for (let k = BASE; ; k += BASE) {
        const t = k <= bias ? TMIN : k >= bias + TMAX ? TMAX : k - bias;
        if (q < t) break;
        out += digit(t + ((q - t) % (BASE - t)));
        q = Math.floor((q - t) / (BASE - t));
      }
      out += digit(q);
      bias = adapt(delta, h + 1, h === b);
      delta = 0;
      h++;
    }
    delta++;
    n++;
  }
  return out;
}

function hostOf(url) {
  const m = /^https?:\/\/(?:www\.)?([^/:?#]+)/i.exec(url);
  return m ? m[1] : url;
}

function clipboard() {
  const fake = env("WC_TEST_CLIPBOARD", null); // test suite only
  if (fake !== null) return fake;
  const s = $.NSPasteboard.generalPasteboard.stringForType($.NSPasteboardTypeString);
  if (s.isNil()) return "";
  const t = s.js;
  return t.length > 2 * 1024 * 1024 ? "" : t;
}

// Scriptable browsers and how to read their tabs. Firefox-based browsers have no AppleScript tabs.
const BROWSERS = [
  ["com.apple.Safari", "Safari", "safari"],
  ["com.apple.SafariTechnologyPreview", "Safari Technology Preview", "safari"],
  ["com.kagi.kagimacOS", "Orion", "safari"],
  ["com.kagi.kagimacOS.RC", "Orion RC", "safari"],
  ["com.google.Chrome", "Google Chrome", "chromium"],
  ["com.google.Chrome.beta", "Google Chrome Beta", "chromium"],
  ["com.google.Chrome.dev", "Google Chrome Dev", "chromium"],
  ["com.google.Chrome.canary", "Google Chrome Canary", "chromium"],
  ["org.chromium.Chromium", "Chromium", "chromium"],
  ["company.thebrowser.Browser", "Arc", "chromium"],
  ["company.thebrowser.dia", "Dia", "chromium"],
  ["com.brave.Browser", "Brave", "chromium"],
  ["com.brave.Browser.beta", "Brave Beta", "chromium"],
  ["com.brave.Browser.nightly", "Brave Nightly", "chromium"],
  ["com.brave.Browser.origin", "Brave Origin", "chromium"],
  ["com.microsoft.edgemac", "Microsoft Edge", "chromium"],
  ["com.microsoft.edgemac.Beta", "Microsoft Edge Beta", "chromium"],
  ["com.microsoft.edgemac.Dev", "Microsoft Edge Dev", "chromium"],
  ["com.microsoft.edgemac.Canary", "Microsoft Edge Canary", "chromium"],
  ["com.vivaldi.Vivaldi", "Vivaldi", "chromium"],
  ["com.operasoftware.Opera", "Opera", "chromium"],
  ["com.operasoftware.OperaGX", "Opera GX", "chromium"],
  ["ai.perplexity.comet", "Comet", "chromium"],
  ["net.imput.helium", "Helium", "chromium"],
  ["org.mozilla.firefox", "Firefox", "none"],
  ["org.mozilla.firefoxdeveloperedition", "Firefox Developer Edition", "none"],
  ["org.mozilla.nightly", "Firefox Nightly", "none"],
  ["app.zen-browser.zen", "Zen", "none"],
  ["io.gitlab.librewolf-community", "LibreWolf", "none"],
];
const BROWSER_BY_ID = Object.fromEntries(BROWSERS.map((b) => [b[0], { bid: b[0], name: b[1], kind: b[2] }]));

// The browser to read: the frontmost app if it is a browser, else the browser with the frontmost window.
// Only running browsers are considered, so nothing gets launched.
function pickBrowser() {
  const ws = $.NSWorkspace.sharedWorkspace;
  const running = {};
  const apps = ws.runningApplications;
  for (let i = 0; i < apps.count; i++) {
    const a = apps.objectAtIndex(i);
    const bid = a.bundleIdentifier;
    if (!bid.isNil() && own(BROWSER_BY_ID, bid.js)) running[a.processIdentifier] = BROWSER_BY_ID[bid.js];
  }
  if (!Object.keys(running).length) return null;
  const front = ws.frontmostApplication;
  if (!front.isNil() && running[front.processIdentifier]) return running[front.processIdentifier];
  try {
    const list = ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements, 0));
    for (let i = 0; i < list.count; i++) {
      const w = list.objectAtIndex(i);
      if (Number(w.objectForKey("kCGWindowLayer").js) !== 0) continue;
      const b = running[w.objectForKey("kCGWindowOwnerPID").js];
      if (b) return b;
    }
  } catch (e) {
    // fall through
  }
  return Object.values(running)[0];
}

const PAGE_HTML_JS = "document.documentElement.outerHTML"; // a constant: no data is ever put in page scripts

// Returns {url, title, browser, bid, kind} | {unscriptable: name} | {error, browser} | null
function frontTab(withHTML) {
  const fake = env("WC_TEST_TAB", null); // test suite: JSON or "none"
  if (fake !== null) {
    if (fake === "none") return null;
    const t = JSON.parse(fake);
    if (t.kind === "none") return { unscriptable: t.browser };
    if (!withHTML) delete t.html;
    return t;
  }
  const b = pickBrowser();
  if (!b) return null;
  if (b.kind === "none") return { unscriptable: b.name };
  try {
    const app = Application(b.bid);
    let url, title, html = null, tab;
    if (b.kind === "safari") {
      const wins = app.windows();
      for (const w of wins) {
        try {
          tab = w.currentTab();
          url = tab.url();
          break;
        } catch (e) {
          tab = null; // settings or download windows have no tab
        }
      }
      if (!tab) return { error: "No open tab", browser: b.name };
      title = tab.name();
      if (withHTML) {
        try {
          html = app.doJavaScript(PAGE_HTML_JS, { in: tab });
        } catch (e) {
          html = { error: String(e.message || e) };
        }
      }
    } else {
      if (!app.windows.length) return { error: "No open window", browser: b.name };
      tab = app.windows[0].activeTab();
      url = tab.url();
      title = tab.title();
      if (withHTML) {
        try {
          html = tab.execute({ javascript: PAGE_HTML_JS });
        } catch (e) {
          html = { error: String(e.message || e) };
        }
      }
    }
    return { url: url || "", title: title || "", browser: b.name, bid: b.bid, kind: b.kind, html };
  } catch (e) {
    return { error: String(e.message || e), browser: b.name };
  }
}

// Where the URL comes from: the query, else the frontmost browser tab, else the clipboard.
function sourceURL(query, withHTML) {
  const q = String(query || "").trim();
  if (q) {
    const u = asURL(q);
    if (u) return { url: u, from: "query" };
    return { error: "Not a URL", hint: "Type or paste a web address, or leave the query empty to use the frontmost browser tab" };
  }
  const tab = frontTab(withHTML);
  let note = "";
  if (tab && tab.url && /^https?:\/\//i.test(tab.url)) {
    return { url: asciiURL(tab.url), title: tab.title, from: "browser", browser: tab.browser, html: tab.html };
  }
  if (tab && tab.unscriptable) note = `${tab.unscriptable} can’t share its tab`;
  else if (tab && tab.error && /-1743|not (authorized|allowed) to send apple ?events/i.test(tab.error)) {
    note = `Allow Alfred to control ${tab.browser} in System Settings › Privacy & Security › Automation`;
  } else if (tab && tab.error) note = `Could not read ${tab.browser}: ${oneLine(tab.error, 60)}`;
  else if (tab && tab.url) note = `The ${tab.browser} tab is not a web page`;
  const clip = asURL(clipboard().trim());
  if (clip && /^https?:\/\//i.test(clip)) return { url: clip, from: "clipboard", note };
  return {
    error: "No web page",
    hint: note ? `${note}, or copy the URL first` : "Open a page in your browser, copy a URL, or type one",
  };
}

function sourceLabel(src) {
  if (src.from === "browser") return `from ${src.browser}`;
  if (src.from === "clipboard") return "from the clipboard";
  return "";
}

// ---------- tomd: web page → Markdown ----------

const TEXT_TYPES = /^(text\/plain|text\/markdown|text\/x-markdown)/;
const FEED_TYPE = /^application\/([\w.-]+\+)?xml$|^text\/xml$/;
const CODE_TYPES = { "application/json": "json", "text/csv": "csv", "text/xml": "xml", "application/xml": "xml", "text/css": "css", "application/javascript": "javascript", "text/javascript": "javascript", "application/x-yaml": "yaml", "text/yaml": "yaml" };

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function fileLabel(url) {
  const path = url.replace(/[?#].*$/, "");
  const name = decodeURIComponentSafe(path.split("/").filter(Boolean).pop() || hostOf(url));
  return name;
}

function decodeURIComponentSafe(s) {
  try {
    return decodeURIComponent(s);
  } catch (e) {
    return s;
  }
}

// Fetch + convert. Returns {title, markdown, full, words, textLength, url, note, via} or {error, subtitle, items}
function convertPage(src) {
  const frontMatter = env("tomd_front_matter", "1") !== "0";
  const images = env("tomd_images", "1") !== "0";
  let html = null, finalURL = src.url, via = "";
  const notes = [];
  if (src.from === "browser" && env("tomd_browser_html", "0") === "1") {
    if (typeof src.html === "string" && src.html.length > 20) {
      html = src.html;
      via = "page content from the browser";
    } else {
      notes.push(`Could not read the page from ${src.browser}: turn on “Allow JavaScript from Apple Events”`);
    }
  }
  if (html === null) {
    const r = fetchURL(src.url);
    if (r.curl) return { error: r.error, subtitle: src.url };
    if (!r.ok) {
      let subtitle = src.url;
      if (r.status === 401 || r.status === 403 || r.status === 429) {
        subtitle = src.from === "browser"
          ? "The site blocks scripts or needs a login: turn on “Use browser page content” in the Workflow’s Configuration"
          : "The site blocks scripts or needs a login: open it in your browser and use the frontmost tab";
      }
      return { error: httpError(r.status), subtitle };
    }
    finalURL = r.finalURL;
    if (hostOf(finalURL) !== hostOf(src.url) || (/\b(log-?in|sign-?in|auth|consent|subscribe|register)\b/i.test(finalURL) && !/\b(log-?in|sign-?in|auth|consent|subscribe|register)\b/i.test(src.url))) {
      notes.push(`Redirected to ${oneLine(finalURL.replace(/^https?:\/\//, ""), 60)}`);
    }
    const type = r.contentType.split(";")[0].trim();
    const size = Number(r.data.length);
    if (TEXT_TYPES.test(type)) {
      const text = decodeHTML(r.data, r.contentType).text;
      return { title: fileLabel(finalURL), markdown: text.endsWith("\n") ? text : text + "\n", full: null, words: countWords(text), textLength: text.length, url: finalURL, note: "Plain text: copied as is" };
    }
    if (own(CODE_TYPES, type) || (FEED_TYPE.test(type) && type !== "application/xhtml+xml")) {
      const text = decodeHTML(r.data, r.contentType).text.replace(/\n$/, "");
      const fence = (text.match(/`{3,}/g) || []).reduce((f, m) => (m.length >= f.length ? "`".repeat(m.length + 1) : f), "```");
      return { title: fileLabel(finalURL), markdown: `${fence}${own(CODE_TYPES, type) || "xml"}\n${text}\n${fence}\n`, full: null, words: countWords(text), textLength: text.length, url: finalURL, note: `${type} wrapped in a code block` };
    }
    if (type && !/html|xml/.test(type)) {
      const kind = /pdf/.test(type) ? "PDF" : /^image\//.test(type) ? "image" : /^video\//.test(type) ? "video" : /^audio\//.test(type) ? "audio file" : `file (${type})`;
      const name = fileLabel(finalURL);
      const target = MD.urlForMarkdown(finalURL);
      const link = /^image\//.test(type) ? `![${MD.escapeText(name)}](${target})` : `[${MD.escapeText(name)}](${target})`;
      return {
        error: `Not a web page: this URL is a ${kind}`,
        subtitle: `${(size / 1024).toFixed(0)} KB · ${finalURL}`,
        items: [{ title: `Copy a Markdown link to the ${kind}`, subtitle: link, arg: link, valid: true, icon: { path: "icons/link.png" }, mods: { cmd: { arg: link, subtitle: "Paste the link into the frontmost app" }, alt: { arg: link, valid: false, subtitle: "Only web pages can be saved" } } }],
      };
    }
    html = decodeHTML(r.data, r.contentType).text;
    if (!html.trim()) return { error: "The page is empty", subtitle: finalURL };
  }
  if (html.length > MAX_HTML) {
    html = html.slice(0, MAX_HTML);
    notes.push("Very large page: only the first 8 MB were converted");
  }
  const captured = today();
  const main = MD.htmlToMarkdown(html, { url: finalURL, frontMatter, extract: true, captured, images });
  // The whole-page version doubles the time; on very large pages (seconds each in JavaScriptCore) it is skipped.
  const full = html.length <= FULL_PAGE_MAX ? MD.htmlToMarkdown(html, { url: finalURL, frontMatter, extract: false, captured, images }) : { markdown: null, words: 0 };
  if (main.textLength < 200) {
    notes.push(src.from === "browser" && via === ""
      ? "Little text found: the page may need a login or JavaScript. Try “Use browser page content”"
      : "Little text found: the page may need a login or JavaScript");
  }
  return { title: main.meta.title || src.title || hostOf(finalURL), markdown: main.markdown, full: full.markdown, words: main.words, fullWords: full.words, textLength: main.textLength, url: finalURL, note: notes.join(" · "), via };
}

function countWords(s) {
  return (s.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) || []).length;
}

function tomdItems(query) {
  const withHTML = env("tomd_browser_html", "0") === "1";
  const src = sourceURL(query, withHTML);
  if (src.error) return [info(src.error, src.hint, src.error === "Not a URL" ? "error" : "info")];

  // ",noimg" is only added when images are off, so v1.0.0 cache keys stay valid
  const settings = [env("tomd_front_matter", "1"), withHTML && src.from === "browser" ? "b" : ""].join() + (env("tomd_images", "1") === "0" ? ",noimg" : "");
  const key = hashKey(`${src.url}|${settings}`);
  const dir = mkdirs(`${cacheDir()}/md-${key}`);
  const metaPath = `${dir}/result.json`;
  let res = null;
  if (ageSeconds(metaPath) < 600 && !(withHTML && src.from === "browser")) {
    try {
      res = JSON.parse(readFile(metaPath));
    } catch (e) {
      res = null;
    }
  }
  if (!res) {
    res = convertPage(src);
    if (res.error) {
      const items = [info(res.error, res.subtitle, "error")];
      return items.concat(res.items || []);
    }
    res.mdPath = `${dir}/${safeFileName(res.title, "md")}`;
    writeFile(res.mdPath, res.markdown);
    if (res.full !== null && res.full !== undefined) {
      res.fullPath = `${dir}/full/${safeFileName(res.title, "md")}`;
      mkdirs(`${dir}/full`);
      writeFile(res.fullPath, res.full);
    }
    const store = Object.assign({}, res);
    delete store.markdown;
    delete store.full;
    writeFile(metaPath, JSON.stringify(store));
  } else {
    res.markdown = readFile(res.mdPath) || "";
    res.full = res.fullPath ? readFile(res.fullPath) : null;
  }

  const where = sourceLabel(src);
  const minutes = Math.max(1, Math.round(res.words / 230));
  const folder = saveFolder().replace($.NSHomeDirectory().js, "~");
  const saveName = safeFileName(res.title, "md");
  const mainItem = (title, md, path, words, extraSub) => {
    const arg = largeArg(md, "md");
    return {
      title,
      subtitle: [extraSub, `${plural(words, "word")} · ${minutes} min read`, where, "↩ Copy · ⌘↩ Paste · ⌥↩ Save · ⌘Y Preview"].filter(Boolean).join(" · "),
      arg,
      valid: true,
      quicklookurl: path,
      text: textField(md),
      icon: { path: "icons/md.png" },
      mods: {
        cmd: { arg, valid: true, subtitle: "Paste the Markdown into the frontmost app" },
        alt: { arg: path, valid: true, subtitle: `Save to ${folder} and reveal in Finder`, variables: { save_name: saveName } },
      },
    };
  };
  const items = [mainItem(oneLine(res.title), res.markdown, res.mdPath, res.words, res.note || (res.via ? "Page content from the browser" : ""))];
  if (res.full) {
    const it = mainItem("Whole page, without extracting the article", res.full, res.fullPath, res.fullWords || 0, "");
    it.subtitle = `${plural(res.fullWords || 0, "word")} · keeps menus and sidebars · ↩ Copy · ⌘↩ Paste · ⌥↩ Save`;
    it.icon = { path: "icons/page.png" };
    items.push(it);
  }
  const link = `[${MD.escapeText(res.title)}](${MD.urlForMarkdown(res.url)})`;
  items.push({
    title: "Markdown link",
    subtitle: oneLine(link),
    arg: link,
    valid: true,
    text: { copy: link, largetype: link },
    icon: { path: "icons/link.png" },
    mods: { cmd: { arg: link, valid: true, subtitle: "Paste the link into the frontmost app" }, alt: { arg: link, valid: false, subtitle: "Nothing to save for a link" } },
  });
  return items;
}

// ---------- shot: full-page screenshot (the capture itself runs in snapshot.js) ----------

function shotItems(query) {
  const src = sourceURL(query, false);
  if (src.error) return [info(src.error, src.hint, src.error === "Not a URL" ? "error" : "info")];
  const width = Math.min(3840, Math.max(320, parseInt(env("shot_width", "1280"), 10) || 1280));
  const name = oneLine(src.title || hostOf(src.url), 80);
  const folder = saveFolder().replace($.NSHomeDirectory().js, "~");
  const where = sourceLabel(src);
  const row = (title, sub, icon, vars) => ({
    title,
    subtitle: sub,
    arg: src.url,
    valid: true,
    icon: { path: `icons/${icon}.png` },
    variables: Object.assign({ shot_action: "reveal" }, vars),
    mods: {
      cmd: { arg: src.url, valid: true, subtitle: "Copy the image to the clipboard", variables: Object.assign({}, vars, { shot_action: "copy" }) },
      alt: { arg: src.url, valid: true, subtitle: `Save to ${folder} and open it`, variables: Object.assign({}, vars, { shot_action: "open" }) },
    },
  });
  const loginNote = src.from === "browser" ? " · without your browser’s logins" : "";
  return [
    row(`Full page: ${name}`, [`${width} px wide`, where, `↩ Save to ${folder} · ⌘↩ Copy · ⌥↩ Open${loginNote}`].filter(Boolean).join(" · "), "shot", { shot_full: "1", shot_width: String(width) }),
    row(`First screen: ${name}`, `${width}×900 · ↩ Save · ⌘↩ Copy · ⌥↩ Open`, "screen", { shot_full: "0", shot_width: String(width) }),
    row(`Phone width: ${name}`, "390 px wide, full page · ↩ Save · ⌘↩ Copy · ⌥↩ Open", "phone", { shot_full: "1", shot_width: "390" }),
  ];
}

// ---------- code: ray.so ----------

const RAY_LANGUAGES = "cedar shell astro cpp csharp clojure console crystal css cypher dart diff dockerfile elm erb elixir erlang gleam graphql go hcl haskell html java javascript julia json jsx kotlin latex liquid lisp lua markdown matlab move nix plaintext powershell objectivec ocaml php prisma python r ruby rust scala scss solidity sql swift svelte toml typescript tsx v vue xml yaml zig".split(" ");
const LANG_ALIASES = {
  py: "python", python3: "python", js: "javascript", node: "javascript", mjs: "javascript", ts: "typescript", sh: "shell", bash: "shell",
  zsh: "shell", fish: "shell", rb: "ruby", rs: "rust", md: "markdown", yml: "yaml", kt: "kotlin", objc: "objectivec", "objective-c": "objectivec",
  c: "cpp", "c++": "cpp", h: "cpp", hpp: "cpp", cs: "csharp", "c#": "csharp", golang: "go", ps1: "powershell", pwsh: "powershell", tf: "hcl",
  terraform: "hcl", htm: "html", text: "plaintext", txt: "plaintext", plain: "plaintext", ex: "elixir", exs: "elixir", erl: "erlang",
  hs: "haskell", jl: "julia", tex: "latex", clj: "clojure", sol: "solidity", docker: "dockerfile", patch: "diff", gql: "graphql", ml: "ocaml",
  shellsession: "console", terminal: "console",
};
const RAY_THEMES = { candy: "Candy", breeze: "Breeze", midnight: "Midnight", sunset: "Sunset", raindrop: "Raindrop", crimson: "Crimson", falcon: "Falcon", meadow: "Meadow", noir: "Noir", ice: "Ice", sand: "Sand", forest: "Forest", mono: "Mono", bitmap: "Bitmap", vercel: "Vercel", supabase: "Supabase", tailwind: "Tailwind", openai: "OpenAI", mintlify: "Mintlify", prisma: "Prisma", clerk: "Clerk", elevenlabs: "ElevenLabs", resend: "Resend", triggerdev: "Trigger.dev", nuxt: "Nuxt", browserbase: "Browserbase", cloudflare: "Cloudflare", gemini: "Gemini", stripe: "Stripe", firecrawl: "Firecrawl", aws: "AWS", auth0: "Auth0" };

function languageKey(s) {
  const k = String(s || "").trim().toLowerCase();
  if (RAY_LANGUAGES.includes(k)) return k;
  return own(LANG_ALIASES, k) || null;
}

function base64URL(text) {
  const data = $(text).dataUsingEncoding($.NSUTF8StringEncoding);
  return data.base64EncodedStringWithOptions(0).js.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function tidyCode(text) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n").map((l) => l.replace(/\s+$/, ""));
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  const indents = lines.filter((l) => l.trim()).map((l) => /^[ \t]*/.exec(l)[0]);
  let common = indents.length ? indents[0] : "";
  for (const ind of indents) while (!ind.startsWith(common)) common = common.slice(0, -1);
  return lines.map((l) => l.slice(common.length)).join("\n");
}

// ray.so reads its state from the URL fragment (jotai-location atomWithHash):
// code = URL-safe Base64 of UTF-8, theme = theme key, darkMode/background = true|false, padding = 16|32|64|128, language = key.
function raySoURL(code, language) {
  const theme = own(RAY_THEMES, env("code_theme", "candy")) ? env("code_theme", "candy") : "candy";
  const padding = ["16", "32", "64", "128"].includes(env("code_padding", "64")) ? env("code_padding", "64") : "64";
  const params = [
    `theme=${theme}`,
    `background=${env("code_background", "1") === "0" ? "false" : "true"}`,
    `darkMode=${env("code_dark", "1") === "0" ? "false" : "true"}`,
    `padding=${padding}`,
  ];
  if (env("code_line_numbers", "0") === "1") params.push("lineNumbers=true");
  if (language) params.push(`language=${language}`);
  params.push(`code=${base64URL(code)}`);
  return `https://ray.so/#${params.join("&")}`;
}

const RAY_WARN_BYTES = 8 * 1024;

function codeItems(query) {
  const q = String(query || "");
  let text, language = null, source;
  const lang = !/\n/.test(q) && q.trim() && q.trim().split(/\s+/).length === 1 ? languageKey(q) : null;
  const partial = !/\n/.test(q) && /^[\w+#.-]{1,15}$/.test(q.trim()) ? q.trim().toLowerCase() : null;
  const matches = partial ? RAY_LANGUAGES.filter((k) => k.startsWith(partial)).concat(Object.keys(LANG_ALIASES).filter((a) => a.startsWith(partial)).map((a) => LANG_ALIASES[a])) : [];
  if (lang || (partial && matches.length)) {
    text = clipboard();
    language = lang;
    source = "clipboard";
  } else if (q.trim()) {
    text = q;
    source = "text";
  } else {
    text = clipboard();
    source = "clipboard";
  }
  const code = tidyCode(text || "");
  if (!code.trim()) return [info("Copy some code first", "Or select code and use the Universal Action, or type code after the keyword")];
  const lines = code.split("\n").length;
  const theme = own(RAY_THEMES, env("code_theme", "candy")) || "Candy";
  const items = [];
  const add = (lk, title) => {
    const url = raySoURL(code, lk);
    // ray.so keeps the code in the link: long links are slow to open, hard to share, and make huge images
    const warn = url.length > RAY_WARN_BYTES ? `Long code (${Math.round(url.length / 1024)} KB link): ray.so is made for snippets · ` : "";
    items.push({
      title,
      subtitle: `${warn}${plural(lines, "line")} ${source === "clipboard" ? "from the clipboard" : ""} · ${theme} · ${lk || "language auto-detected"} · ↩ Open · ⌘↩ Copy link`.replace(/ {2,}/g, " "),
      arg: url,
      valid: true,
      text: { copy: url, largetype: cutText(code, 2000) },
      quicklookurl: url,
      icon: { path: "icons/code.png" },
      mods: { cmd: { arg: url, valid: true, subtitle: "Copy the ray.so link" } },
    });
  };
  if (language) add(language, `Open in ray.so as ${language}`);
  else add(null, `Open in ray.so: ${oneLine(code.split("\n").find((l) => l.trim()) || "", 60)}`);
  if (!language && partial && matches.length) {
    items.length = 0;
    for (const k of [...new Set(matches)].slice(0, 8)) add(k, `Open in ray.so as ${k}`);
  }
  return items;
}

// ---------- ytt: YouTube transcripts ----------

function youtubeID(s) {
  const t = String(s || "").trim();
  if (/^[\w-]{11}$/.test(t)) return t;
  const m = /^(?:https?:\/\/)?(?:[\w-]+\.)?(?:youtube\.com|youtube-nocookie\.com|youtu\.be)\/(?:watch\/?\?(?:[^#]*&)?v=|embed\/|shorts\/|live\/|v\/|e\/)?([\w-]{11})(?=$|[?&#/])/i.exec(t);
  if (m && (/youtu\.be\//i.test(t) || /[?&]v=|\/(embed|shorts|live|v|e)\//i.test(t))) return m[1];
  const v = /[?&]v=([\w-]{11})(?=$|[&#])/.exec(t);
  if (v && /youtube\.com/i.test(t)) return v[1];
  return null;
}

function ytBase() {
  return env("WC_YT_BASE", "https://www.youtube.com");
}

const YT_BACKOFF = 600; // seconds without YouTube requests after a 429 or a bot check
const YT_HEADERS = ["Cookie: CONSENT=YES+cb; SOCS=CAI"]; // skip the EU consent interstitial

function timestamp(sec) {
  sec = Math.floor(sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

// Parse the timedtext formats: srv1 (<text start dur>) and srv3 (<p t d> in ms).
function parseTimedText(xml) {
  const out = [];
  // caption text is entity-encoded twice (&amp;#39;) and may carry <b>/<i>/<font> tags
  const clean = (t) => MD.decodeEntities(MD.decodeEntities(t.replace(/<[^>]*>/g, ""))).replace(/<\/?[a-z][^>]*>/gi, "").replace(/\s+/g, " ").trim();
  let m;
  const re1 = /<text\b([^>]*)>([\s\S]*?)<\/text>/g;
  while ((m = re1.exec(xml))) {
    const start = parseFloat((/\bstart="([\d.]+)"/.exec(m[1]) || [])[1] || "0");
    const dur = parseFloat((/\bdur="([\d.]+)"/.exec(m[1]) || [])[1] || "0");
    const text = clean(m[2]);
    if (text) out.push({ start, dur, text });
  }
  if (out.length) return out;
  const re3 = /<p\b([^>]*)>([\s\S]*?)<\/p>/g;
  while ((m = re3.exec(xml))) {
    const start = parseInt((/\bt="(\d+)"/.exec(m[1]) || [])[1] || "0", 10) / 1000;
    const dur = parseInt((/\bd="(\d+)"/.exec(m[1]) || [])[1] || "0", 10) / 1000;
    const text = clean(m[2]);
    if (text) out.push({ start, dur, text });
  }
  return out;
}

// Group snippets into readable paragraphs (at pauses or every ~600 characters at a sentence end).
function paragraphs(snippets) {
  const paras = [];
  let cur = null;
  snippets.forEach((s, k) => {
    if (!cur) cur = { start: s.start, text: "" };
    cur.text += (cur.text ? " " : "") + s.text;
    const next = snippets[k + 1];
    const gap = next ? next.start - (s.start + s.dur) : 0;
    const sentenceEnd = /[.!?…]["”’)\]]?$/.test(s.text);
    if (!next || (sentenceEnd && (gap > 1.5 || cur.text.length > 600)) || gap > 4 || cur.text.length > 900) {
      paras.push(cur);
      cur = null;
    }
  });
  return paras;
}

function trackName(t) {
  const n = t.name || {};
  return n.simpleText || (n.runs || []).map((r) => r.text).join("") || t.languageCode;
}

function otherTracks(tracks, chosen) {
  return tracks.filter((t) => t !== chosen).map((t) => ({ code: t.languageCode, name: trackName(t), asr: t.kind === "asr" }));
}

// Manual captions in a preferred language first, then auto-generated ones, then whatever exists.
// (Auto-translation through &tlang= is rate-limited by YouTube, so it isn't used.)
function chooseTrack(tracks, prefs, preferAuto) {
  const base = (c) => c.toLowerCase().split("-")[0];
  const manual = tracks.filter((t) => t.kind !== "asr"), auto = tracks.filter((t) => t.kind === "asr");
  for (const group of preferAuto ? [auto, manual] : [manual, auto]) {
    for (const p of prefs) {
      const exact = group.find((t) => t.languageCode.toLowerCase() === p.toLowerCase());
      if (exact) return { track: exact };
      const loose = group.find((t) => base(t.languageCode) === base(p));
      if (loose) return { track: loose };
    }
  }
  return { track: manual[0] || auto[0], fallback: true };
}

function youtubeError(status, reason, subreason) {
  const r = String(reason || "");
  const detail = [r, subreason].filter(Boolean).join(": ");
  if (/private/i.test(r)) return ["Private video", "Only its owner can see it, so there is no public transcript"];
  if (/inappropriate|\bage\b|age-restricted/i.test(r)) return ["Age-restricted video", "YouTube requires signing in for its transcript"];
  if (/not a bot|\bbot\b/i.test(r)) return ["YouTube asks to confirm you’re not a bot", "YouTube is blocking this network for now: try again in an hour, or from another network (a VPN often is blocked)"];
  if (/members/i.test(detail)) return ["Members-only video", "Only channel members can see its transcript"];
  if (status === "LOGIN_REQUIRED") return ["YouTube requires signing in", detail || "The transcript isn’t public"];
  if (/unavailable|removed|terminated|does not exist/i.test(r) || status === "ERROR") return ["Video unavailable", detail || "It may have been removed or the ID is wrong"];
  if (status === "LIVE_STREAM_OFFLINE") return ["The live stream hasn’t started", detail || "Try again once it has aired"];
  return ["YouTube can’t play this video", detail || status];
}

// Fetch the transcript: watch page → Innertube player (ANDROID client, whose caption URLs need no PO token) → timedtext.
function fetchTranscript(id, prefs, preferAuto) {
  const page = fetchURL(`${ytBase()}/watch?v=${id}&hl=en`, { headers: YT_HEADERS });
  if (page.curl) return { error: page.error };
  if (page.status === 429) return { error: "YouTube is rate-limiting this Mac (HTTP 429)", subtitle: "Try again later", backoff: true };
  if (!page.ok) return { error: httpError(page.status) };
  const html = dataToString(page.data) || "";
  if (/class="g-recaptcha"/.test(html)) return { error: "YouTube asks to confirm you’re not a bot", subtitle: "YouTube is blocking this network for now: try again in an hour, or from another network", backoff: true };
  if (/action="https:\/\/consent\.youtube\.com\/s"/.test(html)) {
    return { error: "YouTube shows its cookie consent page", subtitle: "Open youtube.com in your browser once and accept or reject cookies, then try again" };
  }
  const key = (/"INNERTUBE_API_KEY":\s*"([\w-]+)"/.exec(html) || [])[1];
  if (!key) return { error: "Could not read the YouTube page", subtitle: "YouTube may have changed its page: check for a Web Capture update" };
  const player = fetchURL(`${ytBase()}/youtubei/v1/player?key=${encodeURIComponent(key)}&prettyPrint=false`, {
    json: { context: { client: { clientName: "ANDROID", clientVersion: "20.10.38", hl: "en" } }, videoId: id },
    accept: "application/json",
    headers: YT_HEADERS,
    ua: "com.google.android.youtube/20.10.38 (Linux; U; Android 14) gzip",
  });
  if (player.curl) return { error: player.error };
  if (player.status === 429) return { error: "YouTube is rate-limiting this Mac (HTTP 429)", subtitle: "Try again later", backoff: true };
  if (!player.ok) return { error: httpError(player.status) };
  let data;
  try {
    data = JSON.parse(dataToString(player.data) || "");
  } catch (e) {
    return { error: "Unexpected answer from YouTube" };
  }
  const ps = data.playabilityStatus || {};
  const details = data.videoDetails || {};
  const ogTitle = (/<meta property="og:title" content="([^"]*)"/.exec(html) || [])[1];
  const meta = {
    id,
    title: details.title || (ogTitle ? MD.decodeEntities(ogTitle) : id), // videoDetails is plain text, og:title is HTML
    channel: details.author || "",
    seconds: parseInt(details.lengthSeconds, 10) || 0,
  };
  if (ps.status && ps.status !== "OK") {
    const sub = ((((ps.errorScreen || {}).playerErrorMessageRenderer || {}).subreason || {}).runs || []).map((x) => x.text || "").join("");
    const [error, subtitle] = youtubeError(ps.status, ps.reason, sub);
    return { error, subtitle, meta, backoff: /not a bot/.test(error) };
  }
  const tracks = (((data.captions || {}).playerCaptionsTracklistRenderer || {}).captionTracks || []).filter((t) => t.baseUrl);
  if (!tracks.length) return { error: "No transcript: this video has no captions", subtitle: meta.title, meta };
  const choice = chooseTrack(tracks, prefs, preferAuto);
  // Caption URLs marked "exp=xpe" need a proof-of-origin token that only a real YouTube player can make
  // (youtube-transcript-api reports these as PoTokenRequired); they return an empty document.
  if (/[?&]exp=xpe\b/.test(choice.track.baseUrl)) {
    return { error: "YouTube hides these captions from scripts", subtitle: "They need a token only the YouTube player can make: try again later, or copy the transcript from YouTube’s “Show transcript” panel", meta, others: otherTracks(tracks, choice.track) };
  }
  let url = choice.track.baseUrl.replace(/&fmt=[^&]*/g, "");
  if (!/^https?:\/\//.test(url)) url = ytBase() + url;
  const tt = fetchURL(url, { headers: YT_HEADERS, accept: "*/*" });
  if (tt.curl) return { error: tt.error, meta };
  if (!tt.ok) return { error: tt.status === 429 ? "YouTube is rate-limiting this Mac (HTTP 429)" : httpError(tt.status), meta, backoff: tt.status === 429 };
  const snippets = parseTimedText(dataToString(tt.data) || "");
  if (!snippets.length) {
    return { error: "The transcript is empty", subtitle: `YouTube returned no caption text${tracks.length > 1 ? ": pick another language below" : ": try again later"}`, meta, others: otherTracks(tracks, choice.track) };
  }
  let label = trackName(choice.track);
  if (choice.track.kind === "asr" && !/auto/i.test(label)) label += " (auto-generated)";
  if (choice.fallback) label = `No ${prefs.join("/")} captions: ${label}`;
  return {
    meta,
    language: choice.track.languageCode,
    label,
    generated: choice.track.kind === "asr",
    snippets,
    others: otherTracks(tracks, choice.track),
  };
}

function watchURL(id, t) {
  return `https://www.youtube.com/watch?v=${id}${t ? `&t=${Math.floor(t)}s` : ""}`;
}

function transcriptTexts(r) {
  const paras = paragraphs(r.snippets);
  const plain = paras.map((p) => p.text).join("\n\n");
  const stamped = r.snippets.map((s) => `[${timestamp(s.start)}] ${s.text}`).join("\n");
  const header = [r.meta.title, r.meta.channel ? `${r.meta.channel} · ${watchURL(r.meta.id)}` : watchURL(r.meta.id)].join("\n");
  const txt = `${header}\n\n${paras.map((p) => `[${timestamp(p.start)}] ${p.text}`).join("\n\n")}\n`;
  const fm = ["---", `title: ${MD.yamlString(r.meta.title)}`, `url: ${MD.yamlString(watchURL(r.meta.id))}`];
  if (r.meta.channel) fm.push(`channel: ${MD.yamlString(r.meta.channel)}`);
  if (r.meta.seconds) fm.push(`duration: ${MD.yamlString(timestamp(r.meta.seconds))}`);
  fm.push(`language: ${MD.yamlString(r.language)}`, `captured: ${today()}`, "---");
  const md = `${fm.join("\n")}\n\n# ${MD.escapeText(r.meta.title)}\n\n${paras.map((p) => `[${timestamp(p.start)}](${watchURL(r.meta.id, p.start)}) ${MD.escapeText(p.text)}`).join("\n\n")}\n`;
  return { plain, stamped, txt, md, words: countWords(plain) };
}

// Is the Local AI workflow installed? Looks for its bundle id in Alfred's workflow folders (cached 10 min).
const LOCAL_AI = "io.github.x-o-r-r-o.local-ai";
const LOCAL_AI_TRIGGER = "summarize";
// Alfred hands the argument to Local AI's script as argv, and macOS caps argv + environment at 1 MB
// (ARG_MAX): 150,000 characters are at most ~450 KB of UTF-8. Local AI itself keeps 200,000 characters.
const HANDOFF_MAX = 150000;
function capHandoff(text) {
  if (text.length <= HANDOFF_MAX) return text;
  let cut = text.slice(0, HANDOFF_MAX);
  if (/[\ud800-\udbff]$/.test(cut)) cut = cut.slice(0, -1); // never split an emoji
  const para = cut.lastIndexOf("\n\n");
  return `${para > HANDOFF_MAX * 0.8 ? cut.slice(0, para) : cut}\n\n[Transcript truncated: the rest was too long to hand over]`;
}
function localAIInstalled() {
  const fake = env("WC_TEST_LOCAL_AI", null);
  if (fake !== null) return fake === "1";
  const prefs = env("alfred_preferences", "");
  if (!prefs) return false;
  const cache = `${cacheDir()}/local-ai.txt`;
  if (ageSeconds(cache) < 600) return readFile(cache) === "1";
  let found = false;
  const dir = `${prefs}/workflows`;
  const list = FM.contentsOfDirectoryAtPathError(dir, $());
  if (!list.isNil()) {
    for (let i = 0; i < list.count && !found; i++) {
      const plist = $.NSDictionary.dictionaryWithContentsOfFile(`${dir}/${list.objectAtIndex(i).js}/info.plist`);
      if (plist.isNil() || plist.objectForKey("bundleid").isNil() || plist.objectForKey("bundleid").js !== LOCAL_AI) continue;
      // it must also have the External Trigger we call
      const objects = ObjC.deepUnwrap(plist.objectForKey("objects")) || [];
      found = objects.some((o) => o.type === "alfred.workflow.trigger.external" && o.config && o.config.triggerid === LOCAL_AI_TRIGGER);
    }
  }
  writeFile(cache, found ? "1" : "0");
  return found;
}

function yttItems(query) {
  const tokens = String(query || "").trim().split(/\s+/).filter(Boolean);
  let urlToken = null, lang = null, preferAuto = false;
  const rest = [];
  for (const t of tokens) {
    if (t.toLowerCase() === "auto") preferAuto = true;
    else if (!urlToken && (youtubeID(t) && (/[./]/.test(t) || /\d|_|-|[A-Z]/.test(t)) || asURL(t))) urlToken = t;
    else if (!lang && /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/i.test(t)) lang = t;
    else rest.push(t);
  }
  if (rest.length) return [info("Type a YouTube URL and an optional language code", "Like: ytt https://youtu.be/… es · or leave it empty to use the frontmost tab", "error")];
  let src;
  if (urlToken) {
    const id = youtubeID(urlToken);
    src = id ? { url: watchURL(id), from: "query" } : sourceURL(urlToken, false);
  } else src = sourceURL("", false);
  if (src.error) return [info(src.error === "No web page" ? "No YouTube video" : src.error, src.hint)];
  const id = youtubeID(src.url);
  if (!id) {
    return [info("Not a YouTube video", `${src.from === "browser" ? `The ${src.browser} tab` : "The URL"} isn’t a YouTube video: ${oneLine(src.url, 70)}`, "error")];
  }
  const prefs = lang ? [lang] : env("ytt_language", "en").split(/[,\s]+/).filter(Boolean);
  if (!prefs.length) prefs.push("en");
  const key = hashKey(`${id}|${prefs.join(",")}|${preferAuto ? "a" : ""}`);
  const cachePath = `${cacheDir()}/yt-${key}.json`;
  let r = null;
  if (ageSeconds(cachePath) < 6 * 3600) {
    try {
      r = JSON.parse(readFile(cachePath));
    } catch (e) {
      r = null;
    }
  }
  // After a 429 or a bot check, every process waits before asking YouTube again: Script Filters run on
  // each keystroke, and retrying at once only prolongs the block.
  const backoffPath = `${cacheDir()}/yt-backoff.json`;
  const waited = ageSeconds(backoffPath);
  if (!r && waited < YT_BACKOFF) {
    try {
      const b = JSON.parse(readFile(backoffPath));
      const mins = Math.max(1, Math.ceil((YT_BACKOFF - waited) / 60));
      r = { error: String(b.error || "YouTube is rate-limiting this Mac"), subtitle: `Web Capture waits ${plural(mins, "more minute")} before asking YouTube again` };
    } catch (e) {
      r = null;
    }
  }
  if (!r) {
    r = fetchTranscript(id, prefs, preferAuto);
    if (!r.error) writeFile(cachePath, JSON.stringify(r));
    else if (r.backoff) writeFile(backoffPath, JSON.stringify({ error: r.error }));
  }
  // other caption languages, offered below the transcript (or below an error about the chosen one)
  const languageRows = () => {
    const rows = [], seen = new Set();
    for (const o of r.others || []) {
      const k = `${o.code}|${o.asr}`;
      if (seen.has(k)) continue;
      seen.add(k);
      rows.push({
        title: `${oneLine(o.name, 80)}${o.asr && !/auto/i.test(o.name) ? " (auto-generated)" : ""}`,
        subtitle: `Show the ${oneLine(o.code, 20)} transcript${o.asr ? " (auto-generated)" : ""}`,
        autocomplete: `${urlToken || (src.from === "browser" ? "" : src.url)} ${o.code}${o.asr ? " auto" : ""}`.trim() + " ",
        valid: false,
        icon: { path: "icons/lang.png" },
      });
    }
    return rows;
  };
  if (r.error) return [info(r.error, r.subtitle || (r.meta ? r.meta.title : watchURL(id)), "error")].concat(languageRows());

  const t = transcriptTexts(r);
  const format = env("ytt_save_format", "md") === "txt" ? "txt" : "md";
  const dir = mkdirs(`${cacheDir()}/yt-${key}`);
  const savePath = `${dir}/${safeFileName(`${r.meta.title} transcript`, format)}`;
  writeFile(savePath, format === "md" ? t.md : t.txt);
  const plainArg = largeArg(t.plain, "yt");
  const stampedArg = largeArg(t.stamped, "yts");
  const ai = localAIInstalled();
  const handoff = largeArg(capHandoff(`${r.meta.title}\n${watchURL(id)}\n\n${t.plain}`), "yth");
  const folder = saveFolder().replace($.NSHomeDirectory().js, "~");
  const items = [{
    title: oneLine(r.meta.title),
    subtitle: `${r.label} · ${plural(t.words, "word")}${r.meta.seconds ? ` · ${timestamp(r.meta.seconds)}` : ""} · ↩ Copy · ⌘↩ Paste · ⇧↩ With timestamps · ⌥↩ Save${ai ? " · ⌃↩ Summarize" : ""}`,
    arg: plainArg,
    valid: true,
    quicklookurl: savePath,
    text: textField(t.plain),
    icon: { path: "icons/ytt.png" },
    mods: {
      cmd: { arg: plainArg, valid: true, subtitle: "Paste the transcript into the frontmost app" },
      shift: { arg: stampedArg, valid: true, subtitle: "Copy with a timestamp on every line" },
      alt: { arg: savePath, valid: true, subtitle: `Save as .${format} to ${folder} and reveal in Finder`, variables: { save_name: safeFileName(`${r.meta.title} transcript`, format) } },
      ctrl: ai
        ? { arg: handoff, valid: true, subtitle: "Summarize with the Local AI workflow" }
        : { arg: handoff, valid: false, subtitle: "Install the Local AI workflow to summarize transcripts" },
    },
  }];
  return items.concat(languageRows());
}

// ---------- actions ----------

function insideCache(path) {
  const cache = $(cacheDir()).stringByStandardizingPath.js.replace(/\/+$/, "");
  const p = $(path).stringByStandardizingPath.js;
  return p.startsWith(cache + "/") && !p.includes("/../");
}

function revealOrReport(path, message) {
  if (env("WC_TEST_NO_UI", "") === "1") return `${message}: ${path}`;
  $.NSWorkspace.sharedWorkspace.activateFileViewerSelectingURLs($([$.NSURL.fileURLWithPath(path)]));
  return message;
}

// ⌥↩: copy a prepared file from the cache to the save folder.
function saveAction(arg) {
  const path = String(arg || "").replace(/^wcfile:/, "");
  if (!insideCache(path) || !exists(path)) return "Nothing to save";
  const dir = mkdirs(saveFolder());
  const name = safeFileName((env("save_name", "") || path.split("/").pop()).replace(/\.(md|txt)$/i, ""), (/\.(md|txt)$/i.exec(path) || [, "md"])[1]);
  let target = `${dir}/${name}`, n = 2;
  while (exists(target)) target = `${dir}/${name.replace(/\.(\w+)$/, ` ${n++}.$1`)}`;
  const err = Ref();
  if (!FM.copyItemAtPathToPathError(path, target, err)) return `Could not save to ${dir}`;
  return revealOrReport(target, `Saved ${name}`);
}

function resolveArg(arg) {
  const a = String(arg || "");
  if (a.startsWith("wcfile:")) {
    const p = a.slice(7);
    return insideCache(p) ? readFile(p) || "" : "";
  }
  return a;
}

// ⌃↩: hand the transcript to the Local AI workflow through its External Trigger.
function handoffAction(arg) {
  const text = capHandoff(resolveArg(arg));
  if (!text.trim()) return "Nothing to summarize";
  const log = env("WC_TEST_HANDOFF", ""); // tests record the call instead of calling Alfred
  if (!localAIInstalled()) return "Install the Local AI workflow to summarize transcripts";
  if (log) {
    writeFile(log, JSON.stringify({ trigger: LOCAL_AI_TRIGGER, workflow: LOCAL_AI, argument: text }));
    return undefined; // success prints nothing: "" still printed a newline, a blank notification
  }
  try {
    const alfred = Application("com.runningwithcrayons.Alfred");
    alfred.runTrigger(LOCAL_AI_TRIGGER, { inWorkflow: LOCAL_AI, withArgument: text });
    return undefined;
  } catch (e) {
    return `Could not reach the Local AI workflow: ${oneLine(String(e.message || e), 80)}`;
  }
}

// ---------- entry ----------

function run(argv) {
  const [cmd, ...rest] = argv;
  const query = rest.join(" ");
  try {
    switch (cmd) {
      case "tomd": pruneCache(); return output(tomdItems(query));
      case "shot": return output(shotItems(query));
      case "code": return output(codeItems(query));
      case "ytt": pruneCache(); return output(yttItems(query));
      case "save": return saveAction(query);
      case "handoff": return handoffAction(query);
      case "convert": { // developer/test helper: convert <html file> <url> [full]
        const html = readFile(rest[0]);
        if (html === null) return "No such file";
        return MD.htmlToMarkdown(html, { url: rest[1] || "https://example.com/", frontMatter: env("tomd_front_matter", "1") !== "0", extract: rest[2] !== "full", captured: "2026-01-01", images: env("tomd_images", "1") !== "0" }).markdown;
      }
      default: return output([info(`Unknown command: ${cmd}`, "", "error")]);
    }
  } catch (e) {
    const msg = String(e && e.message ? e.message : e);
    if (cmd === "save" || cmd === "handoff") return `Web Capture error: ${msg}`;
    return output([info("Web Capture error", msg, "error")]);
  }
}
