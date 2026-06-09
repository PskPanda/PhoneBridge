// build-with-icon.js
// Builds dist/PhoneBridge.exe with the gradient PB icon embedded.
//
// WHY THIS IS DONE THIS WAY:
//   You cannot embed the icon AFTER pkg builds the .exe. pkg appends its
//   payload (the bundled bytecode + assets, ~1.7 MB) as an "overlay" past the
//   last PE section. Running rcedit on the finished .exe rewrites the PE
//   resources and DROPS that overlay -> the icon shows but the .exe dies with
//   "Pkg: Error reading from file."
//
//   So instead we embed the icon into the BASE Node binary FIRST, then let pkg
//   append its payload to that already-iconed base. pkg normally re-downloads
//   the base if its hash changes, which would wipe our icon -- but setting
//   PKG_NODE_PATH tells pkg to use our exact binary as-is and skip the hash
//   check (see @yao-pkg/pkg-fetch places.js + index.js). Result: a .exe that
//   both runs AND shows the PB icon.

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ICON_PATH = path.join(__dirname, 'assets', 'PhoneBridge.ico');
const OUTPUT_EXE = path.join(__dirname, 'dist', 'PhoneBridge.exe');
const ICON_BASE = path.join(__dirname, 'dist', '_iconbase.exe'); // temp icon'd base
const TARGET = 'node18-win-x64';

function findCachedBaseBinary() {
  const candidates = [
    process.env.PKG_CACHE_PATH,
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'pkg-cache'),
    path.join(os.homedir(), '.pkg-cache'),
    path.join(os.homedir(), 'AppData', 'Local', 'pkg-cache'),
  ].filter(Boolean);

  for (const cacheRoot of candidates) {
    if (!fs.existsSync(cacheRoot)) continue;
    const versions = fs.readdirSync(cacheRoot, { withFileTypes: true })
      .filter(d => d.isDirectory());
    for (const v of versions) {
      const versionDir = path.join(cacheRoot, v.name);
      const files = fs.readdirSync(versionDir);
      for (const f of files) {
        if (/^fetched/i.test(f)
            && /v?18/i.test(f)
            && /win/i.test(f)
            && /x64/i.test(f)
            && !f.includes('.original')
            && !f.includes('.bak')
            && !f.includes('.phonebridge_backup')) {
          return path.join(versionDir, f);
        }
      }
    }
  }
  return null;
}

function ensureBaseBinaryCached() {
  let binary = findCachedBaseBinary();
  if (binary) return binary;

  // Not cached yet -> trigger a download via a throwaway build.
  // IMPORTANT: do NOT set PKG_NODE_PATH here, or pkg won't fetch anything.
  console.log('  [ .. ] Base binary not cached yet; downloading (~40 MB, first time only)...');
  const warmup = path.join(__dirname, 'dist', '_warmup.exe');
  try {
    execSync(`npx pkg . --targets ${TARGET} --output "${warmup}"`, {
      cwd: __dirname,
      stdio: 'inherit',
    });
  } catch (e) {
    // Even a failed build still populates the cache once the download succeeds.
  }
  try { fs.unlinkSync(warmup); } catch {}

  binary = findCachedBaseBinary();
  if (!binary) {
    throw new Error('Could not locate cached pkg base binary after fetch attempt.');
  }
  return binary;
}

async function main() {
  if (!fs.existsSync(ICON_PATH)) {
    throw new Error('Icon file not found at ' + ICON_PATH);
  }

  // rcedit handles both v4 (default export) and v5 (named export).
  const rceditMod = require('rcedit');
  const rcedit = typeof rceditMod === 'function' ? rceditMod : rceditMod.rcedit;
  if (typeof rcedit !== 'function') {
    throw new Error('rcedit module did not export a usable function.');
  }

  console.log('  [ .. ] Locating pkg base binary in cache...');
  const baseBinary = ensureBaseBinaryCached();
  console.log('  [ ok ] Base binary: ' + baseBinary);

  // Work on a private COPY of the base binary so we never touch pkg's cache
  // (keeps other pkg projects unaffected and survives repeat builds cleanly).
  if (!fs.existsSync(path.dirname(ICON_BASE))) {
    fs.mkdirSync(path.dirname(ICON_BASE), { recursive: true });
  }
  try { fs.unlinkSync(ICON_BASE); } catch {}
  fs.copyFileSync(baseBinary, ICON_BASE);
  console.log('  [ ok ] Copied base binary to a private working file.');

  console.log('  [ .. ] Embedding PB icon into the base copy...');
  await rcedit(ICON_BASE, { icon: ICON_PATH });
  console.log('  [ ok ] Icon embedded into base copy.');

  console.log('');
  console.log('  [ .. ] Running pkg (using icon\'d base via PKG_NODE_PATH)...');
  console.log('');

  let buildOk = false;
  try {
    try { fs.unlinkSync(OUTPUT_EXE); } catch {}
    execSync(`npx pkg . --targets ${TARGET} --output "${OUTPUT_EXE}"`, {
      cwd: __dirname,
      stdio: 'inherit',
      // PKG_NODE_PATH => pkg uses OUR icon'd binary as-is and skips the hash
      // re-fetch, so the embedded icon survives into the final .exe.
      env: { ...process.env, PKG_NODE_PATH: ICON_BASE },
    });
    buildOk = fs.existsSync(OUTPUT_EXE);
  } catch (e) {
    console.error('  [ FAIL ] pkg build failed.');
  } finally {
    // Clean up the temporary icon'd base regardless of outcome.
    try { fs.unlinkSync(ICON_BASE); } catch {}
  }

  if (!buildOk) {
    throw new Error('Build did not produce PhoneBridge.exe');
  }

  console.log('');
  console.log('  [ ok ] PhoneBridge.exe built with embedded PB icon.');
  console.log('         Final .exe size: ' + fs.statSync(OUTPUT_EXE).size + ' bytes');
}

main().catch(e => {
  console.error('');
  console.error('  [ FAIL ] ' + (e.message || e));
  process.exit(1);
});
