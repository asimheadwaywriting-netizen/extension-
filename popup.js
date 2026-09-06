/**
 * Popup controller.
 *
 * Nothing happens until the user presses "Extract": the button click is what
 * injects the content script (activeTab is granted at that moment). Results
 * live in this popup only - closing it throws them away.
 */
"use strict";

const extractButton = document.getElementById("extract");
const copyButton = document.getElementById("copy");
const downloadButton = document.getElementById("download");
const statusEl = document.getElementById("status");
const resultsEl = document.getElementById("results");
const scopeRow = document.getElementById("scope");
const includeAll = document.getElementById("include-all");
const scopeCount = document.getElementById("scope-count");

/**
 * @type {{name: string, url: string, company: string, designation: string,
 *   headline: string}[]}
 */
let profiles = [];

/** Every profile the last extraction found, before the owner-only filter. */
let allProfiles = [];

/** True when the tab is one person's profile rather than a list of people. */
let isProfilePage = false;

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.classList.toggle("error", Boolean(isError));
}

function setExportsEnabled(enabled) {
  copyButton.disabled = !enabled;
  downloadButton.disabled = !enabled;
}

/**
 * On somebody's profile, that person is the point of the click - the sidebar
 * suggestions and mutual connections the page also links to are noise unless
 * asked for. Everywhere else (search results, connections) every profile counts.
 */
function applyScope() {
  const owner = allProfiles.find((p) => p.owner);

  if (isProfilePage && owner && !includeAll.checked) {
    profiles = [owner];
  } else {
    profiles = allProfiles;
  }

  render();
  reportCount();
}

function reportCount() {
  if (profiles.length === 0) {
    setStatus("No profile links found on the rendered page.");
    return;
  }

  const others = allProfiles.length - profiles.length;
  if (others > 0) {
    setStatus(`This profile only - ${others} others on the page are hidden.`);
    return;
  }

  const named = profiles.filter((p) => p.name).length;
  setStatus(
    `${profiles.length} profile${profiles.length === 1 ? "" : "s"} found` +
      (named === profiles.length ? "." : ` (${named} with a name).`)
  );
}

function render() {
  resultsEl.textContent = "";
  const fragment = document.createDocumentFragment();

  for (const profile of profiles) {
    const item = document.createElement("li");

    const name = document.createElement("span");
    name.className = profile.name ? "name" : "name missing";
    name.textContent = profile.name || "(name not found)";

    const url = document.createElement("span");
    url.className = "url";
    url.textContent = profile.url;

    item.append(name);

    // Show the split when we have it, the raw headline when we do not.
    const detail = [profile.designation, profile.company]
      .filter(Boolean)
      .join(" - ");
    const subtitle = detail || profile.headline;
    if (subtitle) {
      const headline = document.createElement("span");
      headline.className = "headline";
      headline.textContent = subtitle;
      item.append(headline);
    }

    item.append(url);
    fragment.append(item);
  }

  resultsEl.append(fragment);
  setExportsEnabled(profiles.length > 0);
}

