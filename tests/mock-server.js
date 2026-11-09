/**
 * เซิร์ฟเวอร์ทดสอบ: เสิร์ฟเว็บแอป (app/) + API จำลอง Apps Script พร้อมข้อมูลจริงที่อนุมัติแล้ว
 * SAMPLE_SAP=... SAMPLE_POS=... PORT=8787 node tests/mock-server.js
 * มี /debug/* สำหรับชุดทดสอบ E2E เท่านั้น
 */
const http = require('http'), fs = require('fs'), path = require('path');
const { createEnv, loadSamples } = require('./gas-env');
const PORT = Number(process.env.PORT || 8787);
const APP = path.join(__dirname, '..', 'app');

const env = createEnv();
const { sap, pos } = loadSamples(env.ctx.Core);
const run = (c, v) => env.run(c, Object.assign({ _sap: sap, _pos: pos }, v || {}));
run('setupSheets()');
run('apiOpenRound("2026Q4", "2026-11-04")');
run('apiUpload("POS", _pos, { fileName: "pos.xls", fileDate: "2026-11-04" })');
run('apiUpload("SAP", _sap, { fileName: "sap.xls", fileDate: "2026-11-04", d1Confirmed: true })');
const st = run('apiGetState()');
run(`apiApprove(${JSON.stringify(st.master.hash)}, ${JSON.stringify(st.master.checks.filter(c => c.level === 'WARN' && !c.pass).map(c => c.id))})`);
env.sheets.Staff.data.push(['EMP-NU', 'นุ่น', 'ผู้ตรวจสอบ', 'Y'], ['EMP-AOY', 'อ้อย', 'ผู้ตรวจสอบ', 'Y']);
run('apiSeedDevices(5, "TC21")');

let offline = false;
let appVersion = '2.2.5';
let slowMs = 0;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    const send = (code, obj, type) => { res.writeHead(code, { 'Content-Type': type || 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(typeof obj === 'string' || Buffer.isBuffer(obj) ? obj : JSON.stringify(obj)); };
    try {
      if (url.pathname === '/api') {
        if (offline) { req.socket.destroy(); return; }
        if (req.method === 'GET') return send(200, run('doGet(_e).getContent()', { _e: { parameter: Object.fromEntries(url.searchParams) } }));
        return send(200, run('doPost(_r).getContent()', { _r: { postData: { contents: body } } }));
      }
      if (url.pathname === '/debug/paircode') return send(200, run(`apiPairCode(${JSON.stringify(url.searchParams.get('d'))})`).devices.find(d => d.id === url.searchParams.get('d')));
      if (url.pathname === '/debug/log') return send(200, env.sheets.Count_Log.data);
      if (url.pathname === '/debug/revoke') return send(200, run(`apiSetDeviceActive(${JSON.stringify(url.searchParams.get('d'))}, false, ${JSON.stringify(url.searchParams.get('r') || 'TEMP')}, "e2e")`));
      if (url.pathname === '/debug/enable') return send(200, run(`apiSetDeviceActive(${JSON.stringify(url.searchParams.get('d'))}, true)`));
      if (url.pathname === '/debug/adminlog') return send(200, env.sheets.Admin_Log.data);
      if (url.pathname === '/debug/locations') return send(200, run('apiDevicesState()'));
      if (url.pathname === '/debug/loccheck') return send(200, env.sheets.Loc_Checks.data);
      if (url.pathname === '/debug/offline') { offline = url.searchParams.get('on') === '1'; return send(200, { offline }); }
      if (url.pathname === '/debug/import') return send(200, run('apiImportDeviceFile(_t, "e2e.csv")', { _t: body }));
      if (url.pathname === '/debug/slow') { slowMs = Number(url.searchParams.get('ms') || 0); return send(200, { slowMs }); }
      if (url.pathname === '/debug/reupload-sap') { run('apiUpload("SAP", _sap, { fileName: "sap2.xls", fileDate: "2026-11-04", d1Confirmed: true })'); return send(200, { ok: true }); }
      if (url.pathname === '/debug/version') { appVersion = url.searchParams.get('v'); return send(200, { appVersion }); }
      if (url.pathname === '/app/config.json') return send(200, { apiUrl: 'http://localhost:' + PORT + '/api', appVersion });
      if (url.pathname.startsWith('/app/') && slowMs) return setTimeout(serveStatic, slowMs);   // จำลองเน็ตช้า/เพิ่งต่อ Wi-Fi
      if (url.pathname.startsWith('/app/')) return serveStatic();
      function serveStatic() {
        let f = path.join(APP, url.pathname.slice(5) || 'index.html');
        if (fs.existsSync(f) && fs.statSync(f).isDirectory()) f = path.join(f, 'index.html');
        if (!fs.existsSync(f)) return send(404, 'not found', 'text/plain');
        return send(200, fs.readFileSync(f), TYPES[path.extname(f)] || 'application/octet-stream');
      }
      send(404, 'not found', 'text/plain');
    } catch (e) { send(500, { error: String(e.stack || e) }); }
  });
}).listen(PORT, () => console.log('mock server http://localhost:' + PORT + '/app/'));
