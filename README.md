# LinkedIn Profile Link Extractor

A Manifest V3 Chrome extension that reads the LinkedIn page you already have
open and lists the profile links rendered on it.

## What it does

Click the toolbar icon, press **Extract profiles from this page**, and the
extension injects a one-shot content script into the active tab. That script
walks the anchors already in the DOM, keeps the ones pointing at
`linkedin.com/in/<slug>`, strips tracking parameters, pairs each URL with the
best name it can find nearby, picks up the headline shown on the result card
("Chief Operating Officer @ Roister"), splits that into a designation and a
company, and de-duplicates by URL.

It covers two cases:

- **A list of people** - search results, "more profiles for you", connections.
  Every profile rendered on the page comes back in one click.
- **One person's profile** - when the open page is `linkedin.com/in/<slug>`,
  you get that person and nobody else: the sidebar suggestions, mutual
  connections and "people also viewed" links the page is full of stay out of
  the way. Their company comes from the top card's "Current company" control
  rather than being guessed from the headline. A checkbox reveals everyone
  else on the page when you do want them.

Results can be copied for a spreadsheet (tab-separated, so Google Sheets and
Excel split them into columns on paste) or downloaded as a CSV file. The columns
are `name`, `url`, `company`, `designation`, `headline` - the raw headline
trails last as a fallback for rows where the split reads oddly.

The company *website* is deliberately absent: it is not on the profile page, and
fetching it would mean visiting the company page, which this extension does not
do.

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
| `clipboardWrite` | "Copy for spreadsheet" |
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
popup.js            Popup logic: injection, rendering, clipboard/CSV export
content-script.js   DOM-only extraction, injected on click
icon.png            Toolbar icon
```

## Fragility notes

LinkedIn's class names are obfuscated and rotate, so nothing here matches on
them. Links are found by `href` pattern (`/in/`), and names are resolved from
the most stable signals first: the visible `span[aria-hidden="true"]`, then the
anchor text, then `aria-label` / `title` / image `alt`, then a nearby heading.

Headlines are read only from genuine result cards (list items), and only from
text that is not itself a link - so mutual-connection names, "Connect" buttons
and connection-degree badges stay out. On layouts without cards, such as the
feed, the headline is left empty rather than guessed at.

Entries that cannot be parsed are skipped silently; a profile whose name or
headline cannot be found is still listed with that field empty rather than
dropped.
