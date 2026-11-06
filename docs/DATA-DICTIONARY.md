# Data Dictionary — ไฟล์ Google Sheets หลัก (SCHEMA_VERSION 4 · v2.2.0)

โครงสร้างกำหนดใน `gas/Code.gs` (ตัวแปร `SHEETS`) ชีตถูกสร้างและเติมคอลัมน์ใหม่อัตโนมัติ (ไม่ลบหรือย้ายคอลัมน์เดิม)
ทุกชีตมีหัวคอลัมน์แถวที่ 1 คอลัมน์รหัส (บาร์โค้ด รหัสสินค้า Location ฯลฯ) เก็บเป็นข้อความ กันเลข 0 นำหน้าหายและการแสดงเป็น 8.85E+12

**ระดับข้อมูล** — 🔒 ลับ (ต้นทุน มูลค่า ราคา ยอดบัญชี) · 🟡 ภายใน (ผลนับ รายชื่อ อีเมล) · ⚪ ระบบ
ไฟล์นี้ต้องแชร์เฉพาะผู้มีหน้าที่ เพราะมีทั้ง 🔒 และ 🟡 อยู่ในไฟล์เดียว

## ภาพรวม

| กลุ่ม | ชีต | เขียนโดย | แก้มือได้ไหม | ระดับ |
|---|---|---|---|---|
| ตั้งค่า | Config, Staff | Admin / ตั้งค่าครั้งแรก | Staff: ได้ · Config: ไม่ควร (ใช้หน้า Admin) | ⚪ / 🟡 |
| ข้อมูลต้นทาง | SAP_Snapshot, POS_Snapshot | อัปโหลดในหน้า Admin | ไม่ได้ | 🔒 |
| Master | Barcode_Map, SAP_POS_Compare, Map_Decisions, Master_Check, Device_Master | ระบบ (สร้างใหม่ทุกครั้งที่ข้อมูลเปลี่ยน) | ไม่ได้ | 🔒 / ⚪ |
| เครื่อง | Devices, Device_Checks | API + หน้า Admin | ไม่ได้ (ใช้หน้า Admin) | ⚪ |
| การนับ | Count_Log, Quarantine, Import_Files | API / นำเข้าไฟล์ | **ห้ามแก้** (append-only) | 🟡 |
| Location | Locations, Loc_Members, Loc_Checks | API + หน้า Admin | ไม่ได้ | 🟡 |
| สรุป (เฟส 3–4) | Dash_Data, Count_History | ยังไม่ใช้ | — | 🔒 |
| ตรวจสอบ | Admin_Log | ระบบ | **ห้ามแก้** | 🟡 |

## ความเชื่อมโยงหลัก

| จาก | คอลัมน์ | ไปที่ | คอลัมน์ |
|---|---|---|---|
| Count_Log | Device_ID | Devices | Device_ID |
| Count_Log | Staff_Code | Staff | Staff_Code |
| Count_Log | Material / Barcode | Barcode_Map | Material / Barcode |
| Count_Log | Location | Locations, Loc_Members | Location |
| Count_Log | Ref_ID | Count_Log | Log_ID (รายการที่ถูกยกเลิก/ปรับ) |
| Count_Log, Loc_Members, Loc_Checks | Project_ID | Config | PROJECT_ID |
| Loc_Members | Device_ID | Devices | Device_ID |
| Device_Master | (ทั้งตาราง) | Config | MASTER_APPROVED_HASH (checksum) |
| Map_Decisions | Key | ข้อขัดแย้งที่ตรวจพบตอนสร้าง Master | — |

---

## ตั้งค่า

### Config — ค่าระบบ 1 แถวต่อ 1 ค่า
`Key` · `Value` · `Note`

