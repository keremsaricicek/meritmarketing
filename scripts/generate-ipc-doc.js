'use strict';
/* Generates docs/IPC-SECURITY-SURFACE.md from src/shared/contracts/ipc-surface.js.
 *
 *   node scripts/generate-ipc-doc.js          # write the file
 *   node scripts/generate-ipc-doc.js --check  # exit 1 if out of date
 *
 * This is the security matrix for the SHIPPING PRODUCT.
 *
 * There was already a generated matrix — tests/API-SECURITY-SURFACE.md — and it
 * opens with "Every operation exposed on window.api in merit-marketing-hub.html".
 * That sentence is true and was the problem: it describes the prototype. The CI
 * gate compared that document to the prototype's matrix and passed, so the
 * human-readable security document a reviewer reads before approving a verb
 * described an artifact that is no longer what ships. Sixty-three of its rows
 * name verbs the real IPC surface does not have.
 *
 * The prototype matrix still earns its place: the prototype is the behavioural
 * baseline and its suites still run against it. But it is not this, and the two
 * are now generated separately and checked separately.
 */

const fs = require('fs');
const path = require('path');
const { SURFACE } = require('../src/shared/contracts/ipc-surface');
const { SCHEMAS } = require('../src/shared/validation/schemas');

const DOC_PATH = path.resolve(__dirname, '..', 'docs', 'IPC-SECURITY-SURFACE.md');

const counts = () => {
  const rows = Object.entries(SURFACE);
  return {
    total: rows.length,
    anonymous: rows.filter(([, v]) => v.auth === 'anonymous').length,
    scoped: rows.filter(([, v]) => v.scope && v.scope !== 'none').length,
    destructive: rows.filter(([, v]) => v.destructive).length,
    audited: rows.filter(([, v]) => v.audit).length,
    marketing: rows.filter(([, v]) => (v.roles || []).includes('MARKETING')).length,
    protection: rows.filter(([, v]) => v.protection).length,
  };
};

function preamble() {
  const c = counts();
  return `# IPC Security Surface

Every channel the renderer can reach in the shipping Electron application, with
the authorization contract each one is required to honour.

**Generated from [\`src/shared/contracts/ipc-surface.js\`](../src/shared/contracts/ipc-surface.js) —
do not edit by hand.** Run \`npm run ipc:doc\` after changing the contract;
\`npm run ipc:check\` fails when this file drifts, and the release script blocks on it.

> This is the matrix for the product that ships.
> [\`tests/API-SECURITY-SURFACE.md\`](../tests/API-SECURITY-SURFACE.md) documents the
> *prototype* \`window.api\` — the behavioural baseline the migration had to preserve.
> The two describe different artifacts and are generated and checked separately.

## At a glance

| | |
|---|---|
| Channels | **${c.total}** |
| Callable with no session | ${c.anonymous} |
| Record- or query-scoped | ${c.scoped} |
| Destructive | ${c.destructive} |
| Written to the audit log | ${c.audited} |
| Enforcing guest protection | ${c.protection} |
| Reachable by MARKETING | ${c.marketing} |

## This file is load-bearing

It is not documentation *about* the system. \`src/main/ipc/registry.js\` reads the
contract at startup and **refuses to boot** when a channel is registered without a
matching entry, when an entry has no handler, or when a channel has no validation
schema. A verb cannot be added quietly; the application will not start.

## How to read a row

| Column | Meaning |
|---|---|
| **Channel** | The IPC channel name. The preload exposes exactly one named function per channel — there is no generic \`invoke\`. |
| **Auth** | \`required\` (a session must exist) or \`anonymous\` (reachable before sign-in). |
| **Capability** | The capability string \`guard.requireCapability\` demands. \`—\` for anonymous channels. |
| **Roles** | Who may call it at all. \`anon\` means no session needed. |
| **Scope** | How far the caller may reach *within* the channel — see below. |
| **Protection** | Whether the channel must enforce the one-year guest protection rule. |
| **Destructive** | Whether it removes or overwrites something. |
| **Audit** | Whether it writes an audit row. |
| **Denial** | The error code a refused call must return. |

### Scope values

| Value | Meaning |
|---|---|
| \`none\` | No record-level narrowing. The capability alone decides. |
| \`query\` | Returns a set. The set is narrowed to the caller's scope **before** any caller-supplied filter applies. |
| \`record\` | Addresses one record by id. The handler must verify that record is in the caller's scope. |
| \`self\` | Acts only on the calling session's own row. |

\`none\` is an answer, not a gap. \`reservations:create\` is deliberately unscoped —
any marketer may book any registered guest, which is precisely how a guest whose
protection has lapsed changes hands. Recording it as \`record\` would document a check
the handler does not perform, and the next reader would trust it.

### Two axes, both required

\`guard.requireCapability(capability)\` answers **"may this ROLE call this channel?"**

\`requireCustomerInScope(record)\` / \`requireReservationInScope(record)\` answer
**"may this SESSION touch THIS record?"**

A channel marked \`record\` needs both. One with only the capability check is
horizontal privilege escalation: the role may call \`customers:get\`, so the call
succeeds — for anybody's guest.

\`scopeProfileId()\` returns the caller's profile for MARKETING and \`null\`
(unrestricted) for ADMIN/MANAGER. It falls back to \`-1\` rather than \`null\` when a
MARKETING session has no profile, so a broken session matches nothing instead of
everything.

### Refusals must not become oracles

A channel that refuses a foreign id and one that refuses a nonexistent id must
answer **identically**, or the difference is itself a read. This applies across
every verb that takes an id, not only the ones somebody remembered to check: a
marketer who can tell "deleted" from "never existed" can classify every row in the
table, including other marketers'.

---

## The matrix
`;
}

