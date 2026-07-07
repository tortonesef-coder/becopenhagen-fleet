// Shared guide-name matching logic — handles accents, case, typos, aliases.
// Used anywhere we need to check if a FareHarbor crew name (e.g. "Feidhlim")
// matches a team member's app name (e.g. "Féidhlim").

// Known aliases — calendar/crew names that don't textually match the team member's app name
const GUIDE_ALIASES = {
  'hassan': ['hasse', 'hassesorensen', 'hassesoerensen'],
  'pam': ['paloma'],
};

// Normalize a name for fuzzy comparison: lowercase, strip accents, remove non-letters
function normalizeName(s) {
  if (!s) return '';
  return s.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // strip accents
    .replace(/[^a-z]/g, ''); // keep only letters
}

// Levenshtein distance for fuzzy matching typos
function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const matrix = Array.from({length: a.length+1}, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) matrix[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i-1] === b[j-1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i-1][j] + 1,
        matrix[i][j-1] + 1,
        matrix[i-1][j-1] + cost
      );
    }
  }
  return matrix[a.length][b.length];
}

// Does the guide string on the availability match this person's name?
// Handles accents, case, typos, and partial matches (first name only, etc.)
function guideMatches(availGuide, personName) {
  if (!availGuide || !personName) return false;
  const a = normalizeName(availGuide);
  const p = normalizeName(personName);
  if (!a || !p) return false;

  // Exact normalized match or substring either direction
  if (a === p || a.includes(p) || p.includes(a)) return true;

  // Check known aliases (e.g. Hasse = Hassan, Paloma = Pam)
  const personAliases = GUIDE_ALIASES[p] || [];
  if (personAliases.some(alias => a === alias || a.includes(alias) || alias.includes(a))) return true;
  // Also check reverse: maybe availGuide is the "canonical" name and personName is the alias
  for (const [canonical, aliases] of Object.entries(GUIDE_ALIASES)) {
    if (aliases.includes(p) && (a === canonical || a.includes(canonical))) return true;
    if (aliases.some(al => a.includes(al)) && p === canonical) return true;
  }

  // Fuzzy match: allow up to 2 character edits per ~6 chars (handles typos)
  const maxDist = Math.max(1, Math.floor(Math.min(a.length, p.length) / 3));
  if (levenshtein(a, p) <= maxDist) return true;

  // Word-level match: any word in availGuide fuzzy-matches any word in personName
  const aWords = availGuide.toLowerCase().split(/\s+/).map(normalizeName).filter(Boolean);
  const pWords = personName.toLowerCase().split(/\s+/).map(normalizeName).filter(Boolean);
  for (const aw of aWords) {
    for (const pw of pWords) {
      if (aw.length < 3 || pw.length < 3) continue;
      if (aw === pw) return true;
      const d = Math.max(1, Math.floor(Math.min(aw.length, pw.length) / 3));
      if (levenshtein(aw, pw) <= d) return true;
    }
  }
  return false;
}

module.exports = { guideMatches, normalizeName, GUIDE_ALIASES };