| Key | ความหมาย |
|---|---|
| SCHEMA_VERSION | เวอร์ชันโครงสร้างชีต ต่ำกว่าโค้ด = อัปเกรดอัตโนมัติ |
| PROJECT_ID | รหัสรอบนับ เช่น `2026Q4` |
| COUNT_DATE | วันนับ (yyyy-mm-dd) เทียบกับยอด SAP สิ้นวันก่อนหน้า (D−1) |
| ROUND_STATUS | `NONE` → `SETUP` → `COUNTING` (เมื่อได้รายการแรก) → `COUNT_CLOSED` → `CLOSED` |
| DRIVE_FOLDER_ID | โฟลเดอร์ Drive เก็บไฟล์นำเข้าและ Archive |
| SAP_FILE_NAME / _DATE / _UPLOADED_AT / _UPLOADED_BY | ไฟล์ SAP ล่าสุดที่อัปโหลด |
| SAP_D1_CONFIRMED | ผู้ยืนยันว่าบัญชีปิดยอด D−1 แล้วตอนอัปโหลด |
| POS_FILE_NAME / _DATE / _UPLOADED_AT / _UPLOADED_BY | ไฟล์ POS ล่าสุดที่อัปโหลด |
| MASTER_APPROVED_HASH | checksum ของคู่บาร์โค้ด→สินค้าที่อนุมัติ |
| MASTER_APPROVED_VERSION / _AT / _BY / _COUNT / _PROJECT | ครั้งที่ เวลา ผู้อนุมัติ จำนวนรายการ และรอบที่อนุมัติ |
| MASTER_APPROVED_ACK | รหัสคำเตือนที่รับทราบแล้ว (คั่นด้วย ,) |
| APP_URL | ที่อยู่เว็บแอป (ใช้ในลิงก์ป้ายและหน้า Admin) |
| API_URL | URL ของ Web app ที่ใช้งานจริง ต้องตรงกับ `app/config.json` |
| MEMBERS_MIGRATED | รอบที่ย้ายข้อมูลเป็นผู้ดูแล/ผู้ช่วยแล้ว (v2.2.0) |

### Staff — รายชื่อผู้ตรวจสอบ 🟡
| คอลัมน์ | ความหมาย |
|---|---|
| Staff_Code | รหัสบนบัตร (บัตรพิมพ์เป็น `EMP:<รหัส>`) |
| Name | ชื่อที่แสดงบนเครื่องและหน้า Admin |
| Role | ตำแหน่ง (แสดงผลเท่านั้น ไม่ใช้กำหนดสิทธิ์) |
| Active | `N` = ใช้ไม่ได้ ค่าอื่น = ใช้ได้ |

## ข้อมูลต้นทาง

### SAP_Snapshot, POS_Snapshot 🔒
สำเนาข้อมูลดิบจากไฟล์ที่อัปโหลดล่าสุด หัวคอลัมน์ตามไฟล์ต้นทาง (ไม่มีโครงสร้างตายตัว)
- SAP ต้องมี: Material, Descriptio, Plant, Qty-UR, Qty-IT, Qty-QI, Qty-BL, Barcode, Cust-mat (ใช้ถ้ามี: Amt-UR, MOV, UOM)
- POS ต้องมี: Item_No, Cust_Mat, Barcode, Bal_qty (ใช้ถ้ามี: Retail_Price, Short_Style)

## Master

### Barcode_Map — บาร์โค้ดที่ใช้นับ 1 แถวต่อบาร์โค้ด 🔒
| คอลัมน์ | ความหมาย |
|---|---|
| Barcode | บาร์โค้ด (ว่าง = สินค้าไม่มีบาร์โค้ด ต้องป้อนเอง) |
| Material | รหัสสินค้า SAP (คีย์หลักของสินค้า) |
| Cust_Mat | รหัสที่ใช้หน้าร้าน (แสดงบนการ์ด) |
| Name | ชื่อสินค้า |
| Source / Source_TH | ที่มาของบาร์โค้ด: `SAP` · `POS_FILL` เติมจาก POS · `POS` · `DECIDED` Admin เลือก · `NONE` ไม่มีบาร์โค้ด · `PENDING` รอตัดสิน |
| Book_Qty / Book_Source | ยอดบัญชีที่ใช้เทียบ และมาจาก `SAP` หรือ `POS` (ชั่วคราวก่อนมี SAP) |
| SAP_Qty / POS_Qty | ยอดใช้ได้ (Qty-UR) จาก SAP / ยอดคงเหลือจาก POS |
| Unit_Cost | ต้นทุนต่อหน่วย (Amt-UR ÷ Qty-UR หรือ MOV) |
| SAP_IT / SAP_QI / SAP_BL | ยอดระหว่างทาง / รอตรวจคุณภาพ / ระงับใช้ ตาม SAP |
| Retail_Price | ราคาขายจาก POS |
| Status | ผลเทียบ SAP กับ POS: ตรง · ยอดต่าง · มีเฉพาะ SAP · มีเฉพาะ POS · เติมบาร์โค้ด · ขัดแย้ง · ยังไม่มี SAP |

