# LinkedIn Profile Link Extractor

A Manifest V3 Chrome extension that reads the LinkedIn page you already have
open and lists the profile links rendered on it.

## What it does

Click the toolbar icon, press **Extract profiles from this page**, and the
extension injects a one-shot content script into the active tab. That script
walks the anchors already in the DOM, keeps the ones pointing at
`linkedin.com/in/<slug>`, strips tracking parameters, pairs each URL with the
best name it can find nearby, and de-duplicates by URL. Results can be copied
as CSV or downloaded as `name,url`.

## What it deliberately does not do

- No HTTP requests of any kind — it never fetches a profile or an API endpoint
- No auto-scrolling, auto-clicking, "load more", or simulated navigation
- No background service worker, no polling, nothing on page load
- No credential handling; it relies passively on the session already in the browser
- No storage — results live in the popup and disappear when it closes

## Permissions

| Permission | Why |
| --- | --- |
| `activeTab` | Read the tab you are looking at, only after you click |
| `scripting` | Inject the extraction script on that click |
| `clipboardWrite` | "Copy as CSV" |
| `*://*.linkedin.com/*` | Limits the extension to LinkedIn pages |

`tabs`, `webRequest`, and broad host permissions are intentionally not requested.

## Install (unpacked)

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** and select this folder
4. Open a LinkedIn page (feed, search results, connections, a company's people
   tab), then click the extension icon

## Files

```
manifest.json       MV3 manifest
popup.html          UI: extract button, results list, export buttons
popup.js            Popup logic: injection, rendering, CSV copy/download
content-script.js   DOM-only extraction, injected on click
icon.png            Toolbar icon
```

## Fragility notes

LinkedIn's class names are obfuscated and rotate, so nothing here matches on
them. Links are found by `href` pattern (`/in/`), and names are resolved from
the most stable signals first: the visible `span[aria-hidden="true"]`, then the
anchor text, then `aria-label` / `title` / image `alt`, then a nearby heading.
Entries that cannot be parsed are skipped silently; a profile whose name cannot
be found is still listed with an empty name rather than dropped.
