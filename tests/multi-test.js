/**
 * ทดสอบหลายเครื่องนับ Location เดียวกัน (v2.2.0): ผู้ดูแล / ผู้ช่วย / ส่งงาน / พัก / ปิด / Control ต่าง ๆ
 * SAMPLE_SAP=... SAMPLE_POS=... node tests/multi-test.js
 */
const assert = require('assert');
const { createEnv, loadSamples } = require('./gas-env');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + '\n    ' + (e.stack || e.message).split('\n').slice(0, 4).join('\n    ')); }
}

const env = createEnv();
const { sap, pos } = loadSamples(env.ctx.Core);
const run = (c, v) => env.run(c, Object.assign({ _sap: sap, _pos: pos }, v || {}));
run('setupSheets()');
run('apiOpenRound("2026Q4", "2026-11-04")');
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
test('ก เช็ก D80 → เห็นผู้ดูแล นาย ค; เข้าร่วม → ผู้ช่วย', () => {
  const i = K.info('D80');
  assert.strictEqual(i.owner.device, 'TC21-01');
  assert.strictEqual(i.owner.name, 'นาย ค');
  assert.strictEqual(i.me, null);
  const r = K.sync([], [K.ev('JOIN', 'D80')]);
  assert.strictEqual(r.events[0].role, 'HELPER');
  assert.strictEqual(r.events[0].owner, 'TC21-01');
});
test('ข เปิด D80 ตอนออฟไลน์ (ส่ง OPEN ไม่ใช่ JOIN) → เซิร์ฟเวอร์ตัดสินเป็นผู้ช่วย', () => {
  const r = KH.sync([KH.scan('D80', BC2, MAT2, 2)], [KH.ev('OPEN', 'D80')]);
  assert.strictEqual(r.events[0].role, 'HELPER');
  assert.ok(/เป็นผู้ช่วย/.test(env.sheets.Loc_Checks.data.slice(-1)[0][12]));
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
  assert.strictEqual(loc('D80').Status_Detail, '3 เครื่อง · ผู้ช่วยส่งงานแล้ว 0/2');
});
test('สองเครื่องเปิด Location ใหม่พร้อมกัน → เครื่องแรกเป็นผู้ดูแล อีกเครื่องเป็นผู้ช่วย', () => {
  const a = K.sync([], [K.ev('OPEN', 'A30')]), b = KH.sync([], [KH.ev('OPEN', 'A30')]);
  assert.strictEqual(a.events[0].role, 'OWNER');
  assert.strictEqual(b.events[0].role, 'HELPER');
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
  assert.ok(/กลับมาช่วยอีกครั้ง/.test(env.sheets.Loc_Checks.data.slice(-1)[0][12]));
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
  const r = C.sync([], [C.ev('CLOSE', 'D80', { total: 14 })]);
  assert.strictEqual(r.events[0].state, 'CLOSED');
  assert.strictEqual(loc('D80').Status, 'ปิดแล้ว');
  assert.ok(/ปิดขณะผู้ช่วยยังไม่ส่งงาน \(TC21-03\)/.test(loc('D80').Flag), loc('D80').Flag);
});
test('ผู้ดูแลเปิดแก้ไข → ทุกคนส่งงานครบ → ปิดด้วยยอดตรง → ธงเดิมยังอยู่ (v2.2.8: หายได้เฉพาะล้างนับใหม่/หัวหน้าทีมปิดธง)', () => {
  C.sync([], [C.ev('OPEN', 'D80')]);
  assert.strictEqual(loc('D80').Status, 'กำลังนับ');
  KH.sync([], [KH.ev('SUBMIT', 'D80')]);
  const before = loc('D80').Flag;
  const total = C.info('D80').total;
  C.sync([], [C.ev('CLOSE', 'D80', { total })]);
  assert.strictEqual(loc('D80').Flag, before, 'ปิดถูกต้องไม่เพิ่มธงใหม่ และไม่ลบธงเดิม');
  assert.strictEqual(loc('D80').Status_Detail, '3 เครื่อง · ผู้ช่วยส่งงานแล้ว 2/2');
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
test('หัวหน้าทีมส่งงานแทนผู้ช่วย (บันทึกผู้กด) / ส่งงานแทนผู้ดูแลไม่ได้', () => {
  KH.sync([KH.scan('A30', BC1, MAT1, 2)]);
  run('apiLocSubmitFor("A30", "TC21-03", "แบตหมด")');
  assert.strictEqual(mem('A30', 'TC21-03').state, 'SUBMITTED');
  assert.strictEqual(mem('A30', 'TC21-03').subBy, 'ADMIN');
  assert.ok(/แทนโดยหัวหน้าทีม/.test(loc('A30').Members));
  assert.ok(env.sheets.Admin_Log.data.some(r => r[2] === 'LOC_SUBMIT_FOR'));
  assert.throws(() => run('apiLocSubmitFor("A30", "TC21-02", "")'), /โอนการดูแล/);
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
  r2('setupSheets()'); r2('apiOpenRound("2026Q4", "2026-11-04")');
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

console.log('\nผล: ผ่าน ' + pass + ' / ไม่ผ่าน ' + fail);
process.exit(fail ? 1 : 0);