function table() {
  const header = '| Channel | Auth | Capability | Roles | Scope | Protection | Destructive | Audit | Denial |\n'
    + '|---|---|---|---|---|---|---|---|---|\n';
  const yn = (v) => (v ? 'yes' : '—');
  const rows = Object.entries(SURFACE).map(([channel, spec]) => [
    `\`${channel}\``,
    spec.auth,
    spec.capability ? `\`${spec.capability}\`` : '—',
    (spec.roles || []).join(', '),
    `\`${spec.scope}\``,
    yn(spec.protection),
    yn(spec.destructive),
    yn(spec.audit),
    spec.denial ? `\`${spec.denial}\`` : '—',
  ].join(' | '));
  return `${header}| ${rows.join(' |\n| ')} |\n`;
}

function notes() {
  const withNotes = Object.entries(SURFACE).filter(([, v]) => v.notes);
  if (!withNotes.length) return '';
  return `\n## Notes\n\n${withNotes.map(([c, v]) => `- \`${c}\` — ${v.notes}`).join('\n')}\n`;
}

function schemaSection() {
  const missing = Object.keys(SURFACE).filter((c) => !SCHEMAS[c]);
  const extra = Object.keys(SCHEMAS).filter((c) => !SURFACE[c]);
  return `
## Payload validation

Every channel has a \`zod\` schema in
[\`src/shared/validation/schemas.js\`](../src/shared/validation/schemas.js), and every
schema is \`.strict()\` — an unrecognised field is a rejection, not something
silently carried into an UPDATE. That is what closes mass assignment on ownership,
timestamps and \`row_version\`, and it is why \`__proto__\` and \`constructor\` payloads
are refused as unrecognised keys rather than needing a special case.

| | |
|---|---|
| Channels without a schema | ${missing.length ? missing.join(', ') : '**none**'} |
| Schemas without a channel | ${extra.length ? extra.join(', ') : '**none**'} |

The registry refuses to start if either column is non-empty.
`;
}

function render() {
  return `${preamble()}\n${table()}${notes()}${schemaSection()}`;
}

function main() {
  const content = render();
  if (process.argv.includes('--check')) {
    const current = fs.existsSync(DOC_PATH) ? fs.readFileSync(DOC_PATH, 'utf8') : '';
    if (current !== content) {
      console.error('docs/IPC-SECURITY-SURFACE.md is out of date. Run: npm run ipc:doc');
      process.exit(1);
    }
    console.log('docs/IPC-SECURITY-SURFACE.md is up to date.');
    return;
  }
  fs.mkdirSync(path.dirname(DOC_PATH), { recursive: true });
  fs.writeFileSync(DOC_PATH, content);
  console.log(`Wrote ${DOC_PATH} (${Object.keys(SURFACE).length} channels).`);
}

if (require.main === module) main();
module.exports = { render, DOC_PATH };
