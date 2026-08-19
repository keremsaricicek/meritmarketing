'use strict';
/* Event delegation — the replacement for inline handlers.
 *
 * A strict Content-Security-Policy (`script-src 'self'`) makes `onclick="..."`
 * inert, which is exactly the point: an injected attribute in a guest's name
 * cannot execute. The behaviour that used to live in those attributes now
 * arrives as data:
 *
 *   <button data-act="openCustomerModal" data-on="click" data-args='[42]'>
 *
 * The dispatcher looks the name up in the global scope and calls it. It never
 * evaluates a string as code — `data-act` is a NAME, not an expression, so a
 * hostile value can at worst name a function that does not exist.
 */

(function () {
  /* Arguments the element supplies rather than the markup. */
  function materialise(arg, element, event) {
    if (arg && typeof arg === 'object' && typeof arg.$ === 'string') {
      switch (arg.$) {
        case 'event': return event;
        case 'this': return element;
        case 'value': return element.value;
        case 'checked': return element.checked;
        default: return undefined;
      }
    }
    return arg;
  }

  function parseArgs(element, event) {
    const raw = element.getAttribute('data-args');
    if (!raw) return [];
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch (_) { return []; }
    if (!Array.isArray(parsed)) return [];
    return parsed.map((a) => materialise(a, element, event));
  }

  /* Actions that existed only as multi-statement inline expressions. Each is a
     named function so the dispatcher stays a simple lookup. */
  const NAMED = {
    stopPropagation() { /* the dispatcher already stopped it */ },

    calDayGoToGuest(customerId) {
      window.closeModal('modalCalDay');
      window.goToGuest(customerId, 'reservations');
    },
    rowCancelReservation(id) { window.openCancelReservationModal(id); },
    rowEditCustomer(id) { window.openCustomerModal(id); },
    rowEditReservation(id) { window.openReservationModal(id); },

    openReservationGuestFinder() {
      window.setResNewGuest(false);
      window.openFinder({
        mode: 'customer', targetInputId: 'resCustomerSelect', scoped: false,
        title: 'Find Guest', subtitle: 'Search by ID, name or phone',
        onSelect: window.onResCustomerChange,
      });
    },
    openReservationInvitedByFinder() {
      window.openFinder({
        mode: 'profile', targetInputId: 'resInvitedBy',
        title: 'Find Marketing Profile', subtitle: 'Search by name',
        onSelect: window.onResInvitedByChange,
      });
    },
    openRecordGuestFinder() {
      window.openFinder({
        mode: 'customer', targetInputId: 'recCustomerSelect',
        scoped: window.isMarketingScoped ? window.isMarketingScoped() : false,
        title: 'Find Guest', subtitle: 'Search by ID, name or phone',
        onSelect: window.onRecordCustomerChange,
      });
    },
    openRecordMarketingFinder() {
      window.openFinder({
        mode: 'profile', targetInputId: 'recMarketing', writeAs: 'id',
        title: 'Find Marketing Profile', subtitle: 'Search by name',
      });
    },

    cancelEditingReservation() { window.openCancelReservationModal(window.editingReservationId); },
    deleteEditingReservation() { window.openDeleteReservationModal(window.editingReservationId); },

    enterOpensCustomer(id) { window.openCustomerModal(id); },
    enterOpensUser(id) { window.openUserModal(id); },
    arrowRightOpensCrmSubmenu(event) { window.openCrmSubmenu(event); },

    clearSearchAnd(inputId, handlerName) {
      const input = document.getElementById(inputId);
      if (input) input.value = '';
      const handler = window[handlerName];
      if (typeof handler === 'function') handler();
    },
    clearListFiltersAndSearch() {
      window.clearListFilters();
      const input = document.getElementById('listSearch');
      if (input) input.value = '';
      window.onListSearch();
    },
  };

  window.__actions = NAMED;

  function dispatch(event, expected) {
    const element = event.target.closest(`[data-act][data-on="${expected}"]`);
    if (!element) return;
    if (element.disabled) return;

    const name = element.getAttribute('data-act');
    if (!name) return;

    /* Keyboard actions only fire on the key they were written for. The
       originals were `if(event.key==='Enter'){…}` guards. */
    if (expected === 'keydown') {
      if (name === 'enterOpensCustomer' || name === 'enterOpensUser') {
        if (event.key !== 'Enter') return;
      } else if (name === 'arrowRightOpensCrmSubmenu') {
        if (event.key !== 'ArrowRight') return;
      }
    }

    if (name === 'stopPropagation') { event.stopPropagation(); return; }

    const args = parseArgs(element, event);
    const fn = NAMED[name] || window[name];
    if (typeof fn !== 'function') {
      /* A name that resolves to nothing is a bug in the markup, never a
         security event — but it should be visible while developing. */
      console.warn('[actions] no handler named', name);
      return;
    }
    try { fn.apply(null, args); }
    catch (err) { console.error('[actions] handler failed', name, err); }
  }

  for (const type of ['click', 'change', 'input', 'keydown', 'dblclick']) {
    document.addEventListener(type, (event) => dispatch(event, type), false);
  }
})();
