# Web Capture — Plan

**Priority tier:** 2 · **Bundle ID:** `io.github.x-o-r-r-o.web-capture` · **Keywords:** `tomd`, `shot`, `code`, `ytt`

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
- [x] `code` selected code → ray.so image (open prefilled URL)
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
