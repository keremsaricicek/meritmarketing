'use strict';
/* Electron Forge packaging.
 *
 * Squirrel.Windows is the maker because it is what electron-updater's
 * differential Windows flow expects; choosing something else would mean
 * building the update path twice.
 */

const path = require('path');
const fs = require('fs');
const { FusesPlugin } = require('@electron-forge/plugin-fuses');
const { FuseV1Options, FuseVersion } = require('@electron/fuses');

const ICON = path.join(__dirname, 'assets', 'crm.ico');
const hasIcon = fs.existsSync(ICON);

if (!hasIcon) {
  /* Loud rather than silent. Shipping a Windows build with the default
     Electron icon is a visible defect, and inventing a replacement for the
     owner's own artwork would be worse. */
  console.warn('\n[forge] assets/crm.ico is missing — packaging with the default Electron icon.');
  console.warn('[forge] Place the real crm.ico in assets/ before a release build.\n');
}

module.exports = {
  packagerConfig: {
    name: 'Merit Marketing Hub',
    executableName: 'MeritMarketingHub',
    appBundleId: 'com.meritmarketing.hub',
    /* ASAR keeps the application a single archive. Native modules are unpacked
       by the auto-unpack-natives plugin, because a .node file cannot be loaded
       from inside an archive. */
    asar: true,
    icon: hasIcon ? path.join(__dirname, 'assets', 'crm') : undefined,
    /* Nothing here belongs in a user's installation: tests, fixtures, the
       original single-file prototype, recovery bundles, scratch data. */
    ignore: [
      /^\/tests($|\/)/,
      /^\/scripts($|\/)/,
      /^\/docs($|\/)/,
      /^\/recovery($|\/)/,
      /^\/out($|\/)/,
      /^\/\.github($|\/)/,
      /^\/\.claude($|\/)/,
      /^\/merit-marketing-hub\.html$/,
      /^\/MIGRATION-STATUS\.md$/,
      /^\/forge\.config\.js$/,
      /\.map$/,
      /\.sqlite3(-wal|-shm)?$/,
      /^\/\.git($|\/)/,
      /^\/\.gitignore$/,
      /^\/\.env/,
      /^\/README\.md$/,
      /^\/package-lock\.json$/,
    ],
    win32metadata: {
      CompanyName: 'Merit Marketing',
      FileDescription: 'Merit Marketing Hub',
      ProductName: 'Merit Marketing Hub',
      InternalName: 'MeritMarketingHub',
    },
    /* Signing is driven entirely by environment. No certificate, no password
       and no thumbprint is ever committed; without them the build is unsigned
       and labelled as such. */
    ...(process.env.WINDOWS_CERT_FILE ? {
      windowsSign: {
        certificateFile: process.env.WINDOWS_CERT_FILE,
        certificatePassword: process.env.WINDOWS_CERT_PASSWORD,
        timestampServer: process.env.WINDOWS_TIMESTAMP_SERVER || 'http://timestamp.digicert.com',
      },
    } : {}),
  },

  rebuildConfig: {},

  makers: [
    {
      name: '@electron-forge/maker-squirrel',
      config: {
        name: 'MeritMarketingHub',
        setupExe: 'MeritMarketingHub-Setup.exe',
        ...(hasIcon ? { setupIcon: ICON, iconUrl: undefined } : {}),
        ...(process.env.WINDOWS_CERT_FILE ? {
          certificateFile: process.env.WINDOWS_CERT_FILE,
          certificatePassword: process.env.WINDOWS_CERT_PASSWORD,
        } : {}),
      },
    },
    /* A zip alongside the installer: it is what the Linux/CI smoke tests run,
       and what an emergency hand-install uses when the installer is the thing
       that is broken. */
    { name: '@electron-forge/maker-zip', platforms: ['win32', 'linux'] },
  ],

  plugins: [
    { name: '@electron-forge/plugin-auto-unpack-natives', config: {} },
    /* Fuses are compile-time switches burned into the binary. Each of these
       removes a way to make the packaged app run something other than itself. */
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,                                   // no ELECTRON_RUN_AS_NODE
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,        // no NODE_OPTIONS injection
      [FuseV1Options.EnableNodeCliInspectArguments]: false,               // no --inspect debugger attach
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,        // a tampered asar refuses to load
      [FuseV1Options.OnlyLoadAppFromAsar]: true,                          // no loose-file override
    }),
  ],
};
