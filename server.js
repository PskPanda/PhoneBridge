// PhoneBridge — terminal-native phone-to-PC bridge
// by PskXClaude

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const dgram = require('dgram');
const { execSync } = require('child_process');
const QRCode = require('qrcode');

process.title = 'PhoneBridge';

const PORT = 9147;            // preferred port
const MAX_PORT_TRIES = 20;    // if 9147 is busy, fall forward: 9148, 9149, ... 9166
const state = { clipboard: '', files: [], links: [], events: [] };

// ---------- IP detection ----------
function getLocalIPs() {
  const ifaces = os.networkInterfaces();
  const candidates = [];
  for (const [name, addrs] of Object.entries(ifaces)) {
    for (const addr of addrs) {
      // family is 'IPv4' (Node 18+) but was the number 4 in a few releases — accept both.
      if (addr.family !== 'IPv4' && addr.family !== 4) continue;
      if (addr.internal) continue;
      const ip = addr.address;
      // Reject junk/non-routable addresses some VPN/virtual adapters report.
      if (!ip || ip === '0.0.0.0' || ip.startsWith('0.') ||
          ip.startsWith('127.') || ip.startsWith('169.254.')) continue;

      const lower = name.toLowerCase();
      // Skip virtual machine, container, and VPN adapters by name.
      if (lower.match(/virtualbox|vmware|hyper-?v|vethernet|loopback|docker|tailscale|zerotier|hamachi|radmin|openvpn|wireguard|nordlynx|\bvpn\b|\btap\b|\btun\b|\bwg\d*\b|\bzt\b|npcap|bluetooth/)) continue;

      let score = 0;
      if (ip.startsWith('192.168.')) score = 100;                       // most home LANs
      else if (ip.startsWith('10.')) score = 80;                        // private
      else if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) score = 60;       // private 172.16-31
      else score = 10;                                                  // other/routable — last resort
      if (lower.match(/wi-?fi|wlan|wireless/)) score += 50;
      else if (lower.match(/ethernet|eth|\blan\b/)) score += 30;
      candidates.push({ name, address: ip, score });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates;
}

// Ask the OS which local IP it would actually use to reach the internet.
// A UDP "connect" only does a routing-table lookup and binds a source address;
// it sends no packets and needs no real connectivity. This is the single most
// reliable answer to "what is my real LAN IP" — it can't return a ghost adapter.
function getRoutingSourceIP() {
  return new Promise((resolve) => {
    let settled = false;
    const sock = dgram.createSocket('udp4');
    const done = (ip) => {
      if (settled) return;
      settled = true;
      try { sock.close(); } catch (_) {}
      resolve(ip && ip !== '0.0.0.0' ? ip : null);
    };
    sock.on('error', () => done(null));
    try {
      sock.connect(80, '8.8.8.8', () => {
        try { done(sock.address().address); } catch (_) { done(null); }
      });
    } catch (_) { done(null); }
    setTimeout(() => done(null), 600); // never hang boot
  });
}

// Prove an address is real: try to actually bind a socket to it. A ghost /
// stale / unassigned address fails with EADDRNOTAVAIL and gets dropped.
function ipIsBindable(ip) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    try {
      srv.listen(0, ip, () => srv.close(() => resolve(true)));
    } catch (_) { resolve(false); }
  });
}

// Final, verified pick: cross-check the name/score heuristic against (1) the OS
// routing source IP and (2) a real bind test, so we hand the phone an address
// that is genuinely live and reachable — not a false/ghost IP.
async function resolveLocalIPs() {
  const scored = getLocalIPs();
  // Keep only addresses we can actually bind to (drops ghosts).
  const live = [];
  for (const c of scored) {
    if (await ipIsBindable(c.address)) live.push(c);
  }
  // Let the OS's own routing decision win the tie-break.
  const routeIP = await getRoutingSourceIP();
  if (routeIP) {
    const i = live.findIndex(c => c.address === routeIP);
    if (i > 0) {
      const [hit] = live.splice(i, 1);
      live.unshift(hit); // OS-confirmed address -> front of the line
    } else if (i === -1 && await ipIsBindable(routeIP)) {
      // The OS chose a live address our heuristic skipped — trust the OS.
      live.unshift({ name: 'auto-detected', address: routeIP, score: 999 });
    }
  }
  return live;
}

