'use strict';
/* Generates tests/API-SECURITY-SURFACE.md from surface.js.
 *
 *   node tests/api-surface/generate-doc.js          # write the file
 *   node tests/api-surface/generate-doc.js --check  # exit 1 if out of date
 *
 * The prose lives here rather than in the .md so there is exactly one source
 * for the document. Hand-editing the .md is how a row silently drifts out of
 * agreement with the contract it is supposed to describe; doc-freshness.test.js
 * fails the suite when that happens.
 */

const fs = require('fs');
const path = require('path');
const { SURFACE } = require('./surface');

const DOC_PATH = path.resolve(__dirname, '..', 'API-SECURITY-SURFACE.md');

const PREAMBLE = `# API Security Surface Matrix — PROTOTYPE BASELINE

Every operation exposed on \`window.api\` in \`merit-marketing-hub.html\`, with the
authorization contract each one is required to honour.

> **This documents the PROTOTYPE, not the shipping application.** It is the
> behavioural baseline the Electron migration had to preserve, and the suites that
> still run against \`merit-marketing-hub.html\` are enforced by it. The security
> matrix for the product that ships is
> [\`docs/IPC-SECURITY-SURFACE.md\`](../docs/IPC-SECURITY-SURFACE.md), generated from
> \`src/shared/contracts/ipc-surface.js\`. Sixty-odd verbs listed below — \`auth.firstRun\`,
> \`export.filtered\`, \`photos.pick\`, \`dialog.confirm\` — do not exist on the IPC
> surface at all; the renderer's adapter layer maps them. Reading this file to
> approve a change to the Electron app would be reading about the wrong artifact.

**Generated from [\`tests/api-surface/surface.js\`](api-surface/surface.js) — do not edit by
hand.** Run \`npm run surface:doc\` after changing the matrix.
[\`tests/api-surface/doc-freshness.test.js\`](api-surface/doc-freshness.test.js) fails the
suite if this file drifts, and
[\`tests/api-surface/surface.test.js\`](api-surface/surface.test.js) enforces the matrix
itself against the running application on every test run.

## Why this exists

Before the Electron migration, the boundary being hardened is the one between the
renderer and the business layer. Today \`window.api\` is an in-page object; after the
migration the same verbs become IPC channels reachable by anything running in the
renderer. Whatever is not enforced inside a handler stops being enforced at all the
moment the UI is no longer the only caller.

So the contract is recorded per verb, not per screen.

## How to read a row

| Column | Meaning |
|---|---|
| **Verb** | \`namespace.method\` as exposed on \`window.api\`. |
| **Permission** | The capability string passed to \`guard()\`. \`—\` means the verb is deliberately ungated (pre-session, or a pure UI affordance). |
| **Roles** | Who may call it at all. \`anon\` means callable with no session. |
| **Scope** | How far the caller may reach *within* the verb — see below. |
| **Ownership protection** | Whether the verb must enforce the one-year guest protection rule. |
| **Payload validation** | Whether the handler must validate the payload itself rather than trusting the form. |
| **Denial** | The error code a refused call must return. |

### Scope values

| Value | Meaning |
|---|---|
| \`none\` | No record-level narrowing. Capability alone decides the answer. |
| \`query\` | Returns a set. The set must be narrowed to the caller's scope *before* any caller-supplied filter is applied. |
| \`record\` | Addresses one record by id. The handler must verify that record is in the caller's scope. |
| \`self\` | Acts only on the calling session's own row (own password, own preference, own notification). |

\`none\` is a real answer, not a gap. \`reservations.create\` is deliberately unscoped —
any marketer may book any registered guest, which is exactly how a guest whose
protection has lapsed changes hands. Recording that as \`record\` would document a check
the handler does not have, and the next person to read the matrix would trust it.

### Two checks, not one

\`guard(permission)\` answers **"may this ROLE call this verb at all?"** — a capability
check. It says nothing about *which records* the call may touch.

\`customerInScope(record)\` / \`reservationInScope(record)\` answer **"may this SESSION
touch THIS record?"** — a record-level check.

A verb marked \`record\` needs both. A verb with only the capability check is how
horizontal escalation happens: the role is allowed to call \`customers.get\`, so the call
succeeds — for anybody's guest.

\`scopeProfileId()\` returns the caller's profile for MARKETING and \`null\` (unrestricted)
for ADMIN/MANAGER. It falls back to \`-1\` rather than \`null\` when a MARKETING session has
no profile, so a broken session fails closed and matches nothing, instead of failing open
and matching everything.

### Ownership protection is a separate axis again

The verbs marked \`protection\` can transfer a guest between marketers. Each must enforce
the one-year guest protection rule independently — the rule is not a property of the
record, it is a property of every route that could move it.

## Rules this matrix encodes

1. **UI hiding is never authorization.** A hidden button is a usability decision. Every
   row here is enforced in the handler and proved by a direct \`window.api\` call in the tests.
2. **The business/API layer is authoritative.** Status, scope, attribution and lifecycle
   are derived in the handler. Nothing is trusted from the client — including \`status\`,
   \`invitedByProfileId\` for MARKETING, and \`marketingProfileId\` on update.
3. **Historical attribution and current ownership are different concepts.**
   \`reservation.invited_by_profile_id\` is immutable history. \`customer.marketing_profile_id\`
   is mutable current state. Reassigning a guest must never rewrite who invited them.
4. **Refusals must not become oracles.** A verb that refuses a foreign id and a verb that
   refuses a nonexistent id must answer identically, or the difference itself is a read.

---

## The matrix
`;

const POSTAMBLE = `
---

## Enforcement

\`tests/api-surface/surface.test.js\` runs on every \`npm test\`:

1. **Discovers the live surface** by recursively walking \`window.api\` in the running
   application and comparing it to this matrix. A newly exposed verb that is not
   documented here fails the run; so does a documented verb that no longer exists. The
   walk is recursive and includes bare top-level functions, because a one-level scan only
   catches verbs shaped like the ones that already exist.
2. **Probes every verb unauthenticated.** Anything whose roles omit \`anon\` must refuse
   before a session exists.
3. **Probes every verb as MARKETING and as MANAGER.** Anything not listing that role must
   return its documented denial code.
4. **Probes record scope, driven by the matrix.** Every verb marked \`scope: 'record'\` is
   called against another marketer's record and must be refused. A row claiming \`record\`
   with no registered probe fails the suite — so the claim cannot be made without being
   proved.
5. **Probes ownership protection, driven by the matrix.** Same contract for every verb
   marked \`protection: true\`, and afterwards ownership is re-read to confirm nothing moved.
6. **Probes crafted payloads.** Filter parameters naming another marketer's profile must
   narrow the caller's own set, never select a different one. Export checks read the CSV
   bytes actually written, because the \`export.filtered\` envelope carries only a row count.

The failure this is designed to catch is not a bug in today's code — it is tomorrow's new
verb added without a guard, or with a row that overstates what the handler does.

### Adding a verb

1. Write the handler with its \`guard()\` and, if it addresses records, its scope check.
2. Add the row to \`tests/api-surface/surface.js\`.
3. If the row says \`scope: 'record'\` or \`protection: true\`, register a probe in
   \`surface.test.js\` (\`FOREIGN_PROBE\` / \`PROTECTION_PROBE\`). The suite fails until you do.
4. Run \`npm run surface:doc\` to regenerate this file.
5. Run \`npm test\`. If the matrix and the implementation disagree, fix the
   **implementation** unless the matrix itself is wrong — amending the matrix to match a
   permissive handler is how a boundary quietly disappears.
`;

function render() {
  const esc = v => String(v === null || v === undefined ? '—' : v).replace(/\|/g, '\\|');
  const lines = [];
  let currentNamespace = null;

  for (const [verb, spec] of Object.entries(SURFACE)) {
    const ns = verb.includes('.') ? verb.split('.')[0] : '(top level)';
    if (ns !== currentNamespace) {
      currentNamespace = ns;
      lines.push('', `### \`${ns}\``, '',
        '| Verb | Permission | Roles | Scope | Ownership protection | Payload validation | Denial |',
        '|---|---|---|---|---|---|---|');
    }
    lines.push('| ' + [
      '`' + verb + '`',
      esc(spec.permission),
      esc((spec.roles || []).join(', ')),
      esc(spec.scope),
      spec.protection ? 'yes' : 'no',
      spec.validation ? 'yes' : 'no',
      esc(spec.denial),
    ].join(' | ') + ' |');
  }

  return PREAMBLE + lines.join('\n') + '\n' + POSTAMBLE;
}

module.exports = { render, DOC_PATH };

if (require.main === module) {
  const generated = render();
  if (process.argv.includes('--check')) {
    const onDisk = fs.existsSync(DOC_PATH) ? fs.readFileSync(DOC_PATH, 'utf8') : '';
    if (onDisk !== generated) {
      console.error('API-SECURITY-SURFACE.md is out of date. Run: npm run surface:doc');
      process.exit(1);
    }
    console.log('API-SECURITY-SURFACE.md is up to date.');
  } else {
    fs.writeFileSync(DOC_PATH, generated);
    console.log('Wrote ' + DOC_PATH);
  }
}
