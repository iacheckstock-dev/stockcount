"""
หน้า Admin ในเบราว์เซอร์ (v2.3.6): กล่องยืนยันกลางหน้าแทน confirm()/prompt() + ยอดแยกเครื่องหลังล้าง Location
  DUMP_ADMIN=/tmp/admin-state.json node tests/multi-test.js && python3 tests/admin-ui.py
google.script.run จำลอง: คืน state ที่ได้จาก gas-env จริง และจดคำสั่งที่ถูกเรียก
"""
import json, os, re, sys
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATE = os.environ.get('ADMIN_STATE', '/tmp/admin-state.json')
st = json.load(open(STATE))
html = open(os.path.join(ROOT, 'gas', 'Admin.html'), encoding='utf-8').read()
stub = """<script>
window.CALLS = [];
window.google = { script: { run: (function mk(ok, bad) {
  return new Proxy({}, { get: function (t, k) {
    if (k === 'withSuccessHandler') return function (f) { return mk(f, bad); };
    if (k === 'withFailureHandler') return function (f) { return mk(ok, f); };
    return function () { CALLS.push([k].concat([].slice.call(arguments))); var r = k === 'apiDevicesState' || k.indexOf('apiLoc') === 0 || k === 'apiPairCode' ? window.ST : {};
      setTimeout(function () { ok && ok(r); }, 0); };
  } });
})() } };
</script>"""
html = html.replace('<script>', stub + '<script>', 1)
P = F = 0
def check(c, m):
    global P, F
    if c: P += 1; print('  ✓ ' + m)
    else: F += 1; print('  ✗ ' + m)

with sync_playwright() as p:
    b = p.chromium.launch(); pg = b.new_page()
    dialogs = []
    pg.on('dialog', lambda d: (dialogs.append(d.message), d.dismiss()))
    pg.set_content(html, wait_until='load')
    pg.evaluate('st => { window.ST = st; }', st)
    pg.evaluate('renderDevices(window.ST)')
    row = pg.locator('#locTbl tr', has_text='D3').first.inner_text()
    print('D3:', row.replace('\n', ' | '))
    check('ล้างทั้ง Location เมื่อ' in row and 'โดย TC21-01' in row, 'ใต้ Location บอกเวลาและเครื่องที่ล้าง')
    check(not re.search(r'-\d[\d,.]* ชิ้น', row), 'ไม่มียอดติดลบในเครื่องที่ร่วมนับ')
    check('TC21-02 ผู้ช่วย' in row and '0 ชิ้น' in row and '1 ชิ้น' in row, 'ผู้ช่วย 0 ชิ้น · ผู้ดูแล 1 ชิ้น')

    # ส่งงานแทน: ต้องใส่เหตุผล ปุ่มกดไม่ได้จนกว่าจะใส่
    pg.evaluate("submitFor('W1', 'TC21-03')")
    check(pg.is_visible('#askDlg') and 'ส่งงานแทน TC21-03 ที่ W1' in pg.inner_text('#askTitle'), 'ส่งงานแทน → กล่องกลางหน้า')
    check(pg.is_disabled('#askOk') and pg.is_visible('#askNeed'), 'ยังไม่ใส่เหตุผล → ปุ่มกดไม่ได้ + ตัวแดง')
    pg.fill('#askWhy', 'แบตหมด'); 
    check(not pg.is_disabled('#askOk') and not pg.is_visible('#askNeed'), 'ใส่เหตุผลแล้ว → กดได้')
    pg.click('#askOk'); pg.wait_for_timeout(50)
    c = pg.evaluate('CALLS'); check(['apiLocSubmitFor', 'W1', 'TC21-03', 'แบตหมด'] in c, 'เรียก apiLocSubmitFor พร้อมเหตุผล')
    check(not pg.is_visible('#askDlg'), 'กล่องปิดหลังกด')

    # ยกเลิก → ไม่เรียกอะไร
    pg.evaluate("CALLS.length = 0; pairCode('TC21-04')")
    check(pg.is_visible('#askDlg') and not pg.is_visible('#askWhyBox'), 'สร้างรหัสจับคู่ → กล่องยืนยัน (ไม่ถามเหตุผล)')
    pg.click('#askDlg >> text=ยกเลิก'); pg.wait_for_timeout(50)
    check(pg.evaluate('CALLS.length') == 0, 'กดยกเลิก → ไม่สร้างรหัส')
    pg.evaluate("pairCode('TC21-04')"); pg.click('#askOk'); pg.wait_for_timeout(50)
    check(pg.evaluate('CALLS')[0][:2] == ['apiPairCode', 'TC21-04'], 'กดสร้างรหัส → เรียก apiPairCode')

    # โอนการดูแล: ไม่มี confirm ซ้อน · ขาดอะไรบอกตัวแดงในกล่อง
    pg.evaluate("CALLS.length = 0; transferLoc('D3')")
    pg.click('#trDlg >> text=โอนการดูแล >> nth=-1'); pg.wait_for_timeout(50)
    check('เลือกเครื่องที่จะรับโอนก่อน' in pg.inner_text('#trNeed'), 'ไม่เลือกเครื่อง → ตัวแดงในกล่อง')
    pg.locator('input[name=trTo]').first.check(); pg.click('#trDlg >> text=โอนการดูแล >> nth=-1'); pg.wait_for_timeout(50)
    check('ต้องใส่เหตุผลก่อน' in pg.inner_text('#trNeed'), 'ไม่ใส่เหตุผล → ตัวแดงในกล่อง')
    pg.fill('#trWhy', 'เครื่องเสีย'); check(pg.inner_text('#trNeed') == '', 'พิมพ์เหตุผล → ตัวแดงหาย')
    pg.click('#trDlg >> text=โอนการดูแล >> nth=-1'); pg.wait_for_timeout(50)
    c = pg.evaluate('CALLS'); check(len(c) == 1 and c[0][0] == 'apiLocTransfer' and c[0][3] == 'เครื่องเสีย', 'โอนทันที (กล่องนี้คือการยืนยัน)')

    # อนุมัติ Master
    pg.evaluate("CALLS.length = 0; S = { master: { hash: 'h1' } }; approve()")
    check(pg.is_visible('#askDlg') and 'อนุมัติ Master' in pg.inner_text('#askTitle'), 'อนุมัติ Master → กล่องยืนยัน')
    pg.click('#askOk'); pg.wait_for_timeout(50)
    check(pg.evaluate('CALLS')[0][0] == 'apiApprove', 'กดอนุมัติ → เรียก apiApprove')
    check(not dialogs, 'ไม่มี popup ของเบราว์เซอร์เลย: ' + json.dumps(dialogs, ensure_ascii=False))
    pg.evaluate("renderDevices(window.ST)")
    pg.screenshot(path='/tmp/admin-ui.png', full_page=True)
    b.close()
print('\nผล: ผ่าน %d / ไม่ผ่าน %d' % (P, F))
sys.exit(1 if F else 0)
