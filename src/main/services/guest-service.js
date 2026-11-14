'use strict';
/* Guest features added in 1.2: follow-up reminders, tags, birthdays and
 * special dates, duplicate detection, merging, saved views and recently viewed
 * guests.
 *
 * Same shape as every other service — capability, then record scope, then the
 * work, then the audit row — and the same scope rule throughout: a MARKETING
 * session reads and writes only guests in its own book. Where a feature has to
 * talk about a guest OUTSIDE that book (a duplicate warning), it says that such
 * a guest exists and nothing else.
 */

const customersRepo = require('../repositories/customers');
const domain = require('./domain');
const guard = require('./guard');
const { nowIso, today, addDays, daysBetween, isBusinessDate } = require('../../shared/contracts/dates');
const { validation, notFound } = require('../../shared/errors');

/* ================================================================ helpers */

/* Phone numbers are typed every possible way: "+90 532 111 22 33",
   "0090-532-1112233", "(0532) 111 22 33". Comparing digits only, with leading
   zeros dropped, makes those the same number — and comparing the last ten
   digits makes "+90 532 …" and "0532 …" the same number too, with or without
   the country code. The SQL expression mirrors the JavaScript one for the
   characters people actually type. */
function normalizePhone(value) {
  return String(value || '').replace(/\D+/g, '').replace(/^0+/, '').slice(-10);
}
const PHONE_SQL = (col) => `SUBSTR(LTRIM(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(${col},' ',''),'-',''),'(',''),')',''),'+',''),'.',''),'/',''),'0'),-10)`;
/* Too short to identify anybody — an extension, a typo, a partial entry. */
const MIN_PHONE_DIGITS = 6;

function normalizePassport(value) {
  return String(value || '').replace(/\s+/g, '').toUpperCase();
}

function scopeSql(scopeId, alias = 'c') {
  return scopeId === null ? '' : ` AND ${alias}.marketing_profile_id = ${Number(scopeId)}`;
}

/* The next time a month/day comes round, on or after `from`. A 29 February
   birthday is celebrated on the 28th in a year that has no 29th. */
