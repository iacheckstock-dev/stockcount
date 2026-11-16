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
    return function () { CALLS.push([k].concat([].slice.call(arguments))); var r = k === 'apiReconcile' ? window.RECON : k === 'apiSummary' ? window.ST.SUMMARY : k === 'apiSummarySave' ? Object.assign({}, window.ST.SUMMARY, { run: 3, saved: 9, same: !!window.SAME, prevAt: '2026-11-16 10:58:15', lastSave: { run: 3, at: window.ST.SUMMARY.at } }) : k === 'apiAdjust' || k === 'apiAdjustReverse' ? Object.assign({}, window.ST.SUMMARY, { adjDone: { id: 'ADJ-0099', material: 'A112101UT0550XK', name: 'SHIRT', qty: -1, before: 10, after: 9, book: 52, reversed: k === 'apiAdjustReverse' ? 'ADJ-0001' : '' } }) : k === 'apiSkuDetail' ? window.ST.SKU_DETAIL : k === 'apiDevicesState' || k.indexOf('apiLoc') === 0 || k === 'apiPairCode' ? window.ST : {};
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
    # กระทบยอดทั้งรอบ + คำเตือนบันทึก Admin_Log ไม่สำเร็จ (v2.3.8)
    pg.evaluate("""window.RECON = { at: '2026-11-12 16:30:00', ok: false, locs: 20, closed: 15, qty: 1234, lines: 900,
      indexDiffs: ['T9 TC21-01 ดัชนี 38/38 ชีต 38/37'], closeDiffs: [{ loc: 'T9', close: 39, sheet: 38, flag: '' }, { loc: 'D6', close: 30, sheet: 32, flag: 'มีรายการหลังปิด' }], missing: [],
      audit: { lastRow: 4009, rows: 3495, blank: 513, blankRows: [2416, 2417], noTime: 3223, noScan: 3223, noRecv: 3223, noTimeRows: [100, 2214], dupIds: 0, dupRows: [],
        devices: [{ dev: 'TC21-01', min: 1, max: 2374, count: 2374, missing: 0, missingList: [], dup: 0 }, { dev: 'TC21-02', min: 1, max: 1121, count: 1120, missing: 1, missingList: [700], dup: 0 }], seqOk: false, ok: false } };
      var orig = google.script.run; """)
    pg.evaluate("CALLS.length = 0; ST.logWarn = { n: 2, last: '2026-11-12 15:10:00', what: 'LOC_SUBMIT_FOR D6 TC21-02', why: 'บันทึก Admin_Log ไม่สำเร็จ' }; renderDevices(ST)")
    w = pg.inner_text('#logWarn')
    check(pg.is_visible('#logWarn') and '2 ครั้ง' in w and 'LOC_SUBMIT_FOR' in w, 'แถบแดงเตือนบันทึก Admin_Log ไม่สำเร็จ: ' + w.replace('\n', ' ')[:80])
    pg.click('#logWarn >> text=รับทราบ'); pg.wait_for_timeout(50)
    check(pg.evaluate('CALLS')[0][0] == 'apiAckLogWarn', 'กดรับทราบ → apiAckLogWarn')
    pg.evaluate("ST.logWarn = null")
    check(pg.locator('text=กระทบยอดทั้งรอบ').count() >= 1, 'มีปุ่มกระทบยอดทั้งรอบในตาราง Location')
    # สรุปผลนับ (v2.4.0)
    pg.evaluate("CALLS.length = 0; document.querySelector('#nav button[data-t=summary]').click()"); pg.wait_for_timeout(200)
    body = pg.inner_text('#sumBody')
    check('ภาพรวมทั้งร้าน' in body and 'ความครบของการนับ' in body and 'ผลต่างราย SKU' in body, 'แท็บสรุปผลนับ: 3 ส่วน')
    check(pg.evaluate('CALLS')[0][0] == 'apiSummary', 'เปิดแท็บ → apiSummary')
    check('ยังนับไม่ครบ' in body, 'มี Location ยังไม่ปิด → ป้าย "ยังนับไม่ครบ"')
    check('F2' in pg.inner_text('#sumBody'), 'เลข Location ที่หาย (F2) แสดงในตาราง')
    n_diff = pg.locator('#skuTbl tr.click').count()
    pg.click('#sumBody >> text=ไม่มีใน Master >> nth=-1'); pg.wait_for_timeout(100)
    check('9999999999999' in pg.inner_text('#skuTbl'), 'กรอง "ไม่มีใน Master" → เห็นบาร์โค้ดที่ยิงแต่ไม่มีรหัส')
    pg.click('#sumBody button:has-text("ทั้งหมด") >> nth=1'); pg.wait_for_timeout(100)
    pg.fill('#sumQ', 'A112101UT0450XK'); pg.wait_for_timeout(100)
    pg.locator('#skuTbl tr.click').first.click(); pg.wait_for_timeout(150)
    sd = pg.inner_text('#skuDlg')
    check(pg.is_visible('#skuDlg') and 'F1' in sd and 'TC21-01' in sd and 'รวม' in sd, 'แตะ SKU → เห็น Location / เครื่อง / ผู้นับ: ' + sd.replace('\n', ' ')[:100])
    pg.click('#skuDlg .btn.sec'); pg.wait_for_timeout(50)
    # v2.4.1: ตาราง SKU มีบาร์โค้ด + Location=ชิ้น
    pg.fill('#sumQ', ''); pg.wait_for_timeout(50)
    hdr = pg.inner_text('#skuTbl tr >> nth=0')
    check(hdr.split('\t')[:4] == ['Material', 'บาร์โค้ด', 'ชื่อ', 'นับ (เครื่อง)'] and 'Location=ชิ้น' in hdr, 'หัวตาราง SKU เรียงแบบไฟล์เดิม: ' + hdr.replace('\t', ' | '))
    pg.fill('#sumQ', '8858684826179'); pg.wait_for_timeout(50)
    r1 = pg.inner_text('#skuTbl tr.click >> nth=0')
    check('A112101UT0450XK' in r1 and '8858684826179' in r1 and re.search(r'F1=\d', r1) and 'F2=1, F10=' in r1, 'ค้นด้วยบาร์โค้ดได้ · Location เรียง F2 ก่อน F10: ' + r1.replace('\t', ' | ')[:160])
    pg.fill('#sumQ', ''); pg.wait_for_timeout(50)
    pg.click('text=สรุปผลและบันทึก'); pg.wait_for_timeout(50)
    check(pg.is_visible('#askDlg') and pg.is_visible('#askCancel'), 'สรุปผลและบันทึก → กล่องยืนยัน (มีปุ่มยกเลิก)')
    pg.click('#askOk'); pg.wait_for_timeout(150)
    check(any(c[0] == 'apiSummarySave' for c in pg.evaluate('CALLS')), 'ยืนยัน → apiSummarySave')
    box = pg.inner_text('#askDlg')
    check(pg.is_visible('#askDlg') and 'บันทึกผลครั้งที่ 3 แล้ว' in box and 'เพิ่ม 9 แถว' in box and not pg.is_visible('#askCancel') and 'ตัวเลขเหมือน' not in box,
          'หลังบันทึก → กล่องผลกลางจอ ปุ่มเดียว (ไม่ใช่ toast): ' + box.replace('\n', ' ')[:120])
    check(not pg.is_visible('#toast') or 'บันทึก' not in pg.inner_text('#toast'), 'ผลบันทึกไม่ใช้ toast ล่างจอ')
    pg.click('#askOk'); pg.wait_for_timeout(50)
    pg.evaluate('window.SAME = true'); pg.click('text=สรุปผลและบันทึก'); pg.wait_for_timeout(50); pg.click('#askOk'); pg.wait_for_timeout(150)
    box = pg.inner_text('#askDlg')
    check('ตัวเลขเหมือนครั้งที่ 2' in box and '10:58:15' in box, 'บันทึกโดยผลไม่เปลี่ยน → เตือนในกล่อง: ' + box.replace('\n', ' ')[-120:])
    pg.click('#askOk'); pg.wait_for_timeout(50)
    pg.screenshot(path='/tmp/admin-summary.png', full_page=True)
    # ใบเดินตรวจ
    pg.click('text=พิมพ์ใบเดินตรวจ'); pg.wait_for_timeout(50)
    check(pg.is_visible('#walkDlg'), 'พิมพ์ใบเดินตรวจ → กล่องเลือกแบบ')
    pg.click('#walkDlg >> text=ดูตัวอย่าง'); pg.wait_for_timeout(100)
    wd = pg.inner_text('#walkDoc')
    check(pg.is_visible('#walk') and 'ใบเดินตรวจ' in wd and 'นับทวนได้' in wd and 'Location=ชิ้น' in wd and 'ผลบันทึกครั้งที่ 3' in wd and 'ไม่มีใน Master' in wd and 'ผู้ตรวจสอบ' in wd,
          'แบบ SKU: มีช่องนับทวน · Location=ชิ้น · อ้างอิงครั้งที่บันทึก · บาร์โค้ดไม่มีใน Master · ช่องลงชื่อ')
    check('บาท' not in wd.replace('ต่างตั้งแต่', ''), 'ใบพิมพ์ไม่มีมูลค่า (บาท)')
    pg.pdf(path='/tmp/walk-sku.pdf', prefer_css_page_size=True)
    pg.click('#walk >> text=ปิด'); pg.click('text=พิมพ์ใบเดินตรวจ'); pg.check('input[name=wkSort][value=loc]'); pg.fill('#wkMin', '100')
    pg.click('#walkDlg >> text=ดูตัวอย่าง'); pg.wait_for_timeout(100)
    wd = pg.inner_text('#walkDoc'); heads = pg.eval_on_selector_all('#walkDoc .grp h3', 'e => e.map(x => x.textContent.split(" ")[0])')
    fs = [h for h in heads if h.startswith('F')]
    check('เรียงตาม Location' in wd and 'ต่างตั้งแต่ 100 บาท' in wd and 'นับที่นี่' in wd and fs == sorted(fs, key=lambda x: int(re.sub(r'\D', '', x) or 0)), 'แบบ Location: จัดกลุ่มทีละจุด เรียงแบบคน: ' + ' '.join(heads[:12]))
    pg.emulate_media(media='print')
    check(pg.is_visible('#walkDoc') and not pg.is_visible('#nav') and not pg.is_visible('#walk .bar'), 'ตอนพิมพ์: เห็นเฉพาะใบเดินตรวจ')
    pg.pdf(path='/tmp/walk-loc.pdf', prefer_css_page_size=True)
    ws = pg.eval_on_selector_all('#walkDoc .grp table', 'ts => ts.filter(t => t.querySelectorAll("col").length === 9).slice(0, 8).map(t => Array.from(t.querySelectorAll("thead tr:last-child th")).map(th => Math.round(th.getBoundingClientRect().width)).join(","))')
    check(len(ws) >= 3 and len(set(ws)) == 1, 'แบบ Location: ความกว้างคอลัมน์ทุกกลุ่มเท่ากัน (เส้นตารางตรงกัน · G8-7): ' + ' | '.join(ws))
    pg.emulate_media(media='screen'); pg.click('#walk >> text=ปิด')
    # หน้ากระดาษ A4 แนวนอน + หัวตารางพิมพ์ซ้ำทุกหน้า (v2.4.2)
    import subprocess
    pg.click('text=พิมพ์ใบเดินตรวจ'); pg.check('input[name=wkSort][value=sku]'); pg.check('input[name=wkF][value=all]'); pg.fill('#wkMin', '')
    pg.click('#walkDlg >> text=ดูตัวอย่าง'); pg.wait_for_timeout(150); pg.emulate_media(media='print')
    pg.pdf(path='/tmp/walk-sku-all.pdf', prefer_css_page_size=True); pg.emulate_media(media='screen'); pg.click('#walk >> text=ปิด')
    info = subprocess.run(['pdfinfo', '/tmp/walk-sku-all.pdf'], capture_output=True, text=True).stdout
    size = re.search(r'Page size:\s+([\d.]+) x ([\d.]+)', info); pages = int(re.search(r'Pages:\s+(\d+)', info).group(1))
    check(size and float(size.group(1)) > float(size.group(2)) and abs(float(size.group(1)) - 841.9) < 2, 'PDF เป็น A4 แนวนอน: ' + (size.group(0) if size else info[:80]))
    heads = [subprocess.run(['pdftotext', '-f', str(i), '-l', str(i), '/tmp/walk-sku-all.pdf', '-'], capture_output=True, text=True).stdout for i in (2, 3)]
    check(pages >= 3 and all('Material' in t and 'นับทวนได้' in t and 'ใบเดินตรวจ' in t for t in heads), 'หัวตาราง + ชื่อชุดพิมพ์ซ้ำหน้า 2 และ 3 (%d หน้า): ' % pages + heads[0][:150].replace('\n', ' '))
    # ปรับยอดด้วยมือ (v2.4.2)
    sb = pg.inner_text('#sumBody')
    check('4. ปรับยอดด้วยมือ' in sb and 'นับทวนกับพนักงานหน้าร้าน:' in sb and 'ถูกกลับโดย' in sb and 'กลับ ADJ-' in sb, 'ส่วนที่ 4 ปรับยอด: ยอดตามเหตุผล + บรรทัดกลับรายการเห็นคู่กัน')
    check('ปรับเท่าบัญชี' in sb, 'ป้ายปรับเท่ายอดบัญชีพอดีขึ้นในภาพรวม')
    pg.evaluate('CALLS.length = 0'); pg.click('text=+ ปรับยอด'); pg.wait_for_timeout(50)
    check(pg.is_visible('#adjDlg') and pg.is_disabled('#adjOk') and 'ใส่รหัสสินค้า' in pg.inner_text('#adjNeed'), 'เปิดฟอร์ม: ยังไม่กรอก → ปุ่มบันทึกกดไม่ได้ + บอกสิ่งที่ขาด')
    pg.fill('#adjMat', 'NOPE'); check('ไม่พบรหัสนี้ใน Master' in pg.inner_text('#adjNeed'), 'รหัสไม่มีใน Master → บอกในฟอร์ม')
    pg.fill('#adjMat', '8858153867481'); pg.fill('#adjQty', '-1'); pg.check('input[name=adjR][value=OTHER]'); pg.select_option('#adjStaff', 'EMP-K'); pg.wait_for_timeout(50)
    info = pg.inner_text('#adjInfo')
    check('A112101UT0550XK' in info and 'หลังบันทึก' in info and pg.is_disabled('#adjOk') and 'อื่น ๆ' in pg.inner_text('#adjNeed'), 'ค้นด้วยบาร์โค้ด · เห็นยอดก่อน→หลัง · "อื่น ๆ" ไม่มีหมายเหตุ → ยังบันทึกไม่ได้')
    pg.fill('#adjNote', 'ของตัวอย่างหน้าร้าน'); pg.wait_for_timeout(30)
    check(not pg.is_disabled('#adjOk') and pg.inner_text('#adjNeed') == '', 'กรอกครบ → กดบันทึกได้')
    r = [x for x in pg.evaluate('SUM.skus') if x[0] == 'A112101UT0550XK'][0]
    pg.fill('#adjQty', str(-r[6])); pg.wait_for_timeout(30)
    check('ปรับเท่ายอดบัญชีพอดี' in pg.inner_text('#adjInfo') or r[6] == 0, 'จำนวนที่ทำให้ต่าง = 0 → เตือนว่าจะติดป้าย')
    pg.fill('#adjQty', '-1'); pg.click('#adjOk'); pg.wait_for_timeout(150)
    c = [x for x in pg.evaluate('CALLS') if x[0] == 'apiAdjust']
    check(c and c[0][1] == {'material': '8858153867481', 'qty': '-1', 'reason': 'OTHER', 'note': 'ของตัวอย่างหน้าร้าน', 'location': '', 'staff': 'EMP-K'}, 'กดบันทึก → apiAdjust พร้อมข้อมูลครบ: ' + json.dumps(c[0][1] if c else None, ensure_ascii=False))
    box = pg.inner_text('#askDlg')
    check(pg.is_visible('#askDlg') and 'บันทึกปรับยอด ADJ-0099 แล้ว' in box and '10 → 9' in box and not pg.is_visible('#askCancel'), 'ผลบันทึกในกล่องกลางจอ: ' + box.replace('\n', ' ')[:100])
    pg.click('#askOk'); pg.evaluate('CALLS.length = 0')
    pg.locator('#sumBody button:has-text("กลับรายการ")').first.click(); pg.wait_for_timeout(50)
    check(pg.is_visible('#askDlg') and 'กลับรายการ ADJ-' in pg.inner_text('#askTitle') and pg.is_disabled('#askOk'), 'กลับรายการ → กล่องถามเหตุผล (บังคับ)')
    pg.select_option('#revStaff', 'EMP-KH'); pg.fill('#askWhy', 'คีย์จำนวนผิด'); pg.click('#askOk'); pg.wait_for_timeout(150)
    c = [x for x in pg.evaluate('CALLS') if x[0] == 'apiAdjustReverse']
    check(c and c[0][2:] == ['EMP-KH', 'คีย์จำนวนผิด'] and c[0][1].startswith('ADJ-'), 'ยืนยัน → apiAdjustReverse(เลขที่, ผู้คีย์, เหตุผล)')
    pg.click('#askOk')
    pg.fill('#sumQ', 'A112101UT0450XK'); pg.click('#sumBody button:has-text("ทั้งหมด") >> nth=1'); pg.wait_for_timeout(50)
    pg.locator('#skuTbl tr.click').first.click(); pg.wait_for_timeout(150)
    sd = pg.inner_text('#skuDlg')
    check('ปรับยอดด้วยมือ' in sd and 'ADJ-' in sd, 'แตะ SKU → เห็นบรรทัดปรับยอดของ SKU นั้น')
    pg.click('#skuDlg >> text=ปรับยอด SKU นี้'); pg.wait_for_timeout(50)
    check(pg.is_visible('#adjDlg') and pg.input_value('#adjMat') == 'A112101UT0450XK' and pg.input_value('#adjStaff') == 'EMP-KH', 'ปุ่ม "ปรับยอด SKU นี้" → ฟอร์มใส่รหัสให้ + จำผู้คีย์ล่าสุด')
    pg.click('#adjDlg >> text=ยกเลิก'); pg.fill('#sumQ', '')
    check(not dialogs, 'ไม่มี popup ของเบราว์เซอร์เลย: ' + json.dumps(dialogs, ensure_ascii=False))
    pg.evaluate("CALLS.length = 0; reconcile()"); pg.wait_for_timeout(100)
    rc = pg.inner_text('#recon')
    check('พบจุดต่าง' in rc and 'T9 ปิด 39' in rc and 'มีธงต้องตรวจซ้ำอยู่แล้ว' in rc, 'ผลกระทบยอดแสดงจุดต่าง แยกที่มีธงแล้ว: ' + rc.replace('\n', ' ')[:120])
    check('แถวว่าง / ไม่มี Log_ID: 513 แถว' in rc and 'เช่น แถว 2416, 2417' in rc and 'เวลาหาย (Scan_Time / Received_Time): 3,223 รายการ' in rc and 'TC21-01 Seq 1–2374 ครบ' in rc and 'TC21-02 Seq 1–1121 ขาด 1 (700)' in rc,
          'ผลกระทบยอดแสดงโครงชีต Count_Log: ' + rc[rc.find('โครงชีต'):].replace('\n', ' ')[:200])
    pg.screenshot(path='/tmp/admin-recon.png', full_page=False)
    pg.evaluate("renderDevices(window.ST)")
    pg.screenshot(path='/tmp/admin-ui.png', full_page=True)
    b.close()
print('\nผล: ผ่าน %d / ไม่ผ่าน %d' % (P, F))
sys.exit(1 if F else 0)
