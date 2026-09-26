#!/usr/bin/env python3
"""End-to-end tests: run the Script Filters and actions the way Alfred does, against a local mock
HTTP server (web pages and YouTube), with the browser tab and clipboard stubbed via the environment.

    python3 tests/test_webcapture.py          # offline suite
    WC_LIVE=1 python3 tests/test_webcapture.py  # also hit the real web (example.com, YouTube)
"""
import base64, json, os, plistlib, re, shutil, struct, subprocess, sys, tempfile, threading, time, unittest, zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "src")
FIX = os.path.join(ROOT, "tests", "fixtures")
TMP = tempfile.mkdtemp(prefix="webcapture-test-")
CACHE = os.path.join(TMP, "cache")
SAVE = os.path.join(TMP, "saved")
LIVE = os.environ.get("WC_LIVE") == "1"


def fixture(name, mode="r"):
    with open(os.path.join(FIX, name), mode) as f:
        return f.read()


# ---------- mock server ----------

REQUESTS = []
CYRILLIC = "Привет, мир! Это статья о кофе и чае, написанная в кодировке Windows-1251. " * 5


def big_page():
    paras = "".join(f"<p>Paragraph {i}: the quick brown fox jumps over the lazy dog, again and again, number {i}.</p>" for i in range(3000))
    return f"<html><head><title>Big page</title></head><body><article><h1>Big page</h1>{paras}</article></body></html>"


def png_bytes():
    raw = b"\x00\xff\x00\x00"
    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def send(self, code, body, ctype="text/html; charset=utf-8", headers=None):
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        self.route("GET", b"")

    def do_POST(self):
        n = int(self.headers.get("Content-Length", "0"))
        self.route("POST", self.rfile.read(n))

    def route(self, method, body):
        u = urlparse(self.path)
        q = parse_qs(u.query)
        REQUESTS.append({"method": method, "path": u.path, "query": q, "headers": dict(self.headers), "body": body})
        p = u.path
        base = f"http://127.0.0.1:{self.server.server_address[1]}"
        if p == "/blog/coffee":
            return self.send(200, fixture("article.html"))
        if p == "/old-link":
            return self.send(301, "", headers={"Location": "/blog/coffee"})
        if p == "/edge":
            return self.send(200, fixture("edge.html"))
        if p == "/spa":
            return self.send(200, fixture("spa.html"))
        if p == "/cp1251":
            html = f'<html><head><meta charset="windows-1251"><title>Кофе</title></head><body><article><h1>Кофе</h1><p>{CYRILLIC}</p></article></body></html>'
            return self.send(200, html.encode("cp1251"), "text/html")
        if p == "/latin1":
            html = "<html><head><title>Caf\xe9</title></head><body><article><p>Caf\xe9 cr\xe8me \u2014 d\xe9j\xe0 vu. " + "Plenty of words to make this an article worth reading. " * 10 + "</p></article></body></html>"
            return self.send(200, html.encode("cp1252"), "text/html; charset=ISO-8859-1")
        if p == "/forbidden":
            return self.send(403, "<h1>Forbidden</h1>")
        if p == "/missing":
            return self.send(404, "<h1>Not found</h1>")
        if p == "/busy":
            return self.send(429, "slow down")
        if p == "/broken":
            return self.send(500, "oops")
        if p == "/doc.pdf":
            return self.send(200, b"%PDF-1.4\n%fake", "application/pdf")
        if p == "/pic.png":
            return self.send(200, png_bytes(), "image/png")
        if p == "/notes.txt":
            return self.send(200, "# Notes\n\nPlain *markdown* text\n", "text/plain; charset=utf-8")
        if p == "/data.json":
            return self.send(200, '{"a": [1, 2], "code": "```"}', "application/json")
        if p == "/empty":
            return self.send(200, "")
        if p == "/big":
            return self.send(200, big_page())
        if p == "/slow":
            time.sleep(6)
            return self.send(200, "<p>late</p>")
        if p == "/redirect-loop":
            return self.send(302, "", headers={"Location": "/redirect-loop"})
        if p == "/shot":
            return self.send(200, '<html><body style="margin:0"><div style="height:2500px;background:linear-gradient(red,blue)">Tall</div></body></html>')
        # --- YouTube ---
        if p == "/watch":
            vid = q.get("v", [""])[0]
            if vid == "botcheck001":
                return self.send(200, '<form><div class="g-recaptcha"></div></form>')
            if vid == "layoutchng1":
                return self.send(200, "<html>new layout</html>")
            return self.send(200, fixture("yt_watch.html"))
        if p == "/youtubei/v1/player":
            vid = json.loads(body or b"{}").get("videoId", "")
            files = {"okvideo0001": "yt_player_ok.json", "nocaptions1": "yt_player_nocaptions.json", "private0001": "yt_player_private.json",
                     "agerestrict": "yt_player_age.json", "unavailabl1": "yt_player_unavailable.json", "botreason01": "yt_player_bot.json"}
            if vid == "ratelimit01":
                return self.send(429, "{}", "application/json")
            if vid == "emptytrack1":
                data = json.loads(fixture("yt_player_ok.json").replace("{BASE}", base).replace("lang=en&fmt", "lang=empty&fmt"))
                return self.send(200, json.dumps(data), "application/json")
            return self.send(200, fixture(files.get(vid, "yt_player_unavailable.json")).replace("{BASE}", base), "application/json")
        if p == "/api/timedtext":
            lang, kind = q.get("lang", [""])[0], q.get("kind", [""])[0]
            if "fmt" in q:
                return self.send(200, "", "text/xml")  # the srv3 URL must not be used verbatim
            if lang == "empty":
                return self.send(200, "", "text/xml")
            if kind == "asr":
                return self.send(200, fixture("yt_timedtext_asr.xml"), "text/xml")
            if lang == "de-DE":
                return self.send(200, fixture("yt_timedtext_de.xml"), "text/xml")
            return self.send(200, fixture("yt_timedtext_en.xml"), "text/xml")
        return self.send(404, "no route")


