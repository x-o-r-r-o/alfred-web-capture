// Web Capture: HTML parser, Readability-style content extraction and HTML → Markdown.
// Plain JavaScript (no ObjC), loaded by webcapture.js. Nothing here touches the network or the file system.

// ---------- entities ----------

const LATIN1 = ("nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 " +
  "acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest Agrave Aacute Acirc Atilde Auml Aring AElig " +
  "Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave " +
  "Uacute Ucirc Uuml Yacute THORN szlig agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave " +
  "iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml").split(" ");
const ENTITIES = {
  quot: 34, amp: 38, apos: 39, lt: 60, gt: 62, OElig: 338, oelig: 339, Scaron: 352, scaron: 353, Yuml: 376, fnof: 402,
  circ: 710, tilde: 732, ensp: 8194, emsp: 8195, thinsp: 8201, zwnj: 8204, zwj: 8205, lrm: 8206, rlm: 8207, ndash: 8211,
  mdash: 8212, horbar: 8213, lsquo: 8216, rsquo: 8217, sbquo: 8218, ldquo: 8220, rdquo: 8221, bdquo: 8222, dagger: 8224,
  Dagger: 8225, bull: 8226, hellip: 8230, permil: 8240, prime: 8242, Prime: 8243, lsaquo: 8249, rsaquo: 8250, oline: 8254,
  euro: 8364, trade: 8482, larr: 8592, uarr: 8593, rarr: 8594, darr: 8595, harr: 8596, lArr: 8656, uArr: 8657, rArr: 8658,
  dArr: 8659, hArr: 8660, minus: 8722, lowast: 8727, radic: 8730, infin: 8734, asymp: 8776, ne: 8800, equiv: 8801,
  le: 8804, ge: 8805, sum: 8721, prod: 8719, part: 8706, nabla: 8711, isin: 8712, forall: 8704, exist: 8707, empty: 8709,
  and: 8743, or: 8744, cap: 8745, cup: 8746, int: 8747, there4: 8756, sim: 8764, sub: 8834, sup: 8835, sube: 8838,
  supe: 8839, oplus: 8853, otimes: 8855, perp: 8869, sdot: 8901, loz: 9674, spades: 9824, clubs: 9827, hearts: 9829,
  diams: 9830, check: 10003, cross: 10007, star: 9734, starf: 9733, nbsp: 160, NewLine: 10, Tab: 9, colon: 58,
  lpar: 40, rpar: 41, lsqb: 91, rsqb: 93, lcub: 123, rcub: 125, sol: 47, bsol: 92, verbar: 124, vert: 124, ast: 42,
  num: 35, dollar: 36, percnt: 37, commat: 64, excl: 33, quest: 63, equals: 61, plus: 43, comma: 44, period: 46,
  semi: 59, grave: 96, Hat: 94, lowbar: 95, hyphen: 8208, dash: 8208,
};
LATIN1.forEach((n, i) => { ENTITIES[n] = 160 + i; });
"Alpha Beta Gamma Delta Epsilon Zeta Eta Theta Iota Kappa Lambda Mu Nu Xi Omicron Pi Rho".split(" ").forEach((n, i) => {
  ENTITIES[n] = 913 + i;
  ENTITIES[n.toLowerCase()] = 945 + i;
});
"Sigma Tau Upsilon Phi Chi Psi Omega".split(" ").forEach((n, i) => {
  ENTITIES[n] = 931 + i;
  ENTITIES[n.toLowerCase()] = 963 + i;
});
ENTITIES.sigmaf = 962;
// Numeric references 128–159 mean Windows-1252 characters (HTML spec).
const CP1252 = [8364, 129, 8218, 402, 8222, 8230, 8224, 8225, 710, 8240, 352, 8249, 338, 141, 381, 143, 144, 8216, 8217,
  8220, 8221, 8226, 8211, 8212, 732, 8482, 353, 8250, 339, 157, 382, 376];

function codePoint(n) {
  if (n >= 128 && n <= 159) n = CP1252[n - 128];
  if (!n || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return "\uFFFD";
  return String.fromCodePoint(n);
}

function decodeEntities(s) {
  if (s.indexOf("&") < 0) return s;
  return s.replace(/&(?:#(\d{1,8})|#[xX]([0-9a-fA-F]{1,7})|([A-Za-z][A-Za-z0-9]{1,31}));?/g, (m, dec, hex, name) => {
    if (dec) return codePoint(parseInt(dec, 10));
    if (hex) return codePoint(parseInt(hex, 16));
    if (Object.prototype.hasOwnProperty.call(ENTITIES, name) && (m.endsWith(";") || /^(amp|lt|gt|quot|nbsp|copy|reg)$/.test(name))) {
      return String.fromCodePoint(ENTITIES[name]);
    }
    return m;
  });
}

// ---------- HTML parser ----------
// A forgiving HTML5-ish tree builder: void elements, raw text elements, implied end tags for
// p/li/dt/dd/tr/td/th/option, and stray end tags are ignored.

const VOID = new Set("area base br col embed hr img input keygen link meta param source track wbr".split(" "));
const RAW = new Set(["script", "style", "textarea", "title", "xmp", "iframe", "noembed", "noframes", "plaintext", "template"]);
const CLOSES_P = new Set(("address article aside blockquote center details dialog dir div dl fieldset figcaption figure footer " +
  "form h1 h2 h3 h4 h5 h6 header hgroup hr main menu nav ol p pre section table ul li dd dt search").split(" "));
const BLOCK = new Set(("address article aside blockquote body center dd details dialog dir div dl dt fieldset figcaption figure " +
  "footer form h1 h2 h3 h4 h5 h6 header hgroup hr html li main menu nav ol p pre section summary table tbody td tfoot th thead " +
  "tr ul caption search noscript video audio").split(" "));

const MAX_DEPTH = 300;

function el(tag, attrs, parent) {
  return { type: 1, tag, attrs, children: [], parent };
}

function parseHTML(html) {
  const doc = el("#document", {}, null);
  const stack = [doc];
  // ASCII-only lowercase keeps indexes aligned ("İ".toLowerCase() is two code units long)
  const lower = html.replace(/[A-Z]+/g, (m) => m.toLowerCase());
  const n = html.length;
  let i = 0, textStart = 0;
  const cur = () => stack[stack.length - 1];
  const addText = (t) => {
    if (!t) return;
    const p = cur();
    const last = p.children[p.children.length - 1];
    if (last && last.type === 3) last.text += t;
    else p.children.push({ type: 3, text: t, parent: p });
  };
  const flushText = (end) => {
    if (end > textStart) addText(decodeEntities(html.slice(textStart, end)));
  };
  const inStack = (tag, stopAt) => {
    for (let k = stack.length - 1; k > 0; k--) {
      if (stack[k].tag === tag) return k;
      if (stopAt && stopAt.has(stack[k].tag)) return -1;
    }
    return -1;
  };
  const popTo = (k) => {
    stack.length = k;
  };
  const LIST_SCOPE = new Set(["ul", "ol", "table", "td", "th"]);
  const DL_SCOPE = new Set(["dl", "table", "td", "th"]);
  const TABLE_SCOPE = new Set(["table"]);
  const BUTTON_SCOPE = new Set(["button", "table", "td", "th", "li", "dd", "dt", "blockquote", "figure"]);

  const openTag = (tag, attrs, selfClosing) => {
    if (CLOSES_P.has(tag)) {
      const k = inStack("p", BUTTON_SCOPE);
      if (k > 0) popTo(k);
    }
    if (tag === "li") {
      const k = inStack("li", LIST_SCOPE);
      if (k > 0) popTo(k);
    } else if (tag === "dt" || tag === "dd") {
      const k = Math.max(inStack("dt", DL_SCOPE), inStack("dd", DL_SCOPE));
      if (k > 0) popTo(k);
    } else if (tag === "tr") {
      const k = inStack("tr", TABLE_SCOPE);
      if (k > 0) popTo(k);
    } else if (tag === "td" || tag === "th") {
      const k = Math.max(inStack("td", TABLE_SCOPE), inStack("th", TABLE_SCOPE));
      if (k > 0) popTo(k);
    } else if (tag === "thead" || tag === "tbody" || tag === "tfoot") {
      const k = Math.max(inStack("thead", TABLE_SCOPE), inStack("tbody", TABLE_SCOPE), inStack("tfoot", TABLE_SCOPE));
      if (k > 0) popTo(k);
    } else if (tag === "option" || tag === "optgroup") {
      const k = inStack("option", new Set(["select"]));
      if (k > 0) popTo(k);
    } else if (tag === "a") {
      const k = inStack("a", new Set(["td", "th", "table"]));
      if (k > 0) popTo(k);
    } else if (/^h[1-6]$/.test(tag) && /^h[1-6]$/.test(cur().tag)) {
      stack.pop();
    }
    const node = el(tag, attrs, cur());
    cur().children.push(node);
    // Absurdly deep nesting is flattened so the recursive converter can't overflow the stack.
    if (!VOID.has(tag) && !selfClosing && stack.length < MAX_DEPTH) stack.push(node);
    return node;
  };

  while (i < n) {
    const lt = html.indexOf("<", i);
    if (lt < 0) break;
    const c = html.charCodeAt(lt + 1);
    if (html.startsWith("<!--", lt)) {
      flushText(lt);
      // "<!-->" and "<!--->" are complete (empty) comments, as in browsers
      const end = html.startsWith(">", lt + 4) ? lt + 2 : html.startsWith("->", lt + 4) ? lt + 3 : html.indexOf("-->", lt + 4);
      i = textStart = end < 0 ? n : end + 3;
      continue;
    }
    if (html.startsWith("<![CDATA[", lt)) {
      flushText(lt);
      const end = html.indexOf("]]>", lt + 9);
      addText(html.slice(lt + 9, end < 0 ? n : end));
      i = textStart = end < 0 ? n : end + 3;
      continue;
    }
    if (c === 33 || c === 63) { // <! or <?
      flushText(lt);
      const end = html.indexOf(">", lt + 2);
      i = textStart = end < 0 ? n : end + 1;
      continue;
    }
    if (c === 47) { // </
      const m = /^<\/([A-Za-z][A-Za-z0-9:-]*)[^>]*>/.exec(html.slice(lt, lt + 200));
      if (!m) {
        i = lt + 1;
        continue;
      }
      flushText(lt);
      const tag = m[1].toLowerCase();
      i = textStart = lt + m[0].length;
      if (tag === "p" && inStack("p", BUTTON_SCOPE) < 0) {
        openTag("p", {}, true);
        continue;
      }
      if (tag === "br") {
        openTag("br", {}, true);
        continue;
      }
      const k = inStack(tag, tag === "li" ? LIST_SCOPE : null);
      if (k > 0) popTo(k);
      continue;
    }
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122))) {
      i = lt + 1;
      continue;
    }
    // start tag: scan the name and attributes by hand (linear, no regex backtracking)
    flushText(lt);
    let j = lt + 1;
    while (j < n && !/[\s/>]/.test(html[j])) j++;
    const tag = lower.slice(lt + 1, j);
    const attrs = {};
    let selfClosing = false;
    while (j < n) {
      while (j < n && /\s/.test(html[j])) j++;
      if (html[j] === ">") { j++; break; }
      if (html[j] === "/") {
        if (html[j + 1] === ">") { selfClosing = true; j += 2; break; }
        j++;
        continue;
      }
      let k = j;
      while (k < n && !/[\s/>=]/.test(html[k])) k++;
      const name = lower.slice(j, k);
      j = k;
      while (j < n && /\s/.test(html[j])) j++;
      let value = "";
      if (html[j] === "=") {
        j++;
        while (j < n && /\s/.test(html[j])) j++;
        const q = html[j];
        if (q === '"' || q === "'") {
          const end = html.indexOf(q, j + 1);
          value = html.slice(j + 1, end < 0 ? n : end);
          j = end < 0 ? n : end + 1;
        } else {
          k = j;
          while (k < n && !/[\s>]/.test(html[k])) k++;
          value = html.slice(j, k);
          j = k;
        }
      }
      if (name && !(name in attrs)) attrs[name] = decodeEntities(value);
      if (k === j && !name) j++;
    }
    i = textStart = j;
    const node = openTag(tag, attrs, selfClosing && !RAW.has(tag));
    if (RAW.has(tag) && !selfClosing) {
      const end = lower.indexOf(`</${tag}`, i);
      const raw = html.slice(i, end < 0 ? n : end);
      if (raw) node.children.push({ type: 3, text: tag === "title" || tag === "textarea" ? decodeEntities(raw) : raw, parent: node });
      if (cur() === node) stack.pop();
      if (end < 0) {
        i = textStart = n;
      } else {
        const close = html.indexOf(">", end);
        i = textStart = close < 0 ? n : close + 1;
      }
    }
  }
  flushText(n);
  return doc;
}

// ---------- DOM helpers ----------

function walk(node, fn) {
  // iterative pre-order walk; fn returning false skips the children
  const todo = [node];
  while (todo.length) {
    const x = todo.pop();
    if (fn(x) === false || x.type !== 1) continue;
    for (let k = x.children.length - 1; k >= 0; k--) todo.push(x.children[k]);
  }
}

function findAll(root, pred) {
  const out = [];
  walk(root, (x) => {
    if (x.type === 1 && pred(x)) out.push(x);
  });
  return out;
}

function byTag(root, tag) {
  return findAll(root, (x) => x.tag === tag);
}

function first(root, pred) {
  let found = null;
  walk(root, (x) => {
    if (found) return false;
    if (x.type === 1 && pred(x)) {
      found = x;
      return false;
    }
  });
  return found;
}

function textOf(node) {
  if (node.type === 3) return node.text;
  let s = "";
  walk(node, (x) => {
    if (x.type === 3) s += x.text;
    else if (x.tag === "script" || x.tag === "style") return false;
  });
  return s;
}

function cleanText(s) {
  return s.replace(/\s+/g, " ").trim();
}

function remove(node) {
  const p = node.parent;
  if (!p) return;
  const k = p.children.indexOf(node);
  if (k >= 0) p.children.splice(k, 1);
  node.parent = null;
}

// Remove many nodes at once: one pass per parent instead of indexOf + splice per node (quadratic).
function removeAll(nodes) {
  const parents = new Set();
  for (const x of nodes) {
    if (!x.parent) continue;
    x._gone = true;
    parents.add(x.parent);
  }
  for (const p of parents) p.children = p.children.filter((c) => !c._gone);
  for (const x of nodes) {
    if (x._gone) x.parent = null;
    delete x._gone;
  }
}

function replaceWithChildren(node) {
  const p = node.parent;
  if (!p) return;
  const k = p.children.indexOf(node);
  for (const c of node.children) c.parent = p;
  p.children.splice(k, 1, ...node.children);
}

function isInside(node, tags) {
  for (let p = node.parent; p; p = p.parent) if (p.type === 1 && tags.has(p.tag)) return true;
  return false;
}

function attr(node, name) {
  return (node.attrs && node.attrs[name]) || "";
}

// ---------- URLs ----------

