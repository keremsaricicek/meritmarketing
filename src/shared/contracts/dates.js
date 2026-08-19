'use strict';
/* Two different kinds of "when", kept deliberately apart.
 *
 * A BUSINESS DATE (check_in, check_out, last_visit) is a calendar day on the
 * hotel's wall. It has no time and no zone. 2026-08-16 is the 16th whether the
 * machine is in Istanbul or Los Angeles. Stored as 'YYYY-MM-DD' TEXT.
 *
 * A SYSTEM INSTANT (created_at, cancelled_at, deleted_at, login time) is a real
 * moment. Stored as an ISO-8601 UTC string and rendered in local time.
 *
 * Treating a business date as a UTC timestamp is the classic bug: '2026-08-16'
 * parsed as UTC midnight is the 15th at 21:00 in UTC-3, so a reservation shifts
 * a day for some users and the calendar buckets stop being exclusive. Every
 * business-date comparison below is therefore plain string comparison, which is
 * correct because ISO dates sort lexicographically.
 */

const BUSINESS_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isBusinessDate(value) {
  if (typeof value !== 'string' || !BUSINESS_DATE.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  /* Reject 2026-02-31 and friends: round-tripping through Date must give back
     the same day, otherwise the input was never a real calendar date. */
  const probe = new Date(Date.UTC(y, m - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
}

/** Today on the operator's own wall clock — the calendar the business runs on. */
function today() {
  const n = new Date();
  const p = (x) => String(x).padStart(2, '0');
  return `${n.getFullYear()}-${p(n.getMonth() + 1)}-${p(n.getDate())}`;
}

/** A system instant, always UTC. */
function nowIso() {
  return new Date().toISOString();
}

/** Add whole calendar days to a business date, staying in business-date space. */
function addDays(businessDate, days) {
  const [y, m, d] = businessDate.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  t.setUTCDate(t.getUTCDate() + days);
  return t.toISOString().slice(0, 10);
}

/** Add whole calendar years — used by the one-year guest protection window. */
function addYears(businessDate, years) {
  const [y, m, d] = businessDate.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  t.setUTCFullYear(t.getUTCFullYear() + years);
  return t.toISOString().slice(0, 10);
}

/** Whole days between two business dates (b - a). */
function daysBetween(a, b) {
  const p = (s) => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); };
  return Math.round((p(b) - p(a)) / 86400000);
}

/** Days since a business date, relative to today. Infinity when absent. */
function daysSince(businessDate) {
  if (!businessDate) return Infinity;
  return daysBetween(businessDate, today());
}

/** The business date an instant fell on, in local time. */
function instantToBusinessDate(iso) {
  if (!iso) return null;
  const n = new Date(iso);
  if (Number.isNaN(n.getTime())) return null;
  const p = (x) => String(x).padStart(2, '0');
  return `${n.getFullYear()}-${p(n.getMonth() + 1)}-${p(n.getDate())}`;
}

module.exports = {
  BUSINESS_DATE, isBusinessDate, today, nowIso,
  addDays, addYears, daysBetween, daysSince, instantToBusinessDate,
};