SERVER = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
threading.Thread(target=SERVER.serve_forever, daemon=True).start()
BASE = f"http://127.0.0.1:{SERVER.server_address[1]}"


# ---------- helpers ----------

def base_env(**extra):
    e = {k: v for k, v in os.environ.items() if not k.startswith(("WC_", "alfred_", "tomd_", "shot_", "code_", "ytt_", "save_"))}
    e.update(alfred_workflow_cache=CACHE, save_folder=SAVE, WC_TEST_TAB="none", WC_TEST_CLIPBOARD="", WC_TEST_NO_UI="1",
             WC_YT_BASE=BASE, WC_TEST_LOCAL_AI="0")
    e.update({k: str(v) for k, v in extra.items()})
    return e


def run(script, args, **env):
    out = subprocess.run(["osascript", "-l", "JavaScript", script, *args], cwd=SRC, env=base_env(**env), capture_output=True, text=True, timeout=120)
    assert out.returncode == 0, out.stderr
    return out.stdout


def sf(cmd, query="", **env):
    data = json.loads(run("./webcapture.js", [cmd, query], **env))
    validate(data)
    return data["items"]


def validate(data):
    assert isinstance(data.get("items"), list)
    assert data["items"], "no items"
    for it in data["items"]:
        assert isinstance(it.get("title"), str) and it["title"], it
        if "icon" in it:
            assert os.path.exists(os.path.join(SRC, it["icon"]["path"])), it["icon"]
        if it.get("valid", True) is not False:
            assert "arg" in it, it
        for m in (it.get("mods") or {}).values():
            assert "subtitle" in m and "arg" in m, m


def resolve(arg):
    out = subprocess.run(["./resolve.sh", arg], cwd=SRC, env=base_env(), capture_output=True, text=True)
    return out.stdout


def clear_cache():
    shutil.rmtree(CACHE, ignore_errors=True)


def requests_to(path):
    return [r for r in REQUESTS if r["path"] == path]


def tab(url, title="Tab", browser="Safari", **kw):
    return json.dumps(dict(url=url, title=title, browser=browser, kind="safari", **kw))


def md_of(items):
    return resolve(items[0]["arg"])


# ---------- tests ----------

class SourceTests(unittest.TestCase):
    def setUp(self):
        clear_cache()

    def test_query_url_wins(self):
        it = sf("shot", f"{BASE}/blog/coffee", WC_TEST_TAB=tab("https://other.example/"))
        self.assertEqual(it[0]["arg"], f"{BASE}/blog/coffee")

    def test_frontmost_tab(self):
        it = sf("shot", "", WC_TEST_TAB=tab("https://example.com/page", "Example “Page”", "Arc"))
        self.assertEqual(it[0]["arg"], "https://example.com/page")
        self.assertIn("from Arc", it[0]["subtitle"])
        self.assertIn("Example “Page”", it[0]["title"])

    def test_unscriptable_browser_falls_back_to_clipboard(self):
        t = json.dumps({"kind": "none", "browser": "Firefox"})
        it = sf("shot", "", WC_TEST_TAB=t, WC_TEST_CLIPBOARD="  https://example.org/x  ")
        self.assertEqual(it[0]["arg"], "https://example.org/x")
        self.assertIn("from the clipboard", it[0]["subtitle"])
        it = sf("shot", "", WC_TEST_TAB=t, WC_TEST_CLIPBOARD="not a url")
        self.assertEqual(it[0]["title"], "No web page")
        self.assertIn("Firefox", it[0]["subtitle"])

    def test_non_web_tab_uses_clipboard(self):
        it = sf("shot", "", WC_TEST_TAB=tab("chrome://newtab/", browser="Google Chrome"), WC_TEST_CLIPBOARD="https://example.net/")
        self.assertEqual(it[0]["arg"], "https://example.net/")

    def test_no_source(self):
        it = sf("tomd", "")
        self.assertEqual(it[0]["title"], "No web page")
        self.assertIs(it[0]["valid"], False)

    def test_not_a_url(self):
        it = sf("tomd", "hello world")
        self.assertEqual(it[0]["title"], "Not a URL")

    def test_bare_domain_gets_https(self):
        self.assertEqual(sf("shot", "example.com/path?q=1")[0]["arg"], "https://example.com/path?q=1")
        self.assertEqual(sf("shot", "localhost:8080/app")[0]["arg"], "http://localhost:8080/app")

    def test_file_and_other_schemes_rejected(self):
        self.assertEqual(sf("tomd", "file:///etc/passwd")[0]["title"], "Not a URL")
        self.assertEqual(sf("shot", "javascript:alert(1)")[0]["title"], "Not a URL")


