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

  function parseArgs(element, event, argsAttr = 'data-args') {
    const raw = element.getAttribute(argsAttr);
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

    /* These are declared as top-level `const` arrow functions in screens.js.
       Unlike a `function` declaration, a top-level `const` in a classic script
       creates a global BINDING but NOT a property of `window` — so the
       dispatcher's `window[name]` fallback resolved undefined and both photo
       buttons did nothing at all. Registering them by name is the fix that does
       not depend on how the file happens to declare them. */
    pickCustomerPhoto() { window.pickPhotoFor('customer'); },
    pickProfilePhoto() { window.pickPhotoFor('profile'); },

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

  /* One element, two behaviours — click to select a row, double-click to open
     it — used to be written as two `data-act`/`data-on`/`data-args` triples on
     the same tag. HTML keeps the FIRST occurrence of an attribute and silently
     discards the rest, so the second behaviour never existed: double-click to
     edit was dead on three tables and Enter-to-open on two more, with no error
     anywhere. An event-scoped attribute cannot collide with itself. */
  function resolve(element, expected) {
    /* A document-level listener sees events whose target is the document itself
       or a text node — neither has `closest`. A keyboard shortcut fired at the
       document is the ordinary case, not an error. */
    if (!element || typeof element.closest !== 'function') return null;
    const scoped = element.closest(`[data-act-${expected}]`);
    if (scoped) {
      return { element: scoped, name: scoped.getAttribute(`data-act-${expected}`), argsAttr: `data-args-${expected}` };
    }
    const generic = element.closest(`[data-act][data-on="${expected}"]`);
    if (generic) return { element: generic, name: generic.getAttribute('data-act'), argsAttr: 'data-args' };
    return null;
  }

  function dispatch(event, expected) {
    const found = resolve(event.target, expected);
    if (!found) return;
    const { element, name, argsAttr } = found;
    if (element.disabled) return;
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

    const args = parseArgs(element, event, argsAttr);
    const fn = NAMED[name] || window[name];
    if (typeof fn !== 'function') {
      /* A name that resolves to nothing is a bug in the markup, never a
         security event — but it should be visible while developing. */
      console.warn('[actions] no handler named', name);
      return;
    }
    /* `window[name]` reaches every global, and `eval`, `Function` and `open`
       are globals. The screens' own handlers are ordinary declared functions;
       the dangerous ones are all built in, so refusing native code closes the
       whole category rather than blacklisting names one at a time. CSP already
       blocks eval, and no injection sink was found — this is the second lock on
       a door that should never have opened. */
    if (!NAMED[name] && Function.prototype.toString.call(fn).includes('[native code]')) {
      console.warn('[actions] refusing to invoke a built-in named', name);
      return;
    }
    try { fn.apply(null, args); }
    catch (err) { console.error('[actions] handler failed', name, err); }
  }

  for (const type of ['click', 'change', 'input', 'keydown', 'dblclick', 'focus', 'blur']) {
    document.addEventListener(type, (event) => dispatch(event, type), false);
  }

  /* mouseenter and mouseleave do NOT bubble, so they cannot be delegated from
     the document the way the others are. mouseover/mouseout do bubble and fire
     for every descendant, so they are filtered back down to enter/leave
     semantics: the pointer has entered only when it came from OUTSIDE the
     element, and left only when it went outside it.

     Doing this properly is what let the hover behaviours — the CRM submenu and
     the Finder's cursor row — move off inline `onmouseenter=` attributes, which
     a `script-src 'self'` policy renders inert. They were the last inline
     handlers in the product, and they survived because the test that claimed
     none remained checked a hand-written list of event names that did not
     include them. */
  const HOVER = { mouseover: 'mouseenter', mouseout: 'mouseleave' };
  for (const [bubbling, intended] of Object.entries(HOVER)) {
    document.addEventListener(bubbling, (event) => {
      const found = resolve(event.target, intended);
      if (!found) return;
      const related = event.relatedTarget;
      if (related && found.element.contains(related)) return;   // still inside
      dispatch(event, intended);
    }, false);
  }
})();
