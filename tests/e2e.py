"""
E2E เว็บแอป TC21 กับเซิร์ฟเวอร์จำลอง (tests/mock-server.js ต้องรันอยู่ที่ PORT)
python3 tests/e2e.py
จำลองการยิงด้วยการพิมพ์ + Enter แบบเดียวกับ DataWedge (keystroke output)
"""
import json, os, sys, time, urllib.request
from playwright.sync_api import sync_playwright

PORT = int(os.environ.get('PORT', 8787))
BASE = f'http://localhost:{PORT}'
SHOT = os.environ.get('SHOTS', '/tmp/e2e')
CHROME = os.environ.get('CHROME', '/usr/bin/google-chrome')
ok = 0
def check(cond, msg):
    global ok
    if not cond: raise AssertionError(msg)
    ok += 1; print('  ✓', msg)
def get(path, data=None):
    req = urllib.request.Request(BASE + path, data=data.encode() if data else None, method='POST' if data else 'GET')
    return json.loads(urllib.request.urlopen(req).read())
def log_rows(): return get('/debug/log')[1:]

BC1, MAT1 = '8858684826179', 'A112101UT0450XK'
BC2, MAT2 = '8858153867481', 'A112101UT0550XK'
UNKNOWN = '8850000000003'   # check digit ถูก แต่ไม่มีในรายการ

