/**
 * LinkedIn Profile Link Extractor - content script.
 *
 * Runs only when the user clicks "Extract" in the popup; the popup injects this
 * file with chrome.scripting.executeScript. It reads the DOM that is already
 * rendered in the tab and returns the results as the injection value.
 *
 * It never fetches, scrolls, clicks, or navigates. Anything it cannot parse is
 * skipped silently - LinkedIn's markup changes without notice, so a single odd
 * node must not abort the whole extraction.
 *
 * Everything lives inside one IIFE so repeated injections cannot collide on
 * top-level declarations.
 */
(() => {
  "use strict";

  // Text that shows up inside profile anchors but is never part of a name.
  const NOISE = /^(?:·|•|\||,|-|–|—|\d+(?:st|nd|rd|th)|\+\s*\d+|status is (?:online|offline|reachable)|view profile|view full profile|see full profile|open profile|profile photo|premium|influencer|verified|linkedin member|message|connect|follow|following|withdraw|pending)$/i;

  // aria-label wrappers LinkedIn puts around a name, e.g.
  // "View Jane Doe's profile", "Jane Doe's graphic link", "Jane Doe, #1".
  const ARIA_PREFIX = /^(?:view|open|go to|see)\s+/i;
  const ARIA_SUFFIX = /['’]s\s+(?:profile|graphic link|page|photo|picture|verification badge).*$/i;

  // Connection-degree markers LinkedIn appends to a name ("Jane Doe · 2nd").
  const DEGREE = /\s*[\u2022\u00b7|,]?\s*(?:\d(?:st|nd|rd|th)\+?|\d+(?:st|nd|rd|th)\s*degree(?:\s+connection)?)\s*$/i;
  const EDGE_PUNCT = /^[\s\u2022\u00b7|,\-\u2013\u2014]+|[\s\u2022\u00b7|,\-\u2013\u2014]+$/g;

  /** Collapse whitespace and drop zero-width characters. */
  const clean = (value) =>
    String(value == null ? "" : value)
      .replace(/[\u200B-\u200D\uFEFF]/g, "")
      .replace(/\s+/g, " ")
      .trim();

  /** Trim separators and trailing degree markers off a candidate name. */
  const polish = (value) => clean(clean(value).replace(EDGE_PUNCT, "").replace(DEGREE, ""));

  /** True when the string looks like a usable human name rather than chrome. */
  const looksLikeName = (value) => {
    if (!value) return false;
    if (value.length < 2 || value.length > 120) return false;
    if (NOISE.test(value)) return false;
    if (/^https?:\/\//i.test(value) || /linkedin\.com/i.test(value)) return false;
    if (!/[a-z\u00C0-\u024F\u0370-\uFFFF]/i.test(value)) return false; // needs a letter
    return true;
  };

  /**
   * Normalise a profile href to a clean https://www.linkedin.com/in/<slug> URL.
   * Returns null for anything that is not a real profile link.
   */
  const normaliseUrl = (href) => {
    let parsed;
    try {
      parsed = new URL(href, document.baseURI);
    } catch (err) {
      return null;
    }

    if (!/^https?:$/.test(parsed.protocol)) return null;

    const host = parsed.hostname.toLowerCase();
    if (host !== "linkedin.com" && !host.endsWith(".linkedin.com")) return null;

    // Path may carry extra segments (/in/slug/detail/recent-activity/...).
    // Keep only the slug, and drop every query param (tracking, miniProfileUrn,
    // trk, lipi, ...) plus the hash.
    const segments = parsed.pathname.split("/").filter(Boolean);
    const marker = segments.indexOf("in");
    if (marker === -1) return null;

    const slug = segments[marker + 1];
    if (!slug) return null;

    let decoded;
    try {
      decoded = decodeURIComponent(slug);
    } catch (err) {
      decoded = slug;
    }
    if (!decoded || decoded === "." || decoded === "..") return null;

    return `https://www.linkedin.com/in/${decoded}`;
  };

  /** Strip LinkedIn's aria-label wording down to the bare name. */
  const nameFromAriaLabel = (label) => {
    let value = clean(label);
    if (!value) return "";
    value = value.replace(ARIA_SUFFIX, "");
    value = value.replace(ARIA_PREFIX, "");
    // "Jane Doe, #1 in your network" / "Jane Doe • 2nd"
    value = value.split(/\s+[•·|]\s+/)[0];
    return polish(value.replace(/[,;]\s*$/, ""));
  };

  /**
   * Pull the first plausible name out of an element's rendered text.
   * LinkedIn duplicates the name in a visually-hidden span, so lines repeat.
   */
  const nameFromText = (element) => {
    if (!element) return "";
    const raw = element.innerText || element.textContent || "";
    const lines = raw.split(/\n+/).map(polish).filter(Boolean);
    for (const line of lines) {
      if (looksLikeName(line)) return line;
    }
    return "";
  };

  /**
   * Resolve a display name for one profile anchor, cheapest signal first.
   * Order matters: aria-hidden spans hold the visible name, aria-label is the
   * most stable attribute, and the surrounding heading is the last resort.
   */
  const resolveName = (anchor) => {
    const candidates = [];

    // 1. The visible span LinkedIn marks aria-hidden (the screen-reader copy
    //    next to it usually carries extra text like "2nd degree connection").
    const visibleSpan = anchor.querySelector('span[aria-hidden="true"]');
    if (visibleSpan) candidates.push(nameFromText(visibleSpan));

    // 2. The anchor's own text.
    candidates.push(nameFromText(anchor));

    // 3. Accessible attributes on the anchor or the image inside it.
    candidates.push(nameFromAriaLabel(anchor.getAttribute("aria-label")));
    candidates.push(nameFromAriaLabel(anchor.getAttribute("title")));
    const image = anchor.querySelector("img[alt]");
    if (image) candidates.push(nameFromAriaLabel(image.getAttribute("alt")));

    // 4. A nearby heading, for image-only or icon-only links.
    const heading = anchor.closest(
      'h1, h2, h3, h4, li, article, [role="listitem"]'
    );
    if (heading && heading !== anchor) {
      const headingEl = heading.querySelector("h1, h2, h3, h4");
      if (headingEl) candidates.push(nameFromText(headingEl));
      // Any sibling anchor pointing at the same profile often has the text.
      const twin = heading.querySelector('a[href*="/in/"] span[aria-hidden="true"]');
      if (twin) candidates.push(nameFromText(twin));
    }

    for (const candidate of candidates) {
      if (looksLikeName(candidate)) return candidate;
    }
    return "";
  };

  const results = [];
  const seen = new Map(); // url -> index in results

  let anchors;
  try {
    anchors = document.querySelectorAll('a[href*="/in/"]');
  } catch (err) {
    return { ok: false, error: "Could not read the page DOM.", profiles: [] };
  }

  for (const anchor of anchors) {
    try {
      const url = normaliseUrl(anchor.getAttribute("href") || anchor.href);
      if (!url) continue;

      const name = resolveName(anchor);

      if (seen.has(url)) {
        // Keep the first hit, but upgrade it if we only had a URL before.
        const existing = results[seen.get(url)];
        if (!existing.name && name) existing.name = name;
        continue;
      }

      seen.set(url, results.length);
      results.push({ name, url });
    } catch (err) {
      // Malformed node - skip it and keep going.
      continue;
    }
  }

  return { ok: true, profiles: results, pageUrl: location.href };
})();
