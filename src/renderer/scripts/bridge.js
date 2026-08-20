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
  const bridge = window.ipc;
  if (!bridge) {
    document.body.innerHTML = '<div class="fatal-notice">'
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
      /* Cropping sends the managed name and a rectangle; the trusted process
         does the work and returns a NEW managed name. Image bytes never cross
         the boundary in either direction. */
      crop: ({ name, x, y, size }) => bridge.photos.crop({ name, x, y, size }),
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
      /* Opens the application's OWN data folder through a no-argument verb.
         The renderer supplies no path, so there is nothing to traverse and
         nothing reaches a shell — the main process resolves the fixed location
         and hands it to the OS file manager. This used to be a stub that always
         returned VALIDATION, so the button in Settings could only ever fail. */
      openFolder: () => bridge.app.openDataFolder(),
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

  /* CSP makes a display:none style attribute in markup impossible, so the
     markup carries an `is-hidden` class. But the screens hide and show by assigning
     `element.style.display` — including `= ''` to mean "show" — and an empty
     inline value falls back to the class, which would leave the element hidden
     forever. Converting the class to an inline style once at startup restores
     exactly the semantics the screens were written against, using CSSOM, which
     the policy permits. Style attributes in markup are the thing CSP forbids;
     setting them from script is not. */
  function adoptInitialHiddenState() {
    for (const node of document.querySelectorAll('.is-hidden')) {
      node.style.display = 'none';
      node.classList.remove('is-hidden');
    }
    /* The brand mark is a graceful fallback: show the logo only if it loads,
       and drop the image entirely if it does not. This used to be an inline
       onload/onerror pair, which the policy renders inert — leaving both the
       letter and a broken image on screen at once. */
    for (const img of document.querySelectorAll('[data-brand-logo]')) {
      const fallback = img.previousElementSibling;
      img.addEventListener('load', () => {
        img.style.display = 'block';
        if (fallback) fallback.style.display = 'none';
      });
      img.addEventListener('error', () => img.remove());
    }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', adoptInitialHiddenState, { once: true });
  } else {
    adoptInitialHiddenState();
  }

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