### SAP_POS_Compare — เทียบ SAP กับ POS 1 แถวต่อสินค้า 🔒
`Material` · `Cust_Mat` · `Name` · `Status` (ค่าเดียวกับ Barcode_Map) · `SAP_Barcode` · `POS_Barcode` · `Final_Barcode` (ที่ใช้จริง) ·
`SAP_Qty` · `POS_Qty` · `Diff` (SAP − POS) · `SAP_IT` · `SAP_QI` · `SAP_BL`

### Map_Decisions — การตัดสินข้อขัดแย้งของหัวหน้าทีม
| คอลัมน์ | ความหมาย |
|---|---|
| Key | รหัสข้อขัดแย้ง (ไม่ซ้ำ) |
| Type / Id | ชนิดข้อขัดแย้ง และบาร์โค้ดหรือรหัสสินค้าที่เกี่ยวข้อง |
| Decision | ตัวเลือกที่เลือก |
| Decided_By / Decided_At | อีเมลผู้ตัดสิน / เวลา |

### Master_Check — ประวัติการตรวจความพร้อมและการอนุมัติ (เพิ่มอย่างเดียว)
| คอลัมน์ | ความหมาย |
|---|---|
| Time | เวลา |
| Kind | `CHECK: <เหตุ>` ตรวจหลังข้อมูลเปลี่ยน · `APPROVE vN` อนุมัติครั้งที่ N |
| Master_Hash | checksum ของ Master ณ ตอนนั้น |
| Level | `BLOCK` ห้ามผ่าน · `WARN` ต้องรับทราบ · `INFO` แจ้งให้ทราบ |
| Item / Count | หัวข้อที่ตรวจ / จำนวนรายการที่พบ |
| Result | ผ่าน · บล็อก · เตือน · แจ้งให้ทราบ · อนุมัติ |
| Note / By | รายละเอียด / อีเมลผู้ทำ |

### Device_Master — รายการที่ส่งลงเครื่อง
`Barcode` · `Material` · `Cust_Mat` · `Name` — ไม่มียอดหรือราคา · แถวที่ Barcode ว่าง = สินค้าป้อนเอง

## เครื่อง

### Devices — 1 แถวต่อเครื่อง
| คอลัมน์ | ความหมาย |
|---|---|
| Device_ID | รหัสเครื่อง เช่น `TC21-01` (ตรงกับสติกเกอร์) |
| Name | ชื่อที่แสดง |
| Active | `Y` ใช้ได้ · ค่าอื่น = ปิดใช้งาน (token ใช้ไม่ได้ทันที) |
| Last_Seq / Gaps | Seq สูงสุดที่ได้รับในรอบนี้ / จำนวน Seq ที่ขาด |
| Last_Sync | เวลาที่ส่งข้อมูลล่าสุด |
| App_Version | เวอร์ชันแอปที่เครื่องรายงาน |
| Last_Check_At / Last_Check | ผลตรวจความพร้อมล่าสุด |
| Paired_At | เวลาที่จับคู่ |
| Token_Hash | SHA-256 ของ token (ไม่เก็บ token จริง) |
| Pair_Code / Pair_Expires / Pair_Fails | รหัสจับคู่ที่ยังไม่ใช้ / หมดอายุ (ms) / จำนวนครั้งที่ใส่ผิด |

### Device_Checks — ผลตรวจความพร้อมของเครื่อง (เพิ่มอย่างเดียว)
`Time` · `Device_ID` · `Staff` · `App_Version` · `Result` (ผ่าน / ไม่ผ่าน) · `Detail` (✓ ⚠ ✗ ทีละข้อ)

## การนับ

