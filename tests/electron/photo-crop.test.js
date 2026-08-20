'use strict';
/* CROPPING A PHOTO ACTUALLY CHANGES THE STORED PHOTO.
 *
 * This runs inside real Electron because the crop is performed by
 * `nativeImage`, which only exists in the real runtime — the same reason the
 * other database suites cannot cover it.
 *
 * What it is really testing is that the crop PERSISTS. The previous
 * implementation cropped on a canvas in the renderer, called a `photos.save`
 * that always returned VALIDATION, silently kept the ORIGINAL photo's name and
 * wrote the cropped image into an in-memory cache. Everything looked right
 * until the application was closed and reopened, at which point the uncropped
 * original came back. So the assertions here are about dimensions on disk and a
 * name that differs — not about a function returning without throwing.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { Suite } = require('../lib/harness');

const ROOT = path.join(__dirname, '..', '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist',
  process.platform === 'win32' ? 'electron.exe' : 'electron');

const PROBE = `
const path = require('path');
const fs = require('fs');
const os = require('os');
const { app, nativeImage } = require('electron');

app.whenReady().then(async () => {
  const out = {};
  try {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mmh-crop-'));
    const paths = {
      root,
      database: path.join(root, 'data', 'merit.sqlite3'),
      photos: path.join(root, 'photos'),
      backups: path.join(root, 'backups'),
      logs: path.join(root, 'logs'),
    };
    for (const d of [path.dirname(paths.database), paths.photos, paths.backups, paths.logs]) {
      fs.mkdirSync(d, { recursive: true });
    }

    const connection = require(${JSON.stringify(path.join(ROOT, 'src', 'main', 'database', 'connection.js'))});
    const { SessionManager } = require(${JSON.stringify(path.join(ROOT, 'src', 'main', 'auth', 'session.js'))});
    const authService = require(${JSON.stringify(path.join(ROOT, 'src', 'main', 'services', 'auth-service.js'))});
    const photoFactory = require(${JSON.stringify(path.join(ROOT, 'src', 'main', 'services', 'photo-service.js'))});

    const db = connection.open(paths.database);
    const sessions = new SessionManager();
    const audit = () => {};
    const ctx = { db, sessions, audit, paths };

    const PW = 'harbour-lantern-quiet';
    await authService.setup(db, { username: 'owner', password: PW, passwordConfirm: PW, fullName: 'K' }, ctx);
    await authService.login(db, { username: 'owner', password: PW }, ctx);

    /* A real 200x100 PNG, built here so there is genuine image data to crop:
       a known-good 1x1 seed scaled up by nativeImage itself. */
    const seed = nativeImage.createFromDataURL(
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==');
    if (seed.isEmpty()) throw new Error('could not build the seed image');
    const canvasPng = seed.resize({ width: 200, height: 100, quality: 'good' }).toPNG();
    if (!canvasPng.length) throw new Error('could not build the source image');

    const name = 'photo_' + Date.now() + '_aaaaaaaaaaaa.png';
    fs.writeFileSync(path.join(paths.photos, name), canvasPng);
    db.prepare(\`INSERT INTO photos (name, mime_type, byte_size, sha256, created_at, created_by)
      VALUES (?, 'image/png', ?, 'x', ?, 1)\`).run(name, canvasPng.length, new Date().toISOString());

    const before = nativeImage.createFromBuffer(canvasPng).getSize();
    out.sourceSize = before;

    const photos = photoFactory.build({ dialog: null, paths, getWindow: () => null });

    // ------------------------------------------------ an ordinary crop
    const cropped = photos.crop(ctx, { name, x: 20, y: 10, size: 60 });
    out.newName = cropped.name;
    out.differentName = cropped.name !== name;
    out.originalStillOnDisk = fs.existsSync(path.join(paths.photos, name));
    const croppedFile = path.join(paths.photos, cropped.name);
    out.croppedOnDisk = fs.existsSync(croppedFile);
    out.croppedSize = nativeImage.createFromBuffer(fs.readFileSync(croppedFile)).getSize();
    out.rowRecorded = !!db.prepare('SELECT 1 FROM photos WHERE name = ?').get(cropped.name);

    /* Read it back through the ordinary verb — this is what the guest record
       will do on the next launch. */
    const readBack = photos.read(ctx, { name: cropped.name });
    out.readableAfterwards = !!readBack && readBack.dataUrl.startsWith('data:image/jpeg');

    // ------------------------------- a rectangle larger than the image
    const oversized = photos.crop(ctx, { name, x: 9999, y: 9999, size: 9999 });
    out.oversizedSize = nativeImage.createFromBuffer(
      fs.readFileSync(path.join(paths.photos, oversized.name))).getSize();

    // ------------------------------------------- a name that is not managed
    const traversals = ['../../etc/passwd', '..\\\\..\\\\windows\\\\win.ini', '/etc/passwd'];
    out.traversalRefused = traversals.every((bad) => {
      try { photos.crop(ctx, { name: bad, x: 0, y: 0, size: 32 }); return false; }
      catch (err) { return err.code === 'NOT_FOUND' || err.code === 'VALIDATION'; }
    });

    connection.close(db);
    fs.rmSync(root, { recursive: true, force: true });
  } catch (err) {
    out.error = err.message;
    out.stack = String(err.stack).split('\\n').slice(0, 5);
  }
  console.log('PROBE:' + JSON.stringify(out));
  app.exit(0);
});
`;

module.exports = async function () {
  const s = new Suite('electron/photo-crop');

  if (!fs.existsSync(ELECTRON)) {
    s.check('the Electron binary is installed', false, `not found at ${ELECTRON}`);
    return s.finish();
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mmh-cropprobe-'));
  try {
    const probeFile = path.join(dir, 'crop-probe.js');
    fs.writeFileSync(probeFile, PROBE);
    const useXvfb = process.platform === 'linux';
    const command = useXvfb ? 'xvfb-run' : ELECTRON;
    const args = useXvfb ? ['-a', ELECTRON, '--no-sandbox', probeFile] : [probeFile];
    const env = { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' };
    delete env.ELECTRON_RUN_AS_NODE;

    const run = await new Promise((resolve) => {
      const child = spawn(command, args, { env, cwd: ROOT });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => { stdout += d.toString(); });
      child.stderr.on('data', (d) => { stderr += d.toString(); });
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolve({ timedOut: true, stdout, stderr }); }, 90000);
      child.on('exit', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    });

    const line = run.stdout.split('\n').find((l) => l.startsWith('PROBE:'));
    s.check('the crop probe runs inside Electron', !!line,
      `exit=${run.code} timedOut=${!!run.timedOut}\n${run.stderr.slice(-800)}`);
    if (!line) return s.finish();
    const p = JSON.parse(line.slice('PROBE:'.length));
    if (p.error) {
      s.check('the crop completed without throwing', false, `${p.error}\n${(p.stack || []).join('\n')}`);
      return s.finish();
    }

    s.check('the source image is the size the test intended',
      p.sourceSize.width === 200 && p.sourceSize.height === 100, JSON.stringify(p.sourceSize));

    /* The crop must produce a DIFFERENT managed photo — the old code returned
       the original's name, which is exactly why nothing persisted. */
    s.check('cropping produces a new managed photo name',
      p.differentName === true, `${p.newName}`);
    s.check('the cropped file is written to disk', p.croppedOnDisk === true);
    s.check('and recorded in the photos table', p.rowRecorded === true);

    /* The actual proof: the stored pixels changed. */
    s.check('the stored image really is cropped to the requested size',
      p.croppedSize.width === 60 && p.croppedSize.height === 60, JSON.stringify(p.croppedSize));
    s.check('and it reads back through the ordinary photo verb',
      p.readableAfterwards === true, String(p.readableAfterwards));

    /* Non-destructive: the original survives, so a bad crop is recoverable. */
    s.check('the original photo is not destroyed by cropping',
      p.originalStillOnDisk === true);

    /* A rectangle bigger than the image must clamp to the image, not throw and
       not read past it. The source is 200x100, so the largest square is 100. */
    s.check('a rectangle larger than the image is clamped, not refused',
      p.oversizedSize.width === 100 && p.oversizedSize.height === 100, JSON.stringify(p.oversizedSize));

    s.check('a traversal path is refused rather than resolved',
      p.traversalRefused === true, String(p.traversalRefused));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  return s.finish();
};
