# Release

## Gates

A stable release does not happen unless all of these pass. Each is a refusal
with a stated fix, not a warning to scroll past.

| Gate | Why |
|---|---|
| Clean working tree | The build must match a known commit |
| Version is `X.Y.Z` and unused | A released version is never rebuilt |
| `npm ci` succeeds | The lock file is the point of a reproducible build |
| Full test suite green | A release is never made over a red suite |
| `npm run surface:check` | The security matrix document matches the code |
| `assets/crm.ico` present | Stable only — the owner's real icon, not a placeholder |

Missing signing credentials do not block; they downgrade the artifact to
**unsigned/internal** and say so.

## Versioning

- `1.0.0 → 1.0.1` — a bug fix
- `1.0.1 → 1.1.0` — a new feature
- `1.1.0 → 2.0.0` — a change that breaks how the product is used

## Building

```powershell
./scripts/release/Release-Merit.ps1 -Version 1.0.1 -Channel stable
```

Then commit, tag and push:

```powershell
git add package.json
git commit -m "Release 1.0.1"
git tag -a v1.0.1 -m "Release 1.0.1"
git push && git push --tags
```

The script **builds and verifies**; it does not publish. Publishing is CI's job.

## Provenance

Every build writes `out/make/release.json`:

```json
{
  "product": "Merit Marketing Hub",
  "version": "1.0.1",
  "channel": "stable",
  "commit": "abc123…",
  "schemaVersion": 1,
  "builtAt": "2026-08-19T18:00:00Z",
  "signed": false,
  "testsRun": true
}
```

plus `SHA256SUMS.txt` for every artifact. `signed: false` is recorded honestly —
an unsigned build is never described as signed.

## Code signing

Driven entirely by environment; nothing is committed:

- `WINDOWS_CERT_FILE` — path to the `.pfx` on the build machine
- `WINDOWS_CERT_PASSWORD`
- `WINDOWS_TIMESTAMP_SERVER` — defaults to DigiCert

Without a certificate, Windows SmartScreen warns users on first run. That is the
only consequence; the application is otherwise identical.

**Do not disable signature checks in code to make a checklist look green.**

## Reproducibility

- `package-lock.json` is committed and CI uses `npm ci`
- Electron, Forge and every production dependency are pinned exactly
- Node 20+ is required and CI pins the major version
- `MERIT_COMMIT` and `MERIT_CHANNEL` are stamped into the build

## If the push is refused

Run `scripts/recovery/Recover-Push403.ps1` (or `node
scripts/recovery/recover-push.js`). It writes a git bundle, a patch series, a
manifest and checksums into `recovery/`, and resets nothing. Carry that folder
to a machine whose credentials work. This is not hypothetical — tag pushes
returned HTTP 403 during this migration while branch pushes succeeded.