// ---------- Activity log ----------
function timestamp() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function logEvent(type, title, sub) {
  const evt = { type, title, sub, time: Date.now() };
  state.events.unshift(evt);
  if (state.events.length > 50) state.events.pop();
  const typeLabel = type.toUpperCase().padEnd(9);
  let line = `  [${timestamp()}]  ${typeLabel}  ::  ${title}`;
  if (sub) line += `  ::  ${sub}`;
  console.log(line);
}

// ---------- Embedded assets ----------
// In production, embedded.js is generated by prepare.js (run by Build.bat).
// pkg auto-traces this require() and bundles embedded.js into the .exe.
// In dev (node server.js without prepare), fall back to reading source files.
let PHONE_HTML, MANIFEST, EMBEDDED_ASSETS;
try {
  const embedded = require('./embedded.js');
  PHONE_HTML = embedded.PHONE_HTML;
  MANIFEST = embedded.MANIFEST;
  EMBEDDED_ASSETS = embedded.ASSETS || {};
} catch (e) {
  PHONE_HTML = fs.readFileSync(path.join(__dirname, 'phone.html'), 'utf8');
  MANIFEST = fs.readFileSync(path.join(__dirname, 'manifest.webmanifest'), 'utf8');
  EMBEDDED_ASSETS = {};
}

// ---------- HTTP server ----------
function startServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(PHONE_HTML);
    }

    if (req.method === 'GET' && url.pathname === '/manifest.webmanifest') {
      res.writeHead(200, { 'Content-Type': 'application/manifest+json' });
      return res.end(MANIFEST);
    }

    if (req.method === 'GET' && url.pathname.startsWith('/assets/')) {
      const fname = url.pathname.slice('/assets/'.length);
      const contentType = fname.endsWith('.ico') ? 'image/x-icon' : 'image/png';
      // Embedded version (in built .exe)
      if (EMBEDDED_ASSETS[fname]) {
        res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'public, max-age=86400' });
        return res.end(EMBEDDED_ASSETS[fname]);
      }
      // Disk version (dev mode)
      const filePath = path.join(__dirname, url.pathname);
      if (fs.existsSync(filePath)) {
        res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'public, max-age=86400' });
        return res.end(fs.readFileSync(filePath));
      }
      res.writeHead(404); return res.end();
    }

    if (req.method === 'GET' && url.pathname === '/state') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        clipboard: state.clipboard,
        files: state.files.map(f => ({ name: f.name, size: f.size, time: f.time })),
        links: state.links
      }));
    }

    if (req.method === 'POST' && url.pathname === '/clipboard') {
      let body = '';
      req.on('data', d => body += d);
      req.on('end', () => {
        try { state.clipboard = JSON.parse(body).text || ''; } catch { state.clipboard = body; }
        try {
          const tmp = path.join(os.tmpdir(), 'phonebridge_clip.txt');
          fs.writeFileSync(tmp, state.clipboard, 'utf8');
          execSync(`powershell -Command "Get-Content -Raw '${tmp}' | Set-Clipboard"`, { stdio: 'ignore' });
        } catch (e) {}
        const preview = state.clipboard.length > 60
          ? state.clipboard.slice(0, 57) + '...'
          : state.clipboard;
        logEvent('clipboard', preview);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/link') {
      let body = '';
      req.on('data', d => body += d);
      req.on('end', () => {
        try {
          const { url: link, title } = JSON.parse(body);
          state.links.unshift({ url: link, title: title || link, time: Date.now() });
          if (state.links.length > 20) state.links.pop();
          logEvent('link', title || link, link);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch { res.writeHead(400); res.end('bad'); }
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/file') {
      let chunks = [];
      req.on('data', d => chunks.push(d));
      req.on('end', () => {
        try {
          const raw = Buffer.concat(chunks);
          const boundary = (req.headers['content-type'] || '').split('boundary=')[1];
          if (!boundary) { res.writeHead(400); return res.end('no boundary'); }
          const bBuf = Buffer.from('--' + boundary);
          let start = raw.indexOf(bBuf) + bBuf.length + 2;
          const headerEnd = raw.indexOf('\r\n\r\n', start);
          const header = raw.slice(start, headerEnd).toString();
          const nameMatch = header.match(/filename="([^"]+)"/);
          const fname = nameMatch ? nameMatch[1] : `file_${Date.now()}`;
          const fileData = raw.slice(headerEnd + 4, raw.lastIndexOf('\r\n--' + boundary));

          const outDir = path.join(os.homedir(), 'Downloads', 'PhoneBridge');
          if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
          const outPath = path.join(outDir, fname);
          fs.writeFileSync(outPath, fileData);
          state.files.unshift({ name: fname, size: fileData.length, time: Date.now(), path: outPath });
          if (state.files.length > 20) state.files.pop();
          const sizeStr = fileData.length < 1024 ? `${fileData.length}B`
            : fileData.length < 1048576 ? `${(fileData.length/1024).toFixed(1)}KB`
            : `${(fileData.length/1048576).toFixed(1)}MB`;
          logEvent('file', fname, `${sizeStr}  >>  Downloads/PhoneBridge`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, path: outPath }));
        } catch (e) {
          res.writeHead(500); res.end('error');
        }
      });
      return;
    }

    res.writeHead(404); res.end('not found');
  });

  // Try PORT first; if it's already in use, automatically step forward to the
  // next port and try again, up to MAX_PORT_TRIES. Resolves with the port that
  // actually bound so the QR/URL always points at the right one.
  return new Promise((resolve, reject) => {
    let port = PORT;
    let tries = 0;
    server.on('listening', () => resolve(port));
    server.on('error', (err) => {
      if (err && err.code === 'EADDRINUSE' && tries < MAX_PORT_TRIES - 1) {
        tries++; port++;
        setImmediate(() => server.listen(port, '0.0.0.0'));
      } else {
        reject(err);
      }
    });
    server.listen(port, '0.0.0.0');
  });
}

