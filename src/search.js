/*
Natural Language Satellite Search
Uses the Claude API directly from the browser
*/

export let currentFilter = null;

const API_URL = "https://api.anthropic.com/v1/messages";

/* ---------------- System Prompt ---------------- */

const SYSTEM_PROMPT = `
You are a satellite database filter engine.

Your task is to convert a user's natural language query into a JSON filter object.

Rules:
- Return ONLY valid JSON.
- No markdown.
- No explanations.
- No text before or after JSON.

Schema:

{
  "country": string | null,
  "type": string | null,
  "orbitType": "LEO" | "MEO" | "GEO" | null,
  "nameContains": string | null
}

Definitions:

country:
The country responsible for the satellite.
Examples: "USA", "Russia", "China".

type:
The satellite purpose.
Examples: "communications", "reconnaissance", "navigation", "weather".

orbitType:
LEO = Low Earth Orbit
MEO = Medium Earth Orbit
GEO = Geostationary Orbit

nameContains:
If the user references a constellation or satellite name.

If the user query does not specify a field, return null.

Output JSON ONLY.
`;

/* ---------------- Modal UI ---------------- */

const modal = document.getElementById("settings-modal");
const settingsBtn = document.getElementById("settings-btn");
const closeBtn = document.getElementById("close-modal-btn");
const saveBtn = document.getElementById("save-key-btn");
const apiKeyInput = document.getElementById("api-key-input");

/* Settings button still opens modal manually */

settingsBtn.onclick = () => {
    modal.classList.remove("hidden");
};

closeBtn.onclick = () => {
    modal.classList.add("hidden");
};

/* Save API Key */

saveBtn.onclick = () => {

    const key = apiKeyInput.value.trim();

    if (key) {
        localStorage.setItem("CLAUDE_API_KEY", key);
        alert("API key saved locally");
    }

    modal.classList.add("hidden");

};

/* ---------------- Query Handler ---------------- */

const searchBtn = document.getElementById("search-btn");
const searchInput = document.getElementById("search-input");

searchBtn.onclick = runSearch;

searchInput.addEventListener("keydown", e => {
    if (e.key === "Enter") runSearch();
});

/* ---------------- Claude Request ---------------- */

async function runSearch() {

    let apiKey = localStorage.getItem("CLAUDE_API_KEY");

    /* If no key → prompt user */

    if (!apiKey) {

        modal.classList.remove("hidden");

        return;

    }

    const query = searchInput.value.trim();

    if (!query) return;

    try {

        const response = await fetch(API_URL, {

            method: "POST",

            headers: {
                "Content-Type": "application/json",
                "x-api-key": apiKey,
                "anthropic-version": "2023-06-01"
            },

            body: JSON.stringify({

                model: "claude-3-5-sonnet-latest",

                max_tokens: 200,

                system: SYSTEM_PROMPT,

                messages: [
                    {
                        role: "user",
                        content: query
                    }
                ]

            })

        });

        const data = await response.json();

        const text = data.content[0].text;

        const json = JSON.parse(text);

        currentFilter = json;

        window.dispatchEvent(
            new CustomEvent("satellite-filter", { detail: json })
        );

    } catch (err) {

        console.error(err);
        alert("Search failed");

    }

}