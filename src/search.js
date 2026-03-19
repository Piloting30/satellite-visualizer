/**
 * search.js
 * Natural Language Satellite Search
 * Calls /api/search — API key never touches the browser.
 * The response now includes both a filter object and a human-readable label.
 */

export let currentFilter = null;

const searchBtn   = document.getElementById("search-btn");
const searchInput = document.getElementById("search-input");

searchBtn.addEventListener("click", runSearch);
searchInput.addEventListener("keydown", e => {
  if (e.key === "Enter") runSearch();
});

async function runSearch() {
  const query = searchInput.value.trim();
  if (!query) return;

  searchBtn.disabled    = true;
  searchBtn.textContent = "...";

  try {
    const res = await fetch("/api/search", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ query })
    });

    if (!res.ok) {
      const { error } = await res.json().catch(() => ({}));
      throw new Error(error || `HTTP ${res.status}`);
    }

    const { filter, label } = await res.json();
    currentFilter = filter;

    window.dispatchEvent(
      new CustomEvent("satellite-filter", { detail: { filter, label } })
    );

  } catch (err) {
    console.error("Search error:", err);
    alert(`Search failed: ${err.message}`);
  } finally {
    searchBtn.disabled    = false;
    searchBtn.textContent = "Search";
  }
}
