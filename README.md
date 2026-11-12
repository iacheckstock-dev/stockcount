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
| `docs/` | เอกสารเทคนิคและคู่มือติดตั้ง (ดูหัวข้อเอกสาร) |
| `tests/` | ชุดทดสอบบน Node (ไม่ต้องใช้บัญชี Google) |

## เอกสาร

| เอกสาร | เนื้อหา |
|---|---|
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | ภาพรวม Tech stack แผนภาพสถาปัตยกรรม ส่วนประกอบ หลักการออกแบบ สภาพแวดล้อม |
| [DATA-FLOW.md](docs/DATA-FLOW.md) | เส้นทางข้อมูลตั้งแต่ไฟล์ SAP/POS ถึงผลนับ และจุดควบคุม C1–C24 |
| [DATA-DICTIONARY.md](docs/DATA-DICTIONARY.md) | ทุกชีตและคอลัมน์ ความเชื่อมโยง ระดับความลับ |
| [API.md](docs/API.md) | API ของเครื่อง TC21: action คำขอ คำตอบ ข้อผิดพลาด |
| [DEPLOY-PHASE1.md](docs/DEPLOY-PHASE1.md) · [DEPLOY-PHASE2.md](docs/DEPLOY-PHASE2.md) | ติดตั้ง ตั้งค่า Deploy อัปเดตเวอร์ชัน DataWedge |
| [CHANGELOG.md](CHANGELOG.md) | ประวัติเวอร์ชันและวิธีอัปเดต |

เอกสารภายใน (ไม่อยู่ใน repo): สเปกการออกแบบ · การเข้าถึงและความปลอดภัย · Checklist ทดสอบ

## สถานะ

- [x] เฟส 1 — สร้างชีต, เปิดรอบ, นำเข้า SAP/POS, Barcode_Map, ตรวจความพร้อม, ตัดสินขัดแย้ง, อนุมัติ Master, เทียบ SAP กับ POS → [คู่มือติดตั้ง](docs/DEPLOY-PHASE1.md)
- [x] เฟส 2 — เว็บแอป TC21 (PWA), จับคู่เครื่อง, ตรวจความพร้อม, หน้านับ, แก้ยอด Location, คิวออฟไลน์, sync, export/นำเข้าไฟล์, พิมพ์ป้าย → [คู่มือติดตั้ง](docs/DEPLOY-PHASE2.md)
- CHANGELOG: [CHANGELOG.md](CHANGELOG.md) (เวอร์ชันปัจจุบัน 2.3.8 · เฟส 2 อยู่ระหว่าง UAT บนเครื่องจริง)
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
SAMPLE_SAP=... SAMPLE_POS=... node multi-test.js # หลายเครื่องนับ Location เดียวกัน (ผู้ดูแล/ผู้ช่วย)
SAMPLE_SAP=... SAMPLE_POS=... node mock-server.js &   # เซิร์ฟเวอร์จำลอง http://localhost:8787/app/
python3 e2e.py                                   # E2E เว็บแอปด้วย Chrome (Playwright)
python3 e2e_multi.py                             # E2E สองเครื่อง (รัน mock-server ใหม่ก่อน)
```
