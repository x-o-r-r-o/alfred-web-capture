#!/usr/bin/osascript -l JavaScript
// Web Capture: full-page screenshots with the WebKit that ships with macOS (no browser or binary needed).
// Usage: osascript -l JavaScript snapshot.js <url>
// Settings come from the environment (Workflow Configuration and the Script Filter's variables):
//   shot_action   reveal | open | copy        what to do with the PNG
//   shot_width    viewport width in points    (default 1280)
//   shot_full     1 = full page, 0 = first screen only
//   shot_scale    auto | 1 | 2                 pixel density of the PNG
//   shot_max_height  cap for very long pages, in points (default 20000)
//   save_folder   where PNGs are saved (default ~/Downloads)
// Prints one line for Alfred's notification.
ObjC.import("Foundation");
ObjC.import("AppKit");
ObjC.import("WebKit");

const ENV = $.NSProcessInfo.processInfo.environment;
function env(name, fallback) {
  const v = ENV.objectForKey(name);
  return v.isNil() || v.js === "" ? fallback : v.js;
}
function num(name, fallback, min, max) {
  const n = parseInt(env(name, ""), 10);
  return isNaN(n) ? fallback : Math.min(max, Math.max(min, n));
}

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
const VIEWPORT_H = 900;

function expandHome(p) {
  return p.replace(/^~(?=\/|$)/, $.NSHomeDirectory().js);
}

function pad(n) {
  return String(n).padStart(2, "0");
}

