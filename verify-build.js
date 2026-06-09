// verify-build.js — sanity-checks dist/PhoneBridge.exe after a build.
// Confirms the embedded icon matches assets/PhoneBridge.ico, so you find out
// at build time (not when you share it) if the picture didn't make it in.

const fs = require('fs');
const path = require('path');

const EXE = path.join(__dirname, 'dist', 'PhoneBridge.exe');
const ICO = path.join(__dirname, 'assets', 'PhoneBridge.ico');

function fail(msg) {
  console.error('  [ FAIL ] ' + msg);
  process.exit(1);
}

if (!fs.existsSync(EXE)) fail('dist/PhoneBridge.exe not found.');
if (!fs.existsSync(ICO)) fail('assets/PhoneBridge.ico not found.');

// --- read the image byte-sizes inside the source .ico -----------------------
function icoEntrySizes(buf) {
  const type = buf.readUInt16LE(2);
  const count = buf.readUInt16LE(4);
  if (type !== 1) return null;
  const sizes = [];
  for (let i = 0; i < count; i++) {
    const o = 6 + i * 16;
    sizes.push(buf.readUInt32LE(o + 8)); // bytesInRes
  }
  return sizes.sort((a, b) => a - b);
}

// --- read the RT_ICON resource byte-sizes embedded in the .exe --------------
function exeIconSizes(buf) {
  const peOff = buf.readUInt32LE(0x3c);
  if (buf.toString('ascii', peOff, peOff + 2) !== 'PE') return null;
  const numSections = buf.readUInt16LE(peOff + 6);
  const optSize = buf.readUInt16LE(peOff + 20);
  const secOff = peOff + 24 + optSize;
  let rsrcRaw = null;
  for (let i = 0; i < numSections; i++) {
    const o = secOff + i * 40;
    const name = buf.toString('ascii', o, o + 8).replace(/\0/g, '');
    if (name === '.rsrc') rsrcRaw = buf.readUInt32LE(o + 20);
  }
  if (rsrcRaw === null) return null;

  const base = rsrcRaw;
  const sizes = [];
  function walk(off, type) {
    const nNamed = buf.readUInt16LE(off + 12);
    const nId = buf.readUInt16LE(off + 14);
    for (let i = 0; i < nNamed + nId; i++) {
      const eo = off + 16 + i * 8;
      const nameOrId = buf.readUInt32LE(eo);
      const offField = buf.readUInt32LE(eo + 4);
      if (offField & 0x80000000) {
        walk(base + (offField & 0x7fffffff), type === null ? nameOrId : type);
      } else if (type === 3) {
        // RT_ICON == 3
        const de = base + offField;
        sizes.push(buf.readUInt32LE(de + 4));
      }
    }
  }
  walk(base, null);
  return sizes.sort((a, b) => a - b);
}

const exeBuf = fs.readFileSync(EXE);
const icoBuf = fs.readFileSync(ICO);

const want = icoEntrySizes(icoBuf);
const got = exeIconSizes(exeBuf);

if (!want) fail('assets/PhoneBridge.ico is not a valid .ico file.');
if (!got || got.length === 0) {
  fail('No icon resources found in PhoneBridge.exe — icon was NOT embedded.');
}

const matches = want.length === got.length && want.every((s, i) => s === got[i]);

console.log('  [ ok ] PhoneBridge.exe size: ' + exeBuf.length + ' bytes');
console.log('  [ .. ] Source .ico images: ' + want.length + '  -> ' + want.join(', '));
console.log('  [ .. ] Embedded images:    ' + got.length + '  -> ' + got.join(', '));

if (matches) {
  console.log('  [ ok ] Embedded icon matches assets/PhoneBridge.ico exactly.');
  console.log('         If File Explorer still shows the old icon, run RefreshIcons.bat');
  console.log('         (Windows caches icons — the .exe itself is correct).');
} else {
  fail('Embedded icon does NOT match the source .ico. Picture did not embed correctly.');
}