class TomdTests(unittest.TestCase):
    def setUp(self):
        clear_cache()

    def test_article(self):
        it = sf("tomd", f"{BASE}/blog/coffee")
        self.assertEqual(it[0]["title"], "How to Brew Coffee")
        md = md_of(it)
        fm = md.split("---")[1]
        self.assertIn('title: "How to Brew Coffee"', fm)
        self.assertIn(f'url: "{BASE}/blog/coffee"', fm)
        self.assertIn('author: "Ada Lovelace"', fm)
        self.assertIn("date: 2025-03-14", fm)
        self.assertIn('site: "The Daily Bean"', fm)
        self.assertIn("\n# How to Brew Coffee\n", md)
        self.assertEqual(md.count("# How to Brew Coffee"), 1)  # the article's own <h1> isn't repeated
        self.assertIn("## What you need", md)
        self.assertIn("- Fresh beans\n  - Light roast\n  - Medium roast\n    3. Colombia\n    4. Ethiopia\n- A `burr` grinder\n- [x] Kettle", md)
        self.assertIn("| Method | Coffee (g) | Water \\| ml |\n| --- | ---: | --- |\n| Pour over | 15 | 250 |", md)
        self.assertIn("| Espresso | | 36 |", md)
        self.assertIn("```python\ndef brew(grams):\n    ratio = 16\n\n    return grams * ratio  # `water`\n```", md)
        self.assertIn("> Good coffee is a pleasure.\n>\n> Good friends are a treasure.", md)
        self.assertIn(f'[grinder guide]({BASE}/guides/grinders.html "Our grinder guide")', md)
        self.assertIn(f"![A cup]({BASE}/img/cup.jpg)", md)
        self.assertIn("![Lazy](https://cdn.example.com/lazy.png)", md)
        self.assertIn("*A fresh cup*", md)
        self.assertIn("**grind size**", md)
        self.assertIn("snake_case_names and \\_underscored\\_ and \\[brackets\\]", md)
        self.assertIn("Use \\<div> tags", md)
        self.assertIn(f"[notes]({BASE}/blog/coffee#notes) or click.", md)
        for junk in ("Home", "Popular", "not content", "Tweet", "© 2025", "color: red", "javascript"):
            self.assertNotIn(junk, md)
        self.assertIn("Line  \nbreak.", md)

    def test_quicklook_and_mods(self):
        it = sf("tomd", f"{BASE}/blog/coffee")
        main = it[0]
        self.assertTrue(os.path.exists(main["quicklookurl"]))
        self.assertTrue(main["quicklookurl"].endswith("How to Brew Coffee.md"))
        self.assertEqual(main["mods"]["cmd"]["arg"], main["arg"])
        self.assertEqual(main["mods"]["alt"]["arg"], main["quicklookurl"])
        self.assertEqual(main["mods"]["alt"]["variables"]["save_name"], "How to Brew Coffee.md")
        self.assertTrue(it[1]["title"].startswith("Whole page"))
        self.assertIn("Popular", md_of(it[1:]))  # the unextracted page keeps the sidebar
        self.assertEqual(it[2]["arg"], f"[How to Brew Coffee]({BASE}/blog/coffee)")

    def test_redirect_uses_final_url(self):
        md = md_of(sf("tomd", f"{BASE}/old-link"))
        self.assertIn(f'url: "{BASE}/blog/coffee"', md)
        self.assertIn(f"({BASE}/guides/grinders.html", md)

    def test_front_matter_off(self):
        md = md_of(sf("tomd", f"{BASE}/blog/coffee", tomd_front_matter="0"))
        self.assertTrue(md.startswith("# How to Brew Coffee"))

    def test_charset_from_meta(self):
        it = sf("tomd", f"{BASE}/cp1251")
        self.assertEqual(it[0]["title"], "Кофе")
        self.assertIn("Привет, мир!", md_of(it))

    def test_latin1_header_is_windows_1252(self):
        md = md_of(sf("tomd", f"{BASE}/latin1"))
        self.assertIn("Café crème — déjà vu.", md)

    def test_http_errors(self):
        it = sf("tomd", f"{BASE}/forbidden")
        self.assertEqual(it[0]["title"], "Access denied (HTTP 403)")
        self.assertIn("frontmost tab", it[0]["subtitle"])
        it = sf("tomd", "", WC_TEST_TAB=tab(f"{BASE}/forbidden"))
        self.assertIn("Use browser page content", it[0]["subtitle"])
        self.assertEqual(sf("tomd", f"{BASE}/missing")[0]["title"], "Page not found (HTTP 404)")
        self.assertIn("429", sf("tomd", f"{BASE}/busy")[0]["title"])
        self.assertIn("HTTP 500", sf("tomd", f"{BASE}/broken")[0]["title"])

    def test_network_errors(self):
        port = SERVER.server_address[1] + 1 if SERVER.server_address[1] < 65000 else 1
        it = sf("tomd", f"http://127.0.0.1:{port}/")
        self.assertEqual(it[0]["title"], "Could not connect to the server")
        it = sf("tomd", f"{BASE}/slow", fetch_timeout="3")
        self.assertEqual(it[0]["title"], "The server took too long to respond")
        self.assertEqual(sf("tomd", f"{BASE}/redirect-loop")[0]["title"], "Too many redirects")

    def test_pdf_and_image(self):
        it = sf("tomd", f"{BASE}/doc.pdf")
        self.assertEqual(it[0]["title"], "Not a web page: this URL is a PDF")
        self.assertEqual(it[1]["arg"], f"[doc.pdf]({BASE}/doc.pdf)")
        it = sf("tomd", f"{BASE}/pic.png")
        self.assertIn("image", it[0]["title"])
        self.assertEqual(it[1]["arg"], f"![pic.png]({BASE}/pic.png)")

    def test_text_and_json(self):
        self.assertEqual(md_of(sf("tomd", f"{BASE}/notes.txt")), "# Notes\n\nPlain *markdown* text\n")
        md = md_of(sf("tomd", f"{BASE}/data.json"))
        self.assertEqual(md, '````json\n{"a": [1, 2], "code": "```"}\n````\n')

    def test_empty_and_spa(self):
        self.assertEqual(sf("tomd", f"{BASE}/empty")[0]["title"], "The page is empty")
        it = sf("tomd", f"{BASE}/spa")
        self.assertIn("Little text found", it[0]["subtitle"])

    def test_large_page_goes_through_cache(self):
        it = sf("tomd", f"{BASE}/big")
        self.assertTrue(it[0]["arg"].startswith("wcfile:"))
        self.assertTrue(it[0]["text"]["copy"].startswith("Result too large"))
        md = resolve(it[0]["arg"])
        self.assertIn("Paragraph 2999:", md)
        self.assertGreater(len(md), 200000)

    def test_cache(self):
        n = len(requests_to("/blog/coffee"))
        sf("tomd", f"{BASE}/blog/coffee")
        sf("tomd", f"{BASE}/blog/coffee")
        self.assertEqual(len(requests_to("/blog/coffee")), n + 1)

    def test_browser_page_content(self):
        html = "<html><head><title>Secret</title></head><body><article><h1>Members only</h1><p>" + "Logged-in content. " * 30 + "</p></article></body></html>"
        n = len(requests_to("/forbidden"))
        it = sf("tomd", "", WC_TEST_TAB=tab(f"{BASE}/forbidden", html=html), tomd_browser_html="1")
        self.assertEqual(len(requests_to("/forbidden")), n)  # nothing downloaded
        self.assertIn("Logged-in content.", md_of(it))
        self.assertIn("browser", it[0]["subtitle"])
        # JavaScript from Apple Events is off: fall back to downloading, and say why
        it = sf("tomd", "", WC_TEST_TAB=tab(f"{BASE}/blog/coffee", html={"error": "not allowed"}), tomd_browser_html="1")
        self.assertIn("Allow JavaScript from Apple Events", it[0]["subtitle"])
        self.assertIn("Coffee is one of", md_of(it))
        # the option is off: the page is downloaded even if the tab could give it
        it = sf("tomd", "", WC_TEST_TAB=tab(f"{BASE}/blog/coffee", html=html))
        self.assertNotIn("Logged-in", md_of(it))

    def test_injection_safe(self):
        marker = os.path.join(TMP, "pwned")
        q = f"{BASE}/blog/coffee?x=\"';$(touch${{IFS}}{marker})`touch${{IFS}}{marker}`"
        it = sf("tomd", q)
        self.assertEqual(it[0]["title"], "How to Brew Coffee")
        self.assertFalse(os.path.exists(marker))
        it = sf("shot", "", WC_TEST_TAB=tab("https://example.com/\"';$(touch x)", title="\"'`$(touch x)\n\\"))
        self.assertFalse(os.path.exists(os.path.join(SRC, "x")))

    def test_save_action(self):
        it = sf("tomd", f"{BASE}/blog/coffee")
        alt = it[0]["mods"]["alt"]
        msg = run("./webcapture.js", ["save", alt["arg"]], **alt["variables"]).strip()
        self.assertTrue(msg.startswith("Saved How to Brew Coffee.md"), msg)
        path = os.path.join(SAVE, "How to Brew Coffee.md")
        self.assertTrue(os.path.exists(path))
        msg = run("./webcapture.js", ["save", alt["arg"]], **alt["variables"]).strip()
        self.assertTrue(os.path.exists(os.path.join(SAVE, "How to Brew Coffee 2.md")), msg)
        # only files from the cache can be "saved"
        self.assertEqual(run("./webcapture.js", ["save", "/etc/hosts"]).strip(), "Nothing to save")
        self.assertEqual(run("./webcapture.js", ["save", f"{CACHE}/../../etc/hosts"]).strip(), "Nothing to save")

    def test_save_folder_with_tilde(self):
        it = sf("tomd", f"{BASE}/blog/coffee", save_folder="~/Downloads")
        self.assertIn("Save to ~/Downloads", it[0]["mods"]["alt"]["subtitle"])

    def test_unsafe_title_file_name(self):
        html = '<html><head><title>a/b: c? "d" &lt;e&gt;</title></head><body><article><p>' + "Text. " * 60 + "</p></article></body></html>"
        it = sf("tomd", "", WC_TEST_TAB=tab(f"{BASE}/x", html=html), tomd_browser_html="1")
        name = os.path.basename(it[0]["quicklookurl"])
        self.assertEqual(name, "a b c d e.md")

    def test_resolver_refuses_outside_cache(self):
        self.assertEqual(resolve("wcfile:/etc/hosts"), "wcfile:/etc/hosts")
        self.assertEqual(resolve(f"wcfile:{CACHE}/../x"), "")
        self.assertEqual(resolve("plain text"), "plain text")


class MarkdownTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.md = run("./webcapture.js", ["convert", os.path.join(FIX, "edge.html"), "https://docs.example.org/guide/edge.html"], tomd_front_matter="0")

    def convert(self, html, url="https://example.com/a/b.html", full=False):
        path = os.path.join(TMP, "in.html")
        with open(path, "w") as f:
            f.write(html)
        return run("./webcapture.js", ["convert", path, url] + (["full"] if full else []), tomd_front_matter="0")

    def test_entities(self):
        self.assertIn('Entities: \\<tag> "quoted" — 😀 – \xa0x \\&unknown; AT&T', self.md)

    def test_heading_permalink_and_nested_emphasis(self):
        self.assertIn("## Intro & setup\n", self.md)
        self.assertIn("**bold nested** and *it nested* and **spaced** word", self.md)

    def test_code(self):
        self.assertIn("``a `tick` b`` and `` `edge` `` and `Cmd`", self.md)
        self.assertIn("````\nplain ```fence``` inside\n  indented\n````", self.md)
        self.assertIn("```rust\nfn main() {}\n```", self.md)
        self.assertIn('```bash\necho "hi"\nls\n```', self.md)

    def test_lists(self):
        self.assertIn("7. seven\n\n10. ten\n\n11. eleven\n\n    second para", self.md)
        self.assertIn("- outer\n  - inner\n    - deepest", self.md)

    def test_blockquote_and_tables(self):
        self.assertIn("> outer\n>\n> > inner quote", self.md)
        self.assertIn("**Sizes**\n\n| Name | Size | Note |\n| --- | :---: | --- |\n| A\\|B | 1 | x<br>y |\n| | 2 | z |", self.md)
        self.assertIn("\nLayout cell text.\n", self.md)

    def test_links_and_images(self):
        self.assertIn("[relative](https://docs.example.org/guide/page2.html) [root](https://docs.example.org/root) [proto](https://cdn.example.org/x) js link [spaces](https://example.com/a%20b%28c%29)", self.md)
        self.assertIn("![set](https://docs.example.org/guide/large.jpg) ![pic](https://docs.example.org/guide/pic.webp)", self.md)
        self.assertIn("[Demo video](https://www.youtube.com/watch?v=dQw4w9WgXcQ)", self.md)
        self.assertIn("![real](https://docs.example.org/guide/real.png)", self.md)

    def test_misc(self):
        self.assertIn("**Term**\n\n: Definition", self.md)
        self.assertIn("Math: $x^2$", self.md)
        self.assertIn("\\# not a heading  \n1\\. not a list  \n\\- not a bullet  \n\\+ plus", self.md)
        self.assertIn("cdata text", self.md)
        for junk in ("junk", "hidden", "comment", "field", "Click"):
            self.assertNotIn(junk, self.md)

    def test_malformed_html(self):
        md = self.convert("<p>one<p>two</ul></div></span><table><tr><td>a<td>b<tr><td>c<td>d</table><p>after <b>bold")
        self.assertIn("one\n\ntwo", md)
        self.assertIn("| a | b |\n| --- | --- |\n| c | d |", md)
        self.assertIn("after **bold**", md)

    def test_deep_nesting(self):
        md = self.convert("<div>" * 20000 + "<p>deep text</p>" + "</div>" * 20000)
        self.assertIn("deep text", md)

    def test_script_with_closing_tags(self):
        md = self.convert('<p>before</p><script>var s = "</div><p>fake</p>";</script><p>after</p>', full=True)
        self.assertNotIn("fake", md)
        self.assertIn("before\n\nafter", md)

    def test_unicode_and_markdown_chars_in_text(self):
        md = self.convert("<article><p>Emoji 🎉, quotes “x” and ‘y’, *stars*, 2 < 3 > 1, `ticks`, back\\slash, ~~strike~~ and 1_000_000.</p>" + "<p>filler words here</p>" * 20 + "</article>")
        self.assertIn("Emoji 🎉, quotes “x” and ‘y’, \\*stars\\*, 2 < 3 > 1, \\`ticks\\`, back\\\\slash, \\~\\~strike\\~\\~ and 1_000_000.", md)

    def test_readability_picks_article(self):
        filler = "".join(f"<li><a href='/n{i}'>Nav link {i}</a></li>" for i in range(40))
        body = "".join(f"<p>Real sentence number {i}, with commas, and enough words to count as content.</p>" for i in range(15))
        html = f"<body><div class='menu'><ul>{filler}</ul></div><div id='wrap'><div class='entry-content'>{body}</div><div class='related-posts'><a href='/r1'>R1</a> <a href='/r2'>R2</a> <a href='/r3'>R3</a></div></div><div class='comments'><p>Nice post, really, thanks, great, wow, amazing stuff here!</p></div></body>"
        md = self.convert(html)
        self.assertIn("Real sentence number 14", md)
        for junk in ("Nav link", "R1", "Nice post"):
            self.assertNotIn(junk, md)

    def test_sidebar_named_wrapper_kept(self):
        # MDN wraps the whole article in "layout__2-sidebars-inline": it must not be dropped as a sidebar
        body = "".join(f"<p>Documentation paragraph {i}, explaining things in detail.</p>" for i in range(10))
        md = self.convert(f"<body><div class='layout__2-sidebars-inline'><main><h1>Doc</h1>{body}</main></div></body>")
        self.assertIn("Documentation paragraph 9", md)

    def test_wikipedia_edit_links_removed(self):
        body = "<p>" + "Encyclopedia text, with facts. " * 20 + "</p>"
        md = self.convert(f"<body><main><h2>History<span class='mw-editsection'>[<a href='/edit'>edit</a>]</span></h2>{body}</main></body>")
        self.assertIn("## History\n", md)
        self.assertNotIn("edit", md)

    def test_citation_not_double_emphasised(self):
        md = self.convert("<main><ol><li><cite>Smith (2020). <i>Journal</i>. Retrieved today.</cite></li></ol>" + "<p>Body text for the article, long enough.</p>" * 10 + "</main>")
        self.assertIn("1. Smith (2020). *Journal*. Retrieved today.", md)