### Count_Log — ทุกรายการนับ (append-only, ห้ามแก้หรือลบ) 🟡
| คอลัมน์ | ความหมาย |
|---|---|
| Log_ID | `<Device_ID>-<Seq 6 หลัก>` ไม่ซ้ำ ใช้กันส่งซ้ำ |
| Project_ID | รอบนับ |
| Device_ID / Seq | เครื่อง / ลำดับในเครื่อง (ต่อเนื่อง) |
| Staff_Code | ผู้ตรวจที่ยิงบัตรไว้ |
| Location | ชื่อ Location (ตัวอักษรโซน + เลข ไม่มี 0 นำหน้า เช่น `A1`) |
| Barcode / Material | บาร์โค้ดที่ยิง / รหัสสินค้า (ว่าง = บาร์โค้ดไม่รู้จัก) |
| Qty | จำนวน (ติดลบได้สำหรับรายการปรับ) |
| Entry_Type | `SCAN` ยิง · `MANUAL` ป้อนเอง · `VOID` ยกเลิกรายการ · `RECOUNT_SET` ปรับให้เป็นยอดจริง/ล้าง Location · สงวนไว้: `FOUND` `SWAP` `SALE` `HOLD` |
| Ref_ID | Log_ID ของรายการที่ถูกยกเลิก (สำหรับ VOID) |
| Reason / Note | เหตุผล เช่น "แก้ยอด Location 5 → 4" |
| Scan_Time | เวลาบนเครื่องตอนยิง |
| Received_Time | เวลาที่เซิร์ฟเวอร์รับ |
| Source | `SYNC` ส่งจากเครื่อง · `FILE` นำเข้าไฟล์ Export |
| Entered_By / Requested_By | ผู้ป้อน / ผู้ขอให้แก้ (ถ้ามี) |
| Basis | เฉพาะ RECOUNT_SET: ยอดรวม SKU ทุกเครื่องที่ผู้แก้เห็นตอนแก้ ใช้ตรวจการแก้ชนกัน (v2.2.0) |

ยอดของ Location = ผลรวม Qty ทุกแถวของ Location นั้น (รวมรายการปรับ) — ไม่มีแถวไหนถูกแก้ทับ

### Quarantine — รายการที่ไม่รวมยอด
`Received_Time` · `Device_ID` · `Log_ID` · `Project_ID` · `Payload` (JSON ทั้งรายการ) · `Reason` (รอบไม่ตรง / รอบปิดแล้ว)

### Import_Files — ประวัติการนำเข้าไฟล์ Export
`Time` · `File_Name` · `Checksum` · `Lines` · `Existing` (มีอยู่แล้ว) · `Added` (เพิ่มใหม่) · `By`

## Location

### Locations — สรุปสถานะ 1 แถวต่อ Location
| คอลัมน์ | ความหมาย |
|---|---|
| Location / Zone | ชื่อ / ตัวอักษรโซน |
| Status | กำลังนับ · พัก · ปิดแล้ว |
| Owner | เครื่องและผู้ตรวจที่เป็นผู้ดูแล |
| Open_By | ผู้ดูแลขณะยังไม่ปิด (ว่างเมื่อปิด) |
| Members | สรุปทุกเครื่อง: บทบาทและสถานะ |
| Status_Detail | เช่น "3 เครื่อง · ผู้ช่วยส่งงานแล้ว 1/2" |
| Counters / Devices | ผู้ตรวจ / เครื่องทั้งหมดที่เคยนับ |
| Opened_At / Closed_Time | เวลาเปิดครั้งแรก / เวลาปิดล่าสุด |
| Last_Check | ผลเทียบยอดกับเครื่องล่าสุด: OK · MISMATCH · WAIT |
| Edits | จำนวนครั้งที่แก้ยอด |
| Flag | ธงที่หน้า Admin แสดง: "มีรายการหลังปิด — ตรวจซ้ำ" และ/หรือ Flag_Check |
| Flag_Check | "ต้องตรวจซ้ำ: …" จากการแก้ชนกัน หรือปิดในสภาพไม่ครบ · ล้างเมื่อปิดใหม่แบบครบ |
| Close_Cover | JSON: Seq สูงสุดของแต่ละเครื่องที่ครอบคลุมตอนปิด ใช้ตรวจรายการหลังปิด |
| Close_Total | ยอดรวมที่ผู้ดูแลเห็นตอนปิด |
| Updated_At | เวลาแก้ไขล่าสุด |