/** RFC 4180-ish escaping: quote when needed, double up inner quotes. */
function csvField(value) {
  const text = String(value == null ? "" : value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * Tab-separated fields cannot be quoted reliably across spreadsheets, so any
 * tab or line break inside a value is flattened to a space instead.
 */
function tsvField(value) {
  return String(value == null ? "" : value).replace(/[\t\r\n]+/g, " ").trim();
}

function tableRows(rows) {
  // name/url keep the columns they always had; the raw headline trails last as
  // a fallback for the rows where the designation/company split reads oddly.
  return [
    ["name", "url", "company", "designation", "headline"],
    ...rows.map((r) => [
      r.name,
      r.url,
      r.company || "",
      r.designation || "",
      r.headline || "",
    ]),
  ];
}

/** For the downloaded .csv file. */
function toCsv(rows) {
  return tableRows(rows)
    .map((cells) => cells.map(csvField).join(","))
    .join("\r\n");
}

/**
 * For the clipboard. Spreadsheets (Sheets, Excel, Numbers) split pasted text on
 * tabs, so this lands as two columns; a comma-separated paste would pile the
 * whole row into one cell.
 */
function toTsv(rows) {
  return tableRows(rows)
    .map((cells) => cells.map(tsvField).join("\t"))
    .join("\r\n");
}

function timestampedFilename() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `linkedin-profiles-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(
    now.getDate()
  )}-${pad(now.getHours())}${pad(now.getMinutes())}.csv`;
}

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (err) {
    // Older/edge cases where the async clipboard API is unavailable.
    try {
      const scratch = document.createElement("textarea");
      scratch.value = text;
      scratch.setAttribute("readonly", "");
      scratch.style.position = "fixed";
      scratch.style.opacity = "0";
      document.body.append(scratch);
      scratch.select();
      const ok = document.execCommand("copy");
      scratch.remove();
      return ok;
    } catch (fallbackErr) {
      return false;
    }
  }
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

function isLinkedInUrl(url) {
  if (!url) return false;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "linkedin.com" || host.endsWith(".linkedin.com");
  } catch (err) {
    return false;
  }
}

async function extract() {
  extractButton.disabled = true;
  setExportsEnabled(false);
  setStatus("Reading the page…");

  try {
    const tab = await getActiveTab();
    if (!tab || typeof tab.id !== "number") {
      setStatus("No active tab to read.", true);
      return;
    }

    // tab.url is only visible once we hold permission for the tab; when it is
    // visible and clearly not LinkedIn, stop before injecting anything.
    if (tab.url && !isLinkedInUrl(tab.url)) {
      setStatus("Open a LinkedIn page in this tab first.", true);
      return;
    }

    const injection = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content-script.js"],
    });

    const result = injection && injection[0] ? injection[0].result : null;

    if (!result || !result.ok) {
      setStatus(
        (result && result.error) || "Could not read this page.",
        true
      );
      return;
    }

    allProfiles = Array.isArray(result.profiles) ? result.profiles : [];
    isProfilePage = Boolean(result.isProfilePage);

    // The checkbox only makes sense on a profile page with others to reveal.
    const owner = allProfiles.find((p) => p.owner);
    const others = allProfiles.length - (owner ? 1 : 0);
    const offerScope = isProfilePage && owner && others > 0;

    scopeRow.hidden = !offerScope;
    if (offerScope) {
      scopeCount.textContent = String(others);
    } else {
      includeAll.checked = false;
    }

    applyScope();
  } catch (err) {
    // Chrome refuses injection on chrome:// pages, the Web Store, PDFs, etc.
    setStatus(
      "Could not run on this page. Open a LinkedIn page and try again.",
      true
    );
  } finally {
    extractButton.disabled = false;
  }
}

async function handleCopy() {
  if (profiles.length === 0) return;
  const ok = await copyToClipboard(toTsv(profiles));
  setStatus(
    ok
      ? `Copied ${profiles.length} rows - paste into a spreadsheet for two columns.`
      : "Could not copy to clipboard.",
    !ok
  );
}

function handleDownload() {
  if (profiles.length === 0) return;
  try {
    // BOM keeps non-ASCII names readable when Excel opens the file.
    const blob = new Blob(["\uFEFF" + toCsv(profiles)], {
      type: "text/csv;charset=utf-8",
    });
    const objectUrl = URL.createObjectURL(blob);

    const link = document.createElement("a");
    link.href = objectUrl;
    link.download = timestampedFilename();
    document.body.append(link);
    link.click();
    link.remove();

    setTimeout(() => URL.revokeObjectURL(objectUrl), 10000);
    setStatus(`Saved ${profiles.length} rows to CSV.`);
  } catch (err) {
    setStatus("Could not create the CSV file.", true);
  }
}

extractButton.addEventListener("click", extract);
includeAll.addEventListener("change", applyScope);
copyButton.addEventListener("click", handleCopy);
downloadButton.addEventListener("click", handleDownload);
