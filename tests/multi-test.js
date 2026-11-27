/**
 * ทดสอบหลายเครื่องใน Location เดียวกัน: ผู้ดูแล / พัก / ปิด / โอนการดูแล / Control ต่าง ๆ
 * v2.7.0: ไม่มีผู้ช่วยแล้ว — ข้อมูลหลายเครื่องใน Location เกิดจาก "เปิดซ้อน" (ออฟไลน์ / JOIN จากแอปรุ่นเก่า → ติดธง) และ "โอนการดูแล"
 *         เทสต์กลไกข้อมูลหลายเครื่องยังอยู่ (ใช้จริงกับ 2 กรณีนี้) · ใช้ unflag() จำลองหัวหน้าทีมตัดสินธงนับซ้อนแล้ว เพื่อดูผลส่วนอื่นแยก
 * SAMPLE_SAP=... SAMPLE_POS=... node tests/multi-test.js
 */
const assert = require('assert');
const { createEnv, loadSamples } = require('./gas-env');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + '\n    ' + (e.stack || e.message).split("\n").slice(0, 7).join('\n    ')); }
}

const env = createEnv();
const { sap, pos } = loadSamples(env.ctx.Core);
const run = (c, v) => env.run(c, Object.assign({ _sap: sap, _pos: pos }, v || {}));
run('setupSheets()');
run('apiOpenRound("2026Q4", "2026-11-04", "PILOT")');
run('apiUpload("POS", _pos, { fileName: "pos.xls", fileDate: "2026-11-04" })');
run('apiUpload("SAP", _sap, { fileName: "sap.xls", fileDate: "2026-11-04", d1Confirmed: true })');
const st = run('apiGetState()');
run(`apiApprove(${JSON.stringify(st.master.hash)}, ${JSON.stringify(st.master.checks.filter(c => c.level === 'WARN' && !c.pass).map(c => c.id))})`);
env.sheets.Staff.data.push(['EMP-K', 'นาย ก', 'ผู้ตรวจสอบ', 'Y'], ['EMP-KH', 'นาย ข', 'ผู้ตรวจสอบ', 'Y'], ['EMP-C', 'นาย ค', 'ผู้ตรวจสอบ', 'Y']);
run('apiSeedDevices(5, "TC21")');

const BC1 = '8858684826179', MAT1 = 'A112101UT0450XK';
const BC2 = '8858153867481', MAT2 = 'A112101UT0550XK';

/** เครื่องจำลอง: เก็บ seq และรายการของตัวเอง สร้าง event แบบเดียวกับแอป */
function device(id, staff, ver) {
  const code = run(`apiPairCode(${JSON.stringify(id)})`).devices.find(x => x.id === id).pairCode;
  const token = env.post({ action: 'pair', deviceId: id, code }).token;
  const d = { id, staff, seq: 0, entries: [], at: 1 };
  d.call = (action, body) => env.post(Object.assign({ action, deviceId: id, token, appVersion: ver || '2.2.0' }, body || {}));
  d.scan = (loc, bc, mat, qty, extra) => {
    d.seq++;
    const e = Object.assign({ logId: id + '-' + String(d.seq).padStart(6, '0'), seq: d.seq, projectId: '2026Q4', staff, location: loc, barcode: bc,
      material: mat, qty, type: 'SCAN', refId: '', reason: '', note: '', scanTime: '2026-11-04 10:' + String(d.seq % 60).padStart(2, '0') + ':00' }, extra || {});
    d.entries.push(e);
    return e;
  };
  d.ev = (type, loc, extra) => {
    const mine = d.entries.filter(e => e.location === loc);
    const seqs = d.entries.map(e => e.seq);
    return Object.assign({ id: id + '-E' + (d.at), type, projectId: '2026Q4', location: loc, staff, time: '2026-11-04 10:00:00',
      lines: mine.length, qty: Math.round(mine.reduce((a, e) => a + e.qty, 0) * 1000) / 1000,
      fromSeq: seqs.length ? Math.min(...seqs) : 0, upToSeq: seqs.length ? Math.max(...seqs) : 0, at: d.at++ }, extra || {});
  };
  d.sync = (entries, events) => { const r = d.call('sync', { entries: entries || [], events: events || [] }); assert.ok(r.ok, JSON.stringify(r)); return r; };
  d.info = loc => d.call('locInfo', { location: loc });
  return d;
}
const loc = name => run('apiDevicesState()').locations.find(l => l.Location === name) || {};
/** จำลองหัวหน้าทีมตัดสินธงนับซ้อนแล้ว (ล้าง Flag_Check ในชีตตรง ๆ) เพื่อทดสอบส่วนอื่นต่อ */
const unflag = name => { const lt = env.sheets.Locations.data, c = lt[0].indexOf('Flag_Check'); lt.forEach((row, i) => { if (i && row[0] === name) row[c] = ''; }); };
const mem = (l, dev) => run('apiDevicesState()').members.find(m => m.location === l && m.device === dev) || {};

const C = device('TC21-01', 'EMP-C'), K = device('TC21-02', 'EMP-K'), KH = device('TC21-03', 'EMP-KH');

console.log('\nเปิด / เข้าร่วม');
test('ค เปิด D80 → ผู้ดูแล (ไม่มีคำถาม)', () => {
  assert.strictEqual(C.info('D80').owner, null);
  const r = C.sync([C.scan('D80', BC1, MAT1, 4)], [C.ev('OPEN', 'D80')]);
  assert.strictEqual(r.events[0].role, 'OWNER');
  assert.strictEqual(loc('D80').Owner, 'TC21-01 EMP-C');
  assert.strictEqual(loc('D80').Status, 'กำลังนับ');
});
test('ก เช็ก D80 → เห็นผู้ดูแล นาย ค · v2.7.0: JOIN (แอปรุ่นเก่า) = เปิดซ้อน → รับข้อมูลไว้ (บทบาทภายใน HELPER) + ติดธง', () => {
  const i = K.info('D80');
  assert.strictEqual(i.owner.device, 'TC21-01');
  assert.strictEqual(i.owner.name, 'นาย ค');
  assert.strictEqual(i.me, null);
  const r = K.sync([], [K.ev('JOIN', 'D80')]);
  assert.strictEqual(r.events[0].role, 'HELPER');
  assert.strictEqual(r.events[0].owner, 'TC21-01');
  assert.ok(/นับซ้อน: TC21-02/.test(loc('D80').Flag), loc('D80').Flag);
  unflag('D80');
});
test('v2.6.2: ข เปิด D80 ตอนออฟไลน์ (ส่ง OPEN) ขณะมีผู้ดูแล → รับข้อมูลไว้ (ผู้ช่วย) แต่ติดธง "นับซ้อน" ให้หัวหน้าทีมตัดสิน', () => {
  const r = KH.sync([KH.scan('D80', BC2, MAT2, 2)], [KH.ev('OPEN', 'D80')]);
  assert.strictEqual(r.events[0].role, 'HELPER');
  assert.ok(/นับซ้อน/.test(env.sheets.Loc_Checks.data.slice(-1)[0][12]));
  assert.ok(/ต้องตรวจซ้ำ: นับซ้อน: TC21-03 .* เปิด D80 ขณะ TC21-01 เป็นผู้ดูแล/.test(loc('D80').Flag), loc('D80').Flag);
  assert.ok(env.sheets.Admin_Log.data.some(x => x.indexOf('LOC_DOUBLE_OPEN') >= 0));
  // ส่ง OPEN ซ้ำ → ไม่ติดธงซ้ำ
  KH.sync([], [KH.ev('OPEN', 'D80')]);
  assert.strictEqual((loc('D80').Flag.match(/นับซ้อน: TC21-03/g) || []).length, 1);
  unflag('D80');
});
test('ก ยิง 3 ชิ้น · ผู้ดูแลเห็นยอดเครื่องอื่นแยกจากของตัวเอง', () => {
  K.sync([K.scan('D80', BC1, MAT1, 1), K.scan('D80', BC1, MAT1, 1), K.scan('D80', BC2, MAT2, 1)]);
  const i = C.info('D80');
  assert.strictEqual(i.total, 9);
  assert.strictEqual(i.others.qty, 5);
  const o = Object.fromEntries(i.others.items.map(x => [x[0], x[3]]));
  assert.strictEqual(o[MAT1], 2); assert.strictEqual(o[MAT2], 3);
  assert.strictEqual(i.members.length, 3);
  assert.strictEqual(i.members.filter(m => m.role === 'HELPER' && m.state === 'COUNTING').length, 2);
  assert.strictEqual(loc('D80').Status_Detail, '3 เครื่อง · เครื่องอื่นส่งครบ 0/2');
});
test('สองเครื่องเปิด Location ใหม่พร้อมกัน → เครื่องแรกเป็นผู้ดูแล อีกเครื่องรับข้อมูลไว้ + ติดธงนับซ้อน', () => {
  const a = K.sync([], [K.ev('OPEN', 'A30')]), b = KH.sync([], [KH.ev('OPEN', 'A30')]);
  assert.strictEqual(a.events[0].role, 'OWNER');
  assert.strictEqual(b.events[0].role, 'HELPER');
  assert.ok(/นับซ้อน: TC21-03/.test(loc('A30').Flag));
});

console.log('\nส่งงาน / กลับมาช่วย');
test('ก ยิงป้ายที่อื่น → ส่งงาน D80 อัตโนมัติ ยอดครบ → ส่งงานแล้ว ✓', () => {
  const r = K.sync([], [K.ev('SUBMIT', 'D80', { auto: true })]);
  assert.strictEqual(r.events[0].match, 'OK');
  assert.strictEqual(mem('D80', 'TC21-02').state, 'SUBMITTED');
  assert.strictEqual(mem('D80', 'TC21-02').subBy, 'AUTO');
});
test('ส่งงานตอนข้อมูลยังไม่ครบ (Seq ขาด) → รอข้อมูล ผู้ดูแลยังถือว่าไม่ครบ', () => {
  const e1 = KH.scan('D80', BC1, MAT1, 1), e2 = KH.scan('D80', BC1, MAT1, 1);
  const r = KH.sync([e2], [KH.ev('SUBMIT', 'D80')]);
  assert.strictEqual(r.events[0].match, 'WAIT');
  assert.ok(/รอข้อมูล/.test(loc('D80').Members));
  const r2 = KH.sync([e1], [Object.assign(KH.ev('SUBMIT', 'D80'), { at: KH.at - 1 })]);
  assert.strictEqual(r2.events[0].match, 'OK');
  assert.strictEqual(mem('D80', 'TC21-03').match, 'OK');
});
test('ก กลับมาช่วย D80 (เข้าร่วมอีกครั้ง + ยิงเพิ่ม) → กำลังนับ ยอดต่อจากเดิม', () => {
  const r = K.sync([K.scan('D80', BC1, MAT1, 2)], [K.ev('JOIN', 'D80')]);
  assert.strictEqual(r.events[0].state, 'COUNTING');
  assert.strictEqual(mem('D80', 'TC21-02').state, 'COUNTING');
  assert.ok(/นับซ้อน/.test(env.sheets.Loc_Checks.data.slice(-1)[0][12]));
  unflag('D80');
  assert.strictEqual(C.info('D80').members.find(m => m.device === 'TC21-02').qty, 5);
});
test('ส่งงานรอบสอง สรุปยอดสะสม 5 (ไม่ใช่ 2) → ✓', () => {
  const r = K.sync([], [K.ev('SUBMIT', 'D80')]);
  assert.strictEqual(r.events[0].match, 'OK');
  assert.strictEqual(r.events[0].srvQty, 5);
});
test('ส่งงานแล้วแต่ยิงต่อโดยไม่เข้าร่วมใหม่ (เช่น หลังหัวหน้าส่งงานแทน) → กลับเป็นกำลังนับ', () => {
  KH.sync([KH.scan('D80', BC2, MAT2, 1)]);
  assert.strictEqual(mem('D80', 'TC21-03').state, 'COUNTING');
  KH.sync([], [KH.ev('SUBMIT', 'D80')]);
  assert.strictEqual(mem('D80', 'TC21-03').state, 'SUBMITTED');
});
test('เหตุการณ์เก่าที่ส่งซ้ำ (หลังมีเหตุการณ์ใหม่กว่า) ไม่เปลี่ยนสถานะ', () => {
  const old = Object.assign(K.ev('JOIN', 'D80'), { at: 1 });
  K.sync([], [old]);
  assert.strictEqual(mem('D80', 'TC21-02').state, 'SUBMITTED');
});

console.log('\nแก้ยอด (Control 8)');
test('ผู้ดูแลแก้ยอดโดยเห็นยอดรวมถูกต้อง → ไม่ติดธง', () => {
  const i = C.info('D80');
  const cur = i.others.items.find(x => x[0] === MAT1)[3] + 4;     // ของ ค เอง 4
  C.sync([C.scan('D80', BC1, MAT1, 10 - cur, { type: 'RECOUNT_SET', basis: cur, reason: 'แก้ยอด' })], [C.ev('EDIT', 'D80')]);
  assert.strictEqual(loc('D80').Flag, '');
  assert.strictEqual(C.info('D80').total, 10 + 4);    // MAT1 = 10, MAT2 = 4 (ข 2+1, ก 1)
});
test('แก้ยอดด้วยยอดที่เห็นไม่ตรงเซิร์ฟเวอร์ (มีเครื่องอื่นยิงระหว่างนั้น) → ต้องตรวจซ้ำ', () => {
  C.sync([C.scan('D80', BC2, MAT2, -1, { type: 'RECOUNT_SET', basis: 3, reason: 'แก้ยอด' })], [C.ev('EDIT', 'D80')]);
  assert.ok(/ต้องตรวจซ้ำ: ยอดเปลี่ยนระหว่างแก้/.test(loc('D80').Flag), loc('D80').Flag);
  assert.ok(env.sheets.Loc_Checks.data.some(r => r[4] === 'EDIT_CONFLICT'));
});
test('แอปรุ่นเก่าแก้ยอด (ไม่มี basis) ขณะมีหลายเครื่อง → ต้องตรวจซ้ำ', () => {
  const O = device('TC21-04', 'EMP-K', '2.1.1');
  O.sync([O.scan('B5', BC1, MAT1, 3)], [O.ev('OPEN', 'B5')]);
  K.sync([K.scan('B5', BC1, MAT1, 1)], [K.ev('JOIN', 'B5')]);
  O.sync([O.scan('B5', BC1, MAT1, -1, { type: 'RECOUNT_SET' })]);
  assert.ok(/แอปรุ่นเก่า/.test(loc('B5').Flag));
  // ผู้ช่วยแอปเก่ากด "ปิด" → ถือเป็นส่งงาน
  const r = K.sync([], [K.ev('CLOSE', 'B5')]);
  assert.strictEqual(r.events[0].state, 'SUBMITTED');
});

console.log('\nปิด / หลังปิด');
test('ผู้ดูแลปิดขณะผู้ช่วยยังไม่ส่งงาน (เช่น ปิดตอนออฟไลน์) → ปิดแล้ว + ต้องตรวจซ้ำ', () => {
  KH.sync([KH.scan('D80', BC2, MAT2, 1)], [KH.ev('JOIN', 'D80')]);
  unflag('D80');
  const r = C.sync([], [C.ev('CLOSE', 'D80', { total: 14 })]);
  assert.strictEqual(r.events[0].state, 'CLOSED');
  assert.strictEqual(loc('D80').Status, 'ปิดแล้ว');
  assert.ok(/ปิดขณะข้อมูลจากเครื่องอื่นยังไม่ครบ \(TC21-03\)/.test(loc('D80').Flag), loc('D80').Flag);
});
test('ผู้ดูแลเปิดแก้ไข → ทุกคนส่งงานครบ → ปิดด้วยยอดตรง → ธงเดิมยังอยู่ (v2.2.8: หายได้เฉพาะล้างนับใหม่/หัวหน้าทีมปิดธง)', () => {
  C.sync([], [C.ev('OPEN', 'D80')]);
  assert.strictEqual(loc('D80').Status, 'กำลังนับ');
  KH.sync([], [KH.ev('SUBMIT', 'D80')]);
  const before = loc('D80').Flag;
  const total = C.info('D80').total;
  C.sync([], [C.ev('CLOSE', 'D80', { total })]);
  assert.strictEqual(loc('D80').Flag, before, 'ปิดถูกต้องไม่เพิ่มธงใหม่ และไม่ลบธงเดิม');
  assert.strictEqual(loc('D80').Status_Detail, '3 เครื่อง · เครื่องอื่นส่งครบ 2/2');
});
test('ปิดด้วยยอดรวมที่ไม่ตรงเซิร์ฟเวอร์ → ต้องตรวจซ้ำ', () => {
  C.sync([], [C.ev('OPEN', 'D80')]);
  C.sync([], [C.ev('CLOSE', 'D80', { total: 999 })]);
  assert.ok(/ยอดตอนปิด 999/.test(loc('D80').Flag));
  const total = C.info('D80').total;
  C.sync([], [C.ev('OPEN', 'D80')]); C.sync([], [C.ev('CLOSE', 'D80', { total })]);
  assert.ok(/ยอดตอนปิด 999/.test(loc('D80').Flag), 'ปิดใหม่ด้วยยอดตรง ธงเดิมยังอยู่จนกว่าจะตรวจ');
  run('apiLocResolveFlag("D80", "ตรวจแล้ว ปิดใหม่ด้วยยอดตรง")');
  assert.strictEqual(loc('D80').Flag, '');
});
test('ผู้ช่วยออฟไลน์ส่งรายการเข้ามาหลังปิด → มีรายการหลังปิด — ตรวจซ้ำ', () => {
  K.sync([K.scan('D80', BC1, MAT1, 1)]);
  assert.ok(/มีรายการหลังปิด/.test(loc('D80').Flag));
  assert.strictEqual(loc('D80').Status, 'ปิดแล้ว');
});

console.log('\nพัก / หัวหน้าทีม');
test('ผู้ดูแลยิงป้ายที่อื่น → พัก (ยังเป็นผู้ดูแล) · กลับมา → กำลังนับ', () => {
  C.sync([C.scan('A50', BC1, MAT1, 1)], [C.ev('OPEN', 'A50')]);
  C.sync([], [C.ev('PAUSE', 'A50')]);
  assert.strictEqual(loc('A50').Status, 'พัก');
  assert.strictEqual(mem('A50', 'TC21-01').role, 'OWNER');
  C.sync([C.scan('A50', BC1, MAT1, 1)], [C.ev('OPEN', 'A50')]);
  assert.strictEqual(loc('A50').Status, 'กำลังนับ');
});
test('v2.7.0: ส่งงานแทนถูกลบ (ไม่มีผู้ช่วยแล้ว) · ALLOW_JOIN ไม่มีผล', () => {
  assert.strictEqual(run('typeof apiLocSubmitFor'), 'undefined');
  assert.strictEqual(run('typeof adminSubmitFor_'), 'undefined');
  assert.strictEqual(K.info('A30').allowJoin, undefined);
});
test('โอนการดูแล A30 จาก ก ให้ ข → ข เป็นผู้ดูแล ก เป็นผู้ช่วยที่ส่งงานแล้ว', () => {
  run('apiLocTransfer("A30", "TC21-03", "เครื่องเสีย")');
  assert.strictEqual(mem('A30', 'TC21-03').role, 'OWNER');
  assert.strictEqual(mem('A30', 'TC21-02').role, 'HELPER');
  assert.strictEqual(mem('A30', 'TC21-02').state, 'SUBMITTED');
  assert.strictEqual(KH.info('A30').me.role, 'OWNER');
  assert.ok(env.sheets.Loc_Checks.data.some(r => r[4] === 'TRANSFER'));
});
test('myLocs: รายการ Location ของเครื่องพร้อมบทบาท สถานะ ยอดรวม และชื่อทั้งรอบ', () => {
  const r = K.call('myLocs');
  const d80 = r.locs.find(x => x.location === 'D80');
  assert.strictEqual(d80.role, 'HELPER');
  assert.strictEqual(d80.devices, 3);
  assert.ok(/มีรายการหลังปิด/.test(d80.flag));
  assert.ok(['D80', 'A30', 'A50', 'B5'].every(n => r.names.includes(n)));
});

console.log('\nย้ายข้อมูลจากรุ่นก่อน');
test('ข้อมูลรอบที่นับด้วย v2.1.1 (ไม่มี Loc_Members) → Open_By เป็นผู้ดูแล เครื่องอื่นเป็นผู้ช่วยส่งงานแล้ว', () => {
  const e2 = createEnv();
  const r2 = (c, v) => e2.run(c, Object.assign({ _sap: sap, _pos: pos }, v || {}));
  r2('setupSheets()'); r2('apiOpenRound("2026Q4", "2026-11-04", "PILOT")');
  r2('apiSeedDevices(2, "TC21")');
  const log = e2.sheets.Count_Log;
  log.data.push(['TC21-01-000001', '2026Q4', 'TC21-01', '1', 'EMP-C', 'C1', BC1, MAT1, '3', 'SCAN'], ['TC21-02-000001', '2026Q4', 'TC21-02', '1', 'EMP-K', 'C1', BC1, MAT1, '2', 'SCAN']);
  const L = e2.sheets.Locations;
  const h = L.data[0];
  const row = h.map(c => ({ Location: 'C1', Status: 'ปิดแล้ว', Open_By: '', Devices: 'TC21-02,TC21-01' }[c] || ''));
  L.data.push(row);
  r2('migrateMembers_("2026Q4")');
  const m = r2('membersForAdmin_("2026Q4")');
  assert.strictEqual(m.find(x => x.device === 'TC21-02').role, 'OWNER');
  assert.strictEqual(m.find(x => x.device === 'TC21-02').state, 'CLOSED');
  assert.strictEqual(m.find(x => x.device === 'TC21-01').state, 'SUBMITTED');
  assert.strictEqual(e2.sheets.Count_Log.data.length, 3);
});

console.log('\nล็อก');
test('ทุกครั้งที่ปล่อยล็อก สั่ง flush ก่อน (กันเขียนทับแถวเมื่อหลายเครื่องส่งติดกัน)', () => {
  const t = env.lockTrace;
  const releases = t.map((x, i) => x === 'release' ? i : -1).filter(i => i >= 0);
  assert.ok(releases.length > 10, 'มีการใช้ล็อก ' + releases.length + ' ครั้ง');
  assert.ok(releases.every(i => t[i - 1] === 'flush'), 'มี release ที่ไม่ได้ flush ก่อน');
});

console.log('\nชุดทดสอบ (apiTestKit)');
test('สุ่มบาร์โค้ดจริงจาก Device_Master + เลขปลอมที่ไม่มีใน Master + บัตรผิด', () => {
  env.sheets.Staff.data.push(['EMP-OLD', 'นาย ปิด', 'ผู้ตรวจสอบ', 'N']);
  const before = JSON.stringify(env.sheets.Device_Master.data);
  const k = run('apiTestKit(20, 5)');
  const dm = env.sheets.Device_Master.data.slice(1).filter(r => r[0]);
  const have = new Set(dm.map(r => String(r[0])));
  assert.strictEqual(k.real.length, Math.min(20, dm.length));
  assert.strictEqual(new Set(k.real.map(x => x.code)).size, k.real.length, 'ไม่ซ้ำ');
  k.real.forEach(x => assert.ok(have.has(x.code), 'จริงต้องมีใน Master ' + x.code));
  assert.strictEqual(k.fake.length, 5);
  k.fake.forEach(c => {
    assert.ok(/^200\d{10}$/.test(c), c);
    assert.ok(!have.has(c));
    const s = c.slice(0, 12).split('').reduce((a, d, i) => a + Number(d) * (i % 2 ? 3 : 1), 0);
    assert.strictEqual(Number(c[12]), (10 - s % 10) % 10, 'check digit');
  });
  const codes = k.staff.map(x => x.code);
  assert.ok(codes.includes('EMP:FAKE01'));
  assert.ok(codes.includes('EMP:EMP-OLD'), 'พนักงานปิดใช้งาน');
  assert.ok(codes.includes('EMP:'));
  assert.ok(codes.some(c => !/^EMP:/.test(c)), 'บัตรไม่มี EMP:');
  assert.strictEqual(JSON.stringify(env.sheets.Device_Master.data), before, 'อ่านอย่างเดียว');
});
test('ทุกบัตรในชุดทดสอบถูกปฏิเสธตอน bootstrap (ไม่อยู่ในรายชื่อที่ส่งลงเครื่อง)', () => {
  const d = device('TC21-05', 'EMP-K');
  const boot = d.call('bootstrap');
  const ok = new Set(boot.staff.map(s => 'EMP:' + s.code));
  run('apiTestKit(3, 1)').staff.forEach(x => assert.ok(!ok.has(x.code), x.code));
});

console.log('\nสัญญาณเครื่อง / ยกเลิกการจับคู่ (v2.2.2)');
test('hello และ sync บันทึกเวลาติดต่อ + จำนวนค้างส่ง ให้หน้า Admin เห็น (ไม่เขียนชีต)', () => {
  const d = device('TC21-04', 'EMP-K');
  const before = env.sheets.Devices.data.map(r => r.join('|')).join('\n');
  assert.ok(d.call('hello', { pending: 7, location: 'H1' }).ok);
  assert.strictEqual(env.sheets.Devices.data.map(r => r.join('|')).join('\n'), before, 'hello ไม่เขียนชีต');
  let x = run('apiDevicesState()').devices.find(v => v.id === 'TC21-04');
  assert.strictEqual(x.hb.pending, 7); assert.strictEqual(x.hb.loc, 'H1');
  d.scan('H1', BC1, MAT1, 1);
  d.call('sync', { entries: d.entries.slice(-1), events: [], pendingAfter: 0, location: 'H1' });
  x = run('apiDevicesState()').devices.find(v => v.id === 'TC21-04');
  assert.strictEqual(x.hb.pending, 0);
});
test('ยกเลิกการจับคู่จากเครื่อง → Admin ขึ้นยังไม่จับคู่ + บันทึก Admin_Log + token เดิมใช้ไม่ได้', () => {
  const d = device('TC21-03', 'EMP-C');
  assert.ok(run('apiDevicesState()').devices.find(v => v.id === 'TC21-03').paired);
  assert.ok(d.call('unpair', { staff: 'EMP-C' }).ok);
  const x = run('apiDevicesState()').devices.find(v => v.id === 'TC21-03');
  assert.ok(!x.paired && x.active && !x.hb);
  assert.ok(env.sheets.Admin_Log.data.some(r => r[2] === 'DEVICE_UNPAIRED' && r[3] === 'TC21-03'));
  const r = d.call('hello', { pending: 0 });
  assert.strictEqual(r.error, 'BAD_TOKEN');
  const d2 = device('TC21-03', 'EMP-C');   // จับคู่ใหม่ได้ทันทีด้วยรหัสใหม่
  assert.ok(d2.call('hello', { pending: 0 }).ok);
});
test('เครื่องที่ถูกยกเลิกในหน้า Admin: hello ตอบ DEVICE_DISABLED ให้เครื่องรู้ภายใน 1 นาที', () => {
  const d = device('TC21-02', 'EMP-KH');
  run('apiSetDeviceActive("TC21-02", false)');
  assert.strictEqual(d.call('hello', { pending: 0 }).error, 'DEVICE_DISABLED');
  run('apiSetDeviceActive("TC21-02", true)');
});

