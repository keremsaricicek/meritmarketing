# Owner-supplied assets

Two image files are referenced by the build and by the application and are
**not in this repository**. Neither was invented as a placeholder, because a
placeholder icon ships as the product's identity and a placeholder logo appears
on every screen — both would look finished and be wrong.

| File | Used by | Effect while it is missing |
|---|---|---|
| `assets/crm.ico` | `forge.config.js` (Windows icon, installer icon, shortcut icon) | Packaging warns loudly and uses the default Electron icon. `scripts/release/Release-Merit.ps1` **blocks a stable release**. |
| `src/renderer/logo.png` | The application menu trigger | The in-app brand mark falls back to the letter mark. Also blocks a stable release. |

`crm.ico` must be a genuine multi-resolution Windows icon — at minimum 16, 32,
48 and 256 px — not a renamed PNG. Windows picks a size per context, and a
single-size .ico looks correct in Explorer and wrong on the taskbar.

An internal build runs without either file. A stable release does not.
