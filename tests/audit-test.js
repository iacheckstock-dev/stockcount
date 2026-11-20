/**
 * v2.6.0: หน้า Audit — ค้นตาม SKU / Location / ผู้ตรวจ · อ่านอย่างเดียว (ไม่ล็อก ไม่เขียนชีต)
 * SAMPLE_SAP=... SAMPLE_POS=... node tests/audit-test.js
 */
const assert = require('assert');
const { createEnv, loadSamples } = require('./gas-env');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + '\n    ' + (e.stack || e.message).split('\n').slice(0, 4).join('\n    ')); }
}
const throws = (fn, re) => { try { fn(); } catch (e) { assert.ok(re.test(e.message), e.message); return; } assert.fail('ต้องปฏิเสธ: ' + re); };

const env = createEnv();
const { sap, pos } = loadSamples(env.ctx.Core);
const run = (c, v) => env.run(c, Object.assign({ _sap: sap, _pos: pos }, v || {}));
const P = '2026Q4-R2';
run('setupSheets()');

console.log('\nก่อนเปิดรอบ');
test('ไม่มีรอบ → none (ไม่ error)', () => {
  const r = run('apiAudit("sku", "x")');
  assert.ok(r.none);
});

run(`apiOpenRound("${P}", "2026-11-04", "PILOT")`);
run('apiUpload("POS", _pos, { fileName: "pos.xls", fileDate: "2026-11-04" })');
run('apiUpload("SAP", _sap, { fileName: "sap.xls", fileDate: "2026-11-04", d1Confirmed: true })');
const st = run('apiGetState()');
run(`apiApprove(${JSON.stringify(st.master.hash)}, ${JSON.stringify(st.master.checks.filter(c => c.level === 'WARN' && !c.pass).map(c => c.id))})`);
env.sheets.Staff.data.push(['EMP-A', 'นาย ก', 'ผู้ตรวจสอบ', 'Y'], ['EMP-B', 'นาย ข', 'ผู้ตรวจสอบ', 'Y']);
run('apiSeedDevices(2, "TC21")');
const VER = run('SYSTEM_VERSION');
const BC1 = '8858684826179', MAT1 = 'A112101UT0450XK', BC2 = '8858153867481', MAT2 = 'A112101UT0550XK', BAD = '9999999999999';

function device(id, staff) {
  const code = run(`apiPairCode(${JSON.stringify(id)})`).devices.find(x => x.id === id).pairCode;
  const token = env.post({ action: 'pair', deviceId: id, code }).token;
  const d = { id, staff, seq: 0, entries: [], at: 1 };
  d.call = (action, body) => env.post(Object.assign({ action, deviceId: id, token, appVersion: VER }, body || {}));
  d.scan = (loc, bc, mat, qty, extra) => {
    d.seq++;
    const e = Object.assign({ logId: id + '-' + String(d.seq).padStart(6, '0'), seq: d.seq, projectId: P, staff, location: loc, barcode: bc,
      material: mat, qty, type: 'SCAN', refId: '', reason: '', note: '', scanTime: '2026-11-04 10:' + String(d.seq).padStart(2, '0') + ':00' }, extra || {});
    d.entries.push(e);
    return e;
  };
  d.ev = (type, loc, extra) => {
    const mine = d.entries.filter(e => e.location === loc);
    const seqs = d.entries.map(e => e.seq);
    return Object.assign({ id: id + '-E' + d.at, type, projectId: P, location: loc, staff, time: '2026-11-04 10:' + String(30 + d.at).padStart(2, '0') + ':00',
      lines: mine.length, qty: Math.round(mine.reduce((a, e) => a + e.qty, 0) * 1000) / 1000,
      fromSeq: seqs.length ? Math.min(...seqs) : 0, upToSeq: seqs.length ? Math.max(...seqs) : 0, at: d.at++ }, extra || {});
  };
  d.sync = (entries, events) => { const r = d.call('sync', { entries: entries || [], events: events || [] }); assert.ok(r.ok, JSON.stringify(r)); return r; };
  return d;
}
const A = device('TC21-01', 'EMP-A'), B = device('TC21-02', 'EMP-B');
// D1: ก ผู้ดูแล ยิง 3+2 · ป้อนเอง 1 · ยกเลิกรายการล่าสุด · ข ผู้ช่วย ยิง 4 แล้วส่งงาน · ก แก้ยอดรวม MAT1 ตามที่ ข ขอ · ปิด
const a1 = A.scan('D1', BC1, MAT1, 3), a2 = A.scan('D1', BC2, MAT2, 2), a3 = A.scan('D1', BC2, MAT2, 1, { type: 'MANUAL' });
A.sync([a1, a2, a3], [A.ev('OPEN', 'D1')]);
A.sync([A.scan('D1', BC2, MAT2, -1, { type: 'VOID', refId: a3.logId, reason: 'ยกเลิกรายการล่าสุด' })]);
B.sync([B.scan('D1', BC1, MAT1, 4), B.scan('D1', BAD, '', 2)], [B.ev('JOIN', 'D1')]);
B.sync([], [B.ev('SUBMIT', 'D1')]);
A.sync([A.scan('D1', BC1, MAT1, -1, { type: 'RECOUNT_SET', basis: 7, reason: 'แก้ยอด', requestedBy: 'EMP-B' })], [A.ev('EDIT', 'D1')]);
A.sync([], [A.ev('CLOSE', 'D1')]);
// D2: ข ยิง MAT1 5
B.sync([B.scan('D2', BC1, MAT1, 5)], [B.ev('OPEN', 'D2')]);

const snap = () => JSON.stringify(Object.keys(env.sheets).sort().map(k => env.sheets[k].data));
function readOnly(fn) {
  const before = snap(), w = env.stats.all.writes, lk = env.lockTrace.length;
  const r = fn();
  assert.strictEqual(env.stats.all.writes, w, 'ไม่เขียนชีต');
  assert.strictEqual(env.lockTrace.filter((x, i) => i >= lk && x === 'lock').length, 0, 'ไม่ล็อก');
  assert.strictEqual(snap(), before, 'ข้อมูลในชีตไม่เปลี่ยน');
  return r;
}

console.log('\nค้นตาม SKU');
test('Material ตรงตัว → ยอดเท่าหน้าสรุปผลนับ · ทุกบรรทัดของรหัสนี้ (2 Location) · อ่านอย่างเดียว', () => {
  const r = readOnly(() => run(`apiAudit("sku", "${MAT1}")`));
  const S = run('apiSummary()').skus.find(x => x[0] === MAT1);
  assert.strictEqual(r.head.material, MAT1);
  assert.strictEqual(r.head.dev, S[3]); assert.strictEqual(r.head.fin, S[5]); assert.strictEqual(r.head.diff, S[6]); assert.strictEqual(r.head.diffValue, S[8]);
  assert.strictEqual(r.head.dev, 3 + 4 - 1 + 5);
  assert.strictEqual(r.total, 4);
  assert.strictEqual(r.lines.map(l => l.loc).sort().join(), 'D1,D1,D1,D2');
  assert.ok(r.head.perLoc.some(x => x[0] === 'D2' && x[5] === 5));
});
test('บาร์โค้ด / พิมพ์ตัวเล็ก → เจอรหัสเดียวกัน', () => {
  assert.strictEqual(run(`apiAudit("sku", "${BC2}")`).head.material, MAT2);
  assert.strictEqual(run(`apiAudit("sku", "${MAT2.toLowerCase()}")`).head.material, MAT2);
});
test('บรรทัดแก้/ยกเลิก: ประเภทภาษาไทย · อ้างรายการเดิม · ผู้ขอให้แก้ · ตัวกรอง "เฉพาะแก้/ยกเลิก"', () => {
  const r = run(`apiAudit("sku", "${MAT2}")`);
  const v = r.lines.find(l => l.ty === 'VOID'), m = r.lines.find(l => l.ty === 'MANUAL');
  assert.ok(v.ed && v.th === 'ยกเลิก' && v.ref === a3.logId && v.q === -1);
  assert.ok(!m.ed && m.th === 'ป้อนเอง');
  assert.strictEqual(r.editCount, 1);
  const e = run(`apiAudit("sku", "${MAT1}", { edits: true })`);
  assert.strictEqual(e.total, 1); assert.strictEqual(e.all, 4);
  assert.ok(e.lines[0].th === 'ผู้ดูแลแก้ยอด' && e.lines[0].rq === 'EMP-B' && e.lines[0].sn === 'นาย ก');
});
test('ค้นบางส่วนเจอหลายตัว → ให้เลือก · เลือกแล้วได้ผล · ไม่เจอ → แจ้ง', () => {
  const r = run('apiAudit("sku", "A112101UT0")');
  assert.ok(r.choices && r.choices.length > 1 && r.choices.some(c => c[0] === MAT1), JSON.stringify(r).slice(0, 200));
  assert.strictEqual(run(`apiAudit("sku", "A112101UT0", { pick: "${MAT1}" })`).head.material, MAT1);
  throws(() => run('apiAudit("sku", "ZZZ-NOTHING")'), /ไม่พบสินค้า/);
  throws(() => run('apiAudit("sku", "  ")'), /คำค้น/);
});
test('บาร์โค้ดไม่มีใน Master → ค้นได้ บอกว่าไม่มีใน Master ไม่มียอดบัญชี/ผลต่าง', () => {
  const r = run(`apiAudit("sku", "${BAD}")`);
  assert.ok(!r.head.inMaster && r.head.book === undefined && r.head.fin === 2 && r.total === 1);
});

console.log('\nค้นตาม Location');
test('D1: สถานะ ผู้ดูแล เครื่องที่ร่วม ลำดับเหตุการณ์ สินค้า และทุกบรรทัด · พิมพ์ตัวเล็กได้', () => {
  const r = readOnly(() => run('apiAudit("loc", "d1")'));
  assert.strictEqual(r.head.loc, 'D1');
  assert.ok(/ปิดแล้ว/.test(r.head.status), r.head.status);
  assert.strictEqual(r.head.members.map(m => m.device + ':' + m.role).sort().join(), 'TC21-01:OWNER,TC21-02:HELPER');
  const ev = r.head.events.map(e => e.ev);
  ['OPEN', 'JOIN', 'SUBMIT', 'EDIT', 'CLOSE'].forEach(x => assert.ok(ev.indexOf(x) >= 0, 'มี ' + x + ' ใน ' + ev));
  assert.ok(r.head.events.find(e => e.ev === 'SUBMIT').th === 'ส่งงาน');
  assert.strictEqual(r.total, 7);
  assert.strictEqual(r.editCount, 2);
  assert.ok(r.head.items.some(x => x[0] === BAD && !x[4]));
  assert.strictEqual(r.head.qty, 3 + 2 + 1 - 1 + 4 + 2 - 1);
});
test('ไม่มี Location นี้ → แจ้ง', () => { throws(() => run('apiAudit("loc", "Z99")'), /ไม่พบ Location/); });

console.log('\nค้นตามผู้ตรวจ');
test('ข: บรรทัดของตัวเอง + บรรทัดที่ขอให้คนอื่นแก้ (ติดป้าย) · Location ที่ร่วมพร้อมบทบาท', () => {
  const r = readOnly(() => run('apiAudit("staff", "emp-b")'));
  assert.strictEqual(r.head.code, 'EMP-B'); assert.strictEqual(r.head.name, 'นาย ข');
  assert.strictEqual(r.head.lines, 3); assert.strictEqual(r.head.qty, 11); assert.strictEqual(r.head.requested, 1);
  assert.strictEqual(r.total, 4);
  assert.ok(r.lines.filter(l => l.req).length === 1 && r.lines.find(l => l.req).st === 'EMP-A');
  const d1 = r.head.locs.find(x => x.loc === 'D1'), d2 = r.head.locs.find(x => x.loc === 'D2');
  assert.ok(d1.roles.some(x => /ผู้ช่วย TC21-02/.test(x)) && d2.roles.some(x => /ผู้ดูแล/.test(x)));
});
test('ก: ยกเลิก 1 · แก้ยอด 1 · เครื่อง TC21-01', () => {
  const r = run('apiAudit("staff", "EMP-A")');
  assert.strictEqual(r.head.voids, 1); assert.strictEqual(r.head.edits, 1); assert.strictEqual(r.head.devices.join(), 'TC21-01');
});
test('รหัสที่ไม่มี → แจ้ง · ประเภทผิด → แจ้ง', () => {
  throws(() => run('apiAudit("staff", "NOBODY")'), /ไม่พบผู้ตรวจ/);
  throws(() => run('apiAudit("xxx", "a")'), /ประเภท/);
});

console.log('\nแบ่งหน้า');
test('ทีละ 200 บรรทัด: offset ต่อได้ · ครบทุกบรรทัด ไม่ซ้ำ', () => {
  const many = [];
  for (let i = 0; i < 230; i++) many.push(B.scan('D3', BC1, MAT1, 1));
  B.sync(many, [B.ev('OPEN', 'D3')]);
  const p1 = run('apiAudit("loc", "D3")'), p2 = run('apiAudit("loc", "D3", { offset: 200 })');
  assert.strictEqual(p1.total, 230); assert.strictEqual(p1.lines.length, 200); assert.strictEqual(p2.lines.length, 30);
  const ids = new Set(p1.lines.concat(p2.lines).map(l => l.id));
  assert.strictEqual(ids.size, 230);
});

console.log('\nหลังปิดรอบ');
test('รอบปิดแล้ว → closed + ลิงก์ไฟล์สำรอง (ไม่ค้นในชีตที่ล้างแล้ว)', () => {
  run(`setConfig_({ ROUND_STATUS: "CLOSED" })`);
  env.sheets.Count_History.data.push([P, '2026-11-04', 8900, 314, -8597, -1, 1, 0, 'https://docs/x', '', 1, 314, '', '', 'PILOT', 'id']);
  const r = run('apiAudit("sku", "x")');
  assert.ok(r.closed && r.url === 'https://docs/x');
});

console.log('\nผล: ผ่าน ' + pass + ' / ไม่ผ่าน ' + fail);
process.exit(fail ? 1 : 0);
