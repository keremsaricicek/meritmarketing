'use strict';
/* ROLE BOUNDARIES — horizontal and vertical privilege escalation.
 *
 * Every probe here is a DIRECT window.api call, not a UI interaction. The UI is
 * one client of the API; hiding a button proves nothing about the boundary.
 */

const { Suite } = require('../lib/harness');

module.exports = async function () {
  const s = new Suite('authorization/role-boundaries');
  await s.open();
  await s.bootstrap();
  const ids = await s.seedMarketingUser();

  // A guest that belongs to KEREM, with a reservation and a note.
  const foreign = await s.makeGuest({
    code: 'RB-FOREIGN', name: 'ROLE BOUNDARY FOREIGN',
    phone: '+90 500 000 00 01', passport: 'RBPASS1',
    visitMonthsAgo: 2, invitedBy: ids.keremId, assignTo: ids.keremId, note: 'kerem only',
  });

  await s.loginSena();

  // -------------------------------------------------- horizontal escalation
  const horizontal = {
    'customers.get':               await s.api('customers', 'get', { id: foreign.id }),
    'customers.update':            await s.api('customers', 'update', { id: foreign.id, fullName: 'HACKED' }),
    'customers.delete':            await s.api('customers', 'delete', { id: foreign.id }),
    'customers.assign':            await s.api('customers', 'assign', { id: foreign.id, profileId: ids.senaId }),
    'crmNotes.list':               await s.api('crmNotes', 'list', { customerId: foreign.id }),
    'crmNotes.create':             await s.api('crmNotes', 'create', { customerId: foreign.id, note: 'x' }),
    'profiles.relatedCustomers':   await s.api('profiles', 'relatedCustomers', { id: ids.keremId }),
  };
  for (const [verb, res] of Object.entries(horizontal)) {
    s.denied(`horizontal escalation blocked: ${verb}`, res, 'FORBIDDEN');
  }

  // -------------------------------------------------- vertical escalation
  const vertical = {
    'profiles.create':          await s.api('profiles', 'create', { fullName: 'EVIL PROFILE' }),
    'profiles.update':          await s.api('profiles', 'update', { id: ids.keremId, inactive: true }),
    'profiles.delete':          await s.api('profiles', 'delete', { id: ids.keremId }),
    'users.list':               await s.api('users', 'list', {}),
    'users.create':             await s.api('users', 'create', { username: 'evil', password: 'evilpass', role: 'ADMIN' }),
    'audit.list':               await s.api('audit', 'list', {}),
    'backup.create':            await s.api('backup', 'create', {}),
    'backup.list':              await s.api('backup', 'list', {}),
    'backup.restore':           await s.api('backup', 'restore', { name: 'x' }),
    'settings.setPermissions':  await s.api('settings', 'setPermissions', { matrix: { MARKETING: { 'customers.delete': true } } }),
    'reservations.delete':      await s.api('reservations', 'delete', { id: 1 }),
  };
  for (const [verb, res] of Object.entries(vertical)) {
    s.denied(`vertical escalation blocked: ${verb}`, res, 'FORBIDDEN');
  }

  // -------------------------------------------------- IDOR by id enumeration
  const idor = await s.page.evaluate(async () => {
    const out = { reservations: 'none-found', customers: 'none-found', notes: 'none-found' };
    for (let id = 1; id <= 60; id++) {
      const r = await window.api.reservations.get({ id });
      if (r.ok && r.data && r.data.invited_by_name && r.data.invited_by_name !== 'SENA NUR AKMUT') {
        out.reservations = 'LEAKED ' + r.data.invited_by_name; break;
      }
    }
    for (let id = 1; id <= 60; id++) {
      const r = await window.api.customers.get({ id });
      if (r.ok && r.data && r.data.marketing_name && r.data.marketing_name !== 'SENA NUR AKMUT') {
        out.customers = 'LEAKED ' + r.data.full_name; break;
      }
    }
    for (let id = 1; id <= 60; id++) {
      const r = await window.api.crmNotes.list({ customerId: id });
      if (r.ok && r.data.length) {
        const c = await window.api.customers.get({ id });
        if (!c.ok) { out.notes = 'LEAKED notes for unreadable customer ' + id; break; }
      }
    }
    return out;
  });
  s.check('IDOR: reservation ids cannot be walked into another book', idor.reservations === 'none-found', idor.reservations);
  s.check('IDOR: customer ids cannot be walked into another book', idor.customers === 'none-found', idor.customers);
  s.check('IDOR: notes cannot be read for an unreadable customer', idor.notes === 'none-found', idor.notes);

  // -------------------------------------------------- scoped list hygiene
  const listScope = await s.page.evaluate(async (name) => {
    const cs = (await window.api.customers.list({ pageSize: 5000 })).data.rows.map(r => r.full_name);
    const rs = (await window.api.reservations.list({ pageSize: 5000 })).data.rows.map(r => r.customer_name);
    const cancelled = (await window.api.reservations.list({ view: 'cancelled', pageSize: 5000 })).data.rows.map(r => r.customer_name);
    return { inCustomers: cs.includes(name), inReservations: rs.includes(name), inCancelled: cancelled.includes(name) };
  }, 'ROLE BOUNDARY FOREIGN');
  s.check('customers.list excludes another marketer\'s guest', !listScope.inCustomers, JSON.stringify(listScope));
  s.check('reservations.list excludes another marketer\'s reservation', !listScope.inReservations, JSON.stringify(listScope));
  s.check('cancelled view excludes another marketer\'s reservation', !listScope.inCancelled, JSON.stringify(listScope));

  // -------------------------------------------------- cross-scope WRITE
  const crossWrite = await s.api('customers', 'create', {
    code: 'RB-CROSSWRITE', fullName: 'CROSS WRITE', marketingProfileId: ids.keremId,
  });
  s.denied('MARKETING cannot create a guest owned by another marketer', crossWrite, 'FORBIDDEN');

  // -------------------------------------------------- MANAGER boundaries
  await s.loginManager();
  const mgr = {
    'users.create':        await s.api('users', 'create', { username: 'mgrmade', password: 'password1', role: 'ADMIN' }),
    'backup.create':       await s.api('backup', 'create', {}),
    'backup.restore':      await s.api('backup', 'restore', { name: 'x' }),
    'reservations.delete': await s.api('reservations', 'delete', { id: 1 }),
  };
  s.check('MANAGER cannot create users', mgr['users.create'].ok !== true, JSON.stringify(mgr['users.create'].error));
  s.denied('MANAGER cannot create a backup (full DB incl. credentials)', mgr['backup.create'], 'FORBIDDEN');
  s.denied('MANAGER cannot restore a backup', mgr['backup.restore'], 'FORBIDDEN');
  s.denied('MANAGER cannot permanently delete a reservation', mgr['reservations.delete'], 'FORBIDDEN');

  // backup.create must not be grantable through the permission matrix either
  const configurable = await s.page.evaluate(async () => {
    const m = await window.api.settings.permissions({});
    return m.ok ? Object.keys(m.data.labels) : [];
  });
  s.check('backup.create is not exposed as a configurable permission',
    !configurable.includes('backup.create'), JSON.stringify(configurable));

  await s.close();
  return s.finish();
};