class ShotTests(unittest.TestCase):
    def test_items_and_variables(self):
        it = sf("shot", f"{BASE}/shot", shot_width="1024")
        self.assertEqual(len(it), 3)
        self.assertEqual(it[0]["variables"], {"shot_action": "reveal", "shot_full": "1", "shot_width": "1024"})
        self.assertEqual(it[0]["mods"]["cmd"]["variables"]["shot_action"], "copy")
        self.assertEqual(it[0]["mods"]["alt"]["variables"]["shot_action"], "open")
        self.assertEqual(it[1]["variables"]["shot_full"], "0")
        self.assertEqual(it[2]["variables"]["shot_width"], "390")
        self.assertIn("1024 px wide", it[0]["subtitle"])
        self.assertEqual(sf("shot", f"{BASE}/shot", shot_width="99999")[0]["variables"]["shot_width"], "3840")
        self.assertEqual(sf("shot", f"{BASE}/shot", shot_width="abc")[0]["variables"]["shot_width"], "1280")

    def png_size(self, path):
        with open(path, "rb") as f:
            head = f.read(24)
        self.assertEqual(head[:8], b"\x89PNG\r\n\x1a\n")
        return struct.unpack(">II", head[16:24])

    def test_full_page_capture(self):
        out = run("./snapshot.js", [f"{BASE}/shot"], shot_width="400", shot_scale="1", shot_full="1").strip()
        self.assertTrue(out.startswith("OK "), out)
        path = out[3:].rsplit(" ", 1)[0]
        self.assertTrue(path.startswith(SAVE))
        self.assertEqual(self.png_size(path), (400, 2500))

    def test_first_screen_and_scale(self):
        out = run("./snapshot.js", [f"{BASE}/shot"], shot_width="320", shot_scale="2", shot_full="0").strip()
        path = out[3:].rsplit(" ", 1)[0]
        self.assertEqual(self.png_size(path), (640, 1800))

    def test_max_height(self):
        out = run("./snapshot.js", [f"{BASE}/shot"], shot_width="320", shot_scale="1", shot_max_height="1000").strip()
        self.assertIn("cut at the maximum height", out)
        path = out[3:].split(" 320×")[0]
        self.assertEqual(self.png_size(path), (320, 1000))

    def test_copy_to_private_pasteboard(self):
        out = run("./snapshot.js", [f"{BASE}/shot"], shot_width="320", shot_scale="1", shot_action="copy", WC_TEST_NO_UI="", WC_TEST_PASTEBOARD="wc-test-pb").strip()
        self.assertTrue(out.startswith("Screenshot copied · 320×2500"), out)
        check = subprocess.run(["osascript", "-l", "JavaScript", "-e",
                                'ObjC.import("AppKit"); var d = $.NSPasteboard.pasteboardWithName("wc-test-pb").dataForType($.NSPasteboardTypePNG); d.isNil() ? 0 : d.length'],
                               capture_output=True, text=True)
        self.assertGreater(int(check.stdout.strip() or 0), 100)

    def test_errors(self):
        self.assertEqual(run("./snapshot.js", ["file:///etc/hosts"]).strip(), "Screenshot failed: not an http(s) URL")
        port = SERVER.server_address[1] + 1 if SERVER.server_address[1] < 65000 else 1
        out = run("./snapshot.js", [f"http://127.0.0.1:{port}/"]).strip()
        self.assertTrue(out.startswith("Screenshot failed:"), out)


