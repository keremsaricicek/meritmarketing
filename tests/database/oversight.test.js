'use strict';
/* OVERSIGHT — the activity feed, global search, Team control and the audit
 * log's filters.
 *
 * All four are read-only views, so the risk is not that they damage data but
 * that they show it to the wrong person, or quietly show nothing. The global
 * search shipped querying a table called `marketing_profiles` — the schema's is
 * `profiles` — so every search failed with an internal error while the boundary
 * suites, which only check WHO may call it, stayed green. These assertions are
 * about what comes back.
 */

const { Suite } = require('../lib/harness');
const { TestApp } = require('../lib/db-harness');
const customers = require('../../src/main/services/customer-service');
const reservations = require('../../src/main/services/reservation-service');
const support = require('../../src/main/services/support-services');
const oversight = require('../../src/main/services/oversight-service');
const { today, addDays } = require('../../src/shared/contracts/dates');

async function attempt(fn) {
  try { return { ok: true, data: await fn() }; } catch (e) { return { ok: false, code: e.code, message: e.message }; }
}
const names = (rows) => rows.map((r) => r.full_name);
const isNewestFirst = (rows) => rows.every((r, i) => i === 0
  || rows[i - 1].created_at > r.created_at || (rows[i - 1].created_at === r.created_at && rows[i - 1].id > r.id));

