/**
 * api/search.js
 * Vercel serverless function.
 *
 * Environment variable required:
 *   ANTHROPIC_API_KEY
 */

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";

const SYSTEM_PROMPT = `
You are a satellite database filter engine.

Convert the user's natural language query into a JSON response object.

Rules:
- Return ONLY valid JSON. No markdown, no fences, no explanation.
- All filter string values must be lowercase.
- Use null for any filter field the user did not specify.
- If the user wants to clear/reset/show all satellites, return all nulls and label "All Satellites".

Schema:
{
  "label": string,
  "filter": {
    "country": string | null,
    "type": string | null,
    "orbitType": "LEO" | "MEO" | "GEO" | null,
    "nameContains": string | null
  }
}

label: A concise, human-readable name for this filter. 3-5 words max.
  Examples: "Russian Reconnaissance Satellites", "LEO Satellites", "Starlink Constellation",
  "US Weather Satellites", "Chinese Navigation Satellites", "All Satellites"

filter.country: Country of the satellite operator.
  The catalog uses values like "USA", "Russia", "China", "UK", "India", "Japan", "France".
  Examples: "russian" → "russia", "american" or "US" → "USA", "chinese" → "china"

filter.type: Purpose of the satellite.
  The catalog uses values like "Communications", "Earth Observation", "Navigation",
  "Technology Development", "Space Science", "Earth Science", "Reconnaissance".
  Examples: "spy" or "surveillance" → "reconnaissance", "GPS" → "navigation",
  "weather" or "climate" → "earth observation", "internet" → "communications"

filter.orbitType:
  LEO = Low Earth Orbit, MEO = Medium Earth Orbit, GEO = Geostationary Orbit

filter.nameContains: Fragment of a satellite or constellation name.
  Examples: "starlink", "oneweb", "GPS", "NOAA"

Examples:

User: "show me russian spy satellites"
{"label":"Russian Reconnaissance Satellites","filter":{"country":"russia","type":"reconnaissance","orbitType":null,"nameContains":null}}

User: "only LEO satellites"
{"label":"LEO Satellites","filter":{"country":null,"type":null,"orbitType":"LEO","nameContains":null}}

User: "starlink"
{"label":"Starlink Constellation","filter":{"country":null,"type":null,"orbitType":null,"nameContains":"starlink"}}

User: "US weather satellites in LEO"
{"label":"US Weather Satellites (LEO)","filter":{"country":"USA","type":"earth observation","orbitType":"LEO","nameContains":null}}

User: "show all" or "reset" or "clear"
{"label":"All Satellites","filter":{"country":null,"type":null,"orbitType":null,"nameContains":null}}
`.trim();

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("ANTHROPIC_API_KEY is not set");
    return res.status(500).json({ error: "Server misconfiguration: API key missing" });
  }

  const { query } = req.body;
  if (!query || typeof query !== "string" || !query.trim()) {
    return res.status(400).json({ error: "Missing or empty query" });
  }

  try {
    const anthropicRes = await fetch(ANTHROPIC_API_URL, {
      method: "POST",
      headers: {
        "Content-Type":      "application/json",
        "x-api-key":         apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model:      "claude-haiku-4-5-20251001",
        max_tokens: 256,
        system:     SYSTEM_PROMPT,
        // Prime the assistant with "{" to force JSON output without fences
        messages: [
          { role: "user",      content: query.trim() },
          { role: "assistant", content: "{" }
        ]
      })
    });

    if (!anthropicRes.ok) {
      const err = await anthropicRes.text();
      console.error("Anthropic API error:", err);
      return res.status(502).json({ error: "Upstream API error" });
    }

    const data = await anthropicRes.json();
    const raw  = data.content?.[0]?.text ?? "";

    // Prepend the primed "{" and defensively strip any fences
    const cleaned = ("{" + raw)
      .replace(/^```(?:json)?\s*/im, "")
      .replace(/\s*```\s*$/m, "")
      .trim();

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      console.error("Claude returned non-JSON:", raw);
      return res.status(502).json({ error: "Invalid response from model" });
    }

    // Validate shape — ensure we have both label and filter
    if (!parsed.filter || typeof parsed.label !== "string") {
      console.error("Unexpected response shape:", parsed);
      return res.status(502).json({ error: "Unexpected response shape from model" });
    }

    return res.status(200).json({ label: parsed.label, filter: parsed.filter });

  } catch (err) {
    console.error("Handler error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}
