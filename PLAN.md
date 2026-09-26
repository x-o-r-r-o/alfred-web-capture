# Web Capture — Plan

**Priority tier:** 2 · **Bundle ID:** `io.github.x-o-r-r-o.web-capture` · **Keywords:** `tomd`, `shot`, `fredo`, `ytt`

## Why build it
Raycast demand this workflow replaces (downloads, 2026-09-26):

| Raycast extension | Downloads |
|---|---|
| ray.so | 52,196 |
| Summarize YouTube Videos with AI | 16,618 |
| Webpage to Markdown | 5,876 |
| Capture Full Page | 4,758 |
| Fetch YouTube Transcript | 4,221 |
| **Total** | **83,669** |

**Alfred today:** Wayback archive and link cleaners exist; nothing for page→Markdown, full-page capture, code images or YouTube transcripts.

## Features (v1.0)
- [x] `tomd` frontmost tab / URL → clean Markdown (Readability) to clipboard or file
- [x] `shot` full-page screenshot of URL (WebKit via JXA; headless Chromium hung on the test Mac, so it isn't used)
- [x] `fredo` (was `code`) selected code → ray.so image (open prefilled URL)
- [x] `ytt` fetch transcript of current YouTube tab; optional AI summary (hands off to Local AI workflow)

## Tech
- **Stack:** JXA for browser tab access, curl and bash; full-page capture through JXA + WebKit (ObjC bridge), so there is no compiled helper.
- **Dependencies:** None.
- Output via Alfred Script Filter JSON; settings via Workflow Configuration (`userconfigurationconfig`).
- Secrets (API keys/tokens) in the macOS Keychain, never in `prefs.plist`.
- Target: macOS 13+ on Apple Silicon and Intel.

## Milestones
1. [x] Script filter prototype for the main keyword
2. [x] Actions + modifiers, Universal Actions / File Actions where relevant
3. [x] Workflow Configuration, icons, error states (no network / missing dependency)
4. README with screenshots, `tools/build.py --package` release, forum post, then Gallery submission when invited

## Known limitations
- Screenshots render the page in a private WebKit view: no browser logins, cookies or extensions (ad blockers).
- Firefox, Zen and LibreWolf can’t share their tabs over AppleScript; the clipboard is used instead.
- “Use browser page content” needs “Allow JavaScript from Apple Events” in the browser, and Automation permission for Alfred.
- YouTube: captions that need a proof-of-origin token can’t be read by scripts; bot checks and 429s block a network for a while (Web Capture then waits 10 minutes before asking again). The Innertube ANDROID client version may need updating when YouTube changes it.
- ray.so keeps the code in the link, so very long code makes very long links.
- The code Universal Action on a single word that is a language name (like “swift”) uses the clipboard with that language.
- Pages over 8 MB are cut; pages over 2 MB get no whole-page version.

## Round 4 (post-release audit)
- [x] Screenshots rendered the page as hidden (off-screen window = occluded): requestAnimationFrame stopped after one frame, so rAF-driven lazy loaders, fade-ins and carousels could stay blank. WebKit’s occlusion detection is now off for the capture view.
- [x] Autoplaying media could play sound during a capture: audio now needs a user action.
- [x] curl globbing: URLs with `[ ]` or `{ }` (`?filter[tag]=x`) failed as malformed or were fetched as several URLs (`-g`).
- [x] Unicode URLs: macOS 13’s NSURL rejects them (“Invalid URL” in screenshots) and macOS’s curl has no IDN: hosts become Punycode and the rest is percent-encoded.
- [x] The Local AI hand-off printed a newline on success (a possible blank notification).
- [x] `tomd` and `ytt` fetch on each keystroke: their Script Filters now terminate the previous run (queuemode 2) instead of waiting for it, so a slow fetch for the frontmost tab no longer holds up a pasted URL. Cache writes are atomic and there are no locks; a kill-mid-fetch test covers it. `shot` and `code` never fetch while typing and keep “wait” (1).
- [x] New: screenshot appearance (like macOS / light / dark), JPEG format, and a “Keep images” option for Markdown.

## Ideas for v1.1
1. Copy only the selected text of the frontmost tab as Markdown (browser JavaScript, same permission as “Use browser page content”).
2. Screenshot delay setting (pages with splash screens or late animations) and an option to hide fixed headers/cookie banners on long captures.
3. A “Links” section at the end of the Markdown (Raycast’s Webpage to Markdown offers it).
4. YouTube transcript as SRT/VTT subtitles.
5. `shot_width` accepts “1,280” as 1 (clamped to 320): strip non-digits.
6. Capture the frontmost tab’s selection/element only (CSS selector).

## Verify in real Alfred
- [ ] The four Universal Actions appear for URLs / text and fill the Script Filter query.
- [ ] ⌘↩ pastes into the frontmost app (Markdown, links, transcripts); results over 50 KB come back through resolve.sh.
- [ ] ⌘Y previews the cached .md / transcript; ⌘C and Large Type on large results.
- [ ] Screenshot notifications (“Taking a screenshot…” and the result); ⌘↩ copies an image that pastes into Mail/Slack (also as JPEG).
- [ ] No blank notification after ⌃↩ hands a transcript to Local AI.
- [ ] ⌃↩ hands the transcript to the Local AI workflow’s External Trigger.
- [ ] First run asks for Automation permission per browser; the hint appears when it is denied.
- [ ] Keyword changes in the Workflow’s Configuration take effect.

## Release checklist (Alfred forum + Gallery)
Sources: alfred.app/submit, alfred.app/submit/styleguide, alfred.app/submit/screenshots, alfredforum.com topics 23976 and 23388.

- [x] README starts with `## Usage`; each paragraph ends "via the `kw` keyword" / "via the Universal Action"
- [ ] A clean screenshot (window only, transparent background, real-looking data, no other workflows) after each paragraph, stored in `images/`
- [x] Modifiers listed as `* <kbd>⌘</kbd><kbd>↩</kbd> Action.`; Quick Look written as <kbd>⌘</kbd><kbd>Y</kbd>
- [x] `## Setup` only for genuine manual steps (no app installs or API keys; the Gallery lists those)
- [x] Every keyword is ≥ 3 characters and configurable via `{var:keyword_*}`
- [x] Settings in Workflow Configuration; the info.plist `readme` (About This Workflow) matches README.md
- [x] Main icon ≥ 256×256 px
- [x] No self-updater; never download or install software (no pip/brew/curl of binaries); dependencies declared for Alfred to handle
- [x] Any compiled binary is Developer ID signed + notarised; never strip quarantine (there are none)
- [x] No hard-coded paths; `prefs.plist` is git-ignored; secrets stay in Keychain
- [ ] AI assistance disclosed in the README and the forum post (README done)
- [ ] Version bumped in `src/info.plist`; `python3 tools/build.py --package`; GitHub release with the `.alfredworkflow` attached
- [ ] Forum post in "Share your Workflows" with a screenshot, keywords, and the GitHub link