console.log('\nยกเลิกเครื่อง / จับคู่ใหม่ระหว่างรอบ (v2.2.3)');
const T = (m) => '2026-11-04 1' + m;   // เวลา scanTime แบบง่าย
function setRevokeTimes(id, at, rep) {
  const t = env.sheets.Devices; const h = t.data[0];
  const r = t.data.find(x => x[0] === id);
  r[h.indexOf('Revoked_At')] = at; if (rep !== undefined) r[h.indexOf('Repaired_At')] = rep;
}
test('ยกเลิกต้องมีเหตุผล บันทึกเวลา/เหตุผล และ Admin_Log', () => {
  device('TC21-05', 'EMP-K');
  const st = run('apiSetDeviceActive("TC21-05", false, "TEMP", "ทดสอบ")');
  const x = st.devices.find(v => v.id === 'TC21-05');
  assert.ok(!x.active && !x.paired && x.revokedAt && x.revokeReason === 'TEMP' && !x.repairedAt);
  assert.ok(env.sheets.Admin_Log.data.some(r => r[2] === 'DEVICE_REVOKE' && /หยุดใช้ชั่วคราว/.test(r[4]) && /ทดสอบ/.test(r[4])));
});
test('เครื่องเดิมกลับมา (TEMP): จับคู่ใหม่ → Repaired_At + log ค้างส่ง · ของค้างส่งต่อได้ ไม่ติดธง', () => {
  run('apiSetDeviceActive("TC21-05", true)');
  const code = run('apiPairCode("TC21-05")').devices.find(x => x.id === 'TC21-05').pairCode;
  const r = env.post({ action: 'pair', deviceId: 'TC21-05', code, pendingCount: 2, pendingFrom: 11, pendingTo: 12, staff: 'EMP-K' });
  assert.ok(r.ok);
  const x = run('apiDevicesState()').devices.find(v => v.id === 'TC21-05');
  assert.ok(x.paired && x.repairedAt);
  const log = env.sheets.Admin_Log.data.filter(l => l[2] === 'DEVICE_REPAIRED' && l[3] === 'TC21-05').pop();
  assert.ok(log && /ค้างส่งในเครื่อง 2 รายการ \(Seq 11–12/.test(log[4]), log && log[4]);
});
test('เหตุผล LOST: รายการที่ยิงในช่วงยกเลิก → ต้องตรวจซ้ำ เฉพาะ Location นั้น · ก่อนยกเลิก/หลังจับคู่ใหม่ ไม่ติดธง', () => {
  const d = device('TC21-04', 'EMP-K');
  run('apiSetDeviceActive("TC21-04", false, "LOST")');
  setRevokeTimes('TC21-04', T('1:00:00'));
  run('apiSetDeviceActive("TC21-04", true)');
  const code = run('apiPairCode("TC21-04")').devices.find(x => x.id === 'TC21-04').pairCode;
  const tok = env.post({ action: 'pair', deviceId: 'TC21-04', code }).token;
  setRevokeTimes('TC21-04', T('1:00:00'), T('2:00:00'));
  const mk = (seq, loc, t) => ({ logId: 'TC21-04-' + String(seq).padStart(6, '0'), seq, projectId: '2026Q4', staff: 'EMP-K', location: loc, barcode: BC1,
    material: MAT1, qty: 1, type: 'SCAN', refId: '', reason: '', note: '', scanTime: t });
  const base = d.seq + 100;
  const res = env.post({ action: 'sync', deviceId: 'TC21-04', token: tok, appVersion: '2.2.3', events: [], entries: [
    mk(base + 1, 'R1', T('0:59:00')), mk(base + 2, 'R2', T('1:30:00')), mk(base + 3, 'R2', T('1:31:00')), mk(base + 4, 'R3', T('2:05:00'))] });
  assert.strictEqual(res.accepted.length, 4, JSON.stringify(res.rejected) + JSON.stringify(res.duplicate));
  const locs = run('apiDevicesState()').locations;
  const flag = l => String((locs.find(x => x.Location === l) || {}).Flag_Check || '');
  assert.ok(/หลังถูกยกเลิก/.test(flag('R2')), 'R2 ติดธง: ' + flag('R2'));
  assert.ok(/ตรวจซ้ำ/.test(String(locs.find(x => x.Location === 'R2').Flag)), 'คอลัมน์ธงในหน้า Admin');
  assert.ok(!/หลังถูกยกเลิก/.test(flag('R1')) && !/หลังถูกยกเลิก/.test(flag('R3')), 'R1/R3 ไม่ติดธง');
  assert.ok(env.sheets.Admin_Log.data.some(r => r[2] === 'REVOKED_DEVICE_DATA' && /2 รายการ/.test(r[4]) && /ต้องตรวจซ้ำ/.test(r[4])));
  assert.ok(env.sheets.Loc_Checks.data.some(r => r[4] === 'REVOKED_DATA' && r[3] === 'R2'));
});
test('เหตุผล TEMP: รายการในช่วงยกเลิก บันทึก log แต่ไม่ติดธง', () => {
  const d = device('TC21-02', 'EMP-KH');
  run('apiSetDeviceActive("TC21-02", false, "TEMP")'); setRevokeTimes('TC21-02', T('1:00:00'));
  run('apiSetDeviceActive("TC21-02", true)');
  const code = run('apiPairCode("TC21-02")').devices.find(x => x.id === 'TC21-02').pairCode;
  const tok = env.post({ action: 'pair', deviceId: 'TC21-02', code }).token;
  setRevokeTimes('TC21-02', T('1:00:00'), T('2:00:00'));
  const seq = d.seq + 100;
  env.post({ action: 'sync', deviceId: 'TC21-02', token: tok, appVersion: '2.2.3', events: [], entries: [{ logId: 'TC21-02-' + String(seq).padStart(6, '0'), seq,
    projectId: '2026Q4', staff: 'EMP-KH', location: 'R5', barcode: BC1, material: MAT1, qty: 1, type: 'SCAN', refId: '', reason: '', note: '', scanTime: T('1:10:00') }] });
  const l = run('apiDevicesState()').locations.find(x => x.Location === 'R5') || {};
  assert.ok(!/หลังถูกยกเลิก/.test(String(l.Flag_Check || '')));
  assert.ok(env.sheets.Admin_Log.data.some(r => r[2] === 'REVOKED_DEVICE_DATA' && r[3] === 'TC21-02' && !/ต้องตรวจซ้ำ/.test(r[4])));
});

console.log('\nเวลาตอบ / ส่งซ้ำ (v2.2.6)');
test('ทุกคำตอบมีเวลาทำงานที่เซิร์ฟเวอร์ (ms) · sync มีเวลารอคิวและถือล็อก', () => {
  const d = device('TC21-05', 'EMP-K'); d.seq = 900;
  const h = d.call('hello', { pending: 0 });
  assert.ok(typeof h.ms === 'number' && h.ms >= 0);
  d.scan('P1', BC1, MAT1, 1);
  const r = d.call('sync', { entries: d.entries.slice(-1), events: [] });
  assert.ok(typeof r.lockWait === 'number' && typeof r.lockHold === 'number' && typeof r.ms === 'number');
});
test('hello ส่งสรุปเวลาตอบ → หน้า Admin เห็น (และ sync ไม่ลบทิ้ง)', () => {
  const d = device('TC21-04', 'EMP-K'); d.seq = 900;
  d.call('hello', { pending: 2, perf: { sync: { n: 10, avg: 1800, max: 6200, srv: 900, wait: 300, hold: 500, to: 1, err: 0 }, locInfo: { n: 5, avg: 2100, max: 9000, to: 2 }, junk: { n: 1 } } });
  d.scan('P2', BC1, MAT1, 1);
  d.call('sync', { entries: d.entries.slice(-1), events: [], pendingAfter: 0 });
  const x = run('apiDevicesState()').devices.find(v => v.id === 'TC21-04');
  assert.strictEqual(x.hb.perf.sync.max, 6200); assert.strictEqual(x.hb.perf.locInfo.to, 2); assert.ok(!x.hb.perf.junk);
  assert.strictEqual(x.hb.pending, 0);
});
test('เครื่องหมดเวลารอแล้วส่งเหตุการณ์เดิมซ้ำ → ตอบผลเดิม ไม่บันทึก Loc_Checks ซ้ำ', () => {
  const d = device('TC21-02', 'EMP-KH'); d.seq = 900;
  d.scan('P3', BC1, MAT1, 2);
  const ev = { id: 'ev-dup-1', type: 'CLOSE', projectId: '2026Q4', location: 'P3', staff: 'EMP-KH', lines: 1, qty: 2, fromSeq: d.seq, upToSeq: d.seq, total: 2, at: Date.now() };
  const r1 = d.call('sync', { entries: d.entries.slice(-1), events: [ev] });
  const n1 = env.sheets.Loc_Checks.data.length;
  const r2 = d.call('sync', { entries: d.entries.slice(-1), events: [ev] });
  assert.strictEqual(env.sheets.Loc_Checks.data.length, n1, 'ไม่มีแถวเพิ่ม');
  assert.deepStrictEqual(r2.events[0], r1.events[0]);
  assert.strictEqual(r1.events[0].match, 'OK');
});

test('v2.7.4 ปิดอัตโนมัติ (ยิงป้ายถัดไป) → Loc_Checks มีหมายเหตุ "ปิดอัตโนมัติ" · ไม่ส่งคำเตือนกลับเครื่อง', () => {
  const d = device('TC21-02', 'EMP-KH'); d.seq = 940; d.at = 7400;
  const e = d.scan('P4', BC1, MAT1, 3);
  d.sync([e], [d.ev('OPEN', 'P4')]);
  const r = d.sync([], [d.ev('CLOSE', 'P4', { total: 3, auto: true })]);
  const ec = r.events.find(x => x.type === 'CLOSE') || r.events[r.events.length - 1];
  assert.strictEqual(ec.match, 'OK'); assert.ok(!ec.note, 'ไม่มี note กลับเครื่อง: ' + ec.note);
  const lc = env.sheets.Loc_Checks.data, last = lc[lc.length - 1];
  assert.ok(last.includes('P4') && last.some(c => String(c).indexOf('ปิดอัตโนมัติ') === 0), JSON.stringify(last));
  const r2 = d.sync([], [d.ev('OPEN', 'P4'), d.ev('CLOSE', 'P4', { total: 3 })]);
  const lc2 = env.sheets.Loc_Checks.data; assert.ok(!lc2[lc2.length - 1].some(c => String(c).indexOf('ปิดอัตโนมัติ') >= 0), 'ปิดเองไม่มีหมายเหตุ');
  assert.ok(r2.ok);
});

console.log('\nโอนการดูแล / hello บอกจำนวนเครื่อง (v2.2.7)');
test('hello บอกจำนวนเครื่องใน Location ที่อยู่', () => {
  const a = device('TC21-05', 'EMP-K'); a.seq = 950;
  const b = device('TC21-04', 'EMP-K'); b.seq = 950;
  a.sync([a.scan('Q1', BC1, MAT1, 1)], [a.ev('OPEN', 'Q1')]);
  assert.strictEqual(a.call('hello', { pending: 0, location: 'Q1' }).members, 1);
  b.sync([b.scan('Q1', BC1, MAT1, 1)], [b.ev('JOIN', 'Q1')]);
  assert.strictEqual(a.call('hello', { pending: 0, location: 'Q1' }).members, 2);
  assert.strictEqual(a.call('hello', { pending: 0 }).members, undefined);
});
test('โอนการดูแล: ต้องเป็นเครื่องที่เปิดใช้ + จับคู่แล้ว + มีเหตุผล', () => {
  assert.throws(() => run('apiLocTransfer("Q1", "TC21-99", "x")'), /ไม่พบเครื่อง/);
  run('apiSeedDevices(7, "TC21")');
  assert.throws(() => run('apiLocTransfer("Q1", "TC21-07", "x")'), /ยังไม่จับคู่/);
  run('apiSetDeviceActive("TC21-04", false, "TEMP")');
  assert.throws(() => run('apiLocTransfer("Q1", "TC21-04", "x")'), /ถูกยกเลิก/);
  run('apiSetDeviceActive("TC21-04", true)');
  device('TC21-04', 'EMP-K');
  assert.throws(() => run('apiLocTransfer("Q1", "TC21-04", "  ")'), /เหตุผล/);
  run('apiLocTransfer("Q1", "TC21-04", "เครื่องผู้ดูแลเสีย")');
  assert.strictEqual(mem('Q1', 'TC21-04').role, 'OWNER');
});

console.log('\nธงต้องตรวจซ้ำ: ปิดไม่ลบ · ล้างนับใหม่ / หัวหน้าทีมปิดธง (v2.2.8)');
{
  const A = device('TC21-05', 'EMP-K'); A.seq = 1200;
  const B = device('TC21-04', 'EMP-KH'); B.seq = 1200;
  test('แก้ชนกัน → ธง + เครื่องผู้แก้ได้ flags ในคำตอบ', () => {
    A.sync([A.scan('V1', BC1, MAT1, 1), A.scan('V1', BC1, MAT1, 1)], [A.ev('OPEN', 'V1')]);
    B.sync([B.scan('V1', BC1, MAT1, 1)], [B.ev('JOIN', 'V1')]);
    B.sync([], [B.ev('SUBMIT', 'V1')]);
    const r = A.sync([A.scan('V1', BC1, MAT1, -1, { type: 'RECOUNT_SET', basis: 2, reason: 'แก้ยอด' })], [A.ev('EDIT', 'V1')]);
    assert.ok(r.flags && r.flags[0].location === 'V1' && /เห็น 2 เซิร์ฟเวอร์ 3/.test(r.flags[0].note), JSON.stringify(r.flags));
    assert.ok(/ต้องตรวจซ้ำ/.test(loc('V1').Flag));
  });
  test('ปิด Location ไม่ลบธงเดิม · คำตอบ CLOSE มี note เตือน', () => {
    const r = A.sync([], [A.ev('CLOSE', 'V1', { total: 2 })]);
    assert.ok(/ยอดเปลี่ยนระหว่างแก้/.test(loc('V1').Flag), 'ธงยังอยู่: ' + loc('V1').Flag);
    assert.ok(/ยอดเปลี่ยนระหว่างแก้/.test(r.events[0].note || ''), JSON.stringify(r.events[0]));
    assert.strictEqual(loc('V1').Status, 'ปิดแล้ว');
  });
  test('หัวหน้าทีมปิดธง: ต้องมีเหตุผล · ธงหาย · บันทึก Loc_Checks + Admin_Log', () => {
    assert.throws(() => run('apiLocResolveFlag("V1", "  ")'), /เหตุผล/);
    run('apiLocResolveFlag("V1", "นับมือซ้ำแล้ว ได้ 2 ตรงกับระบบ")');
    assert.ok(!/ยอดเปลี่ยนระหว่างแก้/.test(loc('V1').Flag || ''), loc('V1').Flag);
    assert.ok(env.sheets.Loc_Checks.data.some(r => r[3] === 'V1' && r[4] === 'FLAG_RESOLVE' && /นับมือซ้ำแล้ว/.test(r[12])));
    assert.ok(env.sheets.Admin_Log.data.some(r => r[2] === 'LOC_FLAG_RESOLVE' && r[3] === 'V1'));
    assert.throws(() => run('apiLocResolveFlag("V1", "x")'), /ไม่มีธง/);
  });
  test('ล้าง Location นับใหม่ (EDIT clear) → ธงเดิมหาย · ธงใหม่ในชุดเดียวกันยังอยู่', () => {
    A.sync([A.scan('V2', BC1, MAT1, 3)], [A.ev('OPEN', 'V2')]);
    A.sync([A.scan('V2', BC1, MAT1, -1, { type: 'RECOUNT_SET', basis: 9, reason: 'แก้ยอด' })], [A.ev('EDIT', 'V2')]);
    assert.ok(/ต้องตรวจซ้ำ/.test(loc('V2').Flag));
    A.sync([A.scan('V2', BC1, MAT1, -2, { type: 'RECOUNT_SET', basis: 2, reason: 'ล้าง Location นับใหม่ (เดิม 2)' })], [A.ev('EDIT', 'V2', { clear: true })]);
    assert.strictEqual(loc('V2').Flag || '', '', 'ธงหลังล้างนับใหม่: ' + loc('V2').Flag);
    assert.ok(env.sheets.Admin_Log.data.some(r => r[2] === 'LOC_FLAG_CLEARED' && r[3] === 'V2'));
    // ล้างอีกครั้งโดยเห็นยอดผิด → ธงใหม่ต้องอยู่ (ไม่ถูกล้างในชุดเดียวกัน)
    A.sync([A.scan('V2', BC1, MAT1, 4)], []);
    A.sync([A.scan('V2', BC1, MAT1, -3, { type: 'RECOUNT_SET', basis: 3, reason: 'ล้าง Location นับใหม่ (เดิม 3)' })], [A.ev('EDIT', 'V2', { clear: true })]);
    assert.ok(/เห็น 3 เซิร์ฟเวอร์ 4/.test(loc('V2').Flag), loc('V2').Flag);
  });
}

console.log('\nผู้ช่วยแก้ยอดของตัวเอง (v2.3.1)');
{
  const O = device('TC21-01', 'EMP-K', '2.3.1'), H = device('TC21-02', 'EMP-KH', '2.3.1'), H2 = device('TC21-03', 'EMP-C', '2.3.1');
  [O, H, H2].forEach(d => { d.seq = 3000 + d.seq; d.at = 5000; });
  const flagOf = l => (loc(l).Flag_Check || '');
  test('ผู้ช่วยแก้ยอดของตัวเองจาก basis ที่ตรง → ไม่ติดธง · ยอดรวมเปลี่ยนเฉพาะส่วนของผู้ช่วย · Edits +1 แต่ผลตรวจ Location ไม่เปลี่ยน', () => {
    O.sync([O.scan('W1', BC1, MAT1, 1), O.scan('W1', BC1, MAT1, 1), O.scan('W1', BC1, MAT1, 1)], [O.ev('OPEN', 'W1')]);
    H.sync([1, 2, 3, 4, 5, 6, 7].map(() => H.scan('W1', BC1, MAT1, 1)), [H.ev('JOIN', 'W1')]);
    unflag('W1');
    const before = loc('W1');
    const r = H.sync([H.scan('W1', BC1, MAT1, -2, { type: 'SELF_SET', basis: 7, reason: 'ผู้ช่วยแก้ยอดของตัวเอง 7 → 5' })], [H.ev('EDIT', 'W1', { mine: true })]);
    assert.ok(!r.flags, JSON.stringify(r.flags));
    assert.strictEqual(flagOf('W1'), '');
    const st = run('apiDevicesState()');
    assert.strictEqual(st.locTotals.W1.qty, 8);
    assert.strictEqual(st.locTotals.W1.dev['TC21-02'].qty, 5);
    assert.strictEqual(Number(loc('W1').Edits), (Number(before.Edits) || 0) + 1);
    assert.strictEqual(loc('W1').Last_Check, before.Last_Check);
    assert.ok(env.sheets.Loc_Checks.data.slice(-1)[0].join(' ').includes('ผู้ช่วยแก้ยอดของตัวเอง'));
  });
  test('ผู้ช่วยแก้จาก basis ที่ไม่ตรงกับยอดของตัวเองบนเซิร์ฟเวอร์ → ติดธงต้องตรวจซ้ำ', () => {
    const r = H.sync([H.scan('W1', BC1, MAT1, -1, { type: 'SELF_SET', basis: 9, reason: 'ผู้ช่วยแก้ยอดของตัวเอง' })], [H.ev('EDIT', 'W1', { mine: true })]);
    assert.ok(r.flags && /จากยอดของตัวเองที่ไม่ตรง: เห็น 9 เซิร์ฟเวอร์ 5/.test(r.flags[0].note), JSON.stringify(r.flags));
    run('apiLocResolveFlag("W1", "ทดสอบ")');
  });
  test('ผู้ช่วย 2 เครื่องแก้ SKU เดียวกันพร้อมกัน → ไม่ชนกัน (ต่างคนแก้ส่วนของตัวเอง)', () => {
    H2.sync([H2.scan('W1', BC1, MAT1, 1), H2.scan('W1', BC1, MAT1, 1)], [H2.ev('JOIN', 'W1')]);
    const r1 = H.sync([H.scan('W1', BC1, MAT1, -1, { type: 'SELF_SET', basis: 4, reason: 'แก้' })]);
    const r2 = H2.sync([H2.scan('W1', BC1, MAT1, -1, { type: 'SELF_SET', basis: 2, reason: 'แก้' })]);
    assert.ok(!r1.flags && !r2.flags, JSON.stringify([r1.flags, r2.flags]));
  });
  test('locInfo บอกเครื่องอื่นว่าใครแก้ SKU ล่าสุด (ใช้เตือนก่อนแก้)', () => {
    const i = O.info('W1');
    assert.strictEqual(i.edits[MAT1].by, 'TC21-03');
    assert.strictEqual(i.edits[MAT1].cp || 0, 0);
  });
  test('ผู้ดูแลแก้ยอดรวม → จุดตัดยอด (v2.3.5): cp ของผู้ช่วย = Seq ล่าสุด · ยอดของฉันเริ่มที่ 0 · ยิงเพิ่มแล้วแก้ส่วนที่ยิงเพิ่มได้ไม่ติดธง', () => {
    const tot = run('apiDevicesState()').locTotals.W1.qty;
    O.sync([O.scan('W1', BC1, MAT1, -1, { type: 'RECOUNT_SET', basis: tot, reason: 'แก้ยอด Location' })], [O.ev('EDIT', 'W1')]);
    assert.strictEqual(H.info('W1').edits[MAT1].cp, H.seq);
    H.sync([H.scan('W1', BC1, MAT1, 1), H.scan('W1', BC1, MAT1, 1)]);
    const r = H.sync([H.scan('W1', BC1, MAT1, -1, { type: 'SELF_SET', basis: 2, reason: 'แก้ส่วนที่ยิงเพิ่ม 2 → 1' })]);
    assert.ok(!r.flags, JSON.stringify(r.flags));
  });
  test('จุดตัดยอด: ผู้ช่วยแก้จากยอดก่อนจุดตัด (เช่นออฟไลน์ ไม่รู้ว่าผู้ดูแลแก้ยอดรวมแล้ว) → ติดธงยอดไม่ตรง (กันแก้ซ้ำสองชั้น)', () => {
    const r = H.sync([H.scan('W1', BC1, MAT1, -2, { type: 'SELF_SET', basis: 6, reason: 'แก้' })]);
    assert.ok(r.flags && /จากยอดของตัวเองที่ไม่ตรง: เห็น 6 เซิร์ฟเวอร์ 1/.test(r.flags[0].note), JSON.stringify(r.flags));
    run('apiLocResolveFlag("W1", "ทดสอบ")');
  });
  test('ผู้ดูแลล้าง Location นับใหม่ → ยอดของฉันของผู้ช่วยเริ่มใหม่ (clr = Seq ตอนล้าง) · จุดตัดยอดเดิมหาย · แก้จากยอดใหม่ได้ไม่ติดธง', () => {
    const items = run('apiDevicesState()').locTotals.W1;
    O.sync([O.scan('W1', BC1, MAT1, -items.qty, { type: 'RECOUNT_SET', basis: items.qty, reason: 'ล้าง Location นับใหม่ (เดิม ' + items.qty + ')' })], [O.ev('EDIT', 'W1', { clear: true })]);
    const i = H.info('W1');
    assert.strictEqual(i.clr, H.seq, 'clr = Seq ล่าสุดของผู้ช่วยตอนล้าง');
    assert.strictEqual((i.edits[MAT1] || {}).cp || 0, 0);
    H.sync([H.scan('W1', BC1, MAT1, 1), H.scan('W1', BC1, MAT1, 1), H.scan('W1', BC1, MAT1, 1)]);
    const r = H.sync([H.scan('W1', BC1, MAT1, -1, { type: 'SELF_SET', basis: 3, reason: 'แก้' })]);
    assert.ok(!r.flags, JSON.stringify(r.flags));
    assert.strictEqual(run('apiDevicesState()').locTotals.W1.qty, 2);
  });
  test('ผู้ช่วยแก้จนยอดของตัวเองติดลบ → ติดธง', () => {
    const r = H.sync([H.scan('W1', BC1, MAT1, -5, { type: 'SELF_SET', basis: 2, reason: 'แก้' })]);
    assert.ok(r.flags && /ติดลบ/.test(r.flags[0].note), JSON.stringify(r.flags));
    run('apiLocResolveFlag("W1", "ทดสอบ")');
  });
}

console.log('\nนับช่วยกัน: ทุกคนจัดการเฉพาะยอดของตัวเอง (v2.3.2)');
{
  const O = device('TC21-01', 'EMP-K', '2.3.2'), H = device('TC21-02', 'EMP-KH', '2.3.2');
  [O, H].forEach(d => { d.seq = 4000 + d.seq; d.at = 7000; });
  test('ผู้ดูแลแก้ยอดของตัวเองระหว่างผู้ช่วยยังนับ → ไม่ติดธง · ไม่เปลี่ยนผลตรวจ Location · Loc_Checks "ผู้ดูแลแก้ยอดของตัวเอง"', () => {
    O.sync([O.scan('W5', BC1, MAT1, 1), O.scan('W5', BC1, MAT1, 1), O.scan('W5', BC1, MAT1, 1)], [O.ev('OPEN', 'W5')]);
    H.sync([H.scan('W5', BC1, MAT1, 1), H.scan('W5', BC1, MAT1, 1)], [H.ev('JOIN', 'W5')]);
    const before = loc('W5');
    const r = O.sync([O.scan('W5', BC1, MAT1, -1, { type: 'SELF_SET', basis: 3, reason: 'ผู้ดูแลแก้ยอดของตัวเอง 3 → 2' })], [O.ev('EDIT', 'W5', { mine: true })]);
    assert.ok(!r.flags, JSON.stringify(r.flags));
    assert.strictEqual(loc('W5').Last_Check, before.Last_Check);
    assert.ok(env.sheets.Loc_Checks.data.slice(-1)[0].join(' ').includes('ผู้ดูแลแก้ยอดของตัวเอง'));
    assert.strictEqual(run('apiDevicesState()').locTotals.W5.qty, 4);
  });
  test('ผู้ดูแลแก้ยอดรวมตอนนับคนเดียว → ไม่ครอบคลุมใคร: ผู้ช่วยที่มาทีหลังแก้ยอดของตัวเองใน SKU นั้นได้', () => {
    O.sync([O.scan('W6', BC2, MAT2, 1), O.scan('W6', BC2, MAT2, 1)], [O.ev('OPEN', 'W6')]);
    O.sync([O.scan('W6', BC2, MAT2, 3, { type: 'RECOUNT_SET', basis: 2, reason: 'แก้ยอด Location 2 → 5' })], [O.ev('EDIT', 'W6')]);
    H.sync([H.scan('W6', BC2, MAT2, 1), H.scan('W6', BC2, MAT2, 1)], [H.ev('JOIN', 'W6')]);
    assert.strictEqual((H.info('W6').edits[MAT2] || {}).cp || 0, 0);
    const r = H.sync([H.scan('W6', BC2, MAT2, -1, { type: 'SELF_SET', basis: 2, reason: 'แก้' })]);
    assert.ok(!r.flags, JSON.stringify(r.flags));
    // ผู้ดูแลเองก็แก้ยอดของตัวเองต่อได้ (ยอดรวมตอนนั้น = ของตัวเอง)
    const r2 = O.sync([O.scan('W6', BC2, MAT2, -1, { type: 'SELF_SET', basis: 5, reason: 'แก้' })], [O.ev('EDIT', 'W6', { mine: true })]);
    assert.ok(!r2.flags, JSON.stringify(r2.flags));
  });
  test('ผู้ดูแลแก้ยอดรวมขณะมีผู้ช่วยร่วมยอด → ตัดยอดทั้งคู่ (รวมผู้แก้): แก้จากยอดก่อนจุดตัด → ติดธง', () => {
    H.sync([], [H.ev('SUBMIT', 'W6')]);
    const tot = run('apiDevicesState()').locTotals.W6.qty;
    O.sync([O.scan('W6', BC2, MAT2, -1, { type: 'RECOUNT_SET', basis: tot, reason: 'แก้ยอดรวม Location · เหตุผล: นับซ้ำ' })], [O.ev('EDIT', 'W6')]);
    assert.strictEqual(H.info('W6').edits[MAT2].cp, H.seq);
    assert.strictEqual(O.info('W6').edits[MAT2].cp, O.seq, 'จุดตัดของผู้แก้ = Seq ของแถวแก้ยอดรวม');
    const r = O.sync([O.scan('W6', BC2, MAT2, -1, { type: 'SELF_SET', basis: 3, reason: 'แก้' })], [O.ev('EDIT', 'W6', { mine: true })]);
    assert.ok(r.flags && /TC21-01 แก้ .* จากยอดของตัวเองที่ไม่ตรง: เห็น 3 เซิร์ฟเวอร์ 0/.test(r.flags[0].note), JSON.stringify(r.flags));
    run('apiLocResolveFlag("W6", "ทดสอบ")');
  });
  test('G4-8: ผู้ช่วยกลับมายิงเพิ่มหลังผู้ดูแลแก้ยอดรวม → แก้เฉพาะส่วนที่ยิงเพิ่มได้ · ยอดรวมถูก', () => {
    const before = run('apiDevicesState()').locTotals.W6.qty;
    H.sync([H.scan('W6', BC2, MAT2, 1), H.scan('W6', BC2, MAT2, 1), H.scan('W6', BC2, MAT2, 1)], [H.ev('JOIN', 'W6')]);
    const r = H.sync([H.scan('W6', BC2, MAT2, -1, { type: 'SELF_SET', basis: 3, reason: 'ยิงเพิ่มเกิน 3 → 2' })], [H.ev('EDIT', 'W6', { mine: true })]);
    assert.ok(!r.flags, JSON.stringify(r.flags));
    assert.strictEqual(run('apiDevicesState()').locTotals.W6.qty, before + 2);
  });
}

test('หน้า Admin: ยอดเซิร์ฟเวอร์ต่อ Location/เครื่อง ตรงกับชีต + ผลตรวจล่าสุดมีตัวเลขเครื่อง vs เซิร์ฟเวอร์ (v2.3.1)', () => {
  const st = run('apiDevicesState()');
  const rows = env.sheets.Count_Log.data.slice(1).filter(r => r[1] === st.projectId);
  const names = Object.keys(st.locTotals);
  assert.ok(names.length > 0);
  names.forEach(l => {
    const mine = rows.filter(r => r[5] === l);
    const q = Math.round(mine.reduce((a, r) => a + Number(r[8]), 0) * 1000) / 1000;
    assert.strictEqual(st.locTotals[l].qty, q, l);
    assert.strictEqual(st.locTotals[l].lines, mine.length, l);
    Object.keys(st.locTotals[l].dev).forEach(d => assert.strictEqual(st.locTotals[l].dev[d].lines, mine.filter(r => r[2] === d).length, l + ' ' + d));
  });
  const c = Object.values(st.locChecks)[0];
  assert.ok(c && c.devLines !== undefined && c.srvLines !== undefined && c.match, JSON.stringify(c));
});

console.log('\nv2.7.0: 1 Location = 1 เครื่อง · ปล่อยคืนเมื่อยิงป้ายผิด · โอนการดูแลแล้วเครื่องเดิมส่งค้างมาทีหลัง');
{
  const O = device('TC21-01', 'EMP-K', '2.7.0'), H = device('TC21-02', 'EMP-KH', '2.7.0'), N = device('TC21-04', 'EMP-C', '2.7.0');
  [O, H, N].forEach(d => { d.seq = 6500 + d.seq; d.at = 9200; });
  const members = l => run('apiDevicesState()').members.filter(m => m.location === l);
  const hasLoc = l => run('apiDevicesState()').locations.some(x => x.Location === l);
  test('ยิงป้ายผิดแล้วออก (PAUSE ทั้งที่ยังไม่ได้ยิงสินค้า) → ปล่อยคืน: ไม่มีผู้ดูแล ไม่มีแถว Location · เครื่องอื่นเปิดได้เป็นผู้ดูแล', () => {
    O.sync([], [O.ev('OPEN', 'X71')]);
    assert.strictEqual(members('X71').length, 1);
    const r = O.sync([], [O.ev('PAUSE', 'X71')]);
    assert.strictEqual(r.events[0].state, 'RELEASED');
    assert.strictEqual(members('X71').length, 0);
    assert.ok(!hasLoc('X71'), 'ลบแถว Location แล้ว (ไม่ค้างเป็น "พัก" ใน K1)');
    assert.ok(env.sheets.Loc_Checks.data.some(x => x[3] === 'X71' && x[4] === 'RELEASE'));
    assert.ok(env.sheets.Admin_Log.data.some(x => x.indexOf('LOC_RELEASE') >= 0));
    assert.strictEqual(H.info('X71').owner, null);
    const b = H.sync([H.scan('X71', BC1, MAT1, 1)], [H.ev('OPEN', 'X71')]);
    assert.strictEqual(b.events[0].role, 'OWNER');
    assert.strictEqual(loc('X71').Flag, '', 'ไม่ใช่นับซ้อน');
  });
  test('มีรายการแล้ว (แม้ยกเลิกจนเหลือ 0 ชิ้น) → ไม่ปล่อย ยังเป็นพัก', () => {
    O.sync([O.scan('X72', BC1, MAT1, 1), O.scan('X72', BC1, MAT1, -1, { type: 'VOID' })], [O.ev('OPEN', 'X72')]);
    const r = O.sync([], [O.ev('PAUSE', 'X72')]);
    assert.strictEqual(r.events[0].state, 'PAUSED');
    assert.strictEqual(loc('X72').Status, 'พัก');
  });
  test('เครื่องยังมีรายการค้างส่ง (เครื่องบอก lines > 0) → ไม่ปล่อย', () => {
    O.sync([], [O.ev('OPEN', 'X73')]);
    O.scan('X73', BC1, MAT1, 1);   // ยิงแล้วแต่ยังไม่ส่ง
    const r = O.sync([], [O.ev('PAUSE', 'X73')]);
    assert.notStrictEqual(r.events[0].state, 'RELEASED');
    assert.strictEqual(members('X73').length, 1);
  });
  test('เปิดซ้อนตอนออฟไลน์ → รับข้อมูลไว้ + ธง · เครื่องซ้อนออก (SUBMIT) → ผู้ดูแลปิดได้ ธงยังอยู่จนหัวหน้าทีมตัดสิน', () => {
    O.sync([O.scan('X74', BC1, MAT1, 2)], [O.ev('OPEN', 'X74')]);
    const r = H.sync([H.scan('X74', BC1, MAT1, 1)], [H.ev('OPEN', 'X74')]);
    assert.strictEqual(r.events[0].role, 'HELPER');
    assert.ok(/นับซ้อน: TC21-02/.test(loc('X74').Flag));
    H.sync([], [H.ev('SUBMIT', 'X74', { auto: true })]);
    assert.strictEqual(mem('X74', 'TC21-02').state, 'SUBMITTED');
    const c = O.sync([], [O.ev('CLOSE', 'X74', { total: 3 })]);
    assert.strictEqual(c.events[0].state, 'CLOSED');
    assert.ok(/นับซ้อน/.test(loc('X74').Flag), 'ปิดไม่ลบธง');
    assert.strictEqual(run('apiDevicesState()').locTotals.X74.qty, 3, 'ข้อมูลทั้งสองเครื่องไม่หาย');
  });
  test('โอนการดูแล → เครื่องเดิมส่งรายการค้างมาทีหลัง: รับไว้ · เครื่องเดิมกลับเป็น "กำลังนับ" · ผู้ดูแลใหม่ปิด → ธง "ปิดขณะข้อมูลจากเครื่องอื่นยังไม่ครบ"', () => {
    O.sync([O.scan('X75', BC1, MAT1, 1)], [O.ev('OPEN', 'X75')]);
    const late = O.scan('X75', BC1, MAT1, 1);   // ค้างในเครื่องเดิม (เครื่องเสีย)
    N.call('hello', {});
    run('apiLocTransfer("X75", "TC21-04", "เครื่องเสีย")');
    assert.strictEqual(mem('X75', 'TC21-04').role, 'OWNER');
    assert.strictEqual(mem('X75', 'TC21-01').state, 'SUBMITTED');
    O.sync([late]);   // เครื่องเดิมกลับมาส่ง
    assert.strictEqual(mem('X75', 'TC21-01').state, 'COUNTING', 'มีรายการหลังโอน');
    assert.strictEqual(run('apiDevicesState()').locTotals.X75.qty, 2, 'รายการที่มาทีหลังเข้ายอด');
    N.at = Date.now() + 60000;   // แอปจริงใช้เวลาเครื่อง (ms) — ใหม่กว่าเวลาโอน
    N.sync([N.scan('X75', BC1, MAT1, 1)], [N.ev('OPEN', 'X75')]);
    const cr = N.sync([], [N.ev('CLOSE', 'X75', { total: 3 })]);
    assert.ok(/ปิดขณะข้อมูลจากเครื่องอื่นยังไม่ครบ \(TC21-01\)/.test(loc('X75').Flag), JSON.stringify(cr.events) + JSON.stringify(members('X75')));
  });
  test('UAT 19: เปิดซ้อนตอนออฟไลน์ที่ Location ที่ปิดแล้ว → ธง · ผู้ดูแลเปิดนับเพิ่ม → ล้างนับใหม่ → นับใหม่ → ปิด → ไม่มีธง ยอด = ที่นับใหม่', () => {
    O.at = Date.now() + 200000; H.at = Date.now() + 200000;
    O.sync([O.scan('X76', BC2, MAT2, 4)], [O.ev('OPEN', 'X76')]);
    O.sync([], [O.ev('CLOSE', 'X76', { total: 4 })]);
    assert.strictEqual(loc('X76').Flag, '');
    const r = H.sync([H.scan('X76', BC2, MAT2, 1)], [H.ev('OPEN', 'X76')]);
    assert.strictEqual(r.events[0].role, 'HELPER');
    assert.ok(/นับซ้อน: TC21-02/.test(loc('X76').Flag) && /หลังปิด/.test(loc('X76').Flag), loc('X76').Flag);
    H.sync([], [H.ev('SUBMIT', 'X76', { auto: true })]);
    O.sync([], [O.ev('OPEN', 'X76')]);
    O.sync([O.scan('X76', BC2, MAT2, -5, { type: 'RECOUNT_SET', basis: 5, reason: 'ล้าง Location นับใหม่ (เดิม 5) · เหตุผล: นับซ้อน' })], [O.ev('EDIT', 'X76', { clear: true })]);
    O.sync([O.scan('X76', BC2, MAT2, 4)]);
    O.sync([], [O.ev('CLOSE', 'X76', { total: 4 })]);
    assert.strictEqual(loc('X76').Status, 'ปิดแล้ว');
    assert.strictEqual(loc('X76').Flag, '', 'ธงหายหมด: ' + loc('X76').Flag);
    assert.strictEqual(run('apiDevicesState()').locTotals.X76.qty, 4);
  });
  test('เครื่องที่ถูกโอนออกเปิดซ้ำตอนออฟไลน์ → ติดธงนับซ้อน (ระบุว่าถูกโอนออก)', () => {
    run('apiLocResolveFlag("X75", "ตรวจแล้ว")');
    O.at = Date.now() + 120000;   // แอปจริงใช้เวลาเครื่อง (ms)
    O.sync([O.scan('X75', BC1, MAT1, 1)], [O.ev('OPEN', 'X75')]);
    assert.ok(/นับซ้อน: TC21-01 .*ถูกโอนออก/.test(loc('X75').Flag), loc('X75').Flag);
  });
  test('v2.7.1 โอนไปเครื่องที่ยังไม่เคยเปิด Location นี้ → ผู้ดูแลใหม่ได้ชื่อพนักงานล่าสุดของเครื่องนั้น · เครื่องที่เปิดซ้อนเห็นชื่อ (ไม่ใช่ "TC21-04 (TC21-04)")', () => {
    N.at = Date.now() + 300000; O.at = Date.now() + 300000; H.at = Date.now() + 300000;
    N.sync([N.scan('X77', BC1, MAT1, 1)], [N.ev('OPEN', 'X77')]);
    O.sync([O.scan('X78', BC1, MAT1, 1)], [O.ev('OPEN', 'X78')]);
    run('apiLocTransfer("X78", "TC21-04", "เครื่องเสีย")');
    assert.strictEqual(mem('X78', 'TC21-04').staff, 'EMP-C', JSON.stringify(mem('X78', 'TC21-04')));
    const r = H.sync([H.scan('X78', BC1, MAT1, 1)], [H.ev('OPEN', 'X78')]);
    assert.strictEqual(r.events[0].role, 'HELPER');
    assert.strictEqual(r.events[0].ownerLabel, 'นาย ค (TC21-04)', JSON.stringify(r.events[0]));
  });
  test('v2.7.1 apiDevicesState.incidents = จำนวนแถว Device_Log ของรอบนี้แยกเครื่อง', () => {
    const lg = env.sheets.Device_Log.data, cP = lg[0].indexOf('Project_ID'), cD = lg[0].indexOf('Device_ID');
    const row = lg[0].map(() => ''); row[cP] = '2026Q4'; row[cD] = 'TC21-02';
    const other = row.slice(); other[cP] = '2025Q3';
    lg.push(row, row.slice(), other);
    const exp = {}; lg.slice(1).forEach(x => { if (x[cP] === '2026Q4') exp[x[cD]] = (exp[x[cD]] || 0) + 1; });
    assert.strictEqual(JSON.stringify(run('apiDevicesState()').incidents), JSON.stringify(exp));
    assert.ok(exp['TC21-02'] >= 2);
  });
  test('v2.7.2 (UAT G20-11) เวลาในชีตชั่วโมงหลักเดียว ("9:14:57") → รายงานเหตุการณ์ได้ 09:14 · padTs_ ไม่แตะค่าอื่น', () => {
    assert.strictEqual(run('padTs_("2026-11-24 9:14:57")'), '2026-11-24 09:14:57');
    assert.strictEqual(run('padTs_("2026-11-24 10:14:57")'), '2026-11-24 10:14:57');
    assert.strictEqual(run('padTs_("TC21-01-abcdefghij")'), 'TC21-01-abcdefghij');
    const lg = env.sheets.Device_Log.data, h = lg[0], row = h.map(() => '');
    const set = (k, v) => { row[h.indexOf(k)] = v; };
    set('Incident_ID', 'TC21-02-x9'); set('Project_ID', '2026Q4'); set('Device_ID', 'TC21-02'); set('Staff_Code', 'EMP-B'); set('Type', 'OFFLINE');
    set('Start_Time', '2026-11-24 9:14:57'); set('End_Time', '2026-11-24 9:16:49'); set('Minutes', '1'); set('Scans', '1'); set('Pending', '1'); set('Drained_At', '2026-11-24 9:16:50');
    lg.push(row);
    const R = run('apiDeviceIncidents()'), d = R.rows.find(x => x.device === 'TC21-02'), x = d && d.incidents.find(i => i.id === 'TC21-02-x9');
    assert.ok(x, JSON.stringify(R).slice(0, 300));
    assert.strictEqual(x.time, '09:14–09:16');
    assert.ok(x.how.indexOf('09:16') >= 0 && x.how.indexOf('9:16:') < 0, x.how);
  });
}

console.log('\nยอดแยกเครื่องหลังล้าง Location (v2.3.6 — UAT D3 -5)');
{
  const O = device('TC21-01', 'EMP-K', '2.3.6'), H = device('TC21-02', 'EMP-KH', '2.3.6');
  [O, H].forEach(d => { d.seq = 6000 + d.seq; d.at = 9000; });
  test('ผู้ช่วยนับ 5 → ส่งงาน · ผู้ดูแลล้างทั้ง Location แล้วนับ 1 → Admin: ผู้ช่วย 0 ผู้ดูแล 1 (ไม่ติดลบ) รวม 1 · บอกเวลาและเครื่องที่ล้าง', () => {
    O.sync([O.scan('D3', BC1, MAT1, 1)], [O.ev('OPEN', 'D3')]);
    H.sync([1, 2, 3, 4, 5].map(() => H.scan('D3', BC1, MAT1, 1)), [H.ev('JOIN', 'D3')]);
    H.sync([], [H.ev('SUBMIT', 'D3', { lines: 5, qty: 5, fromSeq: H.seq - 4, upToSeq: H.seq })]);
    O.sync([O.scan('D3', BC1, MAT1, -6, { type: 'RECOUNT_SET', basis: 6, reason: 'ล้าง Location นับใหม่ (เดิม 6)' })], [O.ev('EDIT', 'D3', { clear: true })]);
    O.sync([O.scan('D3', BC1, MAT1, 1)]);
    const T = run('apiDevicesState()').locTotals.D3;
    assert.strictEqual(T.qty, 1);
    assert.strictEqual(T.dev['TC21-02'].qty, 0, 'ผู้ช่วย ' + JSON.stringify(T.dev));
    assert.strictEqual(T.dev['TC21-01'].qty, 1, 'ผู้ดูแล ' + JSON.stringify(T.dev));
    assert.strictEqual(T.dev['TC21-01'].raw, -4, 'ยอดเต็มยังเก็บไว้ (รายการล้างอยู่ที่เครื่องผู้ดูแล)');
    assert.strictEqual(T.clearedBy, 'TC21-01');
    assert.ok(T.clearedAt, 'มีเวลาล้าง');
  });
  test('locInfo หลังล้าง: เครื่องอื่นของผู้ดูแล = 0 (ไม่ใช่ 5) แต่ยอดรวมยังถูก · สมาชิกบอกยอดหลังล้าง', () => {
    const i = O.info('D3');
    const x = i.others.items.find(v => v[0] === MAT1);
    assert.strictEqual(x[4], 0, 'ยอดเครื่องอื่นหลังล้าง');
    assert.strictEqual(i.others.qty + (-4), i.total, 'ยอดรวมแบบเดิม: เครื่องอื่น 5 + ผู้ดูแล -4 = 1');
    assert.strictEqual(i.members.find(m => m.device === 'TC21-02').sc, 0);
    const h = H.info('D3').others.items.find(v => v[0] === MAT1);
    assert.strictEqual(h[4], 1, 'ผู้ช่วยเห็นยอดผู้ดูแลหลังล้าง 1 (ไม่ใช่ -4)');
  });
  test('ดัชนีหลังล้าง = สร้างใหม่จากชีต (sc ตรงกัน)', () => {
    const a = run('apiDevicesState()').locTotals.D3;
    run('rebuildCountIndex()');
    const b = run('apiDevicesState()').locTotals.D3;
    assert.strictEqual(JSON.stringify(a), JSON.stringify(b));
  });
}

console.log('\nบันทึก Admin_Log ต้องติดจริง · บันทึกก่อนทำ · กระทบยอดทั้งรอบ (v2.3.8 — UAT: filter ใน Admin_Log ทำให้บันทึกหายเงียบ)');
{
  const O = device('TC21-01', 'EMP-K', '2.3.8'), H = device('TC21-02', 'EMP-KH', '2.3.8');
  [O, H].forEach(d => { d.seq = 7000 + d.seq; d.at = 9500; });
  const AL = env.sheets.Admin_Log, LM = env.sheets.Loc_Members;
  const memState = (loc, dev) => { const h = LM.data[0], r = LM.data.find(x => x[h.indexOf('Location')] === loc && x[h.indexOf('Device_ID')] === dev); return r[h.indexOf('State')]; };
  O.sync([O.scan('D7', BC1, MAT1, 1)], [O.ev('OPEN', 'D7')]);
  H.sync([H.scan('D7', BC1, MAT1, 1)], [H.ev('JOIN', 'D7')]);
  test('Admin_Log เขียนไม่ติด → ปิดธงถูกยกเลิก (ธงยังอยู่) · สำรองใน Loc_Checks · หน้า Admin เตือน', () => {
    assert.ok(/นับซ้อน: TC21-02/.test(loc('D7').Flag), 'JOIN = นับซ้อน ติดธง');
    const n = AL.data.length; AL.dropWrites = true;
    assert.throws(() => run('apiLocResolveFlag("D7", "ตรวจแล้ว")'), /บันทึก Admin_Log ไม่สำเร็จ.*ยกเลิก/);
    AL.dropWrites = false;
    assert.strictEqual(AL.data.length, n);
    assert.ok(/นับซ้อน/.test(loc('D7').Flag), 'ธงยังอยู่');
    assert.ok(!env.sheets.Loc_Checks.data.some(r => r[3] === 'D7' && r[4] === 'FLAG_RESOLVE'));
    assert.ok(env.sheets.Loc_Checks.data.some(r => r[4] === 'ADMIN_LOG_FAIL' && /LOC_FLAG_RESOLVE · D7/.test(r[12])));
    const w = run('apiDevicesState()').logWarn;
    assert.strictEqual(w.n, 1); assert.ok(/LOC_FLAG_RESOLVE/.test(w.what));
  });
  test('สร้างรหัสจับคู่ตอนบันทึกไม่ติด → ไม่สร้าง', () => {
    const DV = env.sheets.Devices, h = DV.data[0], r = DV.data.find(x => x[0] === 'TC21-05'), before = r[h.indexOf('Pair_Code')];
    AL.dropWrites = true;
    assert.throws(() => run('apiPairCode("TC21-05")'), /Admin_Log/);
    AL.dropWrites = false;
    assert.strictEqual(r[h.indexOf('Pair_Code')], before);
    assert.strictEqual(run('apiDevicesState()').logWarn.n, 2);
  });
  test('บันทึกของระบบ (INDEX_FIX) เขียนไม่ติด → งานส่งข้อมูลไม่ล้ม แต่สำรองใน Loc_Checks', () => {
    const CL = env.sheets.Count_Log, row = CL.data.find(x => x[5] === 'D7' && x[2] === 'TC21-01');
    row[8] = '0';   // แก้ชีตตรง ๆ
    AL.dropWrites = true;
    const X = run('logIdx_(readConfig_().PROJECT_ID, { write: true })');
    const d = X.verify(['D7'], 'ทดสอบ'); X.save();
    AL.dropWrites = false;
    assert.ok(d.length);
    assert.ok(env.sheets.Loc_Checks.data.some(r => r[4] === 'ADMIN_LOG_FAIL' && /INDEX_FIX/.test(r[12])));
    row[8] = '1';
  });
  test('กดรับทราบคำเตือน → หายไป และบันทึกผู้กด', () => {
    run('apiAckLogWarn()');
    assert.strictEqual(run('apiDevicesState()').logWarn, null);
    assert.ok(AL.data.some(r => r[2] === 'ADMIN_LOG_WARN_ACK' && /3 ครั้ง/.test(r[4])));
  });
  test('บันทึกได้ปกติ → ปิดธงสำเร็จ และ Admin_Log มาก่อน Loc_Checks', () => {
    assert.throws(() => run('apiLocResolveFlag("D7", "  ")'), /เหตุผล/);
    run('apiLocResolveFlag("D7", "ตรวจแล้ว ยอดถูก")');
    assert.strictEqual(loc('D7').Flag, '');
    assert.ok(AL.data.some(r => r[2] === 'LOC_FLAG_RESOLVE' && r[3] === 'D7'));
  });
  test('กระทบยอดทั้งรอบ: ดัชนีที่เพี้ยนจากการแก้ชีต (ยังไม่มีใครตรวจ) ถูกพบและแก้ · บันทึก RECONCILE', () => {
    const X = run('logIdx_(readConfig_().PROJECT_ID, { write: true })'); X.verify(null, 'ก่อนทดสอบ'); X.save();
    let r = run('apiReconcile()');
    assert.strictEqual(r.indexDiffs.length, 0, JSON.stringify(r.indexDiffs));
    const CL = env.sheets.Count_Log, row = CL.data.find(x => x[5] === 'D7' && x[2] === 'TC21-01');
    row[8] = '5';
    r = run('apiReconcile()');
    assert.ok(r.indexDiffs.length && !r.ok, JSON.stringify(r));
    assert.ok(AL.data.some(x => x[2] === 'RECONCILE' && /พบจุดต่าง/.test(x[4])));
    assert.ok(AL.data.some(x => x[2] === 'INDEX_FIX' && /กระทบยอดทั้งรอบ/.test(x[4])));
    row[8] = '1';
    r = run('apiReconcile()');
    assert.ok(r.indexDiffs.length > 0, 'แก้กลับ = ต่างอีกครั้ง แล้วตรง');
    assert.strictEqual(run('apiReconcile()').indexDiffs.length, 0);
  });
  test('กระทบยอด: Location ที่ปิดแล้วแต่ยอดในชีตเปลี่ยน (ไม่มีธง) ถูกพบ', () => {
    O.sync([], [O.ev('CLOSE', 'D7', { lines: 1, qty: 1, total: 2 })]);
    let r = run('apiReconcile()');
    assert.ok(!r.closeDiffs.some(c => c.loc === 'D7'), JSON.stringify(r.closeDiffs));
    const CL = env.sheets.Count_Log, row = CL.data.find(x => x[5] === 'D7' && x[2] === 'TC21-02');
    row[8] = '4';
    r = run('apiReconcile()');
    const c = r.closeDiffs.find(x => x.loc === 'D7');
    assert.ok(c && c.close === 2 && c.sheet === 5 && !r.ok, JSON.stringify(r.closeDiffs));
    row[8] = '1'; run('apiReconcile()');
  });
}

console.log('\nสรุปผลนับ / Dashboard (v2.4.0)');
{
  const O = device('TC21-01', 'EMP-K', '2.4.0');
  O.seq = 8000 + O.seq; O.at = 9800;
  O.sync([O.scan('F1', BC1, MAT1, 2), O.scan('F1', BC2, MAT2, 1), O.scan('F3', '9999999999999', '', 4)], [O.ev('OPEN', 'F1')]);
  const project = run('readConfig_().PROJECT_ID');
  const CL = env.sheets.Count_Log, BM = env.sheets.Barcode_Map;
  const sumLog = f => Math.round(CL.data.slice(1).filter(r => r[1] === project && f(r)).reduce((t, r) => t + Number(r[8]), 0) * 1000) / 1000;
  const bh = BM.data[0], bookOf = m => { const r = BM.data.find(x => x[bh.indexOf('Material')] === m); return r ? Number(String(r[bh.indexOf('Book_Qty')]).replace(/,/g, '')) || 0 : 0; };
  let R;
  test('ยอดรวมทั้งร้าน = ผลรวม Count_Log ของรอบ · ยอดบัญชี = Book_Qty ต่อรหัส (ไม่นับซ้ำหลายบาร์โค้ด)', () => {
    R = run('apiSummary()');
    assert.strictEqual(R.totals.dev, sumLog(() => true));
    const mats = {}; BM.data.slice(1).forEach(r => { const m = r[bh.indexOf('Material')]; if (m && !(m in mats)) mats[m] = Number(String(r[bh.indexOf('Book_Qty')]).replace(/,/g, '')) || 0; });
    assert.strictEqual(R.totals.book, Math.round(Object.values(mats).reduce((t, v) => t + v, 0) * 1000) / 1000);
    assert.strictEqual(R.totals.final, R.totals.dev + R.totals.adj);
  });
  test('ราย SKU: นับได้ = Count_Log ของรหัสนั้น · ต่าง = นับ − บัญชี · มูลค่า = ต่าง × ต้นทุน · เรียงตามมูลค่าผลต่าง', () => {
    const x = R.skus.find(r => r[0] === MAT1);
    assert.strictEqual(x[3], sumLog(r => r[7] === MAT1));
    assert.strictEqual(x[2], bookOf(MAT1));
    assert.strictEqual(x[6], Math.round((x[3] - x[2]) * 1000) / 1000);
    assert.strictEqual(x[8], Math.round(x[6] * x[7] * 100) / 100);
    for (let i = 1; i < R.skus.length; i++) assert.ok(Math.abs(R.skus[i - 1][8]) >= Math.abs(R.skus[i][8]), 'เรียงตามมูลค่า');
  });
  test('สินค้าไม่มีใน Master แยกออกมา ไม่ปนในผลต่าง', () => {
    const u = R.unmapped.find(r => r[0] === '9999999999999');
    assert.ok(u && u[1] === 4 && /F3/.test(u[2]), JSON.stringify(R.unmapped));
    assert.ok(!R.skus.some(r => r[0] === 'BC:9999999999999'));
  });
  test('Location ที่หาย: รวมทุกเครื่องในโซน เฉพาะช่วงที่ใช้จริง (ตัวอย่างโซน A ของผู้ใช้) · เลขนำหน้า 0', () => {
    const m = run('missingLocations_(_n)', { _n: ['A1', 'A5', 'A8', 'A10', 'A18', 'A20', 'A2', 'A4', 'A5', 'A6', 'A7', 'A9', 'A11', 'B01', 'B03', 'C1', 'C2', 'X'] });
    const a = m.find(z => z.zone === 'A');
    assert.deepStrictEqual(Array.from(a.missing), ['A3', 'A12', 'A13', 'A14', 'A15', 'A16', 'A17', 'A19']);
    assert.deepStrictEqual(Array.from(m.find(z => z.zone === 'B').missing), ['B02']);
    assert.ok(!m.some(z => z.zone === 'C'), 'โซนที่ไม่มีเลขหายไม่ขึ้น');
    assert.ok(R.missing.some(z => z.zone === 'F' && z.missing.indexOf('F2') >= 0), 'F1, F3 → F2 หาย');
  });
  test('ไล่ย้อน SKU: Location / เครื่อง / ผู้นับ / ยอด รวมได้เท่ายอดนับ', () => {
    const d = run('apiSkuDetail(_k)', { _k: MAT1 });
    assert.strictEqual(Math.round(d.rows.reduce((t, r) => t + r[5], 0) * 1000) / 1000, R.skus.find(r => r[0] === MAT1)[3]);
    const f1 = d.rows.find(r => r[0] === 'F1');
    assert.ok(f1 && f1[2] === 'TC21-01' && f1[3] === 'EMP-K' && f1[5] === 2, JSON.stringify(f1));
  });
  test('ไล่ย้อนหลังล้าง Location: ไม่มียอดติดลบของเครื่องที่กดล้าง (D3 จากเคส v2.3.6)', () => {
    const d = run('apiSkuDetail(_k)', { _k: MAT1 });
    const d3 = d.rows.filter(r => r[0] === 'D3');
    assert.ok(d3.length && d3.every(r => r[5] >= 0), JSON.stringify(d3));
    assert.strictEqual(d3.reduce((t, r) => t + r[5], 0), 1);
  });
  test('แก้ชีตตรงก่อนสรุป → กระทบยอดเจอ (INDEX_FIX) และตัวเลขตามชีต', () => {
    const row = CL.data.find(r => r[5] === 'F1' && r[7] === MAT2);
    row[8] = '3';
    const R2 = run('apiSummary()');
    assert.ok(R2.indexDiffs.length > 0);
    assert.strictEqual(R2.skus.find(r => r[0] === MAT2)[3], sumLog(r => r[7] === MAT2));
    row[8] = '1'; run('apiSummary()');
  });
  test('สรุปผลและบันทึก: ชีต Variance ต่อท้าย (ครั้งที่ 1) · Dash_Data · Admin_Log SUMMARY_SAVE · v2.9.1 ผลไม่เปลี่ยน → ไม่บันทึกซ้ำ', () => {
    const V = env.sheets.Variance, n0 = V.data.length;
    const a = run('apiSummarySave()');
    assert.strictEqual(a.run, 1);
    assert.strictEqual(V.data.length - n0, a.skus.length + a.unmapped.length);
    assert.ok(env.sheets.Dash_Data.data.some(r => r[0] === 'SUMMARY_RUN' && String(r[1]) === '1'));
    assert.ok(env.sheets.Admin_Log.data.some(r => r[2] === 'SUMMARY_SAVE' && /ครั้งที่ 1/.test(r[4])));
    const nLog = env.sheets.Admin_Log.data.filter(r => r[2] === 'SUMMARY_SAVE').length;
    const b = run('apiSummarySave()');
    assert.ok(b.skipped && b.same && b.run === 1 && b.saved === 0 && b.prevAt === a.at, JSON.stringify({ skipped: b.skipped, run: b.run, saved: b.saved }));
    assert.strictEqual(V.data.length - n0, a.skus.length + a.unmapped.length, 'ชีต Variance ไม่มีชุดซ้ำ');
    assert.strictEqual(env.sheets.Admin_Log.data.filter(r => r[2] === 'SUMMARY_SAVE').length, nLog, 'ไม่บันทึก SUMMARY_SAVE ซ้ำ');
  });
  test('โหลด SAP ใหม่ระหว่างวันนับ (ยอด UR เปลี่ยน): ยอดเทียบเปลี่ยนตาม · Master ที่เครื่องใช้ไม่เปลี่ยน (ไม่ต้องอนุมัติใหม่)', () => {
    const cfg0 = run('readConfig_()'), dm0 = JSON.stringify(env.sheets.Device_Master.data);
    const rows = JSON.parse(JSON.stringify(sap));
    const hi = rows.findIndex(r => r.indexOf('Qty-UR') >= 0), cM = rows[hi].indexOf('Material'), cU = rows[hi].indexOf('Qty-UR');
    const r1 = rows.find((r, i) => i > hi && String(r[cM]).trim() === MAT1);
    r1[cU] = String(Number(String(r1[cU]).replace(/,/g, '')) + 7);
    const before = run('apiSummary()').skus.find(r => r[0] === MAT1)[2];
    run('apiUpload("SAP", _s, { fileName: "sap-noon.xls", fileDate: "2026-11-04", d1Confirmed: true })', { _s: rows });
    const after = run('apiSummary()');
    assert.strictEqual(after.skus.find(r => r[0] === MAT1)[2], before + 7, 'ยอดบัญชีใหม่');
    assert.strictEqual(after.sap.name, 'sap-noon.xls');
    const cfg1 = run('readConfig_()');
    assert.strictEqual(cfg1.MASTER_APPROVED_HASH, cfg0.MASTER_APPROVED_HASH);
    assert.strictEqual(JSON.stringify(env.sheets.Device_Master.data), dm0, 'Device_Master ไม่ถูกเขียนใหม่');
    assert.ok(run('apiGetState()').master.approved.current, 'Master ที่อนุมัติยังใช้ได้');
    run('apiUpload("SAP", _sap, { fileName: "sap.xls", fileDate: "2026-11-04", d1Confirmed: true })');
  });
  test('บันทึก Admin_Log ไม่ติด → ไม่เขียน Variance (บันทึกก่อนทำ)', () => {
    const V = env.sheets.Variance, n0 = V.data.length;
    env.sheets.Admin_Log.dropWrites = true;
    assert.throws(() => run('apiSummarySave()'), /Admin_Log/);
    env.sheets.Admin_Log.dropWrites = false;
    assert.strictEqual(V.data.length, n0);
    run('apiAckLogWarn()');
  });
}

console.log('\nรายงาน v2.4.1: บาร์โค้ด · Location=จำนวน · บันทึกซ้ำ · ค้นหา SKU บนเครื่อง · ตรวจโครงชีต');
{
  const O = device('TC21-01', 'EMP-K', '2.4.1');
  O.seq = 9000 + O.seq; O.at = 9900;
  O.sync([O.scan('F10', BC1, MAT1, 3), O.scan('F2', BC1, MAT1, 1)], [O.ev('OPEN', 'F10')]);
  const project = run('readConfig_().PROJECT_ID');
  const CL = env.sheets.Count_Log, BM = env.sheets.Barcode_Map, bh = BM.data[0];
  const sumAt = (m, l) => Math.round(CL.data.slice(1).filter(r => r[1] === project && r[7] === m && r[5] === l).reduce((t, r) => t + Number(r[8]), 0) * 1000) / 1000;
  let R;
  test('ราย SKU มี [[Location, ชิ้น]] เรียงแบบคน (F2 ก่อน F10) · ผลรวม = นับได้ · ชิ้นต่อ Location = Count_Log', () => {
    R = run('apiSummary()');
    const x = R.skus.find(r => r[0] === MAT1), locs = x[13];
    const names = locs.map(l => l[0]);
    assert.ok(names.indexOf('F2') >= 0 && names.indexOf('F2') < names.indexOf('F10'), JSON.stringify(names));
    assert.strictEqual(Math.round(locs.reduce((t, l) => t + l[1], 0) * 1000) / 1000, x[3]);
    locs.forEach(l => assert.strictEqual(l[1], sumAt(MAT1, l[0]), l[0]));
    assert.strictEqual(x[12], locs.length);
    assert.strictEqual(run('locStr_(_l)', { _l: [['C3', 2], ['D6', 1]] }), 'C3=2, D6=1');
  });
  test('ราย SKU มีบาร์โค้ดทุกตัวของรหัส (จาก Barcode_Map)', () => {
    const want = BM.data.slice(1).filter(r => r[bh.indexOf('Material')] === MAT1).map(r => r[bh.indexOf('Barcode')]);
    assert.deepStrictEqual(Array.from(R.skus.find(r => r[0] === MAT1)[14]).sort(), Array.from(new Set(want)).sort());
  });
  test('ไม่มีใน Master: Location แสดงเป็น F3=4', () => {
    assert.ok(/F3=4/.test(R.unmapped.find(r => r[0] === '9999999999999')[2]));
  });
  test('Variance มีคอลัมน์ Barcode · Locations = "F2=1, F10=3, …" · บันทึกครั้งถัดไปโดยผลไม่เปลี่ยน → ไม่บันทึกซ้ำ (v2.9.1)', () => {
    const V = env.sheets.Variance, vh = V.data[0];
    assert.ok(vh.indexOf('Barcode') >= 0);
    const a = run('apiSummarySave()');
    assert.ok(a.saved === a.skus.length + a.unmapped.length && a.lastSave.run === a.run);
    const row = V.data.filter(r => String(r[0]) === String(a.run) && r[vh.indexOf('Material')] === MAT1)[0];
    assert.strictEqual(row[vh.indexOf('Locations')], run('locStr_(_l)', { _l: R.skus.find(r => r[0] === MAT1)[13] }));
    assert.ok(row[vh.indexOf('Barcode')].indexOf(BC1) >= 0);
    const b = run('apiSummarySave()');
    assert.ok(b.same && b.skipped && b.run === a.run && b.saved === 0 && b.prevAt === a.at, JSON.stringify({ same: b.same, run: b.run, prevAt: b.prevAt }));
    O.sync([O.scan('F10', BC1, MAT1, 1)]);
    const c = run('apiSummarySave()');
    assert.ok(!c.same && !c.skipped && c.run === a.run + 1, 'ยิงเพิ่มแล้วผลเปลี่ยน → บันทึกครั้งใหม่');
    assert.strictEqual(run('apiSummary()').lastSave.run, c.run);
  });
  test('เครื่องค้นหา SKU ด้วยบาร์โค้ด: ยอดบัญชี · นับ · ต่าง · Location=ชิ้น · ไม่มีต้นทุน/มูลค่า', () => {
    const r = O.call('sku', { q: BC1 }), x = run('apiSummary()').skus.find(s => s[0] === MAT1);
    assert.ok(r.ok && r.key === MAT1 && r.mapped, JSON.stringify(r));
    assert.strictEqual(r.book, x[2]); assert.strictEqual(r.dev, x[3]); assert.strictEqual(r.diff, x[6]);
    assert.strictEqual(JSON.stringify(r.locs.map(l => [l[0], l[1]])), JSON.stringify(x[13].map(l => [l[0], l[1]])));
    assert.ok(r.locs.every(l => typeof l[2] === 'string'), 'มีสถานะ Location');
    assert.ok(!('cost' in r) && !JSON.stringify(r).match(/Unit_Cost|value/i), 'ไม่ส่งต้นทุน');
  });
  test('ค้นหาด้วยรหัสสินค้า (พิมพ์ตัวเล็กได้) ได้ผลเดียวกัน · บาร์โค้ดที่ไม่มีใน Master เห็น Location แต่ไม่มียอดบัญชี · ว่าง = แจ้งให้ยิง', () => {
    const a = O.call('sku', { q: BC1 }), b = O.call('sku', { q: MAT1.toLowerCase() });
    assert.strictEqual(b.key, a.key); assert.strictEqual(b.dev, a.dev);
    const u = O.call('sku', { q: '9999999999999' });
    assert.ok(u.ok && !u.mapped && u.book === null && u.diff === null && u.locs.some(l => l[0] === 'F3' && l[1] === 4), JSON.stringify(u));
    const e = O.call('sku', { q: '  ' });
    assert.ok(!e.ok && /ยิงบาร์โค้ด/.test(e.message || e.error || JSON.stringify(e)), JSON.stringify(e));
  });
  test('เครื่องที่ไม่ได้จับคู่ค้นหาไม่ได้', () => {
    const r = env.post({ action: 'sku', deviceId: 'TC21-01', token: 'wrong', q: BC1 });
    assert.ok(!r.ok);
  });
  test('กระทบยอดทั้งรอบ ตรวจโครงชีต: ปกติ = ครบ · แถวว่าง / เวลาหาย / Log_ID ซ้ำ / Seq ขาด ถูกพบพร้อมเลขแถว (ไม่แก้ชีต)', () => {
    let r = run('apiReconcile()');
    const B = r.audit, bd = d => B.devices.find(x => x.dev === d);
    // ชุดทดสอบนี้ข้ามเลข Seq โดยตั้งใจ (O.seq = 9000 + …) จึงเทียบกับค่าก่อนแก้ ไม่ใช่ ok
    assert.ok(B && B.blank === 0 && B.noTime === 0 && B.dupIds === 0, JSON.stringify(B));
    assert.strictEqual(B.rows, CL.data.length - 1);
    const n = CL.data.length;
    const row = CL.data.find(x => x[2] === 'TC21-01' && x[1] === project && x[5] === 'F10');
    const saveT = [row[13], row[14]];
    row[13] = ''; row[14] = '';
    const W = CL.data[0].length;
    CL.data.splice(n - 1, 0, new Array(W).fill(''));              // แถวว่างกลางชีต
    const dupe = CL.data[n].slice(); CL.data.push(dupe);          // Log_ID ซ้ำ
    const snap = JSON.stringify(CL.data);
    r = run('apiReconcile()');
    const A = r.audit;
    assert.ok(!r.ok && !A.ok);
    assert.strictEqual(A.blank, 1); assert.strictEqual(JSON.stringify(A.blankRows), JSON.stringify([n]));
    assert.ok(A.noTime === 1 && A.noTimeRows.indexOf(CL.data.indexOf(row) + 1) >= 0, JSON.stringify(A.noTimeRows));
    assert.strictEqual(A.dupIds, 1);
    assert.ok(A.devices.find(x => x.dev === dupe[2]).dup === bd(dupe[2]).dup + 1, 'Seq ซ้ำ');
    assert.strictEqual(JSON.stringify(CL.data), snap, 'กระทบยอดไม่แก้ชีต');
    assert.ok(env.sheets.Admin_Log.data.some(x => x[2] === 'RECONCILE' && /แถวว่าง 1 · เวลาหาย 1 · Log_ID ซ้ำ 1/.test(x[4])));
    CL.data.pop(); CL.data.splice(n - 1, 1); row[13] = saveT[0]; row[14] = saveT[1];
    // Seq ขาด: ลบแถวที่มีเลขถัดไปต่อกันของ TC21-01 ออกชั่วคราว
    const i = CL.data.findIndex(x => x[2] === 'TC21-01' && x[1] === project && Number(x[3]) > 1 && CL.data.some(y => y[2] === 'TC21-01' && y[1] === project && Number(y[3]) === Number(x[3]) + 1));
    const gone = CL.data.splice(i, 1)[0];
    r = run('apiReconcile()');
    assert.strictEqual(r.audit.devices.find(d => d.dev === 'TC21-01').missing, bd('TC21-01').missing + 1);
    CL.data.splice(i, 0, gone);
    const back = run('apiReconcile()').audit;
    assert.ok(back.blank === 0 && back.noTime === 0 && back.dupIds === 0 && back.devices.find(d => d.dev === 'TC21-01').missing === bd('TC21-01').missing);
  });
  test('อัปเกรดจาก v2.4.0: ชีต Variance ที่มีข้อมูลแล้ว ได้คอลัมน์ Barcode ต่อท้าย (ข้อมูลเดิมไม่ย้าย) · SCHEMA_VERSION ล่าสุด', () => {
    const e2 = createEnv(); e2.run('setupSheets()');
    const V = e2.sheets.Variance; V.data[0] = V.data[0].slice(0, 18);
    const old = ['1', 't', 'p', 'f', 'M1', 'n', '1', 'SAP', '1', '0', '1', '0', '1', '0', '0', '0', '0', 'A1'];
    V.data.push(old.slice());
    e2.run('setConfig_({ SCHEMA_VERSION: 5 })'); e2.run('ensureSetup_()');
    assert.strictEqual(V.data[0][18], 'Barcode');
    assert.strictEqual(JSON.stringify(V.data[1].slice(0, 18)), JSON.stringify(old));
    assert.strictEqual(String(e2.run('readConfig_().SCHEMA_VERSION')), String(e2.run('SCHEMA_VERSION')));
  });
  test('Seq ที่อยู่ใน Quarantine ไม่นับเป็น Seq ขาด', () => {
    const Q = env.sheets.Quarantine, base = run('countLogAudit_(_p)', { _p: project }).devices.find(d => d.dev === 'TC21-05');
    const lo = base.min, hi = base.max;
    let gap = 0; for (let q = lo + 1; q < hi && !gap; q++) if (!CL.data.some(r => r[2] === 'TC21-05' && r[1] === project && Number(r[3]) === q)) gap = q;
    assert.ok(gap, 'ต้องมีช่องว่างให้ทดสอบ');
    Q.data.push(['2026-11-04 10:00:00', 'TC21-05', 'TC21-05-' + String(gap).padStart(6, '0'), '2026Q3', '{}', 'รอบไม่ตรง']);
    const after = run('countLogAudit_(_p)', { _p: project }).devices.find(d => d.dev === 'TC21-05');
    assert.strictEqual(after.missing, base.missing - 1);
    Q.data.pop();
  });
}

console.log('\nปรับยอดด้วยมือ (v2.4.2)');
{
  const O = device('TC21-01', 'EMP-K', '2.4.2');
  const project = run('readConfig_().PROJECT_ID');
  const AJ = env.sheets.Adjustments, CL = env.sheets.Count_Log, AL = env.sheets.Admin_Log;
  const sku = (R, m) => R.skus.find(r => r[0] === m);
  const adj = o => run('apiAdjust(_o)', { _o: Object.assign({ material: MAT1, qty: 2, reason: 'RECOUNT', note: '', location: '', staff: 'EMP-K' }, o) });
  let R0, R1;
  test('ปรับ +2 (นับทวนกับพนักงานหน้าร้าน): ยอดสุดท้าย = เครื่อง + ปรับ · ต่างเปลี่ยนตาม · Count_Log ไม่เปลี่ยน · ชีต Adjustments 1 บรรทัด', () => {
    R0 = run('apiSummary()');
    const cl0 = JSON.stringify(CL.data), n0 = AJ.data.length;
    R1 = adj({ qty: 2, location: 'f1' });
    const a = sku(R0, MAT1), b = sku(R1, MAT1);
    assert.strictEqual(b[3], a[3], 'ยอดเครื่องไม่เปลี่ยน');
    assert.strictEqual(b[4], a[4] + 2); assert.strictEqual(b[5], a[5] + 2); assert.strictEqual(b[6], a[6] + 2);
    assert.strictEqual(R1.totals.adj, R0.totals.adj + 2); assert.strictEqual(R1.totals.final, R0.totals.final + 2);
    assert.strictEqual(JSON.stringify(CL.data), cl0, 'Count_Log ไม่ถูกแตะ');
    assert.strictEqual(AJ.data.length, n0 + 1);
    const h = AJ.data[0], row = AJ.data[AJ.data.length - 1], g = k => row[h.indexOf(k)];
    assert.ok(/^ADJ-\d{4}$/.test(g('Adj_ID')) && g('Material') === MAT1 && Number(g('Qty')) === 2 && g('Reason') === 'นับทวนกับพนักงานหน้าร้าน' && g('Location') === 'F1' && g('Staff_Code') === 'EMP-K' && g('By'), JSON.stringify(row));
    assert.strictEqual(Number(g('Final_Before')), a[5]); assert.strictEqual(Number(g('Final_After')), a[5] + 2);
    assert.ok(R1.adjDone && R1.adjDone.after === a[5] + 2 && b[15] === 1);
  });
  test('บันทึก Admin_Log (ADJUST) ก่อนเขียน · Admin_Log ไม่ติด → ไม่มีบรรทัดปรับ', () => {
    assert.ok(AL.data.some(r => r[2] === 'ADJUST' && r[3] === MAT1 && /\+2 · นับทวน/.test(r[4]) && /ผู้คีย์ EMP-K/.test(r[4])));
    const n0 = AJ.data.length;
    AL.dropWrites = true;
    assert.throws(() => adj({ qty: 1 }), /Admin_Log/);
    AL.dropWrites = false; run('apiAckLogWarn()');
    assert.strictEqual(AJ.data.length, n0);
  });
  test('ตรวจข้อมูลก่อนบันทึก: รหัสไม่มีใน Master · จำนวน 0 / ไม่ใช่ตัวเลข · ไม่เลือกเหตุผล · "อื่น ๆ" ไม่มีหมายเหตุ · ไม่มีผู้คีย์ · Location ไม่มีในรอบ', () => {
    const n0 = AJ.data.length;
    assert.throws(() => adj({ material: 'NOPE123' }), /ไม่พบรหัสสินค้า/);
    assert.throws(() => adj({ material: '9999999999999' }), /ไม่พบรหัสสินค้า/);
    assert.throws(() => adj({ qty: 0 }), /ไม่ใช่ 0/);
    assert.throws(() => adj({ qty: 'abc' }), /ตัวเลข/);
    assert.throws(() => adj({ reason: '' }), /เลือกเหตุผล/);
    assert.throws(() => adj({ reason: 'OTHER', note: '  ' }), /อื่น ๆ/);
    assert.throws(() => adj({ staff: '' }), /ผู้ตรวจสอบ/);
    assert.throws(() => adj({ staff: 'EMP-NOBODY' }), /ผู้ตรวจสอบ/);
    assert.throws(() => adj({ location: 'ZZ999' }), /ไม่มี Location/);
    assert.strictEqual(AJ.data.length, n0, 'ไม่มีบรรทัดถูกเขียน');
  });
  test('คีย์ด้วยบาร์โค้ดได้ · ลดยอด (−) ได้ · สินค้าโอนระหว่างทาง', () => {
    const before = sku(run('apiSummary()'), MAT2)[5];
    const R = adj({ material: BC2, qty: -1, reason: 'TRANSIT', staff: 'emp-kh' });
    assert.strictEqual(sku(R, MAT2)[5], before - 1);
    assert.ok(R.adjustments.some(x => x[2] === MAT2 && x[4] === -1 && x[5] === 'สินค้าโอนระหว่างทาง' && x[8] === 'EMP-KH'));
  });
  test('กลับรายการ: บรรทัดใหม่จำนวนตรงข้าม อ้าง Ref_ID · บรรทัดเดิมยังอยู่ · ยอดกลับเป็นเดิม · กลับซ้ำไม่ได้ · กลับบรรทัดกลับรายการไม่ได้ · ต้องมีเหตุผล', () => {
    const first = R1.adjDone.id, n0 = AJ.data.length;
    assert.throws(() => run('apiAdjustReverse(_i, "EMP-K", " ")', { _i: first }), /เหตุผล/);
    const R = run('apiAdjustReverse(_i, "EMP-K", "คีย์ผิด ต้องเป็น +3")', { _i: first });
    assert.strictEqual(AJ.data.length, n0 + 1);
    const h = AJ.data[0], row = AJ.data[AJ.data.length - 1];
    assert.ok(row[h.indexOf('Ref_ID')] === first && Number(row[h.indexOf('Qty')]) === -2 && row[h.indexOf('Reason')] === 'กลับรายการ', JSON.stringify(row));
    assert.ok(AJ.data.some(r => r[0] === first), 'บรรทัดเดิมไม่ถูกลบ');
    assert.strictEqual(sku(R, MAT1)[4], sku(R0, MAT1)[4], 'ยอดปรับกลับเป็นเดิม');
    assert.ok(R.adjustments.find(x => x[0] === first)[11] === row[0], 'บรรทัดเดิมรู้ว่าถูกกลับโดยบรรทัดไหน');
    assert.throws(() => run('apiAdjustReverse(_i, "EMP-K", "ซ้ำ")', { _i: first }), /ถูกกลับรายการแล้ว/);
    assert.throws(() => run('apiAdjustReverse(_i, "EMP-K", "ซ้ำ")', { _i: row[0] }), /กลับซ้ำไม่ได้/);
    assert.ok(AL.data.some(r => r[2] === 'ADJUST_REVERSE' && r[4].indexOf(first) >= 0 && /คีย์ผิด/.test(r[4])));
  });
  test('ยอดปรับรวมตามเหตุผล (กลับรายการหักออกจากเหตุผลเดิม) · บาท = ชิ้น × ต้นทุน', () => {
    const R = run('apiSummary()'), g = Object.fromEntries(R.totals.adjByReason.map(x => [x[0], x]));
    assert.strictEqual(g['นับทวนกับพนักงานหน้าร้าน'][2], 0, '+2 แล้วกลับ −2 = 0');
    assert.strictEqual(g['นับทวนกับพนักงานหน้าร้าน'][1], 1, 'นับเฉพาะบรรทัดที่ไม่ใช่กลับรายการ');
    assert.strictEqual(g['สินค้าโอนระหว่างทาง'][2], -1);
    assert.strictEqual(g['สินค้าโอนระหว่างทาง'][3], Math.round(-1 * sku(R, MAT2)[7] * 100) / 100);
    assert.strictEqual(R.totals.adjLines, 3);
  });
  test('ป้าย "ปรับเท่ายอดบัญชีพอดี" ขึ้นเมื่อปรับแล้วต่าง = 0 · นับจำนวนแยก · ไม่กันการบันทึก', () => {
    const x = sku(run('apiSummary()'), MAT1);
    const R = adj({ qty: -x[6], reason: 'OTHER', note: 'ทดสอบปรับให้เท่าบัญชี' });
    const y = sku(R, MAT1);
    assert.ok(y[6] === 0 && y[16] === true && R.totals.adjToBook >= 1, JSON.stringify(y.slice(0, 7)));
    assert.ok(AL.data.some(r => r[2] === 'ADJUST' && /ปรับเท่ายอดบัญชีพอดี/.test(r[4])));
  });
  test('บันทึกผลลงชีต Variance: Adjust_Qty / Final_Qty รวมยอดปรับ', () => {
    const R = run('apiSummarySave()'), V = env.sheets.Variance, vh = V.data[0];
    const row = V.data.filter(r => String(r[0]) === String(R.run) && r[vh.indexOf('Material')] === MAT1)[0];
    assert.strictEqual(Number(row[vh.indexOf('Adjust_Qty')]), sku(R, MAT1)[4]);
    assert.strictEqual(Number(row[vh.indexOf('Final_Qty')]), sku(R, MAT1)[5]);
  });
  test('ไล่ย้อน SKU มีบรรทัดปรับยอดของ SKU นั้น · เครื่องค้นหา SKU เห็นยอดปรับ และ ต่าง = สุดท้าย − บัญชี', () => {
    const d = run('apiSkuDetail(_k)', { _k: MAT1 });
    assert.ok(d.adjustments.length === 3 && d.adjustments.every(x => x[2] === MAT1));
    const r = O.call('sku', { q: BC1 }), x = sku(run('apiSummary()'), MAT1);
    assert.ok(r.adj === x[4] && r.final === x[5] && r.diff === x[6] && r.dev === x[3], JSON.stringify({ adj: r.adj, final: r.final, diff: r.diff }));
    assert.ok(/=/.test(r.locStr) && r.locStr === run('locStr_(_l)', { _l: x[13] }));
  });
  test('รายชื่อผู้คีย์ = ผู้ตรวจสอบที่ใช้งาน (Active ≠ N) · เหตุผลที่เลือกได้ 3 แบบ', () => {
    const R = run('apiSummary()');
    assert.ok(R.staff.some(s => s[0] === 'EMP-K' && s[1] === 'นาย ก'));
    assert.strictEqual(JSON.stringify(R.reasons.map(x => x[0])), JSON.stringify(['RECOUNT', 'TRANSIT', 'OTHER']));
  });
}

console.log('\nปิดการนับ / เงื่อนไขปิดรอบ / Admin_Log ต่อเนื่องข้ามรอบ (v2.5.0)');
{
  const O = device('TC21-01', 'EMP-K', '2.5.0'), H = device('TC21-02', 'EMP-KH', '2.5.0');
  const AL = env.sheets.Admin_Log, CL = env.sheets.Count_Log, AJ = () => env.sheets.Adjustments.data;
  const cfg = () => run('readConfig_()');
  const K = (full) => run(full === false ? 'closeCheck_(false)' : 'apiCloseCheck()');
  const item = (R, id) => R.items.find(x => x.id === id);
  const lastLog = a => AL.data.filter(r => r[2] === a).slice(-1)[0];
  test('Admin_Log มีคอลัมน์ Project_ID · แถวใหม่บันทึกรหัสรอบ · หน้า Admin ได้ทั้ง "รอบนี้" และ "ทุกรอบ"', () => {
    assert.strictEqual(AL.data[0][5], 'Project_ID');
    run('apiReconcile()');
    assert.strictEqual(lastLog('RECONCILE')[5], '2026Q4');
    const L = run('apiGetState()').log;
    assert.ok(L.cur.length && L.cur.every(r => r[5] === '2026Q4') && L.project === '2026Q4' && L.allCount >= L.curCount, JSON.stringify(L.cur[0]));
  });
  test('แถวเก่าไม่มี Project_ID → ใช้รอบจาก OPEN_ROUND ก่อนหน้า (อ่านอย่างเดียว) · ก่อน OPEN_ROUND แรก = ไม่มีรอบ', () => {
    const t = '2026-01-01 00:00:00', u = 'x@y';
    const L = run('logView_(_l, "B")', { _l: [['Time', 'By', 'Action', 'Target', 'Detail', 'Project_ID'], [t, u, 'SETUP', '', ''], [t, u, 'OPEN_ROUND', 'A', ''], [t, u, 'X', '', ''],
      [t, u, 'OPEN_ROUND', 'B', ''], [t, u, 'Y', '', ''], [t, u, 'Z', '', '', 'B'], ['', '', '', '', '']] });
    assert.deepStrictEqual(L.cur.map(r => r[2]), ['Z', 'Y', 'OPEN_ROUND']);
    assert.deepStrictEqual(L.all.map(r => r[5]), ['B', 'B', 'B', 'A', 'A', '']);
    assert.strictEqual(L.allCount, 6, 'แถวว่างไม่นับ');
  });
  test('ก่อนปิดการนับ: แผงเงื่อนไขมี K1–K7 · K7 ✗ (ยังกำลังนับ) · ยังไม่ครบ', () => {
    assert.strictEqual(cfg().ROUND_STATUS, 'COUNTING');
    const R = K();
    assert.strictEqual(R.items.map(x => x.id).join(','), 'K1,K2,K3,K4,K5,K6,K7');
    assert.ok(!item(R, 'K7').ok && /กำลังนับ/.test(item(R, 'K7').detail) && !R.ok && R.full);
    assert.ok(R.items.every(x => x.ok || x.fix), 'ข้อที่ไม่ผ่านมีวิธีแก้ทุกข้อ');
    assert.ok(!item(R, 'K4').ok && /ยังไม่ได้ปิดการนับ|ยังไม่ได้กระทบยอด|พบจุดต่าง/.test(item(R, 'K4').detail), item(R, 'K4').detail);
  });
  test('ปิดการนับ: ต้องเลือกรหัสผู้ตรวจสอบที่ใช้งาน · สถานะอื่นที่ไม่ใช่กำลังนับปิดไม่ได้', () => {
    assert.throws(() => run('apiCountClose("")'), /ผู้ตรวจสอบ/);
    assert.throws(() => run('apiCountClose("EMP-NOBODY")'), /ผู้ตรวจสอบ/);
    run('setConfig_({ ROUND_STATUS: "SETUP" })');
    assert.throws(() => run('apiCountClose("EMP-K")'), /กำลังนับ/);
    run('setConfig_({ ROUND_STATUS: "COUNTING" })');
  });
  test('ปิดการนับ: Admin_Log ไม่ติด → ไม่เปลี่ยนสถานะ (fail closed)', () => {
    AL.dropWrites = true;
    assert.throws(() => run('apiCountClose("EMP-K")'), /Admin_Log/);
    AL.dropWrites = false; run('apiAckLogWarn()');
    assert.strictEqual(cfg().ROUND_STATUS, 'COUNTING');
  });
  let closedAt;
  test('ปิดการนับ → COUNT_CLOSED · บันทึกเวลา/ผู้กด · Admin_Log COUNT_CLOSE บอกสถานะ Location และเครื่องตอนกด · กดซ้ำไม่ได้', () => {
    const r = run('apiCountClose("emp-k")');
    const c = cfg();
    closedAt = c.COUNT_CLOSED_AT;
    assert.ok(c.ROUND_STATUS === 'COUNT_CLOSED' && closedAt && c.COUNT_CLOSED_BY === 'EMP-K', JSON.stringify(c));
    assert.ok(r.state.round.status === 'COUNT_CLOSED' && r.state.round.statusTh === 'ปิดการนับแล้ว' && r.state.round.closedBy === 'EMP-K');
    assert.ok(item(r.check, 'K7').ok && !r.check.full);
    const l = lastLog('COUNT_CLOSE');
    assert.ok(l[3] === '2026Q4' && /ผู้กด EMP-K/.test(l[4]) && /Location/.test(l[4]) && /เครื่อง/.test(l[4]) && l[5] === '2026Q4', l[4]);
    assert.throws(() => run('apiCountClose("EMP-K")'), /ปิดการนับไปแล้ว/);
  });
  test('เปิดรอบใหม่ระหว่างปิดการนับไม่ได้ (ต้องปิดรอบก่อน)', () => {
    assert.throws(() => run('apiOpenRound("2027Q1", "2027-01-05", "REAL")'), /ปิดรอบก่อน/);
  });
  test('เครื่องรู้สถานะ: hello / sync ตอบ round = COUNT_CLOSED · bootstrap ก็เป็น COUNT_CLOSED', () => {
    const h = O.call('hello', { pending: 0, location: '' });
    assert.ok(h.ok && h.round === 'COUNT_CLOSED' && h.project === '2026Q4', JSON.stringify(h));
    assert.strictEqual(O.sync([], []).round, 'COUNT_CLOSED');
    assert.strictEqual(O.call('bootstrap').project.status, 'COUNT_CLOSED');
  });
  test('รายการค้างส่งจากก่อนปิด ยังรับเข้า Count_Log (ไม่กักไว้) · นับไว้ · บันทึก SYNC_AFTER_COUNT_CLOSE', () => {
    O.seq = run('deviceMaxSeqAll_("TC21-01")'); O.at = Date.now();   // event id ไม่ซ้ำกับชุดทดสอบก่อนหน้า
    const n0 = CL.data.length;
    const r = O.sync([O.scan('Z1', BC2, MAT2, 1, { scanTime: '2026-11-04 09:00:00' })], []);
    assert.ok(r.accepted.length === 1 && !r.quarantined.length, JSON.stringify(r.quarantined));
    assert.strictEqual(CL.data.length, n0 + 1);
    const l = lastLog('SYNC_AFTER_COUNT_CLOSE');
    assert.ok(l && /รับ 1 รายการ/.test(l[4]) && /ค้างส่งจากก่อนปิด/.test(l[4]), l && l[4]);
    const a = run('afterClose_()');
    assert.ok(a.n === 1 && a.late === 0 && a.last, JSON.stringify(a));
  });
  test('รายการที่ยิงหลังเวลาปิด (เครื่องยังไม่รู้ เช่น ออฟไลน์) → รับ แต่นับเป็น "ยิงหลังเวลาปิด" แจ้งในแผงเงื่อนไข', () => {
    const late = run('now_()');
    O.sync([O.scan('Z1', BC2, MAT2, 1, { scanTime: late >= closedAt ? late : closedAt })], []);
    assert.ok(/ยิงหลังเวลาปิด 1 รายการ/.test(lastLog('SYNC_AFTER_COUNT_CLOSE')[4]));
    const a = K(false).after;
    assert.ok(a.n === 2 && a.late === 1, JSON.stringify(a));
  });
  test('ระหว่างปิดการนับ ผู้ดูแลยังปิด Location ได้ (เหตุการณ์ CLOSE รับตามปกติ)', () => {
    const r = O.sync([], [O.ev('OPEN', 'Z1'), O.ev('CLOSE', 'Z1', { total: 2 })]);
    assert.ok(r.events.length === 2 && r.events[1].match !== 'WAIT', JSON.stringify(r.events));
    assert.ok(/ปิดแล้ว/.test(loc('Z1').Status), loc('Z1').Status + ' ' + JSON.stringify(r.events) + JSON.stringify(mem('Z1','TC21-01')));
  });
  test('K3: เครื่องค้างส่งตามสัญญาณล่าสุด → ✗ บอกเครื่องและจำนวน · ส่งครบ (0) → เครื่องนั้นผ่าน', () => {
    O.call('hello', { pending: 3, location: '' });
    let k3 = item(K(false), 'K3');
    assert.ok(!k3.ok && k3.list.some(x => /^TC21-01: ค้างส่ง 3 รายการ/.test(x)), JSON.stringify(k3.list));
    O.call('hello', { pending: 0, location: '' }); H.call('hello', { pending: 0, location: '' });
    k3 = item(K(false), 'K3');
    assert.ok(k3.list.some(x => /^TC21-01: ค้าง 0/.test(x)) && k3.list.some(x => /^TC21-02: ค้าง 0/.test(x)), JSON.stringify(k3.list));
    const paired = run('apiDevicesState()').devices.filter(d => d.active && d.paired).map(d => d.id);
    assert.strictEqual(k3.ok, paired.every(id => k3.list.some(x => x.indexOf(id + ': ค้าง 0') === 0)));
  });
  test('K4: กระทบยอดก่อนปิดการนับ → ✗ ต้องทำใหม่ · กระทบยอดหลังปิด → ตามผลจริง · มีแถวเข้ามาหลังกระทบยอด → ✗', () => {
    const R0 = JSON.parse(cfg().LAST_RECONCILE || 'null');
    run('setConfig_({ LAST_RECONCILE: _v })', { _v: JSON.stringify(Object.assign({}, R0, { at: '2000-01-01 00:00:00', ok: true, lastRow: CL.data.length })) });
    assert.ok(/ก่อนปิดการนับ/.test(item(K(false), 'K4').detail), item(K(false), 'K4').detail);
    const rec = run('apiReconcile()');
    const k4 = item(K(false), 'K4');
    assert.strictEqual(k4.ok, rec.ok, k4.detail);
    assert.ok(rec.ok ? /ตรงทั้งหมด/.test(k4.detail) : /พบจุดต่าง/.test(k4.detail), k4.detail);
    // บังคับผลตรง แล้วให้มีแถวเพิ่ม → ต้องกระทบยอดใหม่
    run('setConfig_({ LAST_RECONCILE: _v })', { _v: JSON.stringify(Object.assign({}, JSON.parse(cfg().LAST_RECONCILE), { ok: true })) });
    assert.ok(item(K(false), 'K4').ok);
    O.sync([O.scan('Z1', BC2, MAT2, 1, { scanTime: '2026-11-04 09:01:00' })], []);
    assert.ok(/มีรายการเข้ามาหลังกระทบยอด/.test(item(K(false), 'K4').detail));
  });
  test('K5: ยังไม่ได้เทียบตอนตรวจแบบเร็ว · บันทึกผลสรุปหลังปิด → ✓ · ปรับยอดหลังบันทึก → ✗ ตัวเลขเปลี่ยน · บันทึกก่อนปิด → ✗', () => {
    run('apiSummarySave()');
    const sv = JSON.parse(cfg().SUMMARY_SAVED);
    assert.ok(sv.project === '2026Q4' && sv.sig && sv.at >= closedAt);
    assert.ok(!item(K(false), 'K5').ok && /ยังไม่ได้เทียบ/.test(item(K(false), 'K5').detail));
    assert.ok(item(K(), 'K5').ok, item(K(), 'K5').detail);
    run('apiAdjust(_o)', { _o: { material: MAT1, qty: 1, reason: 'RECOUNT', note: '', location: '', staff: 'EMP-K' } });
    assert.ok(/ตัวเลขเปลี่ยนหลังบันทึกครั้งที่/.test(item(K(), 'K5').detail), 'ปรับยอดได้ระหว่างปิดการนับ และ K5 จับได้');
    run('apiAdjustReverse(_i, "EMP-K", "ทดสอบ K5 เสร็จ")', { _i: AJ().slice(-1)[0][0] });   // คืนยอดเดิม (ชุดข้อมูลหน้า Admin ยังมี SKU ปรับเท่าบัญชี)
    run('apiSummarySave()');
    run('setConfig_({ SUMMARY_SAVED: _v })', { _v: JSON.stringify(Object.assign(JSON.parse(cfg().SUMMARY_SAVED), { at: '2000-01-01 00:00:00' })) });
    assert.ok(/บันทึกก่อนปิดการนับ/.test(item(K(), 'K5').detail));
    const rs = run('apiSummarySave()');
    assert.ok(rs.resave && !rs.skipped && !rs.same, 'v2.9.2 ผลเดิมมาก่อนปิดการนับ → บันทึกใหม่ · บอก resave ไม่ใช่ "ไม่ต้องบันทึกซ้ำ"');
    assert.ok(item(K(), 'K5').ok);
  });
  test('K6: Admin_Log เขียนไม่ติดค้างอยู่ → ✗ · กดรับทราบ → ✓', () => {
    AL.dropWrites = true; run('logSys_("TEST", "-", "x")'); AL.dropWrites = false;
    assert.ok(!item(K(false), 'K6').ok);
    run('apiAckLogWarn()');
    assert.ok(item(K(false), 'K6').ok);
  });
  test('K1 / K2: Location ที่ยังไม่ปิดและธงต้องตรวจซ้ำ แสดงชื่อ Location ให้ตามแก้', () => {
    const R = K(false), open = run('apiDevicesState()').locations.filter(l => !/ปิดแล้ว/.test(l.Status));
    const k1 = item(R, 'K1');
    assert.strictEqual(k1.ok, open.length === 0);
    // v2.5.1: แยกบรรทัดตามเครื่องผู้ดูแล "TC21-01 · EMP-K ชื่อ — พัก 2: A1, A3 · กำลังนับ 1: B2" แสดงครบทุกตัว
    const names = l => l.split(' — ')[1].split(' · ').flatMap(p => p.split(': ')[1].split(', '));
    assert.strictEqual(k1.list.map(names).flat().length, open.length, JSON.stringify(k1.list));
    open.forEach(l => {
      const line = k1.list.find(x => names(x).indexOf(String(l.Location)) >= 0);
      assert.ok(line, l.Location);
      assert.ok(l.Owner ? line.indexOf(l.Owner.split(' ')[0]) === 0 : line.indexOf('ไม่มีผู้ดูแล') === 0, line + ' / ' + l.Owner);
      assert.ok(line.indexOf(l.Status + ' ') >= 0, line + ' / ' + l.Status);
    });
    const flagged = run('apiDevicesState()').locations.filter(l => l.Flag_Check);
    assert.strictEqual(item(R, 'K2').ok, flagged.length === 0);
  });
  test('v2.5.1 K3: สัญญาณล่าสุดมาก่อนปิดการนับ (เช่น ปิด Wi-Fi ไว้) → ✗ "ยังไม่ได้ติดต่อหลังปิดการนับ"', () => {
    const c = cfg().COUNT_CLOSED_AT;
    run('setConfig_({ COUNT_CLOSED_AT: "2099-01-01 00:00:00" })');
    const k3 = item(K(false), 'K3');
    assert.ok(!k3.ok && k3.list.some(x => /^TC21-01: ยังไม่ได้ติดต่อหลังปิดการนับ \(สัญญาณล่าสุด \d\d:\d\d ก่อนปิด 00:00\)/.test(x)), JSON.stringify(k3.list));
    run('setConfig_({ COUNT_CLOSED_AT: _c })', { _c: c });
  });
  test('v2.5.1 K4/K5: ไม่มีผลใน Config (ทำก่อนอัปเดต) → บอกครั้งล่าสุดจาก Admin_Log ไม่ใช่ "ยังไม่เคย"', () => {
    const R0 = cfg().LAST_RECONCILE, S0 = cfg().SUMMARY_SAVED;
    run('setConfig_({ LAST_RECONCILE: "", SUMMARY_SAVED: "" })');
    const R = K(false), rec = AL.data.filter(r => r[2] === 'RECONCILE' && r[3] === '2026Q4').slice(-1)[0], sv = AL.data.filter(r => r[2] === 'SUMMARY_SAVE').slice(-1)[0];
    assert.ok(item(R, 'K4').detail.indexOf('กระทบยอดล่าสุด ' + rec[0]) === 0, item(R, 'K4').detail);
    assert.ok(new RegExp('^บันทึกล่าสุด ' + sv[0] + ' ครั้งที่ \\d+ ').test(item(R, 'K5').detail), item(R, 'K5').detail);
    assert.strictEqual(run('lastLogOf_("NO_SUCH", "2026Q4")'), '');
    run('setConfig_({ LAST_RECONCILE: _r, SUMMARY_SAVED: _s })', { _r: R0, _s: S0 });
  });
  test('เปิดการนับอีกครั้ง: ต้องมีเหตุผลและผู้ตรวจสอบ → COUNTING · ล้างเวลาปิด · บันทึก COUNT_REOPEN พร้อมเหตุผลและจำนวนที่รับระหว่างปิด', () => {
    assert.throws(() => run('apiCountReopen("EMP-K", "  ")'), /เหตุผล/);
    assert.throws(() => run('apiCountReopen("", "นับ C12 ใหม่")'), /ผู้ตรวจสอบ/);
    const r = run('apiCountReopen("EMP-KH", "นับทวน C12 ไม่ตรง")');
    const c = cfg();
    assert.ok(c.ROUND_STATUS === 'COUNTING' && !c.COUNT_CLOSED_AT && !c.COUNT_CLOSED_BY && r.state.round.status === 'COUNTING');
    const l = lastLog('COUNT_REOPEN');
    assert.ok(/ผู้กด EMP-KH/.test(l[4]) && /นับทวน C12 ไม่ตรง/.test(l[4]) && /ระหว่างปิดรับ \d+ รายการ \(ยิงหลังปิด 1\)/.test(l[4]), l[4]);
    assert.strictEqual(JSON.stringify(run('afterClose_()')), JSON.stringify({ n: 0, late: 0, last: '' }));
    assert.throws(() => run('apiCountReopen("EMP-K", "ซ้ำ")'), /เฉพาะตอนปิดการนับแล้ว/);
    assert.strictEqual(O.call('hello', { pending: 0, location: '' }).round, 'COUNTING');
    assert.ok(!item(K(false), 'K7').ok && !item(K(false), 'K4').ok, 'กลับมานับ → K7 และ K4 ไม่ผ่าน (ต้องปิดและกระทบยอดใหม่)');
  });
}

// DUMP_ADMIN=ไฟล์ → เก็บ apiDevicesState() ไว้ให้ tests/admin-ui.py ใช้แสดงหน้า Admin จริงในเบราว์เซอร์
if (process.env.DUMP_ADMIN) {
  const st = run('apiDevicesState()');
  st.SUMMARY = run('apiSummary()');
  st.SKU_DETAIL = run('apiSkuDetail(_k)', { _k: MAT1 });
  st.STATE = run('apiGetState()');      // v2.5.0 หน้า Admin ทั้งหน้า (การ์ดปิดการนับ / บันทึก Admin)
  st.KCHECK = run('apiCloseCheck()');
  st.STAFFEDITS = run('apiStaffEdits()'); st.INCIDENTS = run('apiDeviceIncidents()');   // v2.6.1
  // v2.6.0 หน้า Audit (ข้อมูลจริงจากรอบนี้)
  st.AUDIT = { sku: run('apiAudit("sku", _k)', { _k: MAT1 }), edits: run('apiAudit("sku", _k, { edits: true })', { _k: MAT1 }), loc: run('apiAudit("loc", "D80")'),
    staff: run('apiAudit("staff", "EMP-C")'), choices: run('apiAudit("sku", "A112101UT0")') };
  require('fs').writeFileSync(process.env.DUMP_ADMIN, JSON.stringify(st));
}

console.log('\nผล: ผ่าน ' + pass + ' / ไม่ผ่าน ' + fail);
process.exit(fail ? 1 : 0);
