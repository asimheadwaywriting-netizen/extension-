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

/** @type {{name: string, url: string}[]} */
let profiles = [];

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.classList.toggle("error", Boolean(isError));
}

function setExportsEnabled(enabled) {
  copyButton.disabled = !enabled;
  downloadButton.disabled = !enabled;
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

    item.append(name, url);
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

function toCsv(rows) {
  const lines = [["name", "url"], ...rows.map((r) => [r.name, r.url])];
  return lines.map((cells) => cells.map(csvField).join(",")).join("\r\n");
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

    profiles = Array.isArray(result.profiles) ? result.profiles : [];
    render();

    if (profiles.length === 0) {
      setStatus("No profile links found on the rendered page.");
    } else {
      const named = profiles.filter((p) => p.name).length;
      setStatus(
        `${profiles.length} profile${profiles.length === 1 ? "" : "s"} found` +
          (named === profiles.length ? "." : ` (${named} with a name).`)
      );
    }
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
  const ok = await copyToClipboard(toCsv(profiles));
  setStatus(
    ok ? `Copied ${profiles.length} rows as CSV.` : "Could not copy to clipboard.",
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
copyButton.addEventListener("click", handleCopy);
downloadButton.addEventListener("click", handleDownload);
