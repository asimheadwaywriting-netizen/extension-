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

  // Lines that sit near a name but are never a headline.
  const HEADLINE_NOISE =
    /^(?:connect|message|follow|following|pending|invite sent|withdraw|view profile|view full profile|see full profile|status is (?:online|offline|reachable)|premium|influencer|verified|open to work|hiring|\d+(?:st|nd|rd|th)\+?|.*\bmutual connections?\b.*|.*\b(?:followers?|connections?)\b.*)$/i;

  /** True when a line reads like a professional headline rather than chrome. */
  const looksLikeHeadline = (line) => {
    if (!line || line.length < 3 || line.length > 300) return false;
    if (HEADLINE_NOISE.test(line)) return false;
    if (/^(?:view|open|see|go to)\s+/i.test(line)) return false;
    if (/^https?:\/\//i.test(line)) return false;
    if (!/[a-z]/i.test(line)) return false;
    return true;
  };

  /**
   * The result card holding this anchor. Only genuine list items count -
   * search results, connection lists and "people also viewed" all render as
   * list items, while a feed post is a loose stack of divs where any nearby
   * text would be somebody else's. An empty headline beats a wrong one.
   * Class names are never used: LinkedIn rotates them.
   */
  const findCard = (anchor) => {
    let node = anchor.parentElement;
    let hops = 0;

    while (node && hops < 8) {
      if (
        node.tagName === "LI" ||
        node.hasAttribute("data-chameleon-result-urn") ||
        node.getAttribute("role") === "listitem"
      ) {
        return node;
      }
      node = node.parentElement;
      hops += 1;
    }
    return null;
  };

  /**
   * Text blocks inside a card, in document order, skipping anything inside a
   * link or button - the headline is plain text, while mutual connections,
   * the name itself and "Connect" are not.
   */
  const textBlocks = (card) => {
    const blocks = [];

    const walk = (node, depth) => {
      if (depth > 6) return;
      for (const child of node.children) {
        if (child.tagName === "A" || child.tagName === "BUTTON") continue;
        if (child.querySelector("a, button")) {
          walk(child, depth + 1);
          continue;
        }
        const text = clean(child.innerText || child.textContent);
        if (text) blocks.push(text);
      }
    };

    walk(card, 0);
    return blocks;
  };

  /**
   * The headline is the first meaningful text block in the card
   * ("Director & Chief Executive Officer (CEO) @ Axentra Ltd."). A "Current:"
   * summary is the fallback when no headline is rendered.
   */
  const resolveHeadline = (anchor, name, url) => {
    const card = findCard(anchor);
    if (!card) return "";

    // A card also links the mutual connections it mentions. Only the card's
    // own profile - its first profile link - may claim the card's headline.
    const primary = card.querySelector('a[href*="/in/"]');
    if (
      primary &&
      normaliseUrl(primary.getAttribute("href") || primary.href) !== url
    ) {
      return "";
    }

    let currentSummary = "";

    for (const raw of textBlocks(card)) {
      // polish() strips connection-degree markers, so "· 2nd" becomes empty.
      const line = polish(raw);
      if (!line) continue;
      if (name && line === name) continue;

      // Screen-reader copies repeat the name with a little trailing chrome
      // ("Sunam Samayet . 2nd degree connection"); a real headline that opens
      // with the person's own name still carries substance after it.
      if (name && line.startsWith(name)) {
        const rest = clean(line.slice(name.length).replace(EDGE_PUNCT, ""));
        if (rest.length < 25 || !looksLikeHeadline(rest)) continue;
      }

      const summary = line.match(/^(?:current|past|previous):\s*(.+)$/i);
      if (summary) {
        if (!currentSummary && looksLikeHeadline(summary[1])) {
          currentSummary = clean(summary[1]);
        }
        continue;
      }

      if (looksLikeHeadline(line)) return line;
    }

    return currentSummary;
  };

  /**
   * Split a headline into designation and company:
   * "Chief Operating Officer @ Roister" -> "Chief Operating Officer" + "Roister".
   * The first " @ " or " at " is the separator; everything after a pipe is
   * marketing copy ("COO @ Roister | Building X") and gets trimmed off.
   */
  const splitHeadline = (headline) => {
    if (!headline) return { designation: "", company: "" };

    const trim = (value) => clean(String(value).split(/\s*[|\u2022\u00b7]\s*/)[0]);

    const match = headline.match(/^(.{2,}?)\s+(?:@|at)\s+(.{2,})$/i);
    if (match) {
      return { designation: trim(match[1]), company: trim(match[2]) };
    }

    // "Founder & CEO, roister" - only when the tail is short and is not itself
    // part of the job title ("Marketing Manager, Growth" keeps its tail).
    const comma = trim(headline).match(/^(.{2,}?),\s*([^,]{2,40})$/);
    if (comma) {
      const tail = clean(comma[2]);
      const isRoleWord =
        /\b(?:ceo|coo|cto|cfo|cmo|founder|owner|president|partner|director|manager|head|lead|officer|engineer|developer|designer|consultant|specialist|strategist|analyst|marketer|writer|advisor|freelance|remote|mba|phd|pmp|cfp)\b/i;
      if (tail.split(/\s+/).length <= 3 && !isRoleWord.test(tail)) {
        return { designation: clean(comma[1]), company: tail };
      }
    }

    return { designation: trim(headline), company: "" };
  };

  /**
   * The company named in a profile's top card. LinkedIn labels that control
   * "Current company: Roister ..." for screen readers, which survives class
   * name churn; the company link is the backup.
   */
  const currentCompany = (scope) => {
    const labelled = scope.querySelector('[aria-label*="Current company" i]');
    if (labelled) {
      const label = clean(labelled.getAttribute("aria-label"));
      const after = label.replace(/^.*current company:?\s*/i, "");
      const value = polish(after.split(/[.,]|\s+click\b/i)[0]);
      if (value) return value;
      const text = polish(nameFromText(labelled));
      if (text) return text;
    }

    const link = scope.querySelector('a[href*="/company/"]');
    if (link) {
      const text = polish(nameFromText(link));
      if (text && looksLikeHeadline(text)) return text;
    }

    return "";
  };

  /**
   * When the open page IS somebody's profile, that person is the point of the
   * click - so they lead the results, ahead of the sidebar suggestions and
   * mutual connections that also live on the page.
   */
  const profileOwner = () => {
    const path = location.pathname.match(/^\/in\/([^/]+)/);
    if (!path) return null;

    let slug;
    try {
      slug = decodeURIComponent(path[1]);
    } catch (err) {
      slug = path[1];
    }
    if (!slug) return null;

    const url = `https://www.linkedin.com/in/${slug}`;
    const main = document.querySelector("main") || document.body;

    const h1 = main.querySelector("h1");
    const name = h1 ? polish(nameFromText(h1) || clean(h1.textContent)) : "";

    // The top card is the section around the name; fall back to main.
    const topCard = (h1 && h1.closest("section")) || main;

    let headline = "";
    for (const raw of textBlocks(topCard)) {
      const line = polish(raw);
      if (!line) continue;
      if (name && (line === name || line.startsWith(name))) continue;
      if (looksLikeHeadline(line)) {
        headline = line;
        break;
      }
    }

    const parts = splitHeadline(headline);
    const company = currentCompany(topCard) || parts.company;

    return { name, headline, designation: parts.designation, company, url };
  };

  const results = [];
  const seen = new Map(); // url -> index in results

  let anchors;
  try {
    anchors = document.querySelectorAll('a[href*="/in/"]');
  } catch (err) {
    return { ok: false, error: "Could not read the page DOM.", profiles: [] };
  }

  // On a profile page the owner leads, then everyone else the page links to.
  try {
    const owner = profileOwner();
    if (owner && (owner.name || owner.headline)) {
      seen.set(owner.url, results.length);
      results.push(owner);
    }
  } catch (err) {
    // No owner row - carry on with the links alone.
  }

  for (const anchor of anchors) {
    try {
      const url = normaliseUrl(anchor.getAttribute("href") || anchor.href);
      if (!url) continue;

      const name = resolveName(anchor);
      const headline = resolveHeadline(anchor, name, url);

      if (seen.has(url)) {
        // Keep the first hit, but fill in anything it was missing.
        const existing = results[seen.get(url)];
        if (!existing.name && name) existing.name = name;
        if (!existing.headline && headline) {
          existing.headline = headline;
          const filled = splitHeadline(headline);
          if (!existing.designation) existing.designation = filled.designation;
          if (!existing.company) existing.company = filled.company;
        }
        continue;
      }

      const parts = splitHeadline(headline);

      seen.set(url, results.length);
      results.push({
        name,
        headline,
        designation: parts.designation,
        company: parts.company,
        url,
      });
    } catch (err) {
      // Malformed node - skip it and keep going.
      continue;
    }
  }

  return { ok: true, profiles: results, pageUrl: location.href };
})();
