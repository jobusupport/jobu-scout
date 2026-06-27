require("dotenv").config();

const TEAMS_CSV_URL = process.env.TEAMS_CSV_URL || process.env.GOOGLE_SHEET_CSV_URL;

function cleanTeamName(rawTeamName) {
  if (!rawTeamName) return "";
  return String(rawTeamName)
    .replace(/\s*\(\d+\s*[-–—]\s*\d+\s*[-–—]\s*\d+\s+in\s+\d{4}\)\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function extractAgeFromClassification(classification) {
  if (!classification) return "";
  const match = String(classification).match(/\d+/);
  return match ? match[0] : "";
}

function parseCsvLine(line) {
  const values = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    const next = line[i + 1];
    if (char === '"' && inQuotes && next === '"') { current += '"'; i++; continue; }
    if (char === '"') { inQuotes = !inQuotes; continue; }
    if (char === ',' && !inQuotes) { values.push(current.trim()); current = ""; continue; }
    current += char;
  }
  values.push(current.trim());
  return values;
}

function parseCsv(text) {
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n").filter(l => l.trim());
  if (lines.length < 2) return [];

  const headers = parseCsvLine(lines[0]).map(h => h.replace(/^\uFEFF/, '').trim());
  console.log("Sheet headers detected:", headers);

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const values = parseCsvLine(lines[i]);
    const row = {};
    headers.forEach((header, idx) => {
      row[header] = (values[idx] || "").trim();
    });
    rows.push(row);
  }
  return rows;
}

function getField(row, ...possibleNames) {
  for (const name of possibleNames) {
    if (row[name] !== undefined && String(row[name]).trim() !== "") {
      return String(row[name]).trim();
    }
  }
  return "";
}

async function getTeamsFromGoogleSheet() {
  if (!TEAMS_CSV_URL) {
    throw new Error("Missing TEAMS_CSV_URL in your .env file.");
  }

  console.log("Reading team names from Google Sheet...");

  const response = await fetch(TEAMS_CSV_URL);
  if (!response.ok) throw new Error(`Failed to fetch CSV. Status: ${response.status}`);

  const csvText = await response.text();
  if (csvText.trim().startsWith("<!DOCTYPE") || csvText.includes("<html")) {
    throw new Error("The URL returned HTML instead of CSV. Use File → Share → Publish to web → CSV.");
  }

  const rows = parseCsv(csvText);
  console.log(`CSV rows loaded: ${rows.length}`);

  const teams = rows
    .map((row) => {
      // Support your exact column headers
      const rawTeamName = getField(row,
        "Team", "Team Name", "teamName", "Name", "name"
      );

      const classification = getField(row,
        "Classification", "classification", "Class"
      );

      const fromRaw = getField(row,
        "From", "from", "City", "city", "Location"
      );

      // Split "Birmingham, AL" into city + state
      const fromParts = fromRaw.split(",").map(s => s.trim());
      const city  = fromParts[0] || "";
      const state = fromParts[1] || getField(row, "State", "state");

      const gcSearchName = getField(row,
        "GC Search Name", "gcSearchName", "GameChanger Search Name", "GC Name"
      );

      const gcTeamUrl = getField(row,
        "GC Team URL", "GameChanger Team URL", "GC URL", "Team URL"
      );

      const pgTeamUrl = getField(row,
        "PG Team URL", "Perfect Game URL", "PG URL"
      );

      const status = getField(row, "Status", "status");

      const teamName = cleanTeamName(rawTeamName);
      const age = extractAgeFromClassification(classification);

      return {
        rawTeamName,
        teamName,
        gcSearchName,
        gcTeamUrl,
        pgTeamUrl,
        classification,
        age,
        from: fromRaw,
        city,
        state,
        status
      };
    })
    .filter((row) => {
      if (!row.teamName) return false;
      // No status column = include everything
      if (!row.status) return true;
      // If status column exists, include common active values
      const s = row.status.toLowerCase();
      return ["pending", "active", "yes", "y", "include", ""].includes(s);
    });

  console.log(`Teams loaded after filtering: ${teams.length}`);
  return teams;
}

module.exports = {
  getTeamsFromGoogleSheet,
  cleanTeamName,
  extractAgeFromClassification
};