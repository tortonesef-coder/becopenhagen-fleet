// Parse bike counts out of FareHarbor booking lines.
//
// The old approach read the event SUMMARY with regexes that required the literal
// word "incl." ("5 Adults incl. bike rentals"). Tours phrase it that way, but
// RENTALS don't — they say "2 Adult's Bikes, 1 Christiania Cargo Bike" — so
// every rental parsed to zero bikes and the Today board under-counted badly.
//
// Instead we match against the fleet's OWN bike types: bike_types.fareharbor_resource
// stores the exact FareHarbor name for each type ("Adult's Bikes", "Touring bikes",
// "Christiania Cargo Bikes", ...). So the parser stays correct if a bike type is
// added or renamed — no hard-coded list to drift out of sync.

const { getDb } = require('./db/schema');

let _cache = null;
let _cacheAt = 0;

// [{id, name, words}] — longest name first, so "Adult City Bikes (Small)" is
// tested before "Adult's Bikes" and doesn't get swallowed by it.
function typeMatchers() {
  if (_cache && Date.now() - _cacheAt < 60_000) return _cache;
  let rows = [];
  try {
    rows = getDb().prepare(
      `SELECT id, label, fareharbor_resource FROM bike_types WHERE fareharbor_resource IS NOT NULL AND fareharbor_resource != ''`
    ).all();
  } catch { rows = []; }

  const norm = (s) => String(s).toLowerCase()
    .replace(/['’]/g, '')        // "adult's" -> "adults"
    .replace(/[()]/g, ' ')       // "(small)" -> " small "
    .replace(/\s+/g, ' ')
    .trim();

  _cache = rows.map(r => {
    const n = norm(r.fareharbor_resource);
    return {
      id: r.id,
      // distinctive words, minus the generic ones every type shares
      words: n.split(' ').filter(w => w && !['bike','bikes','with'].includes(w)),
      len: n.length,
    };
  }).sort((a, b) => b.words.length - a.words.length || b.len - a.len);
  _cacheAt = Date.now();
  return _cache;
}

// Score a phrase against each type; the type whose distinctive words ALL appear
// wins, preferring the most specific (most words matched).
function classify(phrase) {
  const p = String(phrase).toLowerCase().replace(/['’]/g, '').replace(/[()]/g, ' ');
  let best = null, bestScore = 0;
  for (const t of typeMatchers()) {
    if (!t.words.length) continue;
    if (!t.words.every(w => p.includes(w))) continue;
    if (t.words.length > bestScore) { best = t.id; bestScore = t.words.length; }
  }
  return best;
}

/**
 * Count bikes in a set of booking text lines.
 * Handles both phrasings:
 *   "2 Adult's Bikes, 1 Christiania Cargo Bike"   (rentals)
 *   "5 Adults incl. bike rentals"                 (tours)
 * Returns e.g. { A: 3, CC: 1 } — only non-zero entries.
 */
function parseBikeCounts(lines) {
  const need = {};
  const add = (k, n) => { if (k && n > 0) need[k] = (need[k] || 0) + n; };

  (Array.isArray(lines) ? lines : [lines]).filter(Boolean).forEach(line => {
    const text = String(line);
    // "Bike context" is LINE-wide: "3 Adults, 1 Child incl. bike rental" means
    // both the adults and the child get a bike, even though only the last phrase
    // says "bike". Tours phrase it that way. If a line mentions no bike at all
    // (e.g. a bare "4 People"), it tells us nothing about bikes — skip it.
    const lineMentionsBike = /bike|cykel/i.test(text);
    if (!lineMentionsBike) return;

    // Split on commas so each "<n> <type>" phrase is judged on its own.
    text.split(/,|;/).forEach(part => {
      const m = part.match(/(\d+)\s+(.+)/);
      if (!m) return;
      const n = parseInt(m[1], 10);
      if (!Number.isFinite(n) || n <= 0) return;
      const phrase = m[2];

      // E-bike first: "2 Adults incl. e-bike rentals" contains "adult", so a
      // naive type match would file it as a plain adult bike and lose the e-bike.
      if (/e-?bike|electric/i.test(phrase)) { add('E', n); return; }

      // Match against the fleet's own FareHarbor type names, but only when the
      // phrase itself names a bike ("2 Adult's Bikes", "1 Christiania Cargo Bike").
      if (/bike|cykel/i.test(phrase)) {
        const hit = classify(phrase);
        if (hit) { add(hit, n); return; }
      }

      // Otherwise it's a person-count on a bike-bearing line ("3 Adults" in
      // "3 Adults, 1 Child incl. bike rental") — one bike each.
      if (/child|kid/i.test(phrase)) add('B', n);
      else if (/adult|people|person|guest/i.test(phrase)) add('A', n);
    });
  });
  return need;
}

module.exports = { parseBikeCounts, classify };