// ---------- Banner ----------
// The frame is generated (not hand-padded) so every row is exactly the same
// width and the right border never drifts. Styled like a Greek temple:
// two columns (||) holding an entablature beam (+===+), standing on temple
// steps (the widening base). Pure ASCII so it renders on any Windows console.
function printBanner() {
  const W = 56;          // inner content width
  const M = '  ';        // left margin
  const COL = '||';      // column shaft (the "pillars")

  const row = (s = '') => {
    if (s.length > W) s = s.slice(0, W);
    const total = W - s.length, left = Math.floor(total / 2), right = total - left;
    return M + COL + ' ' + ' '.repeat(left) + s + ' '.repeat(right) + ' ' + COL;
  };
  const rowLR = (l, r) => {
    const mid = Math.max(1, W - l.length - r.length);
    return M + COL + ' ' + l + ' '.repeat(mid) + r + ' ' + COL;
  };
  const row3 = (l, m, r) => {
    const gaps = W - l.length - m.length - r.length;
    const g1 = Math.max(1, Math.floor(gaps / 2)), g2 = Math.max(1, gaps - g1);
    return M + COL + ' ' + l + ' '.repeat(g1) + m + ' '.repeat(g2) + r + ' ' + COL;
  };
  const beam = M + '+' + '='.repeat(W + 4) + '+';      // entablature
  const block = (rows) => {
    const maxLen = Math.max(...rows.map(r => r.length));
    return rows.map(r => row(r.padEnd(maxLen)));
  };

  const phone = [
    '/---\\  |   |  /---\\  |\\  |  /----',
    '|   |  |   |  |   |  | \\ |  |',
    '|---/  |---|  |   |  |  \\|  |----',
    '|      |   |  |   |  |   |  |',
    '|      |   |  \\---/  |   |  \\----',
  ];
  const bridge = [
    '/---\\  /---\\  |---|  |---\\  /---\\  /----',
    '|   |  |   |    |    |   |  |      |',
    '|---/  |---/    |    |   |  | --\\  |----',
    '|   \\  |  \\     |    |   |  |   |  |',
    '\\---/  |   \\  |---|  |---/  \\---/  \\----',
  ];

  const out = ['', beam, row()];
  out.push(rowLR('[ PHONEBRIDGE.SYS ]', '[ * ONLINE ]'), row());
  out.push(...block(phone), row());
  out.push(...block(bridge), row());
  out.push(row(':: by PskXClaude ::'), row());
  out.push(row3('KEY :: 0xAF.C9.7E.12', 'PORT :: 9147', 'PROTO :: AES'), row());
  out.push(beam);
  // temple steps (stylobate) fanning outward
  out.push(' '  + '+' + '='.repeat(W + 6) + '+');
  out.push(''   + '+' + '='.repeat(W + 8) + '+');
  out.push('');
  console.log(out.join('\n'));
}

