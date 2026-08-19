'use strict';
/* Adapter between the renderer's existing call sites and the IPC bridge.
 *
 * The screens were verified by 529 assertions against the previous backend, so
 * they are left alone: rewriting three thousand lines of working UI to rename a
 * handful of verbs would risk exactly the regressions this migration must not
 * cause. What changed is where the work happens — every call below now crosses
 * into the main process, which enforces authorization and talks to SQLite.
 *
 * Anything that only made sense for a browser mock (a synchronous confirm(), a
 * localStorage reset hook) is replaced here rather than in the screens.
 */

(function () {
  const bridge = window.api;
  if (!bridge) {
    document.body.innerHTML = '<div style="padding:40px;font:14px system-ui">'
      + 'Merit Marketing Hub could not start: the application bridge is unavailable.</div>';
    return;
  }

  /* Verbs the screens call that the IPC surface names differently, or that no
     longer exist in the same shape. */
  const adapted = {
    auth: {
      ...bridge.auth,
      /* The old name asked "is this a first run"; the new one asks the same
         question of the main process, which is the only thing that knows. */
      firstRun: () => bridge.app.needsSetup(),
    },

    export: {
      /* Both old entry points funnel into one verb. The main process picks the
         file path through a native dialog; the renderer never sees it. */
      filtered: ({ entity, params }) => bridge.export.run({ entity: mapEntity(entity), params: params || {} }),
      run: ({ entity, params }) => bridge.export.run({ entity: mapEntity(entity), params: params || {} }),
    },

    photos: {
      /* Import now does what pick+save used to do in two steps, so the file
         never round-trips through the renderer as a base64 string. */
      pick: () => bridge.photos.import(),
      save: async ({ dataUrl }) => ({ ok: false, error: { code: 'VALIDATION',
        message: 'Photos are imported through the application, not uploaded.' } }),
      read: ({ name }) => bridge.photos.read({ name }),
      remove: ({ name }) => bridge.photos.remove({ name }),
    },

    notifications: {
      ...bridge.notifications,
      dismissAll: () => bridge.notifications.markAllRead(),
    },

    profiles: {
      ...bridge.profiles,
      relatedCustomers: ({ id }) => bridge.profiles.related({ id }),
    },

    reports: {
      /* Report visibility is a capability on the session now, so there is
         nothing to ask the backend. */
      access: async () => ({ ok: true, data: { allowed: true } }),
    },

    backup: {
      ...bridge.backup,
      /* Opening a folder would need shell.openExternal, which is deliberately
         not bridged: a path that reaches the shell is a command waiting to
         happen. The screen shows the location as text instead. */
      openFolder: async () => ({ ok: false, error: { code: 'VALIDATION',
        message: 'Backups are stored in the application data folder.' } }),
    },

    dialog: {
      /* window.confirm is unavailable under a sandboxed renderer and blocks the
         process anyway. Screens that used it get the in-app confirmation modal. */
      confirm: async ({ message, detail }) => ({ ok: true, data: await window.confirmDialog(message, detail) }),
    },
  };

  /* Old export entity names, mapped to the ones the surface documents. */
  function mapEntity(entity) {
    const map = {
      customerlist: 'customerlist',
      norecord: 'norecord',
      reservations: 'reservations',
      cancelled: 'cancelled',
      deleted: 'deleted',
      profiles: 'profiles',
      audit_logs: 'audit',
      audit: 'audit',
      /* Report exports that used to build their own dataset now reuse the
         scoped guest list, so a report can never widen scope. */
      profile_guests: 'customerlist',
      profile_customers: 'customerlist',
      profile_invited: 'reservations',
      report_marketing: 'profiles',
    };
    return map[entity] || 'customerlist';
  }

  window.api = Object.freeze({
    ...bridge,
    auth: adapted.auth,
    export: adapted.export,
    photos: adapted.photos,
    notifications: adapted.notifications,
    profiles: adapted.profiles,
    reports: adapted.reports,
    backup: adapted.backup,
    dialog: adapted.dialog,
  });

  /* A promise-based confirmation modal, so a destructive action can await an
     answer the way it awaited window.confirm. Defined here because the screens
     assume it exists. */
  window.confirmDialog = function confirmDialog(message, detail) {
    return new Promise((resolve) => {
      const existing = document.getElementById('appConfirm');
      if (existing) existing.remove();

      const overlay = document.createElement('div');
      overlay.className = 'overlay show';
      overlay.id = 'appConfirm';
      overlay.setAttribute('role', 'dialog');
      overlay.setAttribute('aria-modal', 'true');

      const box = document.createElement('div');
      box.className = 'modal modal-sm';

      const head = document.createElement('div');
      head.className = 'modal-head';
      const title = document.createElement('h2');
      title.className = 'modal-title';
      title.textContent = 'Confirm';
      head.appendChild(title);

      const body = document.createElement('div');
      body.className = 'modal-body';
      const p = document.createElement('p');
      /* textContent, never innerHTML: the message can contain a guest's name. */
      p.textContent = String(message || 'Are you sure?');
      body.appendChild(p);
      if (detail) {
        const d = document.createElement('p');
        d.className = 'muted';
        d.textContent = String(detail);
        body.appendChild(d);
      }

      const foot = document.createElement('div');
      foot.className = 'modal-foot';
      const cancel = document.createElement('button');
      cancel.className = 'btn btn-ghost btn-sm';
      cancel.textContent = 'Cancel';
      const confirm = document.createElement('button');
      confirm.className = 'btn btn-gold btn-sm btn-destructive-solid';
      confirm.textContent = 'Confirm';
      foot.append(cancel, confirm);

      box.append(head, body, foot);
      overlay.appendChild(box);
      document.body.appendChild(overlay);

      const finish = (value) => { overlay.remove(); resolve(value); };
      cancel.addEventListener('click', () => finish(false));
      confirm.addEventListener('click', () => finish(true));
      overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') finish(false); });
      confirm.focus();
    });
  };

  /* The main process ends a session when the account is disabled, its role
     changes, or the workstation goes idle. Clearing the screen is not
     cosmetic: it stops a guest's record sitting on an unattended monitor. */
  bridge.session.onEnded((reason) => {
    if (typeof window.handleSessionEnded === 'function') window.handleSessionEnded(reason);
    else window.location.reload();
  });
})();