### Loc_Members — บทบาทต่อ Location ต่อเครื่อง (v2.2.0)
| คอลัมน์ | ความหมาย |
|---|---|
| Project_ID / Location / Device_ID | คีย์ร่วม |
| Role | `OWNER` ผู้ดูแล · `HELPER` ผู้ช่วย |
| State | `COUNTING` กำลังนับ · `PAUSED` พัก (ผู้ดูแล) · `SUBMITTED` ส่งงานแล้ว · `CLOSED` ปิดแล้ว (ผู้ดูแล) |
| Staff | ผู้ตรวจล่าสุดของเครื่องนั้น |
| Joined_At / State_At | เข้าร่วมครั้งแรก / สถานะเปลี่ยนล่าสุด |
| Cover_Seq | Seq ที่การส่งงาน/พัก/ปิดล่าสุดครอบคลุม |
| Sub_Lines / Sub_Qty | จำนวนรายการ / ชิ้นของเครื่องนี้ตอนส่งงาน |
| Match | ผลตรวจว่าเซิร์ฟเวอร์ได้รับครบ: OK · MISMATCH · WAIT |
| Sub_By | `SELF` กดเอง · `AUTO` ยิงป้ายอื่น · `CLOSE` แอปรุ่นเก่า · `ADMIN` หัวหน้าทีมทำแทน · `MIGRATE` ย้ายจากรุ่นก่อน |
| Ev_At | เวลาของเหตุการณ์ล่าสุดที่ใช้ (กันเหตุการณ์เก่าทับของใหม่) |
| Updated_At | เวลาแก้ไขล่าสุด |

### Loc_Checks — ประวัติทุกเหตุการณ์ของ Location (เพิ่มอย่างเดียว)
| คอลัมน์ | ความหมาย |
|---|---|
| Time / Project_ID / Device_ID / Location / Staff | เมื่อไร รอบไหน เครื่องไหน ที่ไหน ใคร |
| Event | `OPEN` `JOIN` `SUBMIT` `PAUSE` `CLOSE` `EDIT` · `EDIT_CONFLICT` · `ADMIN_SUBMIT` · `TRANSFER` |
| Dev_Lines / Dev_Qty | ยอดของเครื่องตามที่เครื่องส่งมา |
| Srv_Lines / Srv_Qty | ยอดของเครื่องนั้นที่เซิร์ฟเวอร์มี |
| Match | OK · MISMATCH · WAIT (ว่างสำหรับ OPEN/JOIN) |
| Up_To_Seq | Seq สูงสุดที่เหตุการณ์ครอบคลุม |
| Note | รายละเอียด เช่น "ส่งงานอัตโนมัติ", "กลับมาช่วยอีกครั้ง", เหตุผลของหัวหน้าทีม |

## สรุป (สงวนไว้สำหรับเฟส 3–4)

### Dash_Data
`Key` · `Value` · `Updated_At` — ค่าที่คำนวณไว้สำหรับ Dashboard

### Count_History — สรุปรอบที่ปิดแล้ว 🔒
`Project_ID` · `Count_Date` · `SAP_Qty` · `Net_Count` · `Diff_Qty` · `Diff_Value` · `Diff_Items` · `Edits` · `Archive_Link` · `Checksum`

## ตรวจสอบ

### Admin_Log — ทุกการกระทำของหัวหน้าทีมและเหตุการณ์สำคัญ (ห้ามแก้)
| คอลัมน์ | ความหมาย |
|---|---|
| Time / By | เวลา / อีเมลผู้ทำ (หรือระบบ) |
| Action | `SETUP` `OPEN_ROUND` `RESET_ROUND` `UPLOAD_SAP` `UPLOAD_POS` `DECIDE_CONFLICT` `ACK_WARNING` `APPROVE_MASTER` `SET_API_URL` `DEVICE_ADD` `DEVICE_PAIR_CODE` `DEVICE_PAIRED` `DEVICE_REVOKE` `DEVICE_ENABLE` `IMPORT_FILE` `ROUND_COUNTING` `QUARANTINE` `LOC_SUBMIT_FOR` `LOC_TRANSFER` `MIGRATE_MEMBERS` |
| Target / Detail | สิ่งที่ถูกกระทำ / รายละเอียด |