class CodeTests(unittest.TestCase):
    def fragment(self, url):
        self.assertTrue(url.startswith("https://ray.so/#"))
        return dict(p.split("=", 1) for p in url.split("#", 1)[1].split("&"))

    def decode(self, b64):
        return base64.urlsafe_b64decode(b64 + "=" * (-len(b64) % 4)).decode("utf-8")

    def test_clipboard_code(self):
        code = "    def hi():\n        return \"héllo ✓\"  \n\n"
        it = sf("code", "", WC_TEST_CLIPBOARD=code)
        f = self.fragment(it[0]["arg"])
        self.assertEqual(self.decode(f["code"]), 'def hi():\n    return "héllo ✓"')
        self.assertEqual((f["theme"], f["background"], f["darkMode"], f["padding"]), ("candy", "true", "true", "64"))
        self.assertNotIn("language", f)
        self.assertNotIn("+", f["code"] + "/")
        self.assertEqual(it[0]["mods"]["cmd"]["arg"], it[0]["arg"])

    def test_settings(self):
        it = sf("code", "", WC_TEST_CLIPBOARD="x = 1", code_theme="vercel", code_dark="0", code_background="0", code_padding="16", code_line_numbers="1")
        f = self.fragment(it[0]["arg"])
        self.assertEqual((f["theme"], f["background"], f["darkMode"], f["padding"], f["lineNumbers"]), ("vercel", "false", "false", "16", "true"))
        f = self.fragment(sf("code", "", WC_TEST_CLIPBOARD="x", code_theme="bogus", code_padding="7")[0]["arg"])
        self.assertEqual((f["theme"], f["padding"]), ("candy", "64"))

    def test_language(self):
        it = sf("code", "py", WC_TEST_CLIPBOARD="print(1)")
        self.assertEqual(self.fragment(it[0]["arg"])["language"], "python")
        it = sf("code", "ja", WC_TEST_CLIPBOARD="print(1)")
        self.assertIn("java", [self.fragment(i["arg"]).get("language") for i in it])
        self.assertIn("javascript", [self.fragment(i["arg"]).get("language") for i in it])

    def test_typed_code_and_empty(self):
        it = sf("code", "let a = [1, 2]\nconsole.log(a)")
        self.assertEqual(self.decode(self.fragment(it[0]["arg"])["code"]), "let a = [1, 2]\nconsole.log(a)")
        self.assertEqual(sf("code", "", WC_TEST_CLIPBOARD="   \n")[0]["title"], "Copy some code first")


