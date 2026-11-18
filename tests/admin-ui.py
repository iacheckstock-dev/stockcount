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
    return function () { CALLS.push([k].concat([].slice.call(arguments)));
      if (window.FAIL && window.FAIL[k]) { var m = window.FAIL[k]; setTimeout(function () { bad && bad({ message: m }); }, 0); return; }
      if (k === 'apiCloseCheck') { setTimeout(function () { ok && ok(window.KFULL || window.ST.KCHECK); }, 0); return; }
      if (k === 'apiCloseCheckFast') { setTimeout(function () { ok && ok(window.KFAST || Object.assign({}, window.ST.KCHECK, { full: false })); }, 0); return; }
      if (k === 'apiCloseRound') { setTimeout(function () { ok && ok(window.CLOSEROUND); }, 0); return; }
      if (k === 'apiVerifyArchive') { setTimeout(function () { ok && ok(window.VERIFY); }, 0); return; }
      if (k === 'apiCountClose' || k === 'apiCountReopen') { setTimeout(function () { ok && ok(window.CLOSERES); }, 0); return; }
      var r = k === 'apiReconcile' ? window.RECON : k === 'apiSummary' ? window.ST.SUMMARY : k === 'apiSummarySave' ? Object.assign({}, window.ST.SUMMARY, { run: 3, saved: 9, same: !!window.SAME, prevAt: '2026-11-16 10:58:15', lastSave: { run: 3, at: window.ST.SUMMARY.at } }) : k === 'apiAdjust' || k === 'apiAdjustReverse' ? Object.assign({}, window.ST.SUMMARY, { adjDone: { id: 'ADJ-0099', material: 'A112101UT0550XK', name: 'SHIRT', qty: -1, before: 10, after: 9, book: 52, reversed: k === 'apiAdjustReverse' ? 'ADJ-0001' : '' } }) : k === 'apiSkuDetail' ? window.ST.SKU_DETAIL : k === 'apiDevicesState' || k.indexOf('apiLoc') === 0 || k === 'apiPairCode' ? window.ST : {};
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

    print('v2.5.0: error กล่องกลางจอ · ปิดการนับ · เงื่อนไขปิดรอบ · บันทึก Admin รอบนี้ · Q8')
    # Q8: จำนวนที่หักล้างบรรทัดเดิมพอดี → เตือนในฟอร์ม แต่ยังบันทึกได้
    pg.evaluate("loadSummary()"); pg.wait_for_timeout(100)
    act = [a for a in pg.evaluate('SUM.adjustments') if not a[10] and not a[11]]
    a0 = act[0]
    pg.click('text=+ ปรับยอด'); pg.fill('#adjMat', a0[2]); pg.fill('#adjQty', str(-a0[4])); pg.check('input[name=adjR][value=RECOUNT]'); pg.select_option('#adjStaff', 'EMP-K'); pg.wait_for_timeout(50)
    info = pg.inner_text('#adjInfo')
    check('หักล้าง' in info and a0[0] in info and 'กลับรายการ' in info and not pg.is_disabled('#adjOk'), 'Q8: คีย์จำนวนตรงข้ามกับ ' + a0[0] + ' → เตือนให้ใช้ "กลับรายการ" แต่ยังกดบันทึกได้')
    pg.screenshot(path='/tmp/admin-q8.png')
    pg.fill('#adjQty', str(-a0[4] + 1)); pg.wait_for_timeout(30)
    check('หักล้าง' not in pg.inner_text('#adjInfo'), 'จำนวนไม่หักล้างพอดี → ไม่เตือน')
    pg.click('#adjDlg >> text=ยกเลิก')
    # error ทุกปุ่มเป็นกล่องกลางจอ (call → withFailureHandler)
    pg.evaluate("window.FAIL = { apiSummarySave: 'มีคนกำลังบันทึกข้อมูลอยู่ ลองใหม่อีกครั้ง' }")
    pg.click('text=สรุปผลและบันทึก'); pg.wait_for_timeout(50); pg.click('#askOk'); pg.wait_for_timeout(150)
    check(pg.is_visible('#errDlg') and 'ทำไม่สำเร็จ' in pg.inner_text('#errTitle') and 'มีคนกำลังบันทึก' in pg.inner_text('#errMsg') and not pg.is_visible('#busy'),
          'บันทึกไม่สำเร็จ → กล่อง ✕ กลางจอ (ไม่ใช่แถบล่าง) · กล่องรอปิดแล้ว (UAT G9-4)')
    pg.screenshot(path='/tmp/admin-err.png')
    pg.wait_for_timeout(9000)
    check(pg.is_visible('#errDlg'), 'กล่อง error ไม่หายเอง (รอ 9 วินาที) ต้องกดรับทราบ')
    pg.click('#errOk'); check(not pg.is_visible('#errDlg'), 'กด "รับทราบ" → ปิด')
    pg.evaluate("toast('ทดสอบข้อความผิด', true)")
    check(pg.is_visible('#errDlg') and not pg.is_visible('#toast'), 'toast แบบ error ทุกจุด → กล่องกลางจอ')
    pg.keyboard.press('Enter'); check(not pg.is_visible('#errDlg'), 'กด Enter ปิดกล่อง error ได้')
    pg.evaluate("window.FAIL = {}")
    # หน้าภาพรวม: การ์ดปิดการนับ (สถานะกำลังนับ)
    pg.evaluate("st => { setState(st); }", st['STATE'])
    pg.click('#nav button[data-t=overview]')
    cb = pg.inner_text('#closeCard')
    check(st['STATE']['round']['status'] == 'COUNTING' and 'กำลังนับ' in cb and pg.is_visible('#closeBox button:has-text("ปิดการนับ")') and 'ตรวจเงื่อนไขปิดรอบ' in cb, 'กำลังนับ: การ์ดมีปุ่ม "ปิดการนับ" + "ตรวจเงื่อนไขปิดรอบ"')
    check('กำลังนับ' in pg.inner_text('#roundTag'), 'ป้ายรอบด้านบนเป็นภาษาไทย: ' + pg.inner_text('#roundTag'))
    pg.evaluate('CALLS.length = 0'); pg.click('#closeBox button:has-text("ปิดการนับ")'); pg.wait_for_timeout(50)
    check(pg.is_visible('#askDlg') and 'ปิดการนับ รอบ 2026Q4' in pg.inner_text('#askTitle') and pg.is_visible('#askStaff') and pg.is_disabled('#askOk') and 'รหัสผู้ตรวจสอบ' in pg.inner_text('#askNeed'),
          'กด "ปิดการนับ" → กล่องอธิบายผล + ต้องเลือกรหัสผู้ตรวจสอบก่อน')
    pg.screenshot(path='/tmp/admin-countclose-ask.png')
    closed = json.loads(json.dumps(st['STATE'])); closed['round'].update({'status': 'COUNT_CLOSED', 'statusTh': 'ปิดการนับแล้ว', 'closedAt': '2026-11-20 17:05:00', 'closedBy': 'EMP-K'})
    k = json.loads(json.dumps(st['KCHECK'])); k['full'] = False
    pg.evaluate("x => { window.CLOSERES = x; }", {'state': closed, 'check': k})
    pg.select_option('#askStaff', 'EMP-K'); check(not pg.is_disabled('#askOk'), 'เลือกรหัสแล้ว → กดได้')
    pg.click('#askOk'); pg.wait_for_timeout(150)
    check(['apiCountClose', 'EMP-K'] in pg.evaluate('CALLS'), 'เรียก apiCountClose(รหัสผู้ตรวจสอบ)')
    box = pg.inner_text('#askDlg')
    check(pg.is_visible('#askDlg') and 'ปิดการนับแล้ว' in box and 'ขั้นต่อไป' in box and not pg.is_visible('#askCancel'), 'ผลในกล่องกลางจอ บอกสถานะ Location / เครื่อง และขั้นต่อไป: ' + box.replace('\n', ' ')[:140])
    pg.click('#askOk')
    cb = pg.inner_text('#closeCard')
    check('ปิดการนับแล้ว' in cb and 'EMP-K' in cb and pg.is_visible('#closeBox button:has-text("เปิดการนับอีกครั้ง")') and 'ปิดการนับแล้ว' in pg.inner_text('#roundTag'), 'การ์ดเปลี่ยนเป็น "ปิดการนับแล้ว" + ปุ่ม "เปิดการนับอีกครั้ง"')
    check('K7' in pg.inner_text('#kList') and 'ยังไม่ได้เทียบตัวเลข K5' in pg.inner_text('#kList'), 'หลังกดปิดแสดงเงื่อนไขทันที (แบบเร็ว ยังไม่เทียบ K5)')
    # ตรวจเงื่อนไขปิดรอบ (ผลจริงจาก gas-env)
    pg.click('#kBox button:has-text("ตรวจเงื่อนไขปิดรอบ")'); pg.wait_for_timeout(150)
    kl = pg.inner_text('#kList'); K = st['KCHECK']
    rows = pg.locator('#kList .klist tr').count()
    check(rows == 7 and all(x['id'] in kl and x['title'][:12] in kl for x in K['items']), 'แผงเงื่อนไขแสดง K1–K7 ครบ 7 แถว')
    bad = [x for x in K['items'] if not x['ok']]
    check(('ยังไม่ครบ %d ข้อ' % len(bad)) in kl and all(x['fix'][:15] in kl for x in bad), 'ข้อที่ไม่ผ่านบอกจำนวนและ "ทำอย่างไร" ทุกข้อ: ' + ', '.join(x['id'] for x in bad))
    check(pg.locator('#kList .klist td.r.x').count() == len(bad) and pg.locator('#kList .klist td.r.y').count() == 7 - len(bad), 'เครื่องหมาย ✓/✗ ตรงกับผลจากเซิร์ฟเวอร์')
    pg.screenshot(path='/tmp/admin-kpanel.png', full_page=True)
    # เปิดการนับอีกครั้ง: ต้องมีเหตุผล + ผู้ตรวจสอบ
    pg.evaluate('CALLS.length = 0'); pg.click('#closeBox button:has-text("เปิดการนับอีกครั้ง")'); pg.wait_for_timeout(50)
    check(pg.is_disabled('#askOk') and 'เหตุผล' in pg.inner_text('#askNeed') and pg.is_visible('#askWhy') and pg.is_visible('#askStaff'), 'เปิดการนับอีกครั้ง → ต้องใส่เหตุผล (บังคับ) + ช่องรหัสผู้ตรวจสอบ')
    check(pg.input_value('#askStaff') == 'EMP-K', 'จำรหัสผู้ตรวจสอบล่าสุดไว้ให้')
    pg.fill('#askWhy', 'นับทวน C12 ไม่ตรง'); pg.evaluate("x => { window.CLOSERES = x; }", {'state': st['STATE'], 'check': k})
    pg.click('#askOk'); pg.wait_for_timeout(150)
    check(['apiCountReopen', 'EMP-K', 'นับทวน C12 ไม่ตรง'] in pg.evaluate('CALLS'), 'เรียก apiCountReopen(รหัส, เหตุผล)')
    pg.click('#askOk')
    # บันทึก Admin: รอบนี้ / ทุกรอบ
    pg.click('#nav button[data-t=log]')
    L = st['STATE']['log']
    n = pg.locator('#logTbl tr').count() - 1
    check(n == len(L['cur']) and 'รอบ 2026Q4' in pg.inner_text('#logInfo') and pg.locator('#logTbl tr >> nth=0').inner_text().split('\t')[-1] == 'รอบ', 'บันทึก Admin แสดงเฉพาะรอบนี้ + คอลัมน์รอบ: ' + pg.inner_text('#logInfo'))
    pg.check('#logAll'); pg.wait_for_timeout(30)
    check(pg.locator('#logTbl tr').count() - 1 == len(L['all']) and 'ทุกรอบ' in pg.inner_text('#logInfo'), 'ติ๊ก "แสดงทุกรอบ" → เห็นทุกรอบ')

    print('v2.5.1: ตาราง Location กรอง/ค้นหา · ค้นหา SKU ทุกกลุ่ม · K1 แยกตามเครื่อง · ตัด "Error:"')
    pg.click('#nav button[data-t=devices]') if pg.locator('#nav button[data-t=devices]').count() else None
    pg.evaluate("st => { LOCF = 'todo'; $('locQ').value = ''; renderDevices(st); }", st)
    L = st['locations']
    todo = [l for l in L if l['Status'] != 'ปิดแล้ว' or l.get('Flag') or l.get('Last_Check') in ('MISMATCH', 'WAIT')]
    closed_ok = [l for l in L if l not in todo]
    sm = pg.inner_text('#locSum')
    check(('ทั้งหมด %d' % len(L)) in sm and ('ปิดแล้ว %d' % sum(1 for l in L if l['Status'] == 'ปิดแล้ว')) in sm and 'มีธง' in sm and 'ยอดไม่ตรง' in sm, 'บรรทัดสรุปจำนวนตามสถานะ: ' + sm)
    rows = lambda: pg.locator('#locTbl tr').count() - 1
    check(rows() == len(todo) and ('ต้องทำต่อ %d' % len(todo)) in pg.inner_text('#locChips'), 'ค่าเริ่มต้น "ต้องทำต่อ" = ยังไม่ปิด / มีธง / ยอดไม่ตรง (%d จาก %d)' % (len(todo), len(L)))
    pg.click('#locChips button:has-text("ปิดแล้ว")')
    got = [t.split('\n')[0] for t in pg.locator('#locTbl tr td:first-child').all_inner_texts()]
    check(sorted(got) == sorted(l['Location'] for l in closed_ok), '"ปิดแล้ว" = ปิดแล้วและไม่มีอะไรต้องทำ: ' + ', '.join(got))
    pg.click('#locChips button:has-text("ทั้งหมด")'); check(rows() == len(L), '"ทั้งหมด" แสดงครบ %d' % len(L))
    pg.click('#locChips button:has-text("ต้องทำต่อ")'); pg.fill('#locQ', 'p3')
    check(rows() == 1 and pg.locator('#locTbl tr td:first-child').first.inner_text().startswith('P3'), 'ค้นหา "p3" เจอ P3 แม้อยู่นอกกลุ่ม "ต้องทำต่อ"')
    pg.fill('#locQ', 'ZZ99'); check('ไม่พบ Location' in pg.inner_text('#locTbl'), 'ค้นหาไม่เจอ → บอกว่าไม่พบ')
    pg.fill('#locQ', '')
    pg.screenshot(path='/tmp/admin-loc.png')
    # ค้นหา SKU ทุกกลุ่ม
    pg.click('#nav button[data-t=summary]'); pg.evaluate("loadSummary()"); pg.wait_for_timeout(100)
    m0 = pg.evaluate("SUM.skus.filter(function (r) { return r[6] === 0; })[0]")
    pg.evaluate("SUMF = 'diff'; renderSum()") if pg.evaluate("typeof renderSum === 'function'") else pg.click('#sumBody button:has-text("ที่ต่างทั้งหมด")')
    pg.fill('#sumQ', m0[0]); pg.wait_for_timeout(30)
    check(pg.locator('#skuTbl tr').count() - 1 == 1 and m0[0] in pg.inner_text('#skuTbl') and 'ค้นหาทุกกลุ่ม' in pg.inner_text('#skuInfo'),
          'กลุ่ม "ที่ต่างทั้งหมด" ค้นหา SKU ที่ต่าง 0 (' + m0[0] + ') → เจอ บอก "ค้นหาทุกกลุ่ม"')
    pg.fill('#sumQ', ''); pg.wait_for_timeout(30)
    check(m0[0] not in pg.inner_text('#skuTbl') and 'ค้นหาทุกกลุ่ม' not in pg.inner_text('#skuInfo'), 'ลบคำค้น → กลับไปใช้ตัวกรอง')
    # K1 แยกบรรทัดตามเครื่อง
    pg.click('#nav button[data-t=overview]'); pg.evaluate("K => { $('kList').innerHTML = kHtml(K); }", st['KCHECK'])
    k1 = [x for x in st['KCHECK']['items'] if x['id'] == 'K1'][0]
    check(pg.locator('#kList .klist tr').first.locator('.lst > div').count() == len(k1['list']) and all(' — ' in x for x in k1['list']), 'K1 หนึ่งบรรทัดต่อเครื่องผู้ดูแล: ' + ' | '.join(k1['list'])[:160])
    pg.evaluate("errBox('Error: รหัสรอบต้องเป็นรูปแบบ 2026Q4')")
    check(pg.inner_text('#errMsg') == 'รหัสรอบต้องเป็นรูปแบบ 2026Q4', 'กล่อง error ตัด "Error:" นำหน้าออก')
    pg.click('#errOk')

    print('v2.5.2: ขั้นตอนปิดรอบในการ์ด · ปิดรอบ (พิมพ์ยืนยัน) · โหมดทดสอบ · ค้าง CLOSING · รอบที่ปิดแล้ว · ไฟล์สำรอง · ประเภทรอบ · ตาราง Location')
    pg.evaluate("st => { setState(st); }", st['STATE'])
    check(pg.locator('#rtype option').count() == 3, 'เปิดรอบ: มีช่องเลือกประเภท รอบจริง / รอบทดลอง')
    pg.evaluate("CALLS.length = 0; $('rtype').value = ''; openRound()"); pg.wait_for_timeout(50)
    check(pg.is_visible('#errDlg') and 'ประเภทรอบ' in pg.inner_text('#errMsg') and not pg.evaluate('CALLS').__len__(), 'ไม่เลือกประเภท → กล่องแจ้ง ไม่เรียกเซิร์ฟเวอร์')
    pg.click('#errOk')
    pg.select_option('#rtype', 'PILOT'); pg.evaluate("openRound()"); pg.wait_for_timeout(50)
    c = [x for x in pg.evaluate('CALLS') if x[0] == 'apiOpenRound']
    check(c and c[0][3] == 'PILOT', 'เรียก apiOpenRound(รหัส, วันนับ, "PILOT")')
    check(st['STATE']['round']['typeTh'] in pg.inner_text('#roundTag'), 'ป้ายรอบบอกประเภท: ' + pg.inner_text('#roundTag'))
    # ปิดการนับแล้ว: ขั้นตอน 1–6 · ข้อมูลจริงจาก gas-env (ยังไม่ผ่านบางข้อ) → ปุ่มปิดรอบกดไม่ได้
    cc = json.loads(json.dumps(closed)); cc['round']['testAllowed'] = False
    pg.evaluate("x => { window.KFAST = null; window.KFULL = null; KCHK = null; setState(x); }", cc); pg.wait_for_timeout(100)
    steps = pg.locator('#stepBox table.steps tr')
    check(steps.count() == 6 and 'ตรวจอีกครั้ง' in pg.inner_text('#stepBox') and 'กระทบยอดทั้งรอบ' in pg.inner_text('#stepBox'), 'การ์ดปิดการนับแล้ว: ขั้นตอน 1–6 พร้อมปุ่มในแต่ละข้อ')
    check(['apiCloseCheckFast'] in pg.evaluate('CALLS'), 'เปิดหน้า → ตรวจแบบเร็วให้เอง')
    check(pg.is_disabled('#stepBox button:has-text("ปิดรอบ")'), 'ยังไม่ผ่านทุกข้อ (แบบเร็ว) → ปุ่ม "ปิดรอบ" กดไม่ได้')
    check(not pg.locator('#stepBox button:has-text("ล้างข้อมูลทดสอบ")').count(), 'รอบที่ไม่ใช่ 2026Q4 → ไม่มีปุ่มล้างข้อมูลทดสอบ')
    pg.screenshot(path='/tmp/admin-steps.png', full_page=False)
    # ผ่านทุกข้อแบบเต็ม → ปุ่มปิดรอบกดได้
    allok = json.loads(json.dumps(st['KCHECK'])); allok.update({'full': True, 'ok': True})
    for x in allok['items']: x['ok'] = True
    pg.evaluate("K => { window.KFULL = K; window.KFAST = Object.assign({}, K, { full: false }); }", allok)
    pg.click('#stepBox button:has-text("ตรวจเงื่อนไข")'); pg.wait_for_timeout(100)
    check(pg.locator('#stepBox td.r.y').count() == 6 and not pg.is_disabled('#stepBox button:has-text("ปิดรอบ")'), 'ตรวจแบบเต็มผ่าน → ✓ ครบ 6 ข้อ ปุ่ม "ปิดรอบ" กดได้')
    pg.evaluate("fastCheck()"); pg.wait_for_timeout(100)
    check(not pg.is_disabled('#stepBox button:has-text("ปิดรอบ")'), 'ตรวจแบบเร็วซ้ำ (Count_Log ไม่เปลี่ยน) → ผลแบบเต็มยังใช้ได้')
    # ปิดรอบ: พิมพ์รหัสรอบให้ตรง + รหัสผู้ตรวจสอบ
    pid = cc['round']['projectId']
    pg.evaluate('CALLS.length = 0'); pg.click('#stepBox button:has-text("ปิดรอบ")'); pg.wait_for_timeout(50)
    check(pg.is_visible('#askDlg') and ('ปิดรอบ ' + pid) in pg.inner_text('#askTitle') and 'ล้างชีตงาน' in pg.inner_text('#askBody') and pg.is_visible('#askStaff') and pg.is_visible('#askWhy'), 'กด "ปิดรอบ" → กล่องอธิบายขั้นตอน + ช่องพิมพ์ยืนยัน + รหัสผู้ตรวจสอบ')
    pg.fill('#askWhy', pid + 'x'); pg.wait_for_timeout(30)
    check(pg.is_disabled('#askOk') and ('พิมพ์ให้ตรง: ' + pid) in pg.inner_text('#askNeed'), 'พิมพ์ไม่ตรง → กดไม่ได้ + ตัวแดงบอกคำที่ต้องพิมพ์')
    pg.fill('#askWhy', pid); pg.wait_for_timeout(30)
    check(not pg.is_disabled('#askOk'), 'พิมพ์ตรง + มีรหัสผู้ตรวจสอบ → กดได้')
    pg.screenshot(path='/tmp/admin-closeround-ask.png')
    after = json.loads(json.dumps(st['STATE'])); after['round'].update({'status': 'CLOSED', 'statusTh': 'ปิดรอบแล้ว'})
    H = {'project': pid, 'countDate': '2026-11-20', 'book': 120, 'final': 118, 'diffQty': -2, 'diffValue': -350.5, 'diffItems': 2, 'edits': 1, 'url': 'https://example.invalid/a', 'checksum': 'Count_Log:5ed397b96df8dfc8|Adjustments:7ef1e3b1da4df995|Variance:0123456789abcdef',
         'run': 3, 'lines': 99, 'at': '2026-11-20 18:00:00', 'by': 'EMP-K', 'type': 'PILOT', 'typeTh': 'รอบทดลอง'}
    after['history'] = [H]
    C = dict(H); C['type'] = 'PILOT'
    pg.evaluate("x => { window.CLOSEROUND = x; }", {'state': after, 'closed': C})
    pg.click('#askOk'); pg.wait_for_timeout(150)
    check(['apiCloseRound', 'EMP-K', pid, False] in pg.evaluate('CALLS'), 'เรียก apiCloseRound(รหัสผู้ตรวจสอบ, คำยืนยัน, ไม่ใช่โหมดทดสอบ)')
    box = pg.inner_text('#askDlg')
    check('ปิดรอบ ' + pid + ' แล้ว' in box and 'เปิดไฟล์สำรอง' in box and 'Count_Log:5ed397b96df8dfc8' in box and 'รอบทดลอง' in box, 'ผลปิดรอบกลางจอ: ลิงก์ไฟล์สำรอง checksum ยอด')
    sw = pg.evaluate("(() => { const b = document.querySelector('#askBody'); return [b.scrollWidth, b.clientWidth]; })()")
    check(sw[0] <= sw[1] + 1, 'กล่องผลปิดรอบไม่มีแถบเลื่อนแนวนอน (checksum ตัดบรรทัด · UAT G12-6): ' + str(sw))
    pg.screenshot(path='/tmp/admin-closeround-done.png')
    pg.click('#askOk')
    cb = pg.inner_text('#closeCard')
    check('ปิดรอบแล้ว' in cb and 'เปิดไฟล์สำรอง' in cb and 'รหัสรอบใหม่' in cb, 'การ์ดหลังปิดรอบ: ลิงก์ไฟล์สำรอง + บอกให้เปิดรอบใหม่ด้วยรหัสใหม่')
    hb = pg.inner_text('#histBox')
    check(pid in hb and 'รอบทดลอง' in hb and '-2' in hb and pg.locator('#histBox button:has-text("ตรวจไฟล์สำรอง")').count() == 1, 'การ์ด "รอบที่ปิดแล้ว" แสดงรอบ ประเภท ผลต่าง และปุ่มตรวจไฟล์สำรอง')
    pg.evaluate("x => { window.VERIFY = x; }", {'project': pid, 'ok': False, 'cfgOk': True, 'url': 'https://example.invalid/a', 'at': '2026-11-21 09:00:00',
        'rows': [{'sheet': 'Count_Log', 'ok': False, 'rows': 99}, {'sheet': 'Adjustments', 'ok': True, 'rows': 1}, {'sheet': 'Variance', 'ok': True, 'rows': 40}]})
    pg.evaluate('CALLS.length = 0'); pg.click('#histBox button:has-text("ตรวจไฟล์สำรอง")'); pg.wait_for_timeout(100)
    vb = pg.inner_text('#askDlg')
    check(['apiVerifyArchive', pid] in pg.evaluate('CALLS') and 'ไม่ตรง' in pg.inner_text('#askTitle') and 'ถูกแก้หลังปิดรอบ' in vb and 'ARCHIVE_CHECK' in vb, 'ตรวจไฟล์สำรองที่ถูกแก้ → ✗ บอกชีตที่ไม่ตรง')
    pg.screenshot(path='/tmp/admin-verify.png'); pg.click('#askOk')
    # โหมดทดสอบ 2026Q4: ปุ่มล้างข้อมูลทดสอบ ใช้ได้เมื่อ K3 K6 K7 ผ่าน (K1 K2 K4 K5 ไม่ผ่านก็ได้)
    tq = json.loads(json.dumps(closed)); tq['round']['testAllowed'] = True
    kt = json.loads(json.dumps(st['KCHECK'])); kt['full'] = False
    for x in kt['items']: x['ok'] = x['id'] in ('K3', 'K6', 'K7')
    kt['ok'] = False
    pg.evaluate("x => { window.KFAST = x[1]; window.KFULL = null; KCHK = null; setState(x[0]); }", [tq, kt]); pg.wait_for_timeout(100)
    check(pg.is_disabled('#stepBox button:has-text("ปิดรอบ") >> nth=0') and not pg.is_disabled('#stepBox button:has-text("ล้างข้อมูลทดสอบ")'), 'โหมดทดสอบ: K1 ไม่ผ่าน → ปุ่มปิดรอบกดไม่ได้ แต่ "ล้างข้อมูลทดสอบ" กดได้')
    pg.screenshot(path='/tmp/admin-testmode.png')
    pg.evaluate('CALLS.length = 0'); pg.click('#stepBox button:has-text("ล้างข้อมูลทดสอบ")'); pg.wait_for_timeout(50)
    must = 'ล้างข้อมูลทดสอบ ' + tq['round']['projectId']
    pg.fill('#askWhy', must); pg.evaluate("x => { window.CLOSEROUND = x; }", {'state': after, 'closed': dict(C, type='TEST')}); pg.click('#askOk'); pg.wait_for_timeout(150)
    check(['apiCloseRound', 'EMP-K', must, True] in pg.evaluate('CALLS'), 'เรียก apiCloseRound(…, "' + must + '", โหมดทดสอบ)')
    pg.click('#askOk')
    # ค้าง CLOSING → ปุ่มปิดรอบต่อ (ส่งโหมดตาม CLOSE_STATE)
    cl = json.loads(json.dumps(closed)); cl['round'].update({'status': 'CLOSING', 'statusTh': 'กำลังปิดรอบ (ค้าง)', 'closeType': 'TEST'})
    pg.evaluate("x => { setState(x); }", cl)
    check('ค้างกลางทาง' in pg.inner_text('#closeCard') and pg.is_visible('#closeBox button:has-text("ปิดรอบต่อ")'), 'สถานะ CLOSING → การ์ดแจ้งค้าง + ปุ่ม "ปิดรอบต่อ"')
    pg.evaluate('CALLS.length = 0'); pg.click('#closeBox button:has-text("ปิดรอบต่อ")'); pg.fill('#askWhy', must); pg.click('#askOk'); pg.wait_for_timeout(150)
    check(['apiCloseRound', 'EMP-K', must, True] in pg.evaluate('CALLS'), 'ปิดรอบต่อ → เรียกด้วยโหมดเดิม (ทดสอบ)')
    pg.click('#askOk')
    # ไฟล์สำรอง: แถบแดงบนสุด
    ar = json.loads(json.dumps(after)); ar['round'].update({'status': 'ARCHIVED', 'archived': True, 'archivedType': 'PILOT'})
    pg.evaluate("x => { setState(x); }", ar)
    check(pg.is_visible('#archBanner') and 'ดูได้อย่างเดียว' in pg.inner_text('#archBanner') and 'รอบทดลอง' in pg.inner_text('#archBanner'), 'เปิดไฟล์สำรอง → แถบแดง "ดูได้อย่างเดียว": ' + pg.inner_text('#archBanner'))
    pg.evaluate("x => { setState(x); }", st['STATE'])
    check(not pg.is_visible('#archBanner'), 'ไฟล์ปกติ → ไม่มีแถบ')
    # ตาราง Location ความกว้างคอลัมน์ตายตัว (UAT G11)
    pg.click('#nav button[data-t=devices]')
    pg.evaluate("st => { LOCF = 'all'; renderDevices(st); }", st)
    check(pg.locator('#locTbl col').count() == 11 and pg.evaluate("getComputedStyle($('locTbl')).tableLayout") == 'fixed', 'ตาราง Location: 11 คอลัมน์ ความกว้างตายตัว (table-layout fixed)')
    w = pg.evaluate("[].map.call(document.querySelectorAll('#locTbl tr:nth-child(2) td'), function (t) { return Math.round(t.getBoundingClientRect().width); })")
    pg.evaluate("st => { LOCF = 'todo'; renderDevices(st); }", st)
    w2 = pg.evaluate("[].map.call(document.querySelectorAll('#locTbl tr:nth-child(2) td'), function (t) { return Math.round(t.getBoundingClientRect().width); })")
    check(w == w2 and min(w) > 0, 'สลับตัวกรองแล้วความกว้างคอลัมน์เท่าเดิม: ' + str(w))
    check(not dialogs, 'ไม่มี popup ของเบราว์เซอร์: ' + json.dumps(dialogs, ensure_ascii=False))
    b.close()
print('\nผล: ผ่าน %d / ไม่ผ่าน %d' % (P, F))
sys.exit(1 if F else 0)
