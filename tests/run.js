/**
 * ชุดทดสอบเฟส 1 — รันด้วย: node tests/run.js
 * ไฟล์ตัวอย่างจริงของร้านไม่อยู่ใน repo (มีต้นทุนสินค้า) ให้ชี้ตำแหน่งด้วยตัวแปร:
 *   SAMPLE_SAP=/path/ZMMD002A.xls SAMPLE_POS=/path/Stock_Shop_POS.xls node tests/run.js
 * ถ้าไม่ระบุ จะรันเฉพาะชุดทดสอบข้อมูลสังเคราะห์
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const Core = require(path.join(__dirname, '..', 'gas', 'Core.gs'));

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + '\n    ' + e.message); }
}

// ---------- ข้อมูลสังเคราะห์ ----------
const SAP_H = ['Mat Type', 'PF', 'Plant', 'Material', 'Descriptio', 'Storl', 'Qty-UR', 'Qty-IT', 'Qty-QI', 'Qty-BL', 'UOM',
  'Amt-UR', 'Amt-IT', 'Amt-QI', 'Amt-BL', 'Total Qty', 'Total AMT', 'MOV', 'Flag', 'Settle', 'Barcode', 'Cust-mat'];
function sapRow(plant, mat, qty, bc, cust, opt = {}) {
  return ['ZFG', 'A', plant, mat, opt.desc || 'ITEM ' + mat, 'TB', qty.toFixed(3), (opt.it || 0).toFixed(3), '0.000', '0.000', 'EA',
    (qty * 100).toFixed(5), '0', '0', '0', qty.toFixed(3), (qty * 100).toFixed(5), '100.0000000', '', '', bc, cust];
}
const POS_H = ['Profit', 'Short_Style', 'Cust_Mat', 'Item_No', 'Barcode', 'Retail_Price', 'Grade', 'BOI_Flag', 'Qty_BOI', 'Qty_Sale_in', 'Bal_qty'];
function posRow(mat, bc, cust, qty) { return ['A', cust, cust, mat, bc, 290, 'B', 'N', 0, 0, qty]; }

console.log('\nฟังก์ชันพื้นฐาน');
test('check digit EAN-13 ถูก/ผิด', () => {
  assert.ok(Core.checkDigitOk('8850136212080'));
  assert.ok(Core.checkDigitOk('2101000271839'));
  assert.ok(!Core.checkDigitOk('8850136212081'));
  assert.ok(Core.checkDigitOk('ABC-123'));
});
test('บาร์โค้ดที่เป็นตัวเลข/8.85E+12/มี apostrophe แปลงเป็นข้อความถูกต้อง', () => {
  assert.strictEqual(Core.normBarcode(8850136212080), '8850136212080');
  assert.strictEqual(Core.normBarcode('8.85013621208E+12'), '8850136212080');
  assert.strictEqual(Core.normBarcode("'0012345678905"), '0012345678905');
  assert.strictEqual(Core.normBarcode(' 885 0136212080 '), '8850136212080');
});
test('ตัวเลข SAP ลบท้ายและมีจุลภาค', () => {
  assert.strictEqual(Core.num('5.000-'), -5);
  assert.strictEqual(Core.num('1,234.500'), 1234.5);
});
test('ไฟล์ขาดคอลัมน์ถูกปฏิเสธ', () => {
  const r = Core.parseSap([['Material', 'Plant'], ['X', '8111']]);
  assert.ok(!r.ok && /ขาดคอลัมน์/.test(r.error));
});

console.log('\nสร้าง Barcode_Map');
const baseSap = () => [SAP_H,
  sapRow('8111', 'MAT-A', 5, '8850136212080', 'CA'),
  sapRow('8164', 'MAT-A', 2, '8850136212080', 'CA'),           // หลาย Plant รวมกัน
  sapRow('8111', 'MAT-FILL', 3, '', 'CF'),                      // SAP ไม่มีบาร์โค้ด → เติมจาก POS
  sapRow('8111', 'MAT-ZERO', 0, '0000000000000', 'CZ'),
  sapRow('8111', 'MAT-DIFF', 4, '2101000271839', 'CD'),         // SAP กับ POS คนละบาร์โค้ด
  sapRow('8111', 'MAT-SPEC', 1, '2101000271815', 'CS', { it: 2 })
];
const basePos = () => [POS_H,
  posRow('MAT-A', '8850136212080', 'CA', 7),
  posRow('MAT-FILL', '2101000044679', 'CF', 3),
  posRow('MAT-ZERO', '0000000000000', 'CZ', 0),
  posRow('MAT-DIFF', '2101000051745', 'CD', 4),
  posRow('MAT-SPEC', '2101000271815', 'CS', 1),
  posRow('MAT-POSONLY', '2101000125781', 'CP', 0)
];

test('รวมยอดทุก Plant และยอดหลัก = Qty-UR', () => {
  const sap = Core.parseSap(baseSap());
  assert.strictEqual(sap.materials['MAT-A'].qtyUR, 7);
  assert.deepStrictEqual(sap.plants, ['8111', '8164']);
});
test('กรณีต่าง ๆ ตามตาราง Barcode_Map', () => {
  const m = Core.buildMaster(Core.parseSap(baseSap()), Core.parsePos(basePos()), {}, {});
  const by = mat => m.compare.find(c => c.material === mat);
  assert.strictEqual(by('MAT-A').status, 'MATCH');
  assert.strictEqual(by('MAT-FILL').status, 'FILLED');
  assert.strictEqual(m.rows.find(r => r.material === 'MAT-FILL').source, 'POS_FILL');
  assert.strictEqual(by('MAT-DIFF').status, 'CONFLICT');
  assert.strictEqual(by('MAT-POSONLY').status, 'ONLY_POS');
  assert.strictEqual(m.rows.find(r => r.material === 'MAT-ZERO').barcode, '');
  assert.ok(!m.canApprove, 'มีขัดแย้งค้าง ต้องอนุมัติไม่ได้');
  assert.strictEqual(m.checks.find(c => c.id === 'BAD_BARCODE').count, 1);
  assert.deepStrictEqual(m.special, ['MAT-SPEC']);
});
test('Admin ตัดสินขัดแย้งแล้วอนุมัติได้', () => {
  const m = Core.buildMaster(Core.parseSap(baseSap()), Core.parsePos(basePos()), { 'BC_DIFF|MAT-DIFF': 'ALL' }, {});
  assert.ok(m.canApprove);
  assert.strictEqual(m.rows.filter(r => r.material === 'MAT-DIFF').length, 2);
});
test('บาร์โค้ดเดียวชี้สองรหัส → บล็อกจนกว่าจะเลือก', () => {
  const pos = basePos(); pos.push(posRow('MAT-DUPBC', '8850136212080', 'CX', 1));
  let m = Core.buildMaster(Core.parseSap(baseSap()), Core.parsePos(pos), { 'BC_DIFF|MAT-DIFF': 'ALL' }, {});
  assert.ok(m.conflicts.some(c => c.type === 'BC_MULTI'));
  assert.ok(!m.canApprove);
  m = Core.buildMaster(Core.parseSap(baseSap()), Core.parsePos(pos),
    { 'BC_DIFF|MAT-DIFF': 'ALL', 'BC_MULTI|8850136212080': 'MAT-A' }, {});
  assert.ok(m.canApprove);
  assert.strictEqual(m.rows.find(r => r.material === 'MAT-DUPBC').barcode, '');
});
test('Item_No ซ้ำใน POS → บล็อก', () => {
  const pos = basePos(); pos.push(posRow('MAT-A', '8850136212080', 'CA', 1));
  const m = Core.buildMaster(Core.parseSap(baseSap()), Core.parsePos(pos), { 'BC_DIFF|MAT-DIFF': 'ALL' }, {});
  assert.strictEqual(m.checks.find(c => c.id === 'POS_DUP').count, 1);
  assert.ok(!m.canApprove);
});
test('เช้าวันนับยังไม่มี SAP → ใช้ POS ชั่วคราวและอนุมัติได้', () => {
  const m = Core.buildMaster(null, Core.parsePos(basePos()), {}, {});
  assert.ok(m.canApprove);
  assert.strictEqual(m.rows.find(r => r.material === 'MAT-A').bookSource, 'POS');
  assert.ok(!m.checks.find(c => c.id === 'SAP_LOADED').pass);
});
test('Cust-mat ไม่ตรงและ SAP ไม่มีบาร์โค้ด → ต้องตัดสิน', () => {
  const pos = basePos(); pos[2] = posRow('MAT-FILL', '2101000044679', 'OTHER', 3);
  const m = Core.buildMaster(Core.parseSap(baseSap()), Core.parsePos(pos), { 'BC_DIFF|MAT-DIFF': 'ALL' }, {});
  assert.ok(m.conflicts.some(c => c.type === 'FILL_CUSTMAT'));
  assert.ok(!m.canApprove);
});
test('เตือนวันที่ไฟล์', () => {
  const r = Core.fileDateIssues({ countDate: '2026-11-04', sapFileDate: '2026-11-04', posFileDate: '2026-10-28' });
  assert.strictEqual(r.length, 1);
});

// ---------- ไฟล์จริง ----------
const SAP_FILE = process.env.SAMPLE_SAP, POS_FILE = process.env.SAMPLE_POS;
if (SAP_FILE && POS_FILE) {
  console.log('\nไฟล์จริงของร้าน (4 พ.ย. 2026)');
  const XLSX = require('xlsx');
  const sapText = new TextDecoder('windows-874').decode(fs.readFileSync(SAP_FILE));
  const sap = Core.parseSap(Core.parseTsv(sapText));
  const wb = XLSX.readFile(POS_FILE);
  const pos = Core.parsePos(XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: '' }));
  const m = Core.buildMaster(sap, pos, {}, { countDate: '2026-11-04', sapFileDate: '2026-11-04', posFileDate: '2026-11-04' });
  const ck = id => m.checks.find(c => c.id === id);
  console.log('    สรุป:', JSON.stringify(m.stats));
  console.log('    สถานะ:', JSON.stringify(m.counts));
  m.checks.forEach(c => console.log('    ' + (c.pass ? '✓' : c.level === 'BLOCK' ? '✗' : '!') + ' ' + c.title + ': ' + c.count + (c.note ? ' — ' + c.note : '')));
  test('อ่าน SAP ได้และจับคู่ได้ 703/703', () => {
    assert.ok(sap.ok); assert.ok(pos.ok);
    assert.strictEqual(m.stats.sapMaterials, 703);
    assert.strictEqual(m.stats.matched, 703);
  });
  test('ยอด SAP เท่า POS ทุกรหัส', () => assert.strictEqual(ck('QTY_DIFF').count, 0));
  test('เติมจาก POS 4 รหัส U701UMCK*', () => {
    assert.strictEqual(ck('POS_FILL').count, 4);
    const filled = m.rows.filter(r => r.source === 'POS_FILL').map(r => r.material + '=' + r.barcode).sort();
    console.log('      ' + filled.join(', '));
    assert.ok(filled.every(f => /^U701UMCK/.test(f)));
  });
  test('ไม่มีรายการระดับบล็อก อนุมัติได้', () => assert.ok(m.canApprove, JSON.stringify(m.checks.filter(c => c.level === 'BLOCK' && !c.pass))));
  test('POS 2,330 รหัส', () => assert.strictEqual(m.stats.posItems, 2330));
} else {
  console.log('\n(ข้ามการทดสอบไฟล์จริง: ไม่ได้ระบุ SAMPLE_SAP / SAMPLE_POS)');
}

console.log('\nผล: ผ่าน ' + pass + ' / ไม่ผ่าน ' + fail);
process.exit(fail ? 1 : 0);
