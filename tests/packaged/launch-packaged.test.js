'use strict';
/* THE PACKAGED APPLICATION ACTUALLY SHOWS ITS UI.
 *
 * This suite exists because of a defect that every other gate was structurally
 * unable to see. 1353 assertions passed, the golden path drove the real forms
 * through a real Electron window, package hygiene inspected the real archive —
 * and the installed application opened a blank white window on a customer's
 * machine.
 *
 * The reason none of them saw it: every suite launches the app FROM SOURCE,
 * where there is no asar. The failure only exists inside the packaged archive,
 * where `GrantFileProtocolExtraPrivileges: false` left Chromium's file handler
 * unable to read `app.asar/src/renderer/index.html` — ERR_FILE_NOT_FOUND, an
 * empty document, and a main process that carried on happily because Node's
 * fs reads the same archive by a completely different route. The database
 * opened, the migrations applied and the automatic backup was written while
 * the operator looked at nothing.
 *
 * So this one launches the BUILT BINARY, attaches to it, and asserts that a
 * human would see the application. It cannot be satisfied by anything less.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { Suite } = require('../lib/harness');

const net = require('net');

const ROOT = path.join(__dirname, '..', '..');

/* A fresh port per run. The first version of this suite used a fixed one and
   was GREEN against a build it had proved blank minutes earlier: SIGKILL on the
   `xvfb-run` wrapper leaves the Electron grandchild alive, that orphan keeps
   the port, and the next run's `connectOverCDP` attaches to the PREVIOUS
   application. The suite then asserted, truthfully, that a working build was
   working — the wrong one. A port nobody else can be holding, plus a check that
   it is free before launching, makes that impossible rather than unlikely. */
const PORT = 9400 + Math.floor(Math.random() * 500);

function portIsFree(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    socket.on('connect', () => { socket.destroy(); resolve(false); });
    socket.on('error', () => resolve(true));
    setTimeout(() => { socket.destroy(); resolve(true); }, 500);
  });
}

function findExecutable() {
  const out = path.join(ROOT, 'out');
  if (!fs.existsSync(out)) return null;
  for (const entry of fs.readdirSync(out)) {
    const dir = path.join(out, entry);
    if (!fs.existsSync(path.join(dir, 'resources', 'app.asar'))) continue;
    for (const name of ['MeritMarketingHub.exe', 'MeritMarketingHub']) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

module.exports = async function () {
  const s = new Suite('packaged/launch-packaged');

  const exe = findExecutable();
  if (!exe) {
    /* Same rule as package hygiene: never green by having looked at nothing. */
    s.check('a packaged application exists to launch', false,
      'out/ contains no packaged executable. Run: npm run package');
    return s.finish();
  }

  let playwright = null;
  try { playwright = require('playwright'); } catch (_) { /* reported below */ }
  if (!playwright) {
    s.check('playwright is available to attach to the packaged window', false,
      'Run: npm ci (playwright is a devDependency)');
    return s.finish();
  }

  const useXvfb = process.platform === 'linux';
  const command = useXvfb ? 'xvfb-run' : exe;
  const flags = [`--remote-debugging-port=${PORT}`, '--no-sandbox'];
  const args = useXvfb ? ['-a', exe, ...flags] : flags;

  const env = { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' };
  delete env.ELECTRON_RUN_AS_NODE;

  if (!await portIsFree(PORT)) {
    s.check(`nothing is already listening on the debugging port ${PORT}`, false,
      'A previous application is still running; this suite would attach to it.');
    return s.finish();
  }

  /* Its own process group, so the kill below reaches the application and not
     just the xvfb wrapper that started it. */
  const child = spawn(command, args, { env, cwd: path.dirname(exe), detached: true });
  /* Both streams: Electron reports "Failed to load URL" through the Node
     warning channel, which is not always stderr. Watching only one is how a
     load failure stays invisible. */
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d.toString(); });
  child.stdout.on('data', (d) => { stderr += d.toString(); });

  const page = { url: '', bodyLength: 0, text: '', api: 'undefined', title: '' };
  let attachError = null;

  try {
    /* The window is up when the debugging endpoint answers. Polling beats a
       fixed sleep: a slow machine should not fail, and a fast one should not
       wait. */
    const deadline = Date.now() + 45000;
    let browser = null;
    while (!browser && Date.now() < deadline) {
      try {
        browser = await playwright.chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
      } catch (_) {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    if (!browser) throw new Error('the packaged application never opened a debuggable window');

    /* The debugging endpoint answers before the window exists, so connecting is
       not the same as having a page. Wait for one rather than reading an empty
       list and calling it a failure. */
    let p = null;
    while (!p && Date.now() < deadline) {
      const contexts = browser.contexts();
      const pages = contexts.length ? contexts[0].pages() : [];
      if (pages.length) { p = pages[0]; break; }
      await new Promise((r) => setTimeout(r, 300));
    }
    if (!p) throw new Error('the packaged application opened no page');
    /* A renderer that failed to load settles immediately; one that succeeded
       still has scripts to run. Either way this resolves quickly. */
    await p.waitForLoadState('domcontentloaded').catch(() => {});
    await new Promise((r) => setTimeout(r, 1500));

    page.url = p.url();
    page.title = await p.title().catch(() => '');
    Object.assign(page, await p.evaluate(() => ({
      bodyLength: document.body ? document.body.innerHTML.length : 0,
      text: (document.body ? document.body.innerText : '').replace(/\s+/g, ' ').slice(0, 400),
      api: typeof window.api,
    })).catch(() => ({})));

    await browser.close();
  } catch (err) {
    attachError = err.message;
  } finally {
    /* Negative pid = the whole group. `child.kill()` alone kills xvfb-run and
       leaves the application running, which is how this suite lied once. */
    try { process.kill(-child.pid, 'SIGKILL'); } catch (_) { child.kill('SIGKILL'); }
  }

  if (attachError) {
    s.check('the packaged application opens a window', false,
      `${attachError}\n${stderr.slice(-600)}`);
    return s.finish();
  }

  /* THE ASSERTION THAT WOULD HAVE CAUGHT IT. A blank window is a page whose
     URL loaded nothing: chrome-error://chromewebdata/ and an empty body. */
  s.check('the packaged window loaded the application document, not an error page',
    page.url.includes('index.html') && !page.url.startsWith('chrome-error'),
    `${page.url}\n${stderr.slice(-400)}`);

  s.check('the renderer document is not blank',
    page.bodyLength > 1000, `body is ${page.bodyLength} characters`);

  /* Text a human can read, from the screen the first launch actually shows. */
  s.check('the first-run screen is on screen in the packaged build',
    /administrator|MERIT MARKETING HUB/i.test(page.text), page.text.slice(0, 200));

  /* The preload survived packaging too — without it every screen renders and
     nothing works, which is the same defect one layer up. */
  s.check('the preload bridge is present in the packaged renderer',
    page.api === 'object', `typeof window.api === ${page.api}`);

  /* Loading from inside the archive is the specific thing that broke. */
  s.check('no resource failed to load out of the asar archive',
    !/ERR_FILE_NOT_FOUND|Failed to load URL/i.test(stderr),
    stderr.split('\n').filter((l) => /Failed to load URL|ERR_FILE/i.test(l)).join('\n'));

  return s.finish();
};