function fileName(url) {
  let host = "page";
  const m = url.match(/^https?:\/\/(?:www\.)?([^/:?#]+)/i);
  if (m) host = m[1];
  const d = new Date();
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} at ${pad(d.getHours())}.${pad(d.getMinutes())}.${pad(d.getSeconds())}`;
  return `${host.replace(/[^\w.-]+/g, "-")} ${stamp}.png`;
}

function uniquePath(dir, name) {
  const fm = $.NSFileManager.defaultManager;
  let p = `${dir}/${name}`, i = 2;
  while (fm.fileExistsAtPath(p)) p = `${dir}/${name.replace(/\.png$/, "")} ${i++}.png`;
  return p;
}

const runLoop = $.NSRunLoop.currentRunLoop;
function spin(seconds) {
  runLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(seconds));
}

// Evaluate a constant JS expression in the page and wait for the result (never user data in the source).
function evaluate(wv, source, timeout = 5) {
  let done = false, result = null;
  wv.evaluateJavaScriptCompletionHandler(source, (r, e) => {
    try {
      result = e && !e.isNil() ? null : r && !r.isNil() ? r.js : null;
    } catch (x) {
      result = null;
    }
    done = true;
  });
  const end = Date.now() + timeout * 1000;
  while (!done && Date.now() < end) spin(0.02);
  return result;
}

// Navigation delegate: records failures (DNS, TLS, offline) so we can report them.
let navError = null, navFinished = false;
ObjC.registerSubclass({
  name: "WCNavigationDelegate",
  protocols: ["WKNavigationDelegate"],
  methods: {
    "webView:didFinishNavigation:": { types: ["void", ["id", "id"]], implementation: () => { navFinished = true; } },
    "webView:didFailNavigation:withError:": {
      types: ["void", ["id", "id", "id"]],
      implementation: (w, n, e) => { if (e.code !== -999) navError = e.localizedDescription.js; },
    },
    "webView:didFailProvisionalNavigation:withError:": {
      types: ["void", ["id", "id", "id"]],
      implementation: (w, n, e) => { if (e.code !== -999) navError = e.localizedDescription.js; },
    },
  },
});

function capture(url, opts) {
  $.NSApplication.sharedApplication.setActivationPolicy($.NSApplicationActivationPolicyProhibited);
  const W = opts.width;
  const cfg = $.WKWebViewConfiguration.alloc.init;
  cfg.websiteDataStore = $.WKWebsiteDataStore.nonPersistentDataStore; // no cookies or cache left behind
  const frame = $.NSMakeRect(0, 0, W, VIEWPORT_H);
  const wv = $.WKWebView.alloc.initWithFrameConfiguration(frame, cfg);
  wv.customUserAgent = UA;
  const delegate = $.WCNavigationDelegate.alloc.init;
  wv.navigationDelegate = delegate;
  // An off-screen, borderless window gives WebKit a real backing store to draw into.
  const win = $.NSWindow.alloc.initWithContentRectStyleMaskBackingDefer($.NSMakeRect(-30000, -30000, W, VIEWPORT_H), 0, $.NSBackingStoreBuffered, false);
  win.contentView = wv;
  win.orderBack($());
  const nsurl = $.NSURL.URLWithString(url);
  if (nsurl.isNil()) return { error: "Invalid URL" };
  wv.loadRequest($.NSURLRequest.requestWithURLCachePolicyTimeoutInterval(nsurl, 0, opts.timeout));

  const deadline = Date.now() + opts.timeout * 1000;
  while (!navFinished && !navError && Date.now() < deadline) spin(0.05);
  if (navError) return { error: navError };
  if (!navFinished && wv.isLoading) return { error: `The page did not finish loading within ${opts.timeout} s` };
  // Let late scripts, web fonts and images settle.
  for (let i = 0; i < 40 && evaluate(wv, "document.readyState") !== "complete"; i++) spin(0.1);
  evaluate(wv, "document.fonts ? document.fonts.status : 'loaded'");
  spin(0.6);

  const measure = "Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0, document.documentElement.offsetHeight)";
  let height = VIEWPORT_H;
  if (opts.full) {
    // Scroll through the page once so lazy-loaded images appear.
    let h = Number(evaluate(wv, measure)) || VIEWPORT_H;
    for (let y = 0; y < Math.min(h, opts.maxHeight); y += VIEWPORT_H * 0.8) {
      evaluate(wv, `window.scrollTo(0, ${Math.round(y)})`);
      spin(0.12);
      h = Number(evaluate(wv, measure)) || h;
    }
    evaluate(wv, "window.scrollTo(0, 0)");
    spin(0.4);
    height = Math.min(Math.max(h, VIEWPORT_H), opts.maxHeight);
    win.setContentSize($.NSMakeSize(W, height));
    wv.setFrame($.NSMakeRect(0, 0, W, height));
    spin(0.5);
    // Pages sized in vh units grow with the view: measure once more, but never chase them.
    const h2 = Number(evaluate(wv, measure)) || height;
    if (h2 > height && h2 < height * 1.25) {
      height = Math.min(h2, opts.maxHeight);
      win.setContentSize($.NSMakeSize(W, height));
      wv.setFrame($.NSMakeRect(0, 0, W, height));
      spin(0.4);
    }
  }
  const title = evaluate(wv, "document.title") || "";

  const backing = Number(win.backingScaleFactor) || 1;
  const scale = opts.scale === "auto" ? backing : Number(opts.scale) || 1;
  const sc = $.WKSnapshotConfiguration.alloc.init;
  sc.rect = $.NSMakeRect(0, 0, W, height);
  sc.snapshotWidth = $.NSNumber.numberWithDouble((W * scale) / backing);
  let image = null, failure = null, done = false;
  wv.takeSnapshotWithConfigurationCompletionHandler(sc, (img, e) => {
    image = img;
    failure = e && !e.isNil() ? e.localizedDescription.js : null;
    done = true;
  });
  const end = Date.now() + 60000;
  while (!done && Date.now() < end) spin(0.05);
  if (!done) return { error: "WebKit did not return a snapshot" };
  if (!image || image.isNil()) return { error: failure || "WebKit returned an empty snapshot" };
  const rep = $.NSBitmapImageRep.imageRepWithData(image.TIFFRepresentation);
  if (rep.isNil()) return { error: "Could not encode the snapshot" };
  const png = rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $());
  return { png, width: Number(rep.pixelsWide), height: Number(rep.pixelsHigh), title, capped: height >= opts.maxHeight };
}

function copyImage(png, path) {
  const name = env("WC_TEST_PASTEBOARD", ""); // tests use a private pasteboard
  const pb = name ? $.NSPasteboard.pasteboardWithName(name) : $.NSPasteboard.generalPasteboard;
  pb.clearContents;
  const img = $.NSImage.alloc.initWithData(png);
  pb.writeObjects($([img, $.NSURL.fileURLWithPath(path)]));
  pb.setDataForType(png, $.NSPasteboardTypePNG);
}

function run(argv) {
  const url = argv[0] || "";
  if (!/^https?:\/\/\S+$/i.test(url)) return "Screenshot failed: not an http(s) URL";
  const action = env("shot_action", "reveal");
  const opts = {
    width: num("shot_width", 1280, 320, 3840),
    full: env("shot_full", "1") !== "0",
    scale: ["1", "2", "3"].includes(env("shot_scale", "auto")) ? env("shot_scale", "auto") : "auto",
    maxHeight: num("shot_max_height", 20000, 1000, 60000),
    timeout: num("fetch_timeout", 30, 5, 120) + 10,
  };
  let r;
  try {
    r = capture(url, opts);
  } catch (e) {
    r = { error: String(e && e.message ? e.message : e) };
  }
  if (r.error) return `Screenshot failed: ${r.error}`;

  const fm = $.NSFileManager.defaultManager;
  let dir;
  if (action === "copy") {
    dir = env("alfred_workflow_cache", `${$.NSTemporaryDirectory().js}web-capture`);
  } else {
    dir = expandHome(env("save_folder", "~/Downloads"));
  }
  fm.createDirectoryAtPathWithIntermediateDirectoriesAttributesError(dir, true, $(), $());
  const path = uniquePath(dir, action === "copy" ? "screenshot.png" : fileName(url));
  if (action === "copy" && fm.fileExistsAtPath(`${dir}/screenshot.png`)) fm.removeItemAtPathError(`${dir}/screenshot.png`, $());
  const target = action === "copy" ? `${dir}/screenshot.png` : path;
  if (!r.png.writeToFileAtomically(target, true)) return `Screenshot failed: could not write to ${dir}`;

  const note = r.capped ? " (cut at the maximum height)" : "";
  const size = `${r.width}×${r.height}`;
  if (env("WC_TEST_NO_UI", "") === "1") return `OK ${target} ${size}${note}`;
  if (action === "copy") {
    copyImage(r.png, target);
    return `Screenshot copied · ${size}${note}`;
  }
  const ws = $.NSWorkspace.sharedWorkspace;
  if (action === "open") ws.openURL($.NSURL.fileURLWithPath(target));
  else ws.activateFileViewerSelectingURLs($([$.NSURL.fileURLWithPath(target)]));
  return `Screenshot saved · ${size}${note}`;
}
