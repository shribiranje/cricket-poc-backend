/**
 * UTC datetime helpers.
 *
 * Convention: matches.start_time is stored in UTC as MySQL DATETIME.
 * The DB pool uses dateStrings:true, so reads come back as
 * 'YYYY-MM-DD HH:MM:SS'. The API always serializes datetimes as
 * ISO-8601 with a 'Z' suffix so every browser parses them correctly
 * regardless of the viewer's locale.
 */

/** ISO string (any offset) -> 'YYYY-MM-DD HH:MM:SS' in UTC, or null if unparseable. */
function toMysqlUtc(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

/** Stored 'YYYY-MM-DD HH:MM:SS' (UTC) -> 'YYYY-MM-DDTHH:MM:SS.000Z'. Passes through Dates/ISO. */
function toIsoUtc(dt) {
  if (dt == null) return null;
  if (dt instanceof Date) return dt.toISOString();
  const s = String(dt);
  if (s.includes('Z') || /[+-]\d{2}:\d{2}$/.test(s)) return s; // already offset-qualified
  return `${s.replace(' ', 'T')}.000Z`;
}

module.exports = { toMysqlUtc, toIsoUtc };