function nextOccurrence(month, day, from = today()) {
  const year = Number(from.slice(0, 4));
  for (const y of [year, year + 1]) {
    let d = day;
    const last = new Date(Date.UTC(y, month, 0)).getUTCDate();
    if (d > last) d = last;
    const ymd = `${y}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    if (ymd >= from) return ymd;
  }
  return null;
}

function readPref(db, userId, key, fallback) {
  const row = db.prepare('SELECT value FROM user_preferences WHERE user_id = ? AND key = ?').get(userId, key);
  if (!row) return fallback;
  try { const v = JSON.parse(row.value); return v === null || v === undefined ? fallback : v; } catch (_) { return fallback; }
}
function writePref(db, userId, key, value) {
  db.prepare(`INSERT INTO user_preferences (user_id, key, value, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
    .run(userId, key, JSON.stringify(value), nowIso());
}

/* ============================================================== reminders */

const REMINDER_ROW = `
  SELECT rm.id, rm.customer_id, rm.crm_note_id, rm.due_date, rm.created_at, rm.created_by,
         rm.done_at, c.full_name, c.code, c.photo_name,
         COALESCE(u.full_name, u.username) AS created_by_name,
         n.note AS note
  FROM reminders rm
  JOIN customers c ON c.id = rm.customer_id AND c.deleted_at IS NULL
  LEFT JOIN users u ON u.id = rm.created_by
  LEFT JOIN crm_notes n ON n.id = rm.crm_note_id AND n.deleted_at IS NULL`;

const reminders = {
  /* Called from crmNotes.create / crmNotes.update, inside their own capability
     and scope checks. `remindOn` undefined leaves things as they are; null
     clears the note's open reminder; a date sets it. */
  setForNote(ctx, session, { customerId, noteId, remindOn }) {
    if (remindOn === undefined) return null;
    const open = ctx.db.prepare(`SELECT * FROM reminders WHERE crm_note_id = ? AND done_at IS NULL AND deleted_at IS NULL`).get(noteId);
    const now = nowIso();
    if (remindOn === null || remindOn === '') {
      if (open) ctx.db.prepare('UPDATE reminders SET deleted_at = ?, updated_at = ? WHERE id = ?').run(now, now, open.id);
      return null;
    }
    if (!isBusinessDate(remindOn)) throw validation('Choose a valid reminder date.', 'remindOn');
    if (open) {
      ctx.db.prepare('UPDATE reminders SET due_date = ?, updated_at = ? WHERE id = ?').run(remindOn, now, open.id);
      return open.id;
    }
    return ctx.db.prepare(`INSERT INTO reminders (customer_id, crm_note_id, due_date, created_at, created_by, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(Number(customerId), noteId, remindOn, now, session.id, now).lastInsertRowid;
  },

  /* MY follow-ups that are due today or already overdue — the Dashboard's
     "Due today" block. A reminder for a guest who has since left my book is
     not shown: it would put another marketer's guest on my screen. */
  due(ctx) {
    const session = guard.requireCapability(ctx, 'crm.read');
    const scope = domain.scopeProfileId(session);
    const rows = ctx.db.prepare(`${REMINDER_ROW}
      WHERE rm.created_by = @me AND rm.done_at IS NULL AND rm.deleted_at IS NULL
        AND rm.due_date <= @today${scopeSql(scope)}
      ORDER BY rm.due_date DESC, rm.id DESC LIMIT 100`).all({ me: session.id, today: today() });
    const t = today();
    return rows.map((r) => ({ ...r, overdue_days: Math.max(0, daysBetween(r.due_date, t)) }));
  },

  /* Open reminders on one guest, whoever set them — the guest panel shows the
     whole team's follow-ups for a guest the caller may already see. */
  forCustomer(ctx, { customerId }) {
    guard.requireCapability(ctx, 'crm.read');
    const customer = customersRepo.findById(ctx.db, Number(customerId));
    guard.requireCustomerInScope(ctx, customer);
    const t = today();
    return ctx.db.prepare(`${REMINDER_ROW}
      WHERE rm.customer_id = ? AND rm.done_at IS NULL AND rm.deleted_at IS NULL
      ORDER BY rm.due_date DESC, rm.id DESC`).all(customer.id)
      .map((r) => ({ ...r, overdue_days: Math.max(0, daysBetween(r.due_date, t)), due: r.due_date <= t }));
  },

  markDone(ctx, { id }) {
    const session = guard.requireCapability(ctx, 'crm.update');
    const row = ctx.db.prepare('SELECT * FROM reminders WHERE id = ? AND deleted_at IS NULL').get(Number(id));
    if (!row) throw notFound('Reminder not found.');
    const customer = customersRepo.findById(ctx.db, row.customer_id);
    guard.requireCustomerInScope(ctx, customer);
    if (row.done_at) return { ok: true };
    const now = nowIso();
    ctx.db.prepare('UPDATE reminders SET done_at = ?, done_by = ?, updated_at = ? WHERE id = ?').run(now, session.id, now, row.id);
    /* The bell entry is about this follow-up; once it is done, it goes. */
    require('./notification-service').refreshUserDerived(ctx.db, session);
    ctx.audit({ action: 'REMINDER_DONE', entity_type: 'reminder', entity_id: row.id,
      description: `Follow-up for ${customer.full_name} marked done`, metadata: { customer_id: customer.id } });
    return { ok: true };
  },
};

/* =================================================================== tags */

const TAG_COLORS = Object.freeze(['slate', 'red', 'orange', 'amber', 'green', 'teal', 'blue', 'violet', 'pink', 'gold']);

function cleanTagName(name) {
  const value = String(name || '').replace(/\s+/g, ' ').trim();
  if (!value) throw validation('A tag needs a name.', 'name');
  if (value.length > 40) throw validation('Keep tag names to 40 characters.', 'name');
  return value;
}
function cleanColor(color) {
  if (color === undefined || color === null || color === '') return 'slate';
  if (!TAG_COLORS.includes(color)) throw validation('Choose one of the listed colours.', 'color');
  return color;
}

const tags = {
  /* The shared vocabulary. Names and colours only — never which guests carry a
     tag, which would be a view into other marketers' books. */
  list(ctx) {
    guard.requireCapability(ctx, 'customers.read');
    return ctx.db.prepare('SELECT id, name, color FROM tags ORDER BY name COLLATE NOCASE').all();
  },

  /* Creating a tag that already exists (in any letter case) answers with the
     existing one, so two people typing "VIP" do not fork the vocabulary. */
  create(ctx, { name, color }) {
    const session = guard.requireCapability(ctx, 'customers.update');
    const clean = cleanTagName(name);
    const existing = ctx.db.prepare('SELECT id, name, color FROM tags WHERE name = ? COLLATE NOCASE').get(clean);
    if (existing) return existing;
    const id = ctx.db.prepare('INSERT INTO tags (name, color, created_at, created_by) VALUES (?, ?, ?, ?)')
      .run(clean, cleanColor(color), nowIso(), session.id).lastInsertRowid;
    ctx.audit({ action: 'TAG_CREATE', entity_type: 'tag', entity_id: id, description: `Created tag ${clean}` });
    return { id, name: clean, color: cleanColor(color) };
  },

  /* Renaming or recolouring changes the tag on EVERY guest, so it is a shared
     setting, not a guest edit. */
  update(ctx, { id, name, color }) {
    guard.requireCapability(ctx, 'settings.write');
    const row = ctx.db.prepare('SELECT * FROM tags WHERE id = ?').get(Number(id));
    if (!row) throw notFound('Tag not found.');
    const next = { name: name === undefined ? row.name : cleanTagName(name), color: color === undefined ? row.color : cleanColor(color) };
    const clash = ctx.db.prepare('SELECT id FROM tags WHERE name = ? COLLATE NOCASE AND id <> ?').get(next.name, row.id);
    if (clash) throw validation('Another tag already has that name.', 'name');
    ctx.db.prepare('UPDATE tags SET name = ?, color = ? WHERE id = ?').run(next.name, next.color, row.id);
    ctx.audit({ action: 'TAG_UPDATE', entity_type: 'tag', entity_id: row.id, description: `Changed tag ${row.name}` });
    return { id: row.id, ...next };
  },

  remove(ctx, { id }) {
    guard.requireCapability(ctx, 'settings.write');
    const row = ctx.db.prepare('SELECT * FROM tags WHERE id = ?').get(Number(id));
    if (!row) throw notFound('Tag not found.');
    const run = ctx.db.transaction(() => {
      ctx.db.prepare('DELETE FROM customer_tags WHERE tag_id = ?').run(row.id);
      ctx.db.prepare('DELETE FROM tags WHERE id = ?').run(row.id);
      ctx.audit({ action: 'TAG_DELETE', entity_type: 'tag', entity_id: row.id, description: `Deleted tag ${row.name}` });
    });
    run();
    return { ok: true };
  },

  /* Replace a guest's tags with exactly this set. */
  setForCustomer(ctx, { id, tagIds }) {
    const session = guard.requireCapability(ctx, 'customers.update');
    const customer = customersRepo.findById(ctx.db, Number(id));
    guard.requireCustomerInScope(ctx, customer);
    const wanted = [...new Set((tagIds || []).map(Number))];
    if (wanted.length > 20) throw validation('A guest can carry at most 20 tags.', 'tagIds');
    for (const tagId of wanted) {
      if (!ctx.db.prepare('SELECT 1 FROM tags WHERE id = ?').get(tagId)) throw validation('One of those tags no longer exists.', 'tagIds');
    }
    const now = nowIso();
    const run = ctx.db.transaction(() => {
      ctx.db.prepare('DELETE FROM customer_tags WHERE customer_id = ?').run(customer.id);
      const add = ctx.db.prepare('INSERT INTO customer_tags (customer_id, tag_id, created_at, created_by) VALUES (?, ?, ?, ?)');
      for (const tagId of wanted) add.run(customer.id, tagId, now, session.id);
      ctx.audit({ action: 'CUSTOMER_TAGS', entity_type: 'customer', entity_id: customer.id,
        description: `Tags changed for ${customer.full_name}`, metadata: { tag_ids: wanted } });
    });
    run();
    return { id: customer.id, tags: wanted.sort((a, b) => a - b) };
  },
};

/* ========================================================== special dates */

function validMonthDay(month, day) {
  const last = new Date(Date.UTC(2024, month, 0)).getUTCDate(); // a leap year allows 29 Feb
  return Number.isInteger(month) && month >= 1 && month <= 12 && Number.isInteger(day) && day >= 1 && day <= last;
}

const specialDates = {
  /* Replace a guest's list of special dates. The birth date itself is an
     ordinary guest field (customers.update). */
  set(ctx, { id, dates }) {
    const session = guard.requireCapability(ctx, 'customers.update');
    const customer = customersRepo.findById(ctx.db, Number(id));
    guard.requireCustomerInScope(ctx, customer);
    const clean = (dates || []).map((d, i) => {
      const label = String(d.label || '').trim();
      if (!label) throw validation(`Special date ${i + 1} needs a label.`, 'dates');
      if (!validMonthDay(Number(d.month), Number(d.day))) throw validation(`Special date ${i + 1} is not a real day.`, 'dates');
      return { label, month: Number(d.month), day: Number(d.day) };
    });
    const now = nowIso();
    const run = ctx.db.transaction(() => {
      ctx.db.prepare('DELETE FROM customer_special_dates WHERE customer_id = ?').run(customer.id);
      const add = ctx.db.prepare(`INSERT INTO customer_special_dates (customer_id, label, month, day, created_at, created_by)
        VALUES (?, ?, ?, ?, ?, ?)`);
      for (const d of clean) add.run(customer.id, d.label, d.month, d.day, now, session.id);
      ctx.audit({ action: 'CUSTOMER_DATES', entity_type: 'customer', entity_id: customer.id,
        description: `Special dates changed for ${customer.full_name}` });
    });
    run();
    return { id: customer.id, count: clean.length };
  },
};

/* Birthdays and special dates inside the next `days` days (today included),
   for the guests a scope may see. Soonest first. */
function upcomingDates(db, scopeId, { days = 7, from = today() } = {}) {
  const until = addDays(from, days);
  const out = [];
  const guests = db.prepare(`SELECT c.id, c.full_name, c.code, c.photo_name, c.birth_date, c.marketing_profile_id
    FROM customers c WHERE c.deleted_at IS NULL AND c.birth_date IS NOT NULL${scopeSql(scopeId)}`).all();
  for (const g of guests) {
    const [y, m, d] = g.birth_date.split('-').map(Number);
    const on = nextOccurrence(m, d, from);
    if (on && on <= until) {
      const age = Number(on.slice(0, 4)) - y;
      out.push({ customer_id: g.id, full_name: g.full_name, code: g.code, photo_name: g.photo_name,
        marketing_profile_id: g.marketing_profile_id,
        kind: 'birthday', label: age > 0 && age < 130 ? `Birthday (${age})` : 'Birthday', date: on, days_away: daysBetween(from, on) });
    }
  }
  const specials = db.prepare(`SELECT s.label, s.month, s.day, c.id, c.full_name, c.code, c.photo_name, c.marketing_profile_id
    FROM customer_special_dates s JOIN customers c ON c.id = s.customer_id
    WHERE c.deleted_at IS NULL${scopeSql(scopeId)}`).all();
  for (const s of specials) {
    const on = nextOccurrence(s.month, s.day, from);
    if (on && on <= until) {
      out.push({ customer_id: s.id, full_name: s.full_name, code: s.code, photo_name: s.photo_name,
        marketing_profile_id: s.marketing_profile_id,
        kind: 'special', label: s.label, date: on, days_away: daysBetween(from, on) });
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.full_name.localeCompare(b.full_name));
}

/* ============================================================= duplicates */

/* Who else already has this phone number or passport? Asked while a guest is
   being created or edited. The check runs across the WHOLE book, because a
   duplicate in somebody else's book is exactly the one that forks a guest's
   history — but for a guest outside the caller's scope it answers only that
   such a guest exists, never who, with what Guest ID, or what their details
   are. */
function duplicates(ctx, { phone, passportNo, excludeId }) {
  const session = guard.requireCapability(ctx, 'customers.read');
  const digits = normalizePhone(phone);
  const passport = normalizePassport(passportNo);
  const matches = new Map();
  const exclude = excludeId ? Number(excludeId) : -1;

  if (digits.length >= MIN_PHONE_DIGITS) {
    for (const row of ctx.db.prepare(`SELECT c.id, c.code, c.full_name, c.phone, c.passport_no, c.marketing_profile_id
        FROM customers c WHERE c.deleted_at IS NULL AND c.id <> @exclude AND c.phone IS NOT NULL
          AND ${PHONE_SQL('c.phone')} = @digits LIMIT 20`).all({ exclude, digits })) {
      matches.set(row.id, { row, on: ['phone'] });
    }
  }
  if (passport.length >= 3) {
    for (const row of ctx.db.prepare(`SELECT c.id, c.code, c.full_name, c.phone, c.passport_no, c.marketing_profile_id
        FROM customers c WHERE c.deleted_at IS NULL AND c.id <> @exclude AND c.passport_no IS NOT NULL
          AND UPPER(REPLACE(c.passport_no,' ','')) = @passport LIMIT 20`).all({ exclude, passport })) {
      const hit = matches.get(row.id);
      if (hit) hit.on.push('passport'); else matches.set(row.id, { row, on: ['passport'] });
    }
  }

  const visible = [];
  const hidden = { phone: false, passport: false };
  for (const { row, on } of matches.values()) {
    if (domain.customerInScope(session, row)) {
      visible.push({ id: row.id, code: row.code, full_name: row.full_name, phone: row.phone,
        passport_no: row.passport_no, match: on, in_scope: true });
    } else {
      for (const f of on) hidden[f] = true;
    }
  }
  return { matches: visible, elsewhere: hidden };
}

/* ================================================================== merge */

/* Fields copied from the duplicate only where the primary has nothing. */
const MERGE_FILL = Object.freeze(['phone', 'email', 'passport_no', 'nationality', 'photo_name', 'notes', 'birth_date']);

function merge(ctx, { primaryId, duplicateId }) {
  const session = guard.requireCapability(ctx, 'customers.merge');
  if (Number(primaryId) === Number(duplicateId)) throw validation('Choose two different guests to merge.', 'duplicateId');
  const primary = customersRepo.findById(ctx.db, Number(primaryId));
  if (!primary) throw notFound('Guest not found.');
  guard.requireCustomerInScope(ctx, primary);
  const duplicate = customersRepo.findById(ctx.db, Number(duplicateId));
  if (!duplicate) throw notFound('Guest not found.');
  guard.requireCustomerInScope(ctx, duplicate);

  const now = nowIso();
  const run = ctx.db.transaction(() => {
    const moved = {};
    moved.notes = ctx.db.prepare('UPDATE crm_notes SET customer_id = ? WHERE customer_id = ?').run(primary.id, duplicate.id).changes;
    moved.reservations = ctx.db.prepare('UPDATE reservations SET customer_id = ? WHERE customer_id = ?').run(primary.id, duplicate.id).changes;
    moved.reminders = ctx.db.prepare('UPDATE reminders SET customer_id = ? WHERE customer_id = ?').run(primary.id, duplicate.id).changes;
    moved.tags = ctx.db.prepare(`INSERT OR IGNORE INTO customer_tags (customer_id, tag_id, created_at, created_by)
      SELECT ?, tag_id, created_at, created_by FROM customer_tags WHERE customer_id = ?`).run(primary.id, duplicate.id).changes;
    ctx.db.prepare('DELETE FROM customer_tags WHERE customer_id = ?').run(duplicate.id);
    moved.specialDates = ctx.db.prepare('UPDATE customer_special_dates SET customer_id = ? WHERE customer_id = ?').run(primary.id, duplicate.id).changes;
    ctx.db.prepare('UPDATE notifications SET related_customer_id = ? WHERE related_customer_id = ?').run(primary.id, duplicate.id);

    const patch = {};
    for (const column of MERGE_FILL) {
      const mine = primary[column];
      if ((mine === null || mine === undefined || String(mine).trim() === '') && duplicate[column]) patch[column] = duplicate[column];
    }
    patch.updated_at = now; patch.updated_by = session.id;
    customersRepo.update(ctx.db, primary.id, patch);

    ctx.db.prepare(`UPDATE customers SET deleted_at = ?, deleted_by = ?, merged_into_id = ?, updated_at = ?, updated_by = ?,
      row_version = row_version + 1 WHERE id = ?`).run(now, session.id, primary.id, now, session.id, duplicate.id);

    ctx.audit({ action: 'CUSTOMER_MERGE', entity_type: 'customer', entity_id: primary.id,
      description: `Merged ${duplicate.full_name} (${duplicate.code}) into ${primary.full_name} (${primary.code})`,
      metadata: { duplicate_id: duplicate.id, duplicate_code: duplicate.code, moved, filled: Object.keys(patch).filter((k) => MERGE_FILL.includes(k)) } });
    return moved;
  });
  const moved = run();
  return { id: primary.id, merged: duplicate.id, moved };
}

/* ============================================================ saved views */

const VIEW_KEY = 'views.saved';
const VIEW_SCREENS = Object.freeze(['overview', 'customerlist', 'reservations']);
const MAX_VIEWS_PER_SCREEN = 30;

const views = {
  list(ctx, { screen } = {}) {
    const session = guard.requireCapability(ctx, 'customers.read');
    const all = readPref(ctx.db, session.id, VIEW_KEY, []);
    return (Array.isArray(all) ? all : [])
      .filter((v) => !screen || v.screen === screen)
      .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
  },

  /* Saving under a name that already exists on that screen replaces it — the
     operator is updating their view, not making a second one. */
  save(ctx, { screen, name, state }) {
    const session = guard.requireCapability(ctx, 'customers.read');
    if (!VIEW_SCREENS.includes(screen)) throw validation('Unknown screen.', 'screen');
    const clean = String(name || '').replace(/\s+/g, ' ').trim();
    if (!clean) throw validation('Give the view a name.', 'name');
    const all = readPref(ctx.db, session.id, VIEW_KEY, []);
    const list = Array.isArray(all) ? all : [];
    const same = list.find((v) => v.screen === screen && String(v.name).toLowerCase() === clean.toLowerCase());
    const now = nowIso();
    let id;
    if (same) { same.state = state || {}; same.name = clean; same.created_at = now; id = same.id; }
    else {
      if (list.filter((v) => v.screen === screen).length >= MAX_VIEWS_PER_SCREEN) {
        throw validation(`You can keep up to ${MAX_VIEWS_PER_SCREEN} saved views per screen.`, 'name');
      }
      id = list.reduce((m, v) => Math.max(m, Number(v.id) || 0), 0) + 1;
      list.push({ id, screen, name: clean, state: state || {}, created_at: now });
    }
    writePref(ctx.db, session.id, VIEW_KEY, list);
    ctx.audit({ action: 'VIEW_SAVE', entity_type: 'view', entity_id: id, description: `Saved view ${clean}` });
    return { id, name: clean, screen };
  },

  remove(ctx, { id }) {
    const session = guard.requireCapability(ctx, 'customers.read');
    const all = readPref(ctx.db, session.id, VIEW_KEY, []);
    const list = Array.isArray(all) ? all : [];
    const target = list.find((v) => Number(v.id) === Number(id));
    if (!target) throw notFound('Saved view not found.');
    writePref(ctx.db, session.id, VIEW_KEY, list.filter((v) => v !== target));
    ctx.audit({ action: 'VIEW_DELETE', entity_type: 'view', entity_id: target.id, description: `Deleted view ${target.name}` });
    return { ok: true };
  },
};

/* ======================================================= recently viewed */

const RECENT_KEY = 'guests.recent';
const RECENT_MAX = 10;

const recent = {
  /* Remember that the caller opened this guest. Only a guest the caller may
     read is remembered, so the list can never become a way to name one. */
  viewed(ctx, { id }) {
    const session = guard.requireCapability(ctx, 'customers.read');
    const customer = customersRepo.findById(ctx.db, Number(id));
    guard.requireCustomerInScope(ctx, customer);
    const prev = readPref(ctx.db, session.id, RECENT_KEY, []);
    const list = [customer.id, ...(Array.isArray(prev) ? prev : []).map(Number).filter((n) => n !== customer.id)].slice(0, RECENT_MAX);
    writePref(ctx.db, session.id, RECENT_KEY, list);
    return { ok: true };
  },

  /* The remembered guests, most recent first, re-checked against scope and
     archive state on every read: a guest reassigned away or archived since
     simply drops out. */
  list(ctx) {
    const session = guard.requireCapability(ctx, 'customers.read');
    const ids = readPref(ctx.db, session.id, RECENT_KEY, []);
    const out = [];
    for (const id of (Array.isArray(ids) ? ids : []).slice(0, RECENT_MAX)) {
      const row = ctx.db.prepare(`SELECT c.id, c.code, c.full_name, c.photo_name, c.nationality, c.marketing_profile_id,
          p.full_name AS marketing_name
        FROM customers c LEFT JOIN profiles p ON p.id = c.marketing_profile_id
        WHERE c.id = ? AND c.deleted_at IS NULL`).get(Number(id));
      if (row && domain.customerInScope(session, row)) out.push(row);
    }
    return out;
  },
};

/* ========================================================== note templates */

const TEMPLATE_KEY = 'crm.note_templates';
const DEFAULT_TEMPLATES = Object.freeze([
  'Called, no answer', 'Called, interested', 'Offer sent', 'Will call back', 'Invitation accepted', 'Not interested',
]);

/* The shared settings value is free text; a template list must be a short
   JSON array of short strings, or it is refused before it is stored. */
function validateTemplates(value) {
  let parsed;
  try { parsed = JSON.parse(value); } catch (_) { throw validation('Templates must be a list.', 'value'); }
  if (!Array.isArray(parsed)) throw validation('Templates must be a list.', 'value');
  const clean = parsed.map((t) => String(t ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (clean.length > 20) throw validation('Keep the list to 20 templates.', 'value');
  if (clean.some((t) => t.length > 120)) throw validation('Keep each template under 120 characters.', 'value');
  return JSON.stringify(clean);
}

module.exports = {
  reminders, tags, specialDates, views, recent,
  duplicates, merge, upcomingDates, nextOccurrence,
  normalizePhone, normalizePassport, MIN_PHONE_DIGITS, validateTemplates,
  TAG_COLORS, DEFAULT_TEMPLATES, TEMPLATE_KEY, VIEW_SCREENS,
};