with sync_playwright() as p:
    b = p.chromium.launch(executable_path=CHROME)
    ctx = b.new_context(viewport={'width': 480, 'height': 860}, device_scale_factor=1, accept_downloads=True)
    # headless ไม่ให้สิทธิ์ persistent storage เอง → จำลองว่าติดตั้งแอปแล้ว
    ctx.add_init_script("navigator.storage.persist = () => Promise.resolve(true); navigator.storage.persisted = () => Promise.resolve(true);")
    pg = ctx.new_page()
    errors = []
    pg.on('pageerror', lambda e: errors.append(str(e)))
    def scan(code, click=True):
        if click: pg.locator('#topbar').click()  # ให้โฟกัสอยู่ที่หน้า ไม่ใช่ช่องกรอก
        pg.keyboard.type(code, delay=5); pg.keyboard.press('Enter'); pg.wait_for_timeout(250)
    def shot(name): pg.screenshot(path=f'{SHOT}/{name}.png')

    print('ตั้งค่าเครื่อง')
    pg.goto(BASE + '/app/'); pg.wait_for_selector('#v-setup.on')
    check(pg.input_value('#setApi').endswith('/api'), 'ดึงที่อยู่เซิร์ฟเวอร์จาก config.json')
    shot('01-setup')
    pg.fill('#setDevice', 'TC21-01'); pg.fill('#setCode', '123456'); pg.click('#btnPair')
    pg.wait_for_function("document.querySelector('#setupMsg').textContent.length > 0 && !/กำลัง/.test(document.querySelector('#setupMsg').textContent)")
    check('ไม่มีรหัส' in pg.inner_text('#setupMsg') or 'ไม่ถูกต้อง' in pg.inner_text('#setupMsg'), 'รหัสผิดแสดงข้อความ: ' + pg.inner_text('#setupMsg'))
    code = get('/debug/paircode?d=TC21-01')['pairCode']
    pg.fill('#setCode', code); pg.click('#btnPair')
    pg.wait_for_selector('#v-ready.on'); pg.wait_for_function("/พร้อม/.test(document.querySelector('#readyHead').textContent)", timeout=20000)
    shot('02-ready-before')
    check('ยังไม่พร้อม' in pg.inner_text('#readyHead'), 'ตรวจความพร้อมครั้งแรก: ยังไม่พร้อม (ยังไม่ยิงบัตร/ทดสอบเสียง)')
    check('2,330 รายการ' in pg.inner_text('#readyList'), 'โหลดรายการบาร์โค้ด 2,330 รายการลงเครื่อง')

    print('ตรวจความพร้อม')
    scan('EMP:EMP-XX'); check('ไม่พบรหัสผู้ตรวจสอบ' in pg.inner_text('#toast'), 'บัตรที่ไม่มีในระบบ → ปฏิเสธ')
    pg.check('#ckSound'); pg.wait_for_timeout(300); pg.check('#ckPin'); pg.wait_for_timeout(300)
    scan('EMP:EMP-NU', click=False)   # ยิงต่อทันทีหลังติ๊ก (โฟกัสเคยค้างที่ช่องติ๊ก)
    pg.wait_for_timeout(300)
    pg.wait_for_function("/พร้อมนับ ✓/.test(document.querySelector('#readyHead').textContent)", timeout=10000)
    shot('03-ready-pass')
    check(pg.is_visible('#btnStart'), 'ผ่านทุกข้อ ขึ้นปุ่มเริ่มนับ')
    pg.click('#btnStart'); pg.wait_for_selector('#v-count.on')
    check('นุ่น' in pg.inner_text('#tbStaff'), 'เข้างานเป็น นุ่น')

    print('นับ')
    scan(BC1); check('ยิงป้าย Location ก่อน' in pg.inner_text('#card'), 'ยิงสินค้าก่อนเปิด Location → แดง ไม่บันทึก')
    scan('LOC:a01'); check(pg.inner_text('#tbLoc') == 'A1', 'ป้าย LOC:a01 → เปิด A1')
    scan(BC1); scan(BC1)
    check('ok' in pg.get_attribute('#card', 'class') and 'รวม 2' in pg.inner_text('#cardQty'), 'ยิงสินค้าที่รู้จัก → เขียว, ยอดใน A1 = 2')
    pg.click('#keypad button:text("5")'); check(pg.inner_text('#qtyVal') == '5', 'กดจำนวน 5')
    scan(BC2); check(pg.inner_text('#qtyVal') == '1', 'จำนวนกลับเป็น 1 หลังยิง')
    scan(UNKNOWN); check('warn' in pg.get_attribute('#card', 'class'), 'บาร์โค้ดไม่รู้จัก (check digit ถูก) → เหลือง บันทึก')
    shot('04-count-unknown')
    scan('12345'); check('bad' in pg.get_attribute('#card', 'class'), 'รูปแบบผิด → แดง ไม่บันทึก')
    check(pg.inner_text('#locTotal') == '8', 'ยอดรวม A1 = 8 (1+1+5+1)')
    pg.click('#btnUndo'); pg.click('#mYes'); pg.wait_for_timeout(300)
    check(pg.inner_text('#locTotal') == '7', 'ยกเลิกรายการล่าสุด → 7')
    pg.wait_for_function("/ค้าง 0/.test(document.querySelector('#syncText').textContent)", timeout=15000)
    rows = log_rows()
    check(len(rows) == 5 and [r[9] for r in rows].count('VOID') == 1, 'เซิร์ฟเวอร์ได้ 5 รายการ (SCAN 4 + VOID 1)')
    check(any(r[6] == UNKNOWN and r[7] == '' for r in rows), 'บาร์โค้ดไม่รู้จักถูกส่งพร้อม Material ว่าง')
    shot('05-count')

    print('แก้ยอด Location')
    pg.click('#btnLoc'); pg.wait_for_selector('#v-loc.on')
    shot('06-loc')
    pg.locator('#locItems li', has_text='UT0550XK').click()
    pg.fill('#mInput', '3'); pg.wait_for_timeout(100)
    prev = pg.inner_text('#mPreview')
    check('5' in prev and '3' in prev and '7' in prev and '5' in prev, 'แสดงก่อน→หลัง ทั้ง SKU และ Location: ' + prev.replace('\n', ' | '))
    shot('07-edit')
    pg.click('#mYes'); pg.wait_for_timeout(300)
    check(pg.inner_text('#locSum').startswith('5 ชิ้น'), 'หลังแก้ A1 = 5 ชิ้น')
    pg.click('#btnLocUndo'); pg.click('#mYes'); pg.wait_for_timeout(300)
    check(pg.inner_text('#locSum').startswith('7 ชิ้น'), 'ย้อนการแก้ล่าสุด → กลับเป็น 7')
    pg.locator('#locItems li', has_text='UT0550XK').click(); pg.fill('#mInput', '3'); pg.click('#mYes'); pg.wait_for_timeout(300)
    pg.click('#btnLocBack'); pg.wait_for_selector('#v-count.on')
    pg.click('#btnClose'); check('5' in pg.inner_text('#mBody'), 'กล่องปิด Location แสดงยอดรวม 5'); pg.click('#mYes')
    pg.wait_for_function("/ค้าง 0/.test(document.querySelector('#syncText').textContent)", timeout=15000); pg.wait_for_timeout(3500)
    checks = get('/debug/loccheck')[1:]
    check(len(checks) >= 1 and checks[-1][4] == 'CLOSE' and checks[-1][10] == 'OK', 'เซิร์ฟเวอร์ตรวจยอดปิด A1 ตรงกับเครื่อง (OK): ' + json.dumps(checks[-1][6:11], ensure_ascii=False))

    print('ออฟไลน์')
    ctx.set_offline(True)
    scan('LOC:A2')
    for i in range(25): scan(BC1)
    pg.wait_for_timeout(3000)
    check('ค้าง 25' in pg.inner_text('#syncText'), 'ออฟไลน์: ยิงต่อได้ ค้างส่ง 25')
    check('off' in pg.get_attribute('#netDot', 'class'), 'ไฟสถานะเป็นแดง (ออฟไลน์)')
    shot('08-offline')
    ctx.set_offline(False)
    pg.wait_for_function("/ค้าง 0/.test(document.querySelector('#syncText').textContent)", timeout=30000)
    rows = log_rows()
    check(len(rows) == 5 + 3 + 25, 'กลับมาออนไลน์: ส่งครบ ไม่ซ้ำ (เซิร์ฟเวอร์มี ' + str(len(rows)) + ' รายการ)')
    check(len(set(r[0] for r in rows)) == len(rows), 'Log_ID ไม่ซ้ำ')
    seqs = sorted(int(r[3]) for r in rows); check(seqs == list(range(1, len(rows) + 1)), 'Seq ต่อเนื่อง 1..' + str(len(rows)))

    print('Export และนำเข้าไฟล์')
    with pg.expect_download() as dl:
        pg.click('#btnStatus'); pg.wait_for_selector('#v-status.on'); shot('09-status'); pg.click('#btnExport')
    text = open(dl.value.path(), encoding='utf-8-sig').read()
    check(text.startswith('#STOCKCOUNT_EXPORT,v1,TC21-01,2026Q4'), 'ไฟล์ export มีหัวไฟล์ถูกต้อง: ' + dl.value.suggested_filename)
    r = get('/debug/import', '﻿' + text)
    check(r['added'] == 0 and r['existing'] == len(rows), f"นำเข้าไฟล์ export: มีแล้ว {r['existing']} เพิ่มใหม่ {r['added']}")

    print('เปิดแอปใหม่ (ข้อมูลอยู่ในเครื่อง)')
    pg.reload(); pg.wait_for_selector('#v-count.on', timeout=10000)
    check(pg.inner_text('#tbLoc') == 'A2' and 'สแกน 33' in pg.inner_text('#syncText'), 'กลับมาที่ A2 รายการครบ 33 ไม่ต้องตรวจความพร้อมซ้ำวันเดียวกัน')
    shot('10-reload')
    check(not errors, 'ไม่มี JavaScript error: ' + '; '.join(errors))

    print('เครื่องถูกล้างข้อมูล Chrome แล้วจับคู่ใหม่')
    ctx2 = b.new_context(viewport={'width': 480, 'height': 860})
    ctx2.add_init_script("navigator.storage.persist = () => Promise.resolve(true); navigator.storage.persisted = () => Promise.resolve(true);")
    pg = ctx2.new_page()
    pg.goto(BASE + '/app/'); pg.wait_for_selector('#v-setup.on')
    pg.fill('#setDevice', 'TC21-01'); pg.fill('#setCode', get('/debug/paircode?d=TC21-01')['pairCode']); pg.click('#btnPair')
    pg.wait_for_function("/พร้อม/.test(document.querySelector('#readyHead').textContent)", timeout=20000)
    scan('EMP:EMP-AOY'); pg.check('#ckSound'); pg.wait_for_timeout(300); pg.check('#ckPin')
    pg.wait_for_function("/พร้อมนับ ✓/.test(document.querySelector('#readyHead').textContent)", timeout=10000)
    pg.click('#btnStart'); scan('LOC:B1'); scan(BC2)
    pg.wait_for_function("/ค้าง 0/.test(document.querySelector('#syncText').textContent)", timeout=15000)
    rows = log_rows()
    check(len(rows) == 34 and rows[-1][0] == 'TC21-01-000034', 'รายการใหม่ได้ Seq 34 ต่อจากเดิม ไม่ชนกับของเก่า (' + rows[-1][0] + ')')
    b.close()
print(f'\nE2E ผ่าน {ok} ข้อ')
