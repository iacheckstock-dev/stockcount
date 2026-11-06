# stockcount

ระบบตรวจนับสินค้าในร้านค้า (Stock Count System) แทน Honeywell Dolphin 60S

- Handheld: Zebra TC21 + PWA (เฟส 2)
- Backend: Google Apps Script + Google Sheets + Google Drive
- สเปกการออกแบบ: เอกสาร Docs "สเปกระบบตรวจนับสต๊อก" (ไม่เก็บใน repo)

> repo นี้เก็บเฉพาะโค้ด ไม่มีข้อมูลสต๊อก ต้นทุน รหัสลับ หรือ token ใด ๆ — ห้าม commit ไฟล์ SAP/POS จริง

## โครงสร้าง

| โฟลเดอร์ | เนื้อหา |
|---|---|
| `gas/` | โค้ด Apps Script: `Code.gs` (เซิร์ฟเวอร์/Admin), `Api.gs` (API ของเครื่อง), `Core.gs` (ตรรกะล้วน), `Admin.html` (หน้า Admin) |
| `app/` | เว็บแอป TC21 (PWA บน GitHub Pages): `index.html`, `app.js`, `db.js`, `sw.js`, `labels.html` (พิมพ์ป้าย) |
| `docs/` | คู่มือติดตั้งแต่ละเฟส |
| `tests/` | ชุดทดสอบบน Node (ไม่ต้องใช้บัญชี Google) |

## สถานะ

- [x] เฟส 1 — สร้างชีต, เปิดรอบ, นำเข้า SAP/POS, Barcode_Map, ตรวจความพร้อม, ตัดสินขัดแย้ง, อนุมัติ Master, เทียบ SAP กับ POS → [คู่มือติดตั้ง](docs/DEPLOY-PHASE1.md)
- [x] เฟส 2 — เว็บแอป TC21 (PWA), จับคู่เครื่อง, ตรวจความพร้อม, หน้านับ, แก้ยอด Location, คิวออฟไลน์, sync, export/นำเข้าไฟล์, พิมพ์ป้าย → [คู่มือติดตั้ง](docs/DEPLOY-PHASE2.md)
- CHANGELOG: [CHANGELOG.md](CHANGELOG.md) (เวอร์ชันปัจจุบัน 2.1.1)
- [ ] เฟส 3 — Dashboard และการแก้ไขยอดนับ
- [ ] เฟส 4 — ปิดรอบ, Archive, ประวัติ
- [ ] เฟส 5 — ทดลองใช้จริง

## ทดสอบ

```bash
cd tests && npm install
node run.js                     # ข้อมูลสังเคราะห์
SAMPLE_SAP=/path/ZMMD002A.xls SAMPLE_POS=/path/Stock_Shop_POS.xls node run.js      # + ไฟล์จริง
SAMPLE_SAP=... SAMPLE_POS=... node gas-mock.js   # จำลอง Apps Script ทั้ง flow
SAMPLE_SAP=... SAMPLE_POS=... node api-test.js   # API ของเครื่อง (+ SAMPLE_DOLPHIN=ไฟล์ Dolphin)
SAMPLE_SAP=... SAMPLE_POS=... node mock-server.js &   # เซิร์ฟเวอร์จำลอง http://localhost:8787/app/
python3 e2e.py                                   # E2E เว็บแอปด้วย Chrome (Playwright)
```