// ---------- Boot sequence ----------
async function boot() {
  console.clear();
  printBanner();

  console.log('    ~> 7F.4A.E9.C1  ::  PACKET 001  ::  HANDSHAKE OK  ::  200');
  console.log('');

  console.log('    > probing local interfaces ............... [  OK  ]');
  const ips = await resolveLocalIPs();
  if (ips.length === 0) {
    console.log('');
    console.log('    [ FAIL ]  Couldn\'t find your local network address.');
    console.log('              1. Make sure this PC is connected to Wi-Fi or Ethernet.');
    console.log('              2. Or find it by hand: open Command Prompt and run  ipconfig');
    console.log('                 Use the "IPv4 Address" (looks like 192.168.x.x), then on');
    console.log('                 your phone open  http://THAT-ADDRESS:' + PORT);
    console.log('');
    return;
  }

  let activePort;
  try {
    activePort = await startServer();
  } catch (e) {
    console.log('    [ FAIL ]  Could not open a port (tried ' + PORT + '-' + (PORT + MAX_PORT_TRIES - 1) + ').');
    console.log('              Close any other PhoneBridge instances and try again.');
    return;
  }
  if (activePort === PORT) {
    console.log('    > spawning HTTP listener on :' + activePort + ' .......... [  OK  ]');
  } else {
    console.log('    > port ' + PORT + ' was busy - using :' + activePort + ' instead ... [  OK  ]');
  }

  const url = `http://${ips[0].address}:${activePort}`;
  console.log('    > generating QR token .................... [  OK  ]');
  console.log('    > establishing bridge daemon ............. [  OK  ]');
  console.log('');
  console.log('       [ READY ]  bridge active on ' + url);
  console.log('');
  console.log('       SCAN WITH YOUR IPHONE CAMERA:');
  console.log('');

  // Generate and print QR
  try {
    const qr = await QRCode.toString(url, { type: 'terminal', small: true });
    // Indent each line of the QR
    const indented = qr.split('\n').map(l => '       ' + l).join('\n');
    console.log(indented);
  } catch (e) {
    console.log('       (QR render failed — open the URL on your phone manually)');
  }

  console.log('       Or open in iPhone Safari: ' + url);
  console.log('       Tip: Share -> Add to Home Screen for an app icon');
  if (ips.length > 1) {
    console.log('');
    console.log('       Phone can\'t connect? Your PC has more than one network');
    console.log('       adapter — try one of these addresses instead:');
    for (const c of ips) {
      console.log('         http://' + c.address + ':' + activePort + '   (' + c.name + ')');
    }
  }
  console.log('');
  console.log(' :==========================================================:');
  console.log(' |                     LIVE ACTIVITY                         |');
  console.log(' :==========================================================:');
  console.log('');
  console.log('  Waiting for phone... incoming events will appear below.');
  console.log('  Press Ctrl+C to stop.');
  console.log('');
}

// Exported for tests. Boot is skipped when PB_NO_BOOT is set so the IP-resolution
// logic can be exercised without starting the server.
module.exports = { getLocalIPs, getRoutingSourceIP, ipIsBindable, resolveLocalIPs, printBanner };

if (!process.env.PB_NO_BOOT) {
  boot().catch(e => {
    console.error('PhoneBridge crashed:', e);
    console.error('Press any key to close...');
  });

  process.on('SIGINT', () => {
    console.log('');
    console.log('  > PhoneBridge shutting down. Goodbye.');
    process.exit(0);
  });
}