module.exports = async function () {
  const s = new Suite('database/oversight');
  const app = new TestApp('mmh-oversight');

  try {
    await app.bootstrapAdmin();
    const manager = await app.createManagerUser({ username: 'manager' });
    const sena = await app.createMarketingUser({ username: 'sena', profileName: 'SENA NUR AKMUT' });
    const kerem = await app.createMarketingUser({ username: 'kerem', profileName: 'KEREM SARICICEK' });
    const grant = (matrix) => support.settings.setPermissions(app.ctx(), { matrix });

    // ------------------------------------------------------------ fixtures
    /* Admin builds one guest for each marketer, then each marketer works on
       their own book so the feed has several actors. */
    const ayse = customers.create(app.ctx(), { code: 'OV-1', fullName: 'Ayşe Yilmaz', registered: true,
      marketingProfileId: sena.profileId, phone: '+90 555 111 2233' });
    const mehmet = customers.create(app.ctx(), { code: 'OV-2', fullName: 'MEHMET DEMIR', registered: true,
      marketingProfileId: kerem.profileId, notes: 'Prefers the 100% sea-view suite' });
    const lead = customers.create(app.ctx(), { code: 'OV_3', fullName: 'Unassigned Lead', registered: true });
    const stay = reservations.create(app.ctx(), { customerId: mehmet.id, checkIn: addDays(today(), 10),
      checkOut: addDays(today(), 12), invitedByProfileId: kerem.profileId, note: 'Anniversary trip, VIP transfer' });

    await app.login('sena', sena.password);
    support.crmNotes.create(app.ctx(), { customerId: ayse.id, note: 'Sena invited guest to the gala dinner' });
    await app.login('kerem', kerem.password);
    support.crmNotes.create(app.ctx(), { customerId: mehmet.id, note: 'Called about the anniversary booking' });
    customers.update(app.ctx(), { id: mehmet.id, nationality: 'TR' });

    // =================================================== 1. global search
    await app.loginAdmin();
    const search = (q) => oversight.search.global(app.ctx(), { q });

    let r = await attempt(() => search('sena'));
    s.check('search runs against the real schema (no internal error)', r.ok, r.message);
    r = r.ok ? r.data : { guests: [], notes: [], reservations: [], profiles: [] };
    s.check('"sena" finds the note "Sena invited guest…" (partial, case-insensitive)',
      r.notes.some((n) => n.note.startsWith('Sena invited guest')), JSON.stringify(r.notes));
    s.check('"sena" finds the guest owned by the SENA profile (by marketer name)',
      names(r.guests).includes('Ayşe Yilmaz'), JSON.stringify(names(r.guests)));
    s.check('"sena" finds the SENA NUR AKMUT profile',
      r.profiles.some((p) => p.full_name === 'SENA NUR AKMUT' && p.guests === 1), JSON.stringify(r.profiles));

    r = search('mehMET');
    s.check('guest names match partially and case-insensitively', names(r.guests).includes('MEHMET DEMIR'),
      JSON.stringify(names(r.guests)));
    r = search('vip transfer');
    s.check('reservation notes are searched',
      r.reservations.length === 1 && r.reservations[0].id === stay.id
      && r.reservations[0].reservation_note === 'Anniversary trip, VIP transfer'
      && r.reservations[0].invited_by === 'KEREM SARICICEK', JSON.stringify(r.reservations));
    r = search('ANNIVERSARY');
    s.check('one term reaches notes and reservations together',
      r.notes.length === 1 && r.reservations.length === 1, JSON.stringify({ n: r.notes.length, r: r.reservations.length }));
    r = search('saricicek');
    s.check('profile names are searched', r.profiles.some((p) => p.full_name === 'KEREM SARICICEK'),
      JSON.stringify(r.profiles));
    s.check('a reservation is found by the inviting marketer', r.reservations.some((x) => x.id === stay.id));

    /* LIKE wildcards a person types must match literally. */
    r = search('100%');
    s.check('"%" is matched literally, not as a wildcard', names(r.guests).join() === 'MEHMET DEMIR',
      JSON.stringify(names(r.guests)));
    r = search('OV_');
    s.check('"_" is matched literally (OV_3 only, not OV-1/OV-2)', names(r.guests).join() === 'Unassigned Lead',
      JSON.stringify(names(r.guests)));
    r = search('%%');
    s.check('a query of only wildcards matches nothing', r.guests.length + r.notes.length + r.reservations.length === 0);
    r = search('x');
    s.check('a one-character query returns nothing rather than the whole book',
      r.guests.length === 0 && r.profiles.length === 0);

    /* MARKETING: the same record scope as customers.list. */
    await app.login('kerem', kerem.password);
    const keremList = customers.list(app.ctx(), { pageSize: 100 }).rows.map((g) => g.id).sort();
    r = search('ov-');
    s.check('MARKETING finds only its own guests',
      r.guests.every((g) => g.marketing_profile_id === kerem.profileId) && names(r.guests).includes('MEHMET DEMIR'),
      JSON.stringify(r.guests.map((g) => [g.full_name, g.marketing_profile_id])));
    s.check('… which is exactly what customers.list scopes them to',
      r.guests.map((g) => g.id).sort().join() === keremList.join(), `${r.guests.map((g) => g.id)} vs ${keremList}`);
    r = search('sena');
    s.check("MARKETING does not find another marketer's guest, note or profile",
      r.guests.length === 0 && r.notes.length === 0 && r.profiles.length === 0, JSON.stringify(r));
    r = search('gala');
    s.check("MARKETING does not find another marketer's CRM note by its text", r.notes.length === 0);
    r = search('anniversary');
    s.check('MARKETING finds its own notes and reservations', r.notes.length === 1 && r.reservations.length === 1);
    r = search('unassigned');
    s.check('MARKETING does not find unassigned guests', r.guests.length === 0);

    // ==================================================== 2. activity feed
    /* Kerem has no activity.team: own actions only, whatever is asked. */
    let feed = oversight.activity.feed(app.ctx(), {});
    s.check('without activity.team the feed is the caller\'s own actions',
      feed.teamWide === false && feed.events.length === 2 && feed.events.every((e) => e.actor_user_id === kerem.userId),
      JSON.stringify(feed.events.map((e) => [e.action, e.actor_user_id])));
    feed = oversight.activity.feed(app.ctx(), { actorUserId: sena.userId });
    s.check('asking for someone else\'s actions without activity.team still returns only your own',
      feed.events.length === 2 && feed.events.every((e) => e.actor_user_id === kerem.userId));
    s.check('own tallies match the events', feed.total === 2 && feed.byKind.note === 1 && feed.byKind.guest === 1,
      JSON.stringify(feed.byKind));

    await app.login('manager', manager.password);
    feed = oversight.activity.feed(app.ctx(), {});
    s.check('a MANAGER without activity.team sees only their own (none yet)',
      feed.teamWide === false && feed.events.length === 0, JSON.stringify(feed.events.map((e) => e.action)));

    await app.loginAdmin();
    grant({ MANAGER: { 'activity.team': true } });
    await app.login('manager', manager.password);
    feed = oversight.activity.feed(app.ctx(), {});
    s.check('once granted activity.team, a MANAGER sees everyone\'s work',
      feed.teamWide === true && new Set(feed.events.map((e) => e.actor_user_id)).size === 3,
      JSON.stringify(feed.byActor.map((a) => [a.name, a.total])));
    s.check('feed events are newest first', isNewestFirst(feed.events),
      JSON.stringify(feed.events.map((e) => [e.id, e.created_at])));
    s.check('the newest event is Kerem editing the guest', feed.events[0].action === 'CUSTOMER_UPDATE'
      && feed.events[0].actor_user_id === kerem.userId, feed.events[0] && feed.events[0].action);
    const noteEvent = feed.events.find((e) => e.action === 'CRM_NOTE_CREATE' && e.actor_user_id === sena.userId);
    s.check('a note event carries its text and guest', noteEvent && noteEvent.note_text.startsWith('Sena invited')
      && noteEvent.customer_id === ayse.id, JSON.stringify(noteEvent));
    feed = oversight.activity.feed(app.ctx(), { actorUserId: sena.userId });
    s.check('with activity.team the feed can be narrowed to one person',
      feed.events.length === 1 && feed.events[0].actor_user_id === sena.userId);
    feed = oversight.activity.feed(app.ctx(), { kind: 'note' });
    s.check('kind narrows the events but not the summary tallies',
      feed.events.length === 2 && feed.events.every((e) => e.kind === 'note') && feed.total > 2,
      JSON.stringify({ events: feed.events.length, total: feed.total }));
    feed = oversight.activity.feed(app.ctx(), { from: addDays(today(), -3), to: addDays(today(), -1) });
    s.check('a window that excludes today is empty', feed.events.length === 0 && feed.total === 0);
    r = await attempt(() => oversight.activity.feed(app.ctx(), { from: today(), to: addDays(today(), -1) }));
    s.check('an inverted window is refused', !r.ok && r.code === 'VALIDATION', r.code);
    r = await attempt(() => oversight.activity.feed(app.ctx(), { from: addDays(today(), -400), to: today() }));
    s.check('an over-long window is refused', !r.ok && r.code === 'VALIDATION', r.code);

    /* A MARKETING caller granted activity.team sees colleagues' work, but not
       the content of work on guests outside their own book. */
    await app.loginAdmin();
    grant({ MANAGER: { 'activity.team': true }, MARKETING: { 'activity.team': true } });
    await app.login('kerem', kerem.password);
    feed = oversight.activity.feed(app.ctx(), {});
    const senaNote = feed.events.find((e) => e.actor_user_id === sena.userId);
    s.check('MARKETING with activity.team sees a colleague acted', !!senaNote && feed.teamWide === true);
    s.check("… but not the text or guest of a note on a guest outside its book",
      senaNote && senaNote.redacted === true && senaNote.note_text === null && senaNote.customer_id === null
      && senaNote.description === null, JSON.stringify(senaNote));
    const adminOnKerem = feed.events.find((e) => e.action === 'RESERVATION_CREATE');
    s.check('… while work on its own guest stays readable',
      adminOnKerem && !adminOnKerem.redacted && adminOnKerem.customer_id === mehmet.id, JSON.stringify(adminOnKerem));

    // ===================================================== 3. Team control
    await app.loginAdmin();
    grant({});
    await app.login('manager', manager.password);
    r = await attempt(() => oversight.team.overview(app.ctx()));
    s.check('team.overview is refused for a MANAGER by default', !r.ok && r.code === 'FORBIDDEN', r.code);
    await app.login('kerem', kerem.password);
    r = await attempt(() => oversight.team.overview(app.ctx()));
    s.check('team.overview is refused for MARKETING by default', !r.ok && r.code === 'FORBIDDEN', r.code);

    await app.loginAdmin();
    r = await attempt(() => oversight.team.overview(app.ctx()));
    s.check('ADMIN can open team.overview', r.ok, r.message);
    grant({ MANAGER: { 'team.control': true } });
    await app.login('manager', manager.password);
    r = await attempt(() => oversight.team.overview(app.ctx()));
    s.check('once granted team.control, a MANAGER can open it', r.ok, r.message);
    if (r.ok) {
      const t = r.data;
      s.check('the unassigned alert counts the unassigned guest',
        t.alerts.unassigned.count === 1 && t.alerts.unassigned.names[0] === 'Unassigned Lead', JSON.stringify(t.alerts.unassigned));
      const keremRow = t.members.find((m) => m.id === kerem.userId);
      s.check('a member row counts their guests, notes and reservations',
        keremRow && keremRow.guests === 1 && keremRow.notes_7d === 1 && keremRow.reservations_30d === 1
        && keremRow.actions_today === 2 && keremRow.profile_name === 'KEREM SARICICEK', JSON.stringify(keremRow));
      s.check('no password hash in any member row', t.members.every((m) => !('password_hash' in m)));
      s.check('sensitive actions are newest first', isNewestFirst(t.sensitive));
    }
    /* Revoking takes effect immediately. */
    await app.loginAdmin();
    grant({});
    await app.login('manager', manager.password);
    r = await attempt(() => oversight.team.overview(app.ctx()));
    s.check('revoking team.control refuses it again', !r.ok && r.code === 'FORBIDDEN', r.code);

    // =========================================== 4. audit log filters/facets
    await app.loginAdmin();
    let log = support.audit.list(app.ctx(), { actorUserId: sena.userId, pageSize: 100 });
    s.check('audit.list filters by actorUserId',
      log.total > 0 && log.rows.every((x) => x.actor_user_id === sena.userId), JSON.stringify(log.rows.map((x) => x.actor_user_id)));
    s.check('… combined with action', support.audit.list(app.ctx(), { actorUserId: kerem.userId, action: 'CRM_NOTE_CREATE' }).total === 1);
    s.check('without facets: true no facets are returned', !('facets' in log));
    log = support.audit.list(app.ctx(), { facets: true, pageSize: 1 });
    s.check('facets list the distinct actions', log.facets.actions.includes('CRM_NOTE_CREATE')
      && log.facets.actions.includes('LOGIN') && new Set(log.facets.actions).size === log.facets.actions.length,
      JSON.stringify(log.facets.actions));
    s.check('facets list the actors with id and name',
      ['admin', 'sena', 'kerem', 'manager'].every((u) => log.facets.actors.some((a) => a.username === u))
      && log.facets.actors.find((a) => a.id === sena.userId).name === 'SENA NUR AKMUT', JSON.stringify(log.facets.actors));
    s.check('facets do not change the page itself', log.rows.length === 1 && log.total > 1);
    log = support.audit.list(app.ctx(), { from: today(), to: today(), pageSize: 1000 });
    s.check('a business-date "to" includes the whole of that day', log.total === support.audit.list(app.ctx(), {}).total,
      `${log.total}`);
    s.check('a window ending yesterday is empty',
      support.audit.list(app.ctx(), { to: addDays(today(), -1) }).total === 0);
    await app.login('kerem', kerem.password);
    r = await attempt(() => support.audit.list(app.ctx(), { facets: true }));
    s.check('facets still require audit.read (MARKETING refused)', !r.ok && r.code === 'FORBIDDEN', r.code);
  } catch (e) {
    s.check('suite ran without crashing', false, e && e.stack);
  } finally {
    app.close();
  }
  return s.finish();
};
