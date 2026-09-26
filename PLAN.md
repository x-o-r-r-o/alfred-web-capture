# Web Capture — Plan

**Priority tier:** 2 · **Bundle ID:** `com.xorro.web-capture`

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
- [ ] `md` frontmost tab / URL → clean Markdown (Readability) to clipboard or file
- [ ] `shot` full-page screenshot of URL (headless Chrome/Safari WebKit)
- [ ] `code` selected code → ray.so image (open prefilled URL) or local render
- [ ] `yt transcript` fetch transcript of current YouTube tab; optional AI summary (hands off to Local AI workflow)

## Tech
- **Stack:** JXA for browser tab access + zsh; Swift/WebKit helper for full-page capture.
- **Dependencies:** None.
- Output via Alfred Script Filter JSON; settings via Workflow Configuration (`userconfigurationconfig`).
- Secrets (API keys/tokens) in the macOS Keychain, never in `prefs.plist`.
- Target: macOS 13+ on Apple Silicon and Intel (universal binaries for any Swift helpers).

## Milestones
1. Script filter prototype for the main keyword
2. Actions + modifiers, Universal Actions / File Actions where relevant
3. Workflow Configuration, icons, error states (no network / missing dependency)
4. README with screenshots, `build.sh` release, submit to Alfred Gallery + forum post