class YouTubeTests(unittest.TestCase):
    def setUp(self):
        clear_cache()

    def test_transcript(self):
        n = len(requests_to("/youtubei/v1/player"))
        it = sf("ytt", "https://www.youtube.com/watch?v=okvideo0001&t=42s")
        main = it[0]
        self.assertEqual(main["title"], 'Fixture "Talk" & Demo')
        self.assertIn("English · ", main["subtitle"])
        self.assertIn("1:02:05", main["subtitle"])
        self.assertEqual(resolve(main["arg"]), "Hello & welcome. It's a test with a newline.\n\nAfter a pause.\n\nThe end")
        self.assertEqual(resolve(main["mods"]["cmd"]["arg"]), "[0:00] Hello & welcome.\n[0:02] It's a test with a newline.\n[0:10] After a pause.\n[1:02:05] The end")
        post = requests_to("/youtubei/v1/player")[n]
        body = json.loads(post["body"])
        self.assertEqual(body["videoId"], "okvideo0001")
        self.assertEqual(body["context"]["client"]["clientName"], "ANDROID")
        self.assertEqual(post["query"]["key"], ["AIzaTestKey_123-abc"])
        self.assertNotIn("fmt", requests_to("/api/timedtext")[-1]["query"])
        others = [(i["title"], i["autocomplete"]) for i in it[1:]]
        self.assertIn(("English (auto-generated)", "https://www.youtube.com/watch?v=okvideo0001&t=42s en auto "), others)
        self.assertIn(("German (Germany)", "https://www.youtube.com/watch?v=okvideo0001&t=42s de-DE "), others)

    def test_language_choice(self):
        it = sf("ytt", "https://youtu.be/okvideo0001 de")
        self.assertIn("German (Germany)", it[0]["subtitle"])
        self.assertEqual(resolve(it[0]["mods"]["cmd"]["arg"]), "[0:00] Hallo und willkommen.\n[1:01] Grüße aus Köln")
        it = sf("ytt", "okvideo0001", ytt_language="fr, de")
        self.assertIn("German", it[0]["subtitle"])
        it = sf("ytt", "https://youtu.be/okvideo0001 en auto")
        self.assertEqual(resolve(it[0]["arg"]), "hello and welcome this is auto")
        it = sf("ytt", "https://youtu.be/okvideo0001 fr")
        self.assertIn("No fr captions: English", it[0]["subtitle"])

    def test_from_tab_and_url_forms(self):
        for url in ["https://m.youtube.com/watch?feature=share&v=okvideo0001", "https://www.youtube.com/shorts/okvideo0001",
                    "https://youtube.com/embed/okvideo0001?start=3", "https://www.youtube.com/live/okvideo0001", "https://music.youtube.com/watch?v=okvideo0001&list=x"]:
            it = sf("ytt", "", WC_TEST_TAB=tab(url, "YT", "Google Chrome"))
            self.assertEqual(it[0]["title"], 'Fixture "Talk" & Demo', url)
        it = sf("ytt", "", WC_TEST_TAB=tab("https://example.com/"))
        self.assertEqual(it[0]["title"], "Not a YouTube video")
        self.assertIn("Safari tab", it[0]["subtitle"])
        self.assertEqual(sf("ytt", "")[0]["title"], "No YouTube video")
        self.assertEqual(sf("ytt", "hello there")[0]["title"], "Type a YouTube URL and an optional language code")

    def test_errors(self):
        cases = {"nocaptions1": "No transcript: this video has no captions", "private0001": "Private video", "agerestrict": "Age-restricted video",
                 "unavailabl1": "Video unavailable", "botreason01": "YouTube asks to confirm you’re not a bot", "botcheck001": "YouTube asks to confirm you’re not a bot",
                 "ratelimit01": "YouTube is rate-limiting this Mac (HTTP 429)", "layoutchng1": "Could not read the YouTube page", "emptytrack1": "The transcript is empty"}
        for vid, title in cases.items():
            it = sf("ytt", f"https://youtu.be/{vid}")
            self.assertEqual(it[0]["title"], title, vid)
            self.assertIs(it[0]["valid"], False)

    def test_save_formats(self):
        it = sf("ytt", "https://youtu.be/okvideo0001")
        alt = it[0]["mods"]["alt"]
        self.assertTrue(alt["arg"].endswith('Fixture Talk & Demo transcript.md'))
        with open(alt["arg"]) as f:
            md = f.read()
        self.assertIn('title: "Fixture \\"Talk\\" & Demo"', md)
        self.assertIn('channel: "Test Channel"', md)
        self.assertIn("[0:00](https://www.youtube.com/watch?v=okvideo0001&t=0s) Hello & welcome.", md)
        self.assertIn("[0:10](https://www.youtube.com/watch?v=okvideo0001&t=10s) After a pause.", md)
        msg = run("./webcapture.js", ["save", alt["arg"]], **alt["variables"]).strip()
        self.assertTrue(os.path.exists(os.path.join(SAVE, "Fixture Talk & Demo transcript.md")), msg)
        clear_cache()
        it = sf("ytt", "https://youtu.be/okvideo0001", ytt_save_format="txt")
        with open(it[0]["mods"]["alt"]["arg"]) as f:
            txt = f.read()
        self.assertTrue(txt.startswith('Fixture "Talk" & Demo\nTest Channel · https://www.youtube.com/watch?v=okvideo0001\n\n[0:00] Hello & welcome.'), txt)

    def test_local_ai_handoff(self):
        it = sf("ytt", "https://youtu.be/okvideo0001")
        self.assertIs(it[0]["mods"]["ctrl"]["valid"], False)
        self.assertIn("Install the Local AI workflow", it[0]["mods"]["ctrl"]["subtitle"])
        it = sf("ytt", "https://youtu.be/okvideo0001", WC_TEST_LOCAL_AI="1")
        ctrl = it[0]["mods"]["ctrl"]
        self.assertTrue(ctrl["valid"])
        log = os.path.join(TMP, "handoff.json")
        out = run("./webcapture.js", ["handoff", ctrl["arg"]], WC_TEST_LOCAL_AI="1", WC_TEST_HANDOFF=log)
        self.assertEqual(out.strip(), "")
        with open(log) as f:
            call = json.load(f)
        self.assertEqual((call["trigger"], call["workflow"]), ("summarize", "io.github.x-o-r-r-o.local-ai"))
        self.assertTrue(call["argument"].startswith('Fixture "Talk" & Demo\nhttps://www.youtube.com/watch?v=okvideo0001\n\nHello & welcome.'))
        out = run("./webcapture.js", ["handoff", ctrl["arg"]], WC_TEST_LOCAL_AI="0", WC_TEST_HANDOFF=log)
        self.assertEqual(out.strip(), "Install the Local AI workflow to summarize transcripts")

    def test_local_ai_detection_from_alfred_preferences(self):
        prefs = os.path.join(TMP, "Alfred.alfredpreferences")
        wf = os.path.join(prefs, "workflows", "user.workflow.1234")
        os.makedirs(wf, exist_ok=True)
        with open(os.path.join(wf, "info.plist"), "wb") as f:
            plistlib.dump({"bundleid": "io.github.x-o-r-r-o.local-ai", "name": "Local AI"}, f)
        e = base_env(alfred_preferences=prefs)
        del e["WC_TEST_LOCAL_AI"]
        out = subprocess.run(["osascript", "-l", "JavaScript", "./webcapture.js", "ytt", "https://youtu.be/okvideo0001"], cwd=SRC, env=e, capture_output=True, text=True)
        self.assertTrue(json.loads(out.stdout)["items"][0]["mods"]["ctrl"]["valid"])

    def test_cache(self):
        n = len(requests_to("/watch"))
        sf("ytt", "https://youtu.be/okvideo0001")
        sf("ytt", "https://youtu.be/okvideo0001")
        self.assertEqual(len(requests_to("/watch")), n + 1)

    def test_consent_cookie_and_user_agent(self):
        sf("ytt", "https://youtu.be/okvideo0001")
        w = requests_to("/watch")[-1]
        self.assertIn("SOCS=CAI", w["headers"].get("Cookie", ""))