function resolveURL(href, base) {
  href = String(href || "").trim().replace(/[\t\n\r]/g, "");
  if (!href) return "";
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return href;
  if (href.startsWith("\\") || href.startsWith("/\\")) href = href.replace(/\\/g, "/"); // browsers read "\\host" as "//host"
  const m = /^([a-z][a-z0-9+.-]*:)(\/\/[^/?#]*)?([^?#]*)(\?[^#]*)?(#.*)?$/i.exec(base || "");
  if (!m) return href;
  const [, scheme, authority = "", path = "/", query = ""] = m;
  if (href.startsWith("//")) return scheme + href;
  if (href.startsWith("#")) return scheme + authority + path + query + href;
  if (href.startsWith("?")) return scheme + authority + path + href;
  let rest = href, suffix = "";
  const q = rest.search(/[?#]/);
  if (q >= 0) {
    suffix = rest.slice(q);
    rest = rest.slice(0, q);
  }
  let full = rest.startsWith("/") ? rest : path.replace(/[^/]*$/, "") + rest;
  const out = [];
  const parts = full.split("/");
  parts.forEach((seg, idx) => {
    if (seg === "..") {
      if (out.length > 1) out.pop();
    } else if (seg !== "." || idx === parts.length - 1) {
      out.push(seg === "." ? "" : seg);
    }
  });
  full = out.join("/");
  if (!full.startsWith("/")) full = "/" + full;
  return scheme + authority + full + suffix;
}

// ---------- metadata ----------

function metaContent(doc, keys) {
  const metas = byTag(doc, "meta");
  for (const k of keys) {
    for (const m of metas) {
      const name = (attr(m, "property") || attr(m, "name") || attr(m, "itemprop")).toLowerCase();
      if (name === k && attr(m, "content").trim()) return cleanText(attr(m, "content"));
    }
  }
  return "";
}

function jsonLD(doc) {
  const found = [];
  for (const s of byTag(doc, "script")) {
    if (!/ld\+json/i.test(attr(s, "type"))) continue;
    try {
      const data = JSON.parse(textOf(s).trim().replace(/^<!--|-->$/g, ""));
      const queue = Array.isArray(data) ? data.slice() : [data];
      while (queue.length) {
        const o = queue.shift();
        if (!o || typeof o !== "object") continue;
        if (Array.isArray(o["@graph"])) queue.push(...o["@graph"]);
        const type = [].concat(o["@type"] || []).join(" ");
        if (/Article|BlogPosting|Report|Posting|WebPage|Recipe|HowTo/i.test(type)) found.push(o);
      }
    } catch (e) {
      // ignore invalid JSON-LD
    }
  }
  found.sort((a, b) => (/Article|Posting/i.test([].concat(b["@type"]).join()) ? 1 : 0) - (/Article|Posting/i.test([].concat(a["@type"]).join()) ? 1 : 0));
  return found[0] || null;
}

function names(v) {
  if (!v) return [];
  if (typeof v === "string") return [v];
  if (Array.isArray(v)) return v.flatMap(names);
  if (typeof v === "object" && v.name) return names(v.name);
  return [];
}

function isoDate(s) {
  if (!s) return "";
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(s.trim());
  if (m) return m[1];
  const t = Date.parse(s);
  if (isNaN(t)) return "";
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function getMetadata(doc) {
  const ld = jsonLD(doc) || {};
  const titleTag = first(doc, (x) => x.tag === "title");
  const rawTitle = titleTag ? cleanText(textOf(titleTag)) : "";
  const site = metaContent(doc, ["og:site_name", "application-name"]) || names(ld.publisher)[0] || "";
  let title = metaContent(doc, ["og:title", "twitter:title"]) || (typeof ld.headline === "string" ? cleanText(ld.headline) : "") || rawTitle;
  if (title === rawTitle) {
    // "Article title | Site" → "Article title"
    const parts = title.split(/\s+[|\-–—·•»:]\s+/);
    if (parts.length > 1) {
      const lastPart = parts[parts.length - 1];
      if ((site && lastPart.toLowerCase() === site.toLowerCase()) || lastPart.split(" ").length <= 3) {
        const rest = title.slice(0, title.length - lastPart.length).replace(/\s+[|\-–—·•»:]\s+$/, "");
        if (rest.split(" ").length >= 2) title = rest;
      }
    }
  }
  const h1s = byTag(doc, "h1").map((h) => cleanText(textOf(h))).filter(Boolean);
  if (!title && h1s.length) title = h1s[0];
  let author = names(ld.author).map(cleanText).filter(Boolean).join(", ") ||
    metaContent(doc, ["author", "article:author", "parsely-author", "sailthru.author", "dc.creator", "twitter:creator"]);
  if (/^https?:\/\//.test(author)) author = "";
  if (!author) {
    const a = first(doc, (x) => attr(x, "rel") === "author" || attr(x, "itemprop") === "author" || /\b(byline|author-name)\b/i.test(attr(x, "class")));
    if (a) {
      const t = cleanText(textOf(a)).replace(/^by\s+/i, "");
      if (t && t.length < 80) author = t;
    }
  }
  let date = isoDate(ld.datePublished || "") || isoDate(metaContent(doc, ["article:published_time", "og:article:published_time", "datepublished", "date", "dc.date", "pubdate", "publish-date", "sailthru.date", "parsely-pub-date"]));
  if (!date) {
    const t = first(doc, (x) => x.tag === "time" && (attr(x, "datetime") || "").length >= 10);
    if (t) date = isoDate(attr(t, "datetime"));
  }
  const htmlEl = first(doc, (x) => x.tag === "html");
  const baseEl = first(doc, (x) => x.tag === "base" && attr(x, "href"));
  const canonical = first(doc, (x) => x.tag === "link" && /\bcanonical\b/i.test(attr(x, "rel")) && attr(x, "href"));
  return {
    title: title.slice(0, 300),
    author: author.slice(0, 200),
    date,
    site: site.slice(0, 120),
    description: (metaContent(doc, ["og:description", "description", "twitter:description"]) || "").slice(0, 500),
    lang: htmlEl ? attr(htmlEl, "lang") : "",
    base: baseEl ? attr(baseEl, "href") : "",
    canonical: canonical ? attr(canonical, "href") : "",
  };
}

// ---------- content extraction (Readability-style) ----------

const UNLIKELY = /-ad-|\bads?\b|ad-break|advert|agegate|banner|breadcrumb|combx|comment|community|consent|cookie|cover-wrap|disqus|donat|editsection|edit-section|extra|footer|gdpr|header|hidden|legends|masthead|menu|modal|newsletter|outbrain|pager|pagination|paywall|popup|promo|related|remark|replies|rss|share|shoutbox|sidebar|skip|skyscraper|social|sponsor|subscribe|supplemental|taboola|toolbar|tooltip|trending|widget|yom-remote/i;
const MAYBE = /and|article|body|column|content|main|mathjax|shadow|post|entry|story|text|prose|markdown|docs?\b/i;
const POSITIVE = /article|body|content|entry|hentry|h-entry|main|page|pagination|post|text|blog|story|prose|markdown/i;
const NEGATIVE = /-ad-|hidden|^hid$| hid$| hid |^hid |banner|combx|comment|com-|contact|footer|gdpr|masthead|media|meta|outbrain|promo|related|scroll|share|shoutbox|sidebar|skyscraper|sponsor|shopping|tags|widget|byline|author|dateline|subscribe/i;
const JUNK_TAGS = new Set(["script", "style", "noscript", "template", "svg", "canvas", "object", "embed", "applet", "link", "meta",
  "head", "nav", "aside", "footer", "dialog", "button", "select", "textarea", "input", "form-control", "map", "area", "frame", "frameset", "portal"]);
const INVISIBLE_TAGS = new Set(["script", "style", "template", "svg", "canvas", "object", "embed", "applet", "link", "meta", "head",
  "button", "select", "textarea", "input", "map", "area", "frame", "frameset", "dialog"]);
const JUNK_ROLES = /^(navigation|banner|contentinfo|complementary|dialog|alertdialog|menu|menubar|search|toolbar|tablist|button)$/i;
const KEEP_TAGS = new Set(["body", "html", "article", "main", "table", "tbody", "thead", "tr", "td", "th", "pre", "code", "figure", "picture", "img"]);

function classWeight(node) {
  let w = 0;
  for (const v of [attr(node, "class"), attr(node, "id")]) {
    if (!v) continue;
    if (NEGATIVE.test(v)) w -= 25;
    if (POSITIVE.test(v)) w += 25;
  }
  return w;
}

function isHidden(node) {
  const style = attr(node, "style").replace(/\s+/g, "").toLowerCase();
  return "hidden" in node.attrs || attr(node, "aria-hidden") === "true" || /display:none|visibility:hidden/.test(style);
}

function embedLink(node, base) {
  // Replace video embeds with a paragraph linking to the video.
  const src = resolveURL(attr(node, "src") || attr(node, "data-src"), base);
  if (!/youtube(-nocookie)?\.com\/embed\/|player\.vimeo\.com|youtu\.be|loom\.com\/embed|dailymotion\.com\/embed/i.test(src)) return null;
  let url = src;
  const yt = /youtube(?:-nocookie)?\.com\/embed\/([\w-]{11})/i.exec(src);
  if (yt) url = `https://www.youtube.com/watch?v=${yt[1]}`;
  const p = el("p", {}, null);
  const a = el("a", { href: url }, p);
  a.children.push({ type: 3, text: attr(node, "title") || "Video", parent: a });
  p.children.push(a);
  return p;
}

// Remove chrome (navigation, ads, hidden and interactive elements) in place.
function prepare(root, base, light) {
  const doomed = [], unwrap = [], swaps = [];
  const total = stats(root).len;
  walk(root, (x) => {
    if (x.type !== 1) return;
    if (x.tag === "iframe") {
      const p = embedLink(x, base);
      if (p) swaps.push([x, p]);
      else doomed.push(x);
      return false;
    }
    if (x.tag === "noscript") {
      // lazy-loading pages put the real <img> inside <noscript>; keep it unless a loaded <img> precedes it
      const siblings = x.parent.children.slice(0, x.parent.children.indexOf(x)).filter((c) => c.type === 1 || c.text.trim());
      const prev = siblings[siblings.length - 1];
      const hasImg = first(x, (y) => y.tag === "img");
      if (hasImg && !(prev && prev.type === 1 && prev.tag === "img" && /^(https?:)?\/\/|^\//i.test(attr(prev, "src")))) unwrap.push(x);
      else doomed.push(x);
      return false;
    }
    if (x.tag === "input" && attr(x, "type").toLowerCase() === "checkbox" && isInside(x, new Set(["li"]))) return;
    if (light) {
      // whole page: drop only what is never visible or interactive
      if (INVISIBLE_TAGS.has(x.tag) || isHidden(x)) {
        doomed.push(x);
        return false;
      }
      return;
    }
    if (JUNK_TAGS.has(x.tag) || isHidden(x) || JUNK_ROLES.test(attr(x, "role"))) {
      doomed.push(x);
      return false;
    }
    if (x.tag === "header" && !isInside(x, new Set(["article", "main"]))) {
      doomed.push(x);
      return false;
    }
    if (x.tag === "form" && !isInside(x, new Set(["article", "main"]))) {
      // ASP.NET-style pages wrap the whole page in a form: keep it if it holds the text
      if (cleanText(textOf(x)).length < 500) {
        doomed.push(x);
        return false;
      }
    }
    if (!KEEP_TAGS.has(x.tag) && !/^h[1-6]$/.test(x.tag)) {
      const ci = `${attr(x, "class")} ${attr(x, "id")}`;
      if (ci.trim() && UNLIKELY.test(ci) && !MAYBE.test(ci) && !holdsArticle(x, total)) {
        doomed.push(x);
        return false;
      }
    }
  });
  removeAll(doomed);
  unwrap.forEach(replaceWithChildren);
  clearStats(root);
  for (const [a, b] of swaps) {
    const p = a.parent;
    if (!p) continue;
    b.parent = p;
    p.children[p.children.indexOf(a)] = b;
  }
}

// A wrapper whose class looks like chrome ("sidebar-layout") but holds the article must stay.
function holdsArticle(node, total) {
  if (first(node, (y) => y.tag === "main" || y.tag === "article" || y.tag === "h1" || /articleBody/i.test(attr(y, "itemprop")))) return true;
  return total > 0 && stats(node).len > 0.35 * total;
}

const LINK_TAGS = new Set(["a"]);

function stats(node) {
  // text length, link text length, commas (cached per extraction pass)
  if (node._stats) return node._stats;
  let len = 0, linkLen = 0, commas = 0;
  walk(node, (x) => {
    if (x.type === 3) {
      const t = x.text.replace(/\s+/g, " ");
      len += t.length;
      commas += (t.match(/[,،，]/g) || []).length;
      if (isInside(x, LINK_TAGS)) linkLen += t.length;
    }
  });
  node._stats = { len, linkLen, commas, density: len ? linkLen / len : 0 };
  return node._stats;
}

function clearStats(root) {
  walk(root, (x) => {
    if (x.type === 1) {
      delete x._stats;
      delete x._score;
    }
  });
}

function hasBlockChild(node) {
  return node.children.some((c) => c.type === 1 && BLOCK.has(c.tag));
}

function initialScore(node) {
  let s = 0;
  switch (node.tag) {
    case "div": case "article": case "main": case "section": s = 5; break;
    case "pre": case "td": case "blockquote": s = 3; break;
    case "address": case "ol": case "ul": case "dl": case "dd": case "dt": case "li": case "form": s = -3; break;
    case "h1": case "h2": case "h3": case "h4": case "h5": case "h6": case "th": s = -5; break;
  }
  return s + classWeight(node);
}

function scoreCandidates(root) {
  const candidates = [];
  const paras = findAll(root, (x) => ["p", "pre", "td", "blockquote"].includes(x.tag) ||
    ((x.tag === "div" || x.tag === "section") && !hasBlockChild(x)));
  for (const p of paras) {
    const st = stats(p);
    const text = cleanText(textOf(p));
    if (text.length < 25) continue;
    let score = 1 + st.commas + Math.min(Math.floor(text.length / 100), 3);
    if (p.tag === "pre") score += 3;
    let anc = p.parent, level = 0;
    while (anc && anc.type === 1 && anc.tag !== "#document" && level < 3) {
      if (anc._score === undefined) {
        anc._score = initialScore(anc);
        candidates.push(anc);
      }
      anc._score += level === 0 ? score : level === 1 ? score / 2 : score / (level * 3);
      anc = anc.parent;
      level++;
    }
  }
  let best = null, bestScore = -Infinity;
  for (const c of candidates) {
    const s = c._score * (1 - stats(c).density);
    c._final = s;
    if (s > bestScore) {
      bestScore = s;
      best = c;
    }
  }
  // If the best node's parent also scores well, it probably holds more of the article.
  while (best && best.parent && best.parent._final !== undefined && best.parent.tag !== "body" &&
    best.parent._final > bestScore * 0.75 && stats(best.parent).density < 0.35) {
    best = best.parent;
    bestScore = best._final;
  }
  return best;
}

// Drop link farms, empty wrappers and share bars inside the chosen content.
function cleanContent(root) {
  const doomed = [];
  walk(root, (x) => {
    if (x.type !== 1 || x === root) return;
    if (["div", "section", "ul", "ol", "table", "p", "span"].includes(x.tag)) {
      if (x.tag === "table" && first(x, (y) => y.tag === "th")) return false;
      const st = stats(x);
      const hasMedia = first(x, (y) => ["img", "pre", "table", "video", "picture", "math", "code"].includes(y.tag));
      const links = byTag(x, "a").length;
      if (classWeight(x) < 0 && !hasMedia && st.len < 1000) {
        doomed.push(x);
        return false;
      }
      if (!hasMedia && links >= 3 && st.density > 0.75 && st.len < 300 && x.tag !== "p") {
        doomed.push(x);
        return false;
      }
      if (!hasMedia && st.len === 0 && !first(x, (y) => y.tag === "br" || y.tag === "hr" || y.tag === "input")) {
        doomed.push(x);
        return false;
      }
    }
  });
  removeAll(doomed);
}

function extractContent(doc, base) {
  const body = first(doc, (x) => x.tag === "body") || doc;
  prepare(body, base);
  clearStats(body);
  const total = stats(body).len;
  let chosen = null;
  const articleBody = first(body, (x) => /articleBody/i.test(attr(x, "itemprop")));
  if (articleBody && stats(articleBody).len > 200) chosen = articleBody;
  if (!chosen) {
    const articles = byTag(body, "article").filter((a) => stats(a).len > 200 && !isInside(a, new Set(["article"])));
    if (articles.length === 1) chosen = articles[0];
    else if (articles.length > 1) {
      articles.sort((a, b) => stats(b).len - stats(a).len);
      if (stats(articles[0]).len > 0.6 * articles.reduce((s, a) => s + stats(a).len, 0)) chosen = articles[0];
    }
  }
  let merged = false;
  if (!chosen) {
    const scored = scoreCandidates(body);
    const main = first(body, (x) => x.tag === "main" || attr(x, "role") === "main");
    if (main && stats(main).len > 200 && (!scored || (isInsideNode(scored, main) && stats(scored).len < 0.5 * stats(main).len))) chosen = main;
    else if (scored) {
      chosen = withSiblings(scored);
      merged = chosen !== scored;
    }
  }
  if (!chosen || stats(chosen).len < Math.min(250, total * 0.3)) {
    chosen = body;
    merged = false;
  }
  cleanContent(chosen);
  if (merged) chosen.children = chosen.children.filter((c) => c.parent); // drop what cleaning removed
  return { node: chosen, textLength: cleanText(textOf(chosen)).length };
}

// Readability's sibling pass: content split over sibling sections (<section>…</section><section>…)
// joins the best candidate when those siblings score well or read like paragraphs.
function withSiblings(best) {
  const parent = best.parent;
  if (!parent || parent.tag === "#document") return best;
  const threshold = Math.max(10, (best._final || 0) * 0.2);
  const picked = [];
  for (const sib of parent.children) {
    if (sib === best) {
      picked.push(sib);
      continue;
    }
    if (sib.type !== 1) continue;
    const st = stats(sib);
    let take = sib._final !== undefined && sib._final >= threshold;
    if (!take && (sib.tag === "p" || sib.tag === "section" || sib.tag === "div" || /^h[1-6]$|^(ul|ol|pre|blockquote|figure|table)$/.test(sib.tag))) {
      const text = cleanText(textOf(sib));
      take = (st.len > 80 && st.density < 0.25) || (st.len > 0 && st.len <= 80 && st.density === 0 && /[.!?:]$/.test(text)) ||
        (/^h[1-6]$|^(pre|figure|table)$/.test(sib.tag) && st.density < 0.5 && picked.length > 0);
    }
    if (take && classWeight(sib) >= 0) picked.push(sib);
  }
  if (picked.length <= 1) return best;
  const wrapper = el("div", {}, null);
  wrapper.children = picked; // a view over the siblings: their parent links stay intact
  return wrapper;
}

function isInsideNode(node, ancestor) {
  for (let p = node; p; p = p.parent) if (p === ancestor) return true;
  return false;
}

// ---------- HTML → Markdown ----------

function realSrc(img) {
  for (const k of ["data-src", "data-lazy-src", "data-original", "data-srcset", "data-lazy", "src"]) {
    let v = attr(img, k).trim();
    if (!v) continue;
    if (k.endsWith("srcset")) v = pickSrcset(v);
    if (/^data:/i.test(v)) continue;
    if (v) return v;
  }
  const set = attr(img, "srcset");
  return set ? pickSrcset(set) : "";
}

function pickSrcset(set) {
  let best = "", bestW = -1;
  for (const part of set.split(/,\s+(?=\S)/)) {
    const [u, d] = part.trim().split(/\s+/);
    const w = d ? parseFloat(d) * (/x$/.test(d) ? 1000 : 1) : 1;
    if (u && !/^data:/i.test(u) && w > bestW) {
      best = u;
      bestW = w;
    }
  }
  return best;
}

function escapeText(t) {
  let s = t.replace(/\\/g, "\\\\").replace(/\*/g, "\\*").replace(/`/g, "\\`").replace(/\[/g, "\\[").replace(/\]/g, "\\]");
  s = s.replace(/<(?=[A-Za-z/!?])/g, "\\<").replace(/&(?=#?\w+;)/g, "\\&");
  s = s.replace(/~~/g, "\\~\\~");
  // underscores only matter at word boundaries (snake_case stays readable)
  s = s.replace(/_/g, (m, off, str) => {
    const a = str[off - 1] || "", b = str[off + 1] || "";
    return /[A-Za-z0-9]/.test(a) && /[A-Za-z0-9]/.test(b) ? "_" : "\\_";
  });
  return s;
}

// Escape characters that would start a Markdown block at the beginning of a paragraph line.
function escapeLineStarts(s) {
  return s.split("\n").map((line) => line
    .replace(/^(\s*)([#>+-])(?=\s|$)/, "$1\\$2")
    .replace(/^(\s*)(=+|-{3,})\s*$/, (m, sp, r) => sp + "\\" + r)
    .replace(/^(\s*\d+)([.)])(?=\s|$)/, "$1\\$2")
    .replace(/^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/, (m) => (m.includes("|") ? m.replace(/\|/g, "\\|") : m))).join("\n");
}

function urlForMarkdown(u) {
  return u.replace(/ /g, "%20").replace(/\(/g, "%28").replace(/\)/g, "%29").replace(/</g, "%3C").replace(/>/g, "%3E").replace(/\\/g, "%5C");
}

// Only web, mail and phone links survive: javascript:, vbscript:, data:, file: and unknown schemes
// (also when hidden with whitespace, control characters or entities) never become Markdown links.
const SAFE_SCHEME = /^(https?|mailto|tel|ftp):/i;
function safeURL(u) {
  // as browsers do: trim C0 controls and spaces, drop tabs and newlines anywhere; then allow-list the scheme
  const clean = String(u || "").replace(/^[\u0000-\u0020]+|[\u0000-\u0020]+$/g, "").replace(/[\t\n\r]/g, "");
  return SAFE_SCHEME.test(clean) ? clean : "";
}

function titleAttr(node) {
  const t = cleanText(attr(node, "title"));
  return t ? ` "${t.replace(/[\\"]/g, "\\$&")}"` : "";
}

function codeLanguage(pre) {
  const nodes = [pre, ...findAll(pre, (x) => x.tag === "code")];
  if (pre.parent) nodes.push(pre.parent);
  if (pre.parent && pre.parent.parent) nodes.push(pre.parent.parent); // Sphinx: div.highlight-python > div.highlight > pre
  for (const n of nodes) {
    const dl = attr(n, "data-lang") || attr(n, "data-language") || attr(n, "lang");
    if (dl && /^[\w+#.-]{1,30}$/.test(dl)) return dl.toLowerCase();
    const tokens = attr(n, "class").split(/\s+/);
    for (let k = 0; k < tokens.length; k++) {
      const t = tokens[k];
      let m = /^(?:language|lang)-([\w+#.-]+)$/i.exec(t) || // Prism, highlight.js, CommonMark
        /^highlight-(?:source|text)-([\w+#]+)/i.exec(t) || // GitHub: highlight-source-js, highlight-text-html-basic
        /^highlight-(?!source|text)([\w+#]+)$/i.exec(t) || // Sphinx/Pygments: highlight-python
        /^brush:([\w+#]+);?$/i.exec(t); // SyntaxHighlighter: brush:js
      if (!m && /^brush:$/i.test(t) && tokens[k + 1]) m = [t, tokens[k + 1].replace(/;$/, "")];
      if (m && !/^(plaintext|plain|none|text|nohighlight|default|notranslate)$/i.test(m[1])) return m[1].toLowerCase();
    }
  }
  return "";
}

function preText(node) {
  let s = "";
  walk(node, (x) => {
    if (x.type === 3) s += x.text;
    else if (x.tag === "br") s += "\n";
    else if (x.type === 1 && x !== node && (x.tag === "div" || x.tag === "p") && s && !s.endsWith("\n")) s += "\n";
  });
  return s;
}

function fenceFor(code, ch = "`") {
  const runs = code.match(new RegExp(`${ch === "`" ? "`" : "~"}+`, "g")) || [];
  const longest = runs.reduce((m, r) => Math.max(m, r.length), 0);
  return ch.repeat(Math.max(3, longest + 1));
}

function hasBlockDescendant(node) {
  return !!first(node, (y) => y !== node && BLOCK.has(y.tag));
}

function isLayoutTable(t) {
  if (attr(t, "role") === "presentation" || attr(t, "role") === "none") return true;
  if (first(t, (x) => x !== t && x.tag === "table")) return true;
  const rows = findAll(t, (x) => x.tag === "tr");
  if (!rows.length) return true;
  const maxCols = Math.max(...rows.map((r) => r.children.filter((c) => c.type === 1 && (c.tag === "td" || c.tag === "th")).length));
  if (maxCols <= 1) return true;
  return false;
}

const INLINE_CONTENT = new Set(["img", "picture", "math", "input", "svg", "iframe"]);

// Collapse whitespace like a browser does (outside <pre>), trimming at block boundaries.
function collapseWhitespace(root) {
  let prevText = null, atBoundary = true;
  const visit = (node) => {
    for (let k = 0; k < node.children.length; k++) {
      const x = node.children[k];
      if (x.type === 3) {
        let t = x.text.replace(/[\u200b\ufeff]/g, "").replace(/[ \t\n\r\f]+/g, " ");
        if (atBoundary && t.startsWith(" ")) t = t.slice(1);
        x.text = t;
        if (!t) continue;
        prevText = x;
        atBoundary = t.endsWith(" ");
        continue;
      }
      if (x.type !== 1) continue;
      if (x.tag === "pre" || x.tag === "textarea") {
        boundary();
        continue;
      }
      if (INLINE_CONTENT.has(x.tag)) {
        // images and formulas are content: spaces around them matter
        prevText = null;
        atBoundary = false;
        continue;
      }
      const block = BLOCK.has(x.tag) || x.tag === "br" || x.tag === "hr";
      if (block) boundary();
      if (x.tag === "code") {
        // inline code keeps single spaces but still joins the text flow
        visit(x);
        continue;
      }
      visit(x);
      if (block) boundary();
    }
  };
  const boundary = () => {
    if (prevText) prevText.text = prevText.text.replace(/ $/, "");
    prevText = null;
    atBoundary = true;
  };
  visit(root);
}

// Concatenate inline Markdown without doubling the space between pieces ("[x] " + " Kettle").
function joinInline(a, b) {
  return a.endsWith(" ") && !a.endsWith("  \n") && b.startsWith(" ") ? a + b.slice(1) : a + b;
}

// "Array.prototype.map()" and "Array.prototype.map() - JavaScript" are the same title.
function sameTitle(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const [short, long] = a.length < b.length ? [a, b] : [b, a];
  return short.length >= 8 && short.length >= long.length * 0.5 && (long.startsWith(short) || long.endsWith(short));
}

class MarkdownConverter {
  constructor(base, opts = {}) {
    this.base = base;
    this.title = opts.title ? cleanText(opts.title).toLowerCase() : "";
    this.skippedTitle = false;
  }

  // "" when the link is unsafe (javascript:, data:, file:…): callers then keep only the text
  url(u) {
    const safe = safeURL(resolveURL(u, this.base));
    return safe ? urlForMarkdown(safe) : "";
  }

  // Convert children into blocks ({text, kind}); inline runs become paragraphs.
  blocks(node, ctx) {
    const out = [];
    let inline = "";
    const flush = () => {
      const t = inline.replace(/(?: *\n){2,}/g, "\n\n").replace(/^(?: {2}\n|\s)+|(?: {2}\n|\s)+$/g, "");
      if (t) out.push({ text: ctx.inTable ? t : escapeLineStarts(t), kind: "p" });
      inline = "";
    };
    for (const c of node.children) {
      if (c.type === 3) {
        inline = joinInline(inline, ctx.code ? c.text : escapeText(c.text));
        continue;
      }
      if (c.type !== 1) continue;
      const r = this.element(c, ctx);
      if (r == null) continue;
      if (r.block) {
        flush();
        if (r.text) out.push({ text: r.text, kind: r.kind || "block" });
      } else inline = joinInline(inline, r.text);
    }
    flush();
    return out;
  }

  join(blocks, tight) {
    let s = "";
    blocks.forEach((b, k) => {
      if (k) s += tight && (b.kind === "list" || blocks[k - 1].kind === "list") ? "\n" : "\n\n";
      s += b.text;
    });
    return s;
  }

  children(node, ctx) {
    return this.join(this.blocks(node, ctx));
  }

  inline(node, ctx) {
    // inline content of an element; nested blocks are flattened to one line
    return this.children(node, ctx).replace(/\n{2,}/g, " ").replace(/ {2}\n/g, " ").replace(/\n/g, " ").trim();
  }

  wrapInline(content, mark) {
    const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(content);
    if (!m[2]) return content;
    return `${m[1]}${mark}${m[2]}${mark}${m[3]}`;
  }

  element(x, ctx) {
    const tag = x.tag;
    const block = (text, kind) => ({ block: true, text, kind });
    const inl = (text) => ({ block: false, text });
    switch (tag) {
      case "h1": case "h2": case "h3": case "h4": case "h5": case "h6": {
        const t = this.inline(x, Object.assign({}, ctx, { heading: true }));
        if (!t) return null;
        if (!this.skippedTitle && this.title && sameTitle(cleanText(textOf(x)).toLowerCase(), this.title)) {
          this.skippedTitle = true; // the title is already the document heading
          return null;
        }
        if (ctx.inTable) return inl(`**${t}**`);
        return block(`${"#".repeat(Number(tag[1]))} ${t}`);
      }
      case "p": case "div": case "section": case "article": case "main": case "header": case "center": case "address":
      case "hgroup": case "search": case "body": case "html": case "form": case "fieldset": case "legend": {
        const t = this.children(x, ctx);
        return block(t);
      }
      case "br":
        return inl(ctx.inTable ? "<br>" : "  \n");
      case "hr":
        return block("---");
      case "blockquote": {
        const t = this.children(x, ctx);
        if (!t) return null;
        return block(t.split("\n").map((l) => (l ? `> ${l}` : ">")).join("\n"));
      }
      case "ul": case "ol":
        return this.list(x, ctx);
      case "li": {
        // stray <li> without a list
        return block(`- ${this.join(this.blocks(x, ctx), true).replace(/\n/g, "\n  ")}`);
      }
      case "pre": {
        const code = preText(x).replace(/\n$/, "");
        if (!code.trim()) return null;
        const fence = fenceFor(code);
        return block(`${fence}${codeLanguage(x)}\n${code}\n${fence}`, "code");
      }
      case "code": case "kbd": case "samp": case "tt": {
        if (isInside(x, new Set(["pre"]))) return inl(textOf(x));
        const code = textOf(x).replace(/\s+/g, " ");
        if (!code.trim()) return inl(code);
        const runs = code.match(/`+/g) || [];
        const n = runs.length ? Math.max(...runs.map((r) => r.length)) + 1 : 1;
        const tick = "`".repeat(n);
        const pad = /^`|`$/.test(code) || (/^ .* $/.test(code) && code.trim()) ? " " : "";
        return inl(`${tick}${pad}${code}${pad}${tick}`);
      }
      case "strong": case "b": {
        if (ctx.strong) return inl(this.inlineKeepSpace(x, ctx));
        return inl(this.wrapInline(this.inlineKeepSpace(x, Object.assign({}, ctx, { strong: true })), "**"));
      }
      case "em": case "i": case "dfn": case "var": {
        if (ctx.em) return inl(this.inlineKeepSpace(x, ctx));
        return inl(this.wrapInline(this.inlineKeepSpace(x, Object.assign({}, ctx, { em: true })), "*"));
      }
      case "del": case "s": case "strike":
        return inl(this.wrapInline(this.inlineKeepSpace(x, ctx), "~~"));
      case "sub": case "sup": {
        const t = this.inlineKeepSpace(x, ctx);
        if (!t.trim()) return inl(t);
        if (first(x, (y) => y.tag === "a")) return inl(t);
        return inl(`<${tag}>${t.trim()}</${tag}>`);
      }
      case "q":
        return inl(`“${this.inlineKeepSpace(x, ctx)}”`);
      case "a":
        return this.link(x, ctx);
      case "img":
        return this.image(x);
      case "picture": {
        const img = first(x, (y) => y.tag === "img");
        if (img && realSrc(img)) return this.image(img);
        const src = first(x, (y) => y.tag === "source" && attr(y, "srcset"));
        const u = src ? this.url(pickSrcset(attr(src, "srcset"))) : "";
        return u ? inl(`![${escapeText(cleanText(attr(img || {}, "alt")))}](${u})`) : null;
      }
      case "figure": {
        const parts = [];
        const cap = first(x, (y) => y.tag === "figcaption");
        const inner = this.blocks({ children: x.children.filter((c) => c !== cap) }, ctx);
        if (inner.length) parts.push(this.join(inner));
        if (cap) {
          const t = this.inline(cap, ctx);
          if (t) parts.push(`*${t.replace(/^\*+|\*+$/g, "")}*`);
        }
        return parts.length ? block(parts.join("\n\n")) : null;
      }
      case "figcaption": {
        const t = this.inline(x, ctx);
        return t ? block(`*${t}*`) : null;
      }
      case "table":
        return this.table(x, ctx);
      case "caption": case "thead": case "tbody": case "tfoot": case "tr": case "td": case "th":
        return block(this.children(x, ctx));
      case "dl":
        return block(this.children(x, ctx));
      case "dt": {
        const t = this.inline(x, ctx);
        return t ? block(`**${t}**`) : null;
      }
      case "dd": {
        const t = this.children(x, ctx);
        return t ? block(`: ${t.replace(/\n/g, "\n  ")}`) : null;
      }
      case "details":
        return block(this.children(x, ctx));
      case "summary": {
        const t = this.inline(x, ctx);
        return t ? block(`**${t}**`) : null;
      }
      case "input": {
        if (attr(x, "type").toLowerCase() === "checkbox") return inl("checked" in x.attrs ? "[x] " : "[ ] ");
        return null;
      }
      case "video": case "audio": {
        const src = this.url(attr(x, "src") || attr(first(x, (y) => y.tag === "source") || {}, "src"));
        if (!src) return null;
        const poster = this.url(attr(x, "poster"));
        const label = tag === "video" ? "Video" : "Audio";
        return block(poster ? `[![${label}](${poster})](${src})` : `[${label}](${src})`);
      }
      case "math": {
        const ann = first(x, (y) => y.tag === "annotation" && /tex/i.test(attr(y, "encoding")));
        const tex = attr(x, "alttext") || (ann ? textOf(ann) : "");
        if (!tex.trim()) return inl(escapeText(cleanText(textOf(x))));
        return attr(x, "display") === "block" ? block(`$$\n${tex.trim()}\n$$`) : inl(`$${tex.trim()}$`);
      }
      case "script": case "style": case "template": case "svg": case "noscript": case "title": case "head": case "button":
      case "select": case "option": case "textarea": case "iframe": case "canvas": case "source": case "track":
        return null;
      default: {
        if (BLOCK.has(tag) || hasBlockDescendant(x)) return block(this.children(x, ctx));
        // unknown inline element (span, font, mark, abbr, u, small, time, label…): keep its content inline
        return inl(this.inlineKeepSpace(x, ctx));
      }
    }
  }

  // Inline content that keeps its leading/trailing space (so "a <b>b</b> c" keeps both spaces).
  inlineKeepSpace(x, ctx) {
    let s = "";
    for (const c of x.children) {
      if (c.type === 3) s += ctx.code ? c.text : escapeText(c.text);
      else if (c.type === 1) {
        const r = this.element(c, ctx);
        if (r) s += r.block ? ` ${r.text.replace(/\n+/g, " ")} ` : r.text;
      }
    }
    return s.replace(/ {2,}(?!\n)/g, " "); // keep "  \n" hard breaks
  }

  link(x, ctx) {
    const hrefRaw = attr(x, "href").trim();
    const href = hrefRaw ? this.url(hrefRaw) : ""; // "" for javascript:, data: and other unsafe links
    if (hasBlockDescendant(x) && !ctx.inTable && !href) return { block: true, text: this.children(x, ctx) };
    if (hasBlockDescendant(x) && !ctx.inTable && href) {
      // card links (<a><h3>Title</h3><p>Summary</p></a>): link the heading, keep the rest as blocks
      const blocks = this.blocks(x, ctx);
      if (!blocks.length) return null;
      const b0 = blocks[0];
      const hm = /^(#{1,6} )(.*)$/s.exec(b0.text);
      if (hm) b0.text = `${hm[1]}[${hm[2]}](${href})`;
      else if (b0.kind === "p") b0.text = `[${b0.text.replace(/\n+/g, " ")}](${href})`;
      else blocks.push({ text: `[${escapeText(cleanText(textOf(x)).slice(0, 80)) || href}](${href})`, kind: "p" });
      return { block: true, text: this.join(blocks) };
    }
    const content = this.inlineKeepSpace(x, ctx);
    const text = content.trim();
    if (!href && !(ctx.heading && hrefRaw.startsWith("#"))) return { block: false, text: content };
    if (!text) return { block: false, text: "" };
    // permalink anchors in headings ("## [Title](#title)", "¶", "#") add nothing
    if (ctx.heading && hrefRaw.startsWith("#")) return { block: false, text: /^[#¶§🔗\s]*$/u.test(cleanText(textOf(x))) ? "" : content };
    const lead = /^\s/.test(content) ? " " : "", trail = /\s$/.test(content) ? " " : "";
    return { block: false, text: `${lead}[${text.replace(/ {2}\n/g, " ")}](${href}${titleAttr(x)})${trail}` };
  }

  image(img) {
    const src = this.url(realSrc(img));
    if (!src) return null;
    const alt = escapeText(cleanText(attr(img, "alt")));
    return { block: false, text: `![${alt}](${src}${titleAttr(img)})` };
  }

  list(x, ctx) {
    if (ctx.inTable) {
      // GFM cells are one line: flatten (nested) lists into "• item" lines joined by <br>
      const lines = [];
      const collect = (list, depth) => {
        for (const li of list.children) {
          if (li.type !== 1) continue;
          if (li.tag === "ul" || li.tag === "ol") {
            collect(li, depth + 1);
            continue;
          }
          const own = { children: li.children.filter((c) => !(c.type === 1 && (c.tag === "ul" || c.tag === "ol"))) };
          const t = this.inline(own, ctx);
          if (t) lines.push(`${"\u00a0\u00a0".repeat(depth)}• ${t}`);
          for (const c of li.children) if (c.type === 1 && (c.tag === "ul" || c.tag === "ol")) collect(c, depth + 1);
        }
      };
      collect(x, 0);
      return lines.length ? { block: true, text: lines.join("\n"), kind: "list" } : null;
    }
    const ordered = x.tag === "ol";
    let n = parseInt(attr(x, "start"), 10);
    if (isNaN(n)) n = 1;
    const items = [];
    for (const li of x.children) {
      if (li.type === 3) {
        // text straight inside <ul> (invalid, but browsers show it; also where over-deep nesting is flattened)
        const t = li.text.trim();
        if (t) {
          if (items.length) items[items.length - 1] += " " + escapeText(t);
          else items.push(escapeLineStarts(escapeText(t)));
        }
        continue;
      }
      if (li.tag === "ul" || li.tag === "ol") {
        // a list directly nested in a list (invalid but common): indent it under the previous item
        const r = this.list(li, ctx);
        if (r && items.length) items[items.length - 1] += "\n" + r.text.replace(/^/gm, "  ").replace(/^ +$/gm, "");
        continue;
      }
      if (li.tag !== "li") {
        const r = this.element(li, ctx);
        if (r && r.text.trim() && items.length) items[items.length - 1] += " " + r.text.trim();
        continue;
      }
      const v = parseInt(attr(li, "value"), 10);
      if (ordered && !isNaN(v)) n = v;
      const marker = ordered ? `${n}. ` : "- ";
      n++;
      const body = this.join(this.blocks(li, ctx), true);
      const indent = " ".repeat(marker.length);
      items.push(marker + body.split("\n").map((l, k) => (k === 0 || !l ? l : indent + l)).join("\n"));
    }
    if (!items.length) return null;
    // loose items (multiple paragraphs) are separated by a blank line
    const loose = items.some((it) => /\n\n/.test(it));
    return { block: true, text: items.join(loose ? "\n\n" : "\n"), kind: "list" };
  }

  table(t, ctx) {
    if (ctx.inTable || isLayoutTable(t)) return { block: true, text: this.children(t, ctx) };
    const rows = [];
    const collect = (node) => {
      for (const c of node.children) {
        if (c.type !== 1) continue;
        if (c.tag === "tr") rows.push(c);
        else if (["thead", "tbody", "tfoot"].includes(c.tag)) collect(c);
      }
    };
    collect(t);
    const sub = Object.assign({}, ctx, { inTable: true });
    const grid = [], aligns = [];
    let headerRows = 0;
    const spans = []; // rowspan carry-over: column → remaining rows
    rows.forEach((tr, ri) => {
      const cells = [];
      let col = 0;
      const place = () => {
        while (spans[col] > 0) {
          cells.push("");
          spans[col]--;
          col++;
        }
      };
      for (const td of tr.children) {
        if (td.type !== 1 || (td.tag !== "td" && td.tag !== "th")) continue;
        place();
        const text = this.children(td, sub).replace(/\n+/g, "<br>").replace(/\|/g, "\\|").trim();
        const span = Math.min(parseInt(attr(td, "colspan"), 10) || 1, 50);
        const rspan = Math.min(parseInt(attr(td, "rowspan"), 10) || 1, 500);
        const align = (attr(td, "align") || (/text-align:\s*(left|right|center)/i.exec(attr(td, "style")) || [])[1] || "").toLowerCase();
        if (align && aligns[col] === undefined) aligns[col] = align;
        for (let s = 0; s < span; s++) {
          cells.push(s === 0 ? text : "");
          if (rspan > 1) spans[col] = rspan - 1;
          col++;
        }
      }
      while (col < spans.length) {
        if (spans[col] > 0) {
          cells.push("");
          spans[col]--;
        }
        col++;
      }
      const isHead = tr.parent.tag === "thead" || tr.children.filter((c) => c.type === 1).every((c) => c.tag === "th");
      if (isHead && ri === headerRows) headerRows++;
      grid.push(cells);
    });
    if (!grid.length) return null;
    const cols = Math.max(...grid.map((r) => r.length));
    if (!cols) return null;
    const pad = (r) => r.concat(Array(cols - r.length).fill(""));
    let head;
    let body;
    if (headerRows > 0) {
      // multiple header rows are merged into one
      head = pad(grid[0]).map((h, k) => grid.slice(0, headerRows).map((r) => r[k] || "").filter(Boolean).join(" "));
      body = grid.slice(headerRows);
    } else {
      head = pad(grid[0]);
      body = grid.slice(1);
    }
    const line = (r) => `| ${pad(r).map((c) => c || " ").join(" | ")} |`.replace(/ {2,}\|/g, " |").replace(/\| {2,}/g, "| ");
    const sep = `| ${Array.from({ length: cols }, (_, k) => ({ left: ":---", right: "---:", center: ":---:" }[aligns[k]] || "---")).join(" | ")} |`;
    const out = [line(head), sep, ...body.map(line)];
    const cap = first(t, (y) => y.tag === "caption");
    const capText = cap ? this.inline(cap, sub) : "";
    return { block: true, text: (capText ? `**${capText}**\n\n` : "") + out.join("\n"), kind: "table" };
  }

  convert(node) {
    collapseWhitespace(node);
    const md = this.children(node, { code: false, inTable: false });
    return tidyLines(md).replace(/\n{3,}/g, "\n\n").trim();
  }
}

// Trim trailing spaces line by line, keeping "  " hard breaks that are followed by more text.
// (A /[ \t]+$/gm regex is quadratic on the long indentation runs of deeply nested lists.)
function tidyLines(md) {
  const lines = md.split("\n");
  for (let k = 0; k < lines.length; k++) {
    const l = lines[k];
    let e = l.length;
    while (e > 0 && (l.charCodeAt(e - 1) === 32 || l.charCodeAt(e - 1) === 9)) e--;
    if (e === l.length) continue;
    const hardBreak = e > 0 && l.length - e === 2 && l.endsWith("  ") && k + 1 < lines.length && lines[k + 1].trim() !== "";
    lines[k] = hardBreak ? l : l.slice(0, e);
  }
  return lines.join("\n");
}

function yamlString(s) {
  return JSON.stringify(String(s)); // JSON strings are valid YAML double-quoted scalars
}

function frontMatter(meta, url, captured) {
  const lines = ["---", `title: ${yamlString(meta.title || url)}`, `url: ${yamlString(url)}`];
  if (meta.site) lines.push(`site: ${yamlString(meta.site)}`);
  if (meta.author) lines.push(`author: ${yamlString(meta.author)}`);
  if (meta.date) lines.push(`date: ${meta.date}`);
  if (meta.description) lines.push(`description: ${yamlString(meta.description)}`);
  lines.push(`captured: ${captured}`);
  lines.push("---");
  return lines.join("\n");
}

// Full pipeline: HTML string → { markdown, meta, words, textLength }
// opts: { url, frontMatter: bool, extract: bool, captured: "YYYY-MM-DD" }
function htmlToMarkdown(html, opts) {
  const doc = parseHTML(html);
  const meta = getMetadata(doc);
  let base = opts.url;
  if (meta.base && /^https?:\/\//i.test(resolveURL(meta.base, opts.url))) base = resolveURL(meta.base, opts.url); // never a javascript: base
  let node, textLength;
  if (opts.extract === false) {
    node = first(doc, (x) => x.tag === "body") || doc;
    prepare(node, base, true);
    textLength = cleanText(textOf(node)).length;
  } else {
    const r = extractContent(doc, base);
    node = r.node;
    textLength = r.textLength;
  }
  const conv = new MarkdownConverter(base, { title: meta.title });
  const body = conv.convert(node);
  const parts = [];
  if (opts.frontMatter !== false) parts.push(frontMatter(meta, opts.url, opts.captured || isoDate(new Date().toISOString())));
  if (meta.title) parts.push(`# ${escapeText(meta.title)}`);
  if (body) parts.push(body);
  const markdown = parts.join("\n\n") + "\n";
  const words = (body.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1").match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) || []).length;
  return { markdown, meta, words, textLength };
}

// exported for webcapture.js (JXA has no modules; this file is evaluated in its scope)
this.WCMarkdown = { urlForMarkdown, safeURL, parseHTML, decodeEntities, resolveURL, htmlToMarkdown, getMetadata, textOf, cleanText, first, byTag, attr, isoDate, escapeText, frontMatter, yamlString };