class BuildTests(unittest.TestCase):
    def test_plist(self):
        subprocess.run([sys.executable, os.path.join(ROOT, "tools", "build.py"), "--check"], check=True, capture_output=True)
        with open(os.path.join(SRC, "info.plist"), "rb") as f:
            info = plistlib.load(f)
        kws = sorted(o["config"]["keyword"] for o in info["objects"] if "keyword" in o["config"])
        self.assertEqual(kws, ["{var:keyword_code}", "{var:keyword_shot}", "{var:keyword_tomd}", "{var:keyword_ytt}"])
        variables = {c["variable"] for c in info["userconfigurationconfig"]}
        sources = ""
        for name in ("webcapture.js", "snapshot.js"):
            with open(os.path.join(SRC, name)) as f:
                sources += f.read()
        for v in variables - {"keyword_tomd", "keyword_shot", "keyword_code", "keyword_ytt"}:
            self.assertIn(f'"{v}"', sources, v)
        self.assertIn("## Usage", info["readme"])
        self.assertNotIn("images/", info["readme"])

    def test_no_binaries(self):
        for base, _, files in os.walk(SRC):
            for f in files:
                p = os.path.join(base, f)
                with open(p, "rb") as fh:
                    head = fh.read(4)
                self.assertNotIn(head, (b"\xcf\xfa\xed\xfe", b"\xca\xfe\xba\xbe", b"\xfe\xed\xfa\xcf"), p)


@unittest.skipUnless(LIVE, "set WC_LIVE=1 to run live network tests")
class LiveTests(unittest.TestCase):
    def test_example_com(self):
        it = sf("tomd", "https://example.com/", WC_YT_BASE="https://www.youtube.com")
        self.assertIn("Example Domain", it[0]["title"])

    def test_youtube(self):
        it = sf("ytt", "https://www.youtube.com/watch?v=dQw4w9WgXcQ", WC_YT_BASE="https://www.youtube.com")
        self.assertIn("Never Gonna Give You Up", it[0]["title"])
        self.assertIn("give you up", resolve(it[0]["arg"]).lower())


if __name__ == "__main__":
    unittest.main(verbosity=1)
