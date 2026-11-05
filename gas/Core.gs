/**
 * Core.gs — ตรรกะล้วน (ไม่เรียก Google API) ใช้ร่วมกันทั้งใน Apps Script และชุดทดสอบ Node
 * เฟส 1: อ่านไฟล์ SAP/POS, สร้าง Barcode_Map, ตรวจความพร้อม, เทียบ SAP กับ POS
 */
var Core = (function () {
  'use strict';

  var SAP_REQUIRED = ['Material', 'Descriptio', 'Plant', 'Qty-UR', 'Qty-IT', 'Qty-QI', 'Qty-BL', 'Barcode', 'Cust-mat'];
  var SAP_OPTIONAL = ['Amt-UR', 'MOV', 'UOM'];
  var POS_REQUIRED = ['Item_No', 'Cust_Mat', 'Barcode', 'Bal_qty'];
  var POS_OPTIONAL = ['Retail_Price', 'Short_Style'];

  var STATUS_TH = {
    MATCH: 'ตรง',
    QTY_DIFF: 'ยอดต่าง',
    ONLY_SAP: 'มีเฉพาะ SAP',
    ONLY_POS: 'มีเฉพาะ POS',
    FILLED: 'เติมบาร์โค้ด',
    CONFLICT: 'ขัดแย้ง',
    NO_SAP: 'ยังไม่มี SAP'
  };

  var SOURCE_TH = {
    SAP: 'SAP',
    POS_FILL: 'เติมจาก POS',
    POS: 'POS',
    DECIDED: 'Admin เลือก',
    NONE: 'ไม่มีบาร์โค้ด (ป้อนเอง)'
  };

  // ---------- ค่าพื้นฐาน ----------

  function str(v) {
    if (v === null || v === undefined) return '';
    return String(v).trim();
  }

  function num(v) {
    if (typeof v === 'number') return isFinite(v) ? v : 0;
    var s = str(v).replace(/,/g, '');
    if (s === '') return 0;
    // SAP บางรุ่นใส่เครื่องหมายลบไว้ท้าย เช่น 5.000-
    if (/-$/.test(s)) s = '-' + s.slice(0, -1);
    var n = parseFloat(s);
    return isFinite(n) ? n : 0;
  }

  function round3(n) {
    return Math.round(n * 1000) / 1000;
  }

  /** บาร์โค้ดเป็นข้อความเสมอ: ตัดช่องว่าง, ตัด ' นำหน้า, แปลงตัวเลขที่ Excel เก็บเป็น number */
  function normBarcode(v) {
    if (typeof v === 'number') {
      if (!isFinite(v)) return '';
      return Math.round(v).toLocaleString('fullwide', { useGrouping: false });
    }
    var s = str(v).replace(/^'+/, '').replace(/\s+/g, '');
    // 8.85E+12 → ตัวเลขเต็ม (กรณีไฟล์ผ่าน Excel มาแล้ว)
    if (/^\d+(\.\d+)?E\+\d+$/i.test(s)) {
      var n = Number(s);
      if (isFinite(n)) s = Math.round(n).toLocaleString('fullwide', { useGrouping: false });
    }
    return s.toUpperCase();
  }

  function normKey(v) {
    return str(v).toUpperCase();
  }

  function isZeroBarcode(b) {
    return b === '' || /^0+$/.test(b);
  }

  /** ตรวจ check digit ของ EAN-8 / UPC-A / EAN-13 / GTIN-14; รหัสแบบอื่น (Code128 ตัวอักษร) ถือว่าผ่าน */
  function checkDigitOk(b) {
    if (!/^\d+$/.test(b)) return true;
    if ([8, 12, 13, 14].indexOf(b.length) < 0) return true;
    var digits = b.split('').map(Number);
    var check = digits.pop();
    var sum = 0;
    for (var i = digits.length - 1, w = 3; i >= 0; i--, w = (w === 3 ? 1 : 3)) sum += digits[i] * w;
    return (10 - (sum % 10)) % 10 === check;
  }

  // ---------- อ่านตาราง ----------

  /** หาแถวหัวตารางที่มีคอลัมน์ที่ต้องใช้ครบ (ค้นใน 20 แถวแรก) */
  function findHeader(rows, required, optional) {
    var limit = Math.min(rows.length, 20);
    var best = null;
    for (var r = 0; r < limit; r++) {
      var idx = {};
      var row = rows[r] || [];
      for (var c = 0; c < row.length; c++) {
        var h = str(row[c]);
        if (h && idx[h] === undefined) idx[h] = c;
      }
      var missing = required.filter(function (k) { return idx[k] === undefined; });
      if (!best || missing.length < best.missing.length) best = { row: r, idx: idx, missing: missing };
      if (missing.length === 0) break;
    }
    if (!best) return { ok: false, missing: required.slice(), row: -1, idx: {} };
    (optional || []).forEach(function (k) { if (best.idx[k] === undefined) best.idx[k] = -1; });
    return { ok: best.missing.length === 0, missing: best.missing, row: best.row, idx: best.idx };
  }

  function cell(row, i) {
    return i >= 0 && row ? row[i] : '';
  }

  /** แปลงข้อความคั่นด้วย Tab (เช่นไฟล์ SAP ที่นามสกุล .xls) เป็นตาราง 2 มิติ */
  function parseTsv(text) {
    return String(text || '')
      .replace(/^﻿/, '')
      .split(/\r\n|\n|\r/)
      .filter(function (l) { return l.replace(/\t/g, '').trim() !== ''; })
      .map(function (l) { return l.split('\t'); });
  }

  /**
   * อ่านไฟล์ SAP ZMMD002A → รวมทุก Plant ต่อ Material
   * คืน { ok, error, rowCount, materials: {MAT: {...}}, plants: [...] }
   */
  function parseSap(rows) {
    var h = findHeader(rows, SAP_REQUIRED, SAP_OPTIONAL);
    if (!h.ok) return { ok: false, error: 'ไฟล์ SAP ขาดคอลัมน์: ' + h.missing.join(', ') };
    var I = h.idx;
    var mats = {};
    var plants = {};
    var count = 0;
    for (var r = h.row + 1; r < rows.length; r++) {
      var row = rows[r];
      var mat = normKey(cell(row, I['Material']));
      if (!mat) continue;
      count++;
      var plant = str(cell(row, I['Plant']));
      if (plant) plants[plant] = true;
      var m = mats[mat];
      if (!m) {
        m = mats[mat] = {
          material: mat, desc: '', custMat: '', barcodes: [], zeroBarcode: false, emptyBarcode: false,
          qtyUR: 0, qtyIT: 0, qtyQI: 0, qtyBL: 0, amtUR: 0, mov: 0, uom: '', plants: [], lines: 0
        };
      }
      m.lines++;
      if (!m.desc) m.desc = str(cell(row, I['Descriptio']));
      if (!m.custMat) m.custMat = normKey(cell(row, I['Cust-mat']));
      if (!m.uom) m.uom = str(cell(row, I['UOM']));
      if (plant && m.plants.indexOf(plant) < 0) m.plants.push(plant);
      var bc = normBarcode(cell(row, I['Barcode']));
      if (bc === '') m.emptyBarcode = true;
      else if (isZeroBarcode(bc)) m.zeroBarcode = true;
      else if (m.barcodes.indexOf(bc) < 0) m.barcodes.push(bc);
      m.qtyUR += num(cell(row, I['Qty-UR']));
      m.qtyIT += num(cell(row, I['Qty-IT']));
      m.qtyQI += num(cell(row, I['Qty-QI']));
      m.qtyBL += num(cell(row, I['Qty-BL']));
      m.amtUR += num(cell(row, I['Amt-UR']));
      var mov = num(cell(row, I['MOV']));
      if (!m.mov && mov) m.mov = mov;
    }
    Object.keys(mats).forEach(function (k) {
      var m = mats[k];
      m.qtyUR = round3(m.qtyUR); m.qtyIT = round3(m.qtyIT); m.qtyQI = round3(m.qtyQI); m.qtyBL = round3(m.qtyBL);
      m.unitCost = m.qtyUR > 0 && m.amtUR ? Math.round(m.amtUR / m.qtyUR * 10000) / 10000 : m.mov;
    });
    if (count === 0) return { ok: false, error: 'ไฟล์ SAP ไม่มีข้อมูลสินค้า' };
    return { ok: true, rowCount: count, materials: mats, plants: Object.keys(plants).sort() };
  }

  /**
   * อ่านไฟล์ POS Stock_Shop → หนึ่งรายการต่อ Item_No
   * คืน { ok, error, rowCount, items: {ITEM: {...}}, duplicates: [ITEM...] }
   */
  function parsePos(rows) {
    var h = findHeader(rows, POS_REQUIRED, POS_OPTIONAL);
    if (!h.ok) return { ok: false, error: 'ไฟล์ POS ขาดคอลัมน์: ' + h.missing.join(', ') };
    var I = h.idx;
    var items = {};
    var dups = {};
    var count = 0;
    for (var r = h.row + 1; r < rows.length; r++) {
      var row = rows[r];
      var item = normKey(cell(row, I['Item_No']));
      if (!item) continue;
      count++;
      var rec = {
        material: item,
        custMat: normKey(cell(row, I['Cust_Mat'])),
        barcode: normBarcode(cell(row, I['Barcode'])),
        balQty: round3(num(cell(row, I['Bal_qty']))),
        price: num(cell(row, I['Retail_Price'])),
        style: str(cell(row, I['Short_Style']))
      };
      if (items[item]) {
        dups[item] = true;
        // รวมยอดไว้ก่อน แต่ระดับบล็อกจะไม่ให้อนุมัติจนกว่าไฟล์จะถูกแก้
        items[item].balQty = round3(items[item].balQty + rec.balQty);
        if (items[item].extraBarcodes.indexOf(rec.barcode) < 0) items[item].extraBarcodes.push(rec.barcode);
      } else {
        rec.extraBarcodes = [];
        items[item] = rec;
      }
    }
    if (count === 0) return { ok: false, error: 'ไฟล์ POS ไม่มีข้อมูลสินค้า' };
    return { ok: true, rowCount: count, items: items, duplicates: Object.keys(dups).sort() };
  }

  // ---------- สร้าง Master ----------

  function decisionKey(type, id) {
    return type + '|' + id;
  }

  /**
   * sap, pos: ผลจาก parseSap / parsePos (sap อาจเป็น null ถ้ายังไม่อัปโหลด)
   * decisions: { 'BC_DIFF|MAT': 'ALL' | '<barcode>', 'BC_MULTI|BARCODE': '<material>' | 'NONE', 'FILL_CUSTMAT|MAT': 'USE_POS' | 'NONE' }
   * meta: { countDate: 'yyyy-mm-dd', sapFileDate, posFileDate } สำหรับเตือนวันที่ไฟล์
   */
  function buildMaster(sap, pos, decisions, meta) {
    decisions = decisions || {};
    meta = meta || {};
    var hasSap = !!(sap && sap.ok);
    var hasPos = !!(pos && pos.ok);
    var S = hasSap ? sap.materials : {};
    var P = hasPos ? pos.items : {};

    var allMats = {};
    Object.keys(S).forEach(function (k) { allMats[k] = true; });
    Object.keys(P).forEach(function (k) { allMats[k] = true; });
    var matList = Object.keys(allMats).sort();

    var conflicts = [];
    var info = {}; // material → { cands:[{bc,src}], flags }
    var badCheckDigit = {};
    var zeroMats = [];

    function addConflict(c) {
      c.key = decisionKey(c.type, c.id);
      c.decision = decisions[c.key] !== undefined ? decisions[c.key] : null;
      conflicts.push(c);
      return c;
    }

    matList.forEach(function (mat) {
      var s = S[mat], p = P[mat];
      var sapBcs = s ? s.barcodes.slice() : [];
      var posBc = p && !isZeroBarcode(p.barcode) ? p.barcode : '';
      var custOk = !(s && p) || !s.custMat || !p.custMat || s.custMat === p.custMat;
      var cands = [];
      var flags = { custMismatch: !custOk };

      if ((s && s.zeroBarcode) || (p && p.barcode !== '' && isZeroBarcode(p.barcode))) zeroMats.push(mat);

      if (s && p) {
        if (sapBcs.length === 0 && posBc) {
          if (custOk) {
            cands = [{ bc: posBc, src: 'POS_FILL' }];
          } else {
            var c1 = addConflict({
              type: 'FILL_CUSTMAT', id: mat, material: mat,
              title: 'SAP ไม่มีบาร์โค้ด แต่ Cust-mat ของ SAP กับ POS ไม่ตรงกัน',
              detail: 'SAP Cust-mat ' + s.custMat + ' / POS Cust_Mat ' + p.custMat + ' / บาร์โค้ด POS ' + posBc,
              options: [
                { value: 'USE_POS', label: 'ใช้บาร์โค้ด POS ' + posBc },
                { value: 'NONE', label: 'ไม่ใช้บาร์โค้ด (นับแบบป้อนเอง)' }
              ]
            });
            if (c1.decision === 'USE_POS') cands = [{ bc: posBc, src: 'DECIDED' }];
            else if (c1.decision === 'NONE') cands = [];
            else flags.pending = true;
          }
        } else if (sapBcs.length > 0) {
          var all = sapBcs.slice();
          if (posBc && all.indexOf(posBc) < 0) all.push(posBc);
          if (all.length === 1) {
            cands = [{ bc: all[0], src: 'SAP' }];
          } else {
            var c2 = addConflict({
              type: 'BC_DIFF', id: mat, material: mat,
              title: 'บาร์โค้ดของรหัสนี้ไม่ตรงกัน',
              detail: 'SAP: ' + sapBcs.join(', ') + (posBc ? ' / POS: ' + posBc : ''),
              options: [{ value: 'ALL', label: 'ใช้ทุกบาร์โค้ด (ยิงตัวไหนก็เป็นรหัสนี้)' }].concat(all.map(function (b) {
                return { value: b, label: 'ใช้ ' + b + (sapBcs.indexOf(b) >= 0 ? ' (SAP)' : ' (POS)') };
              }))
            });
            if (c2.decision === 'ALL') cands = all.map(function (b) { return { bc: b, src: 'DECIDED' }; });
            else if (c2.decision && all.indexOf(c2.decision) >= 0) cands = [{ bc: c2.decision, src: 'DECIDED' }];
            else flags.pending = true;
          }
        }
      } else if (s) {
        if (sapBcs.length === 1) cands = [{ bc: sapBcs[0], src: 'SAP' }];
        else if (sapBcs.length > 1) {
          var c3 = addConflict({
            type: 'BC_DIFF', id: mat, material: mat,
            title: 'SAP มีหลายบาร์โค้ดในรหัสเดียว',
            detail: 'SAP: ' + sapBcs.join(', '),
            options: [{ value: 'ALL', label: 'ใช้ทุกบาร์โค้ด' }].concat(sapBcs.map(function (b) { return { value: b, label: 'ใช้ ' + b }; }))
          });
          if (c3.decision === 'ALL') cands = sapBcs.map(function (b) { return { bc: b, src: 'DECIDED' }; });
          else if (c3.decision && sapBcs.indexOf(c3.decision) >= 0) cands = [{ bc: c3.decision, src: 'DECIDED' }];
          else flags.pending = true;
        }
      } else if (p) {
        if (posBc) cands = [{ bc: posBc, src: 'POS' }];
      }

      cands.forEach(function (c) { if (!checkDigitOk(c.bc)) badCheckDigit[c.bc] = mat; });
      info[mat] = { cands: cands, flags: flags };
    });

    // บาร์โค้ดเดียวชี้หลาย Material
    var bcIndex = {};
    matList.forEach(function (mat) {
      info[mat].cands.forEach(function (c) {
        (bcIndex[c.bc] = bcIndex[c.bc] || []).push(mat);
      });
    });
    Object.keys(bcIndex).sort().forEach(function (bc) {
      var mats = bcIndex[bc];
      if (mats.length < 2) return;
      var c = addConflict({
        type: 'BC_MULTI', id: bc, barcode: bc, material: mats.join(', '),
        title: 'บาร์โค้ดเดียวชี้หลายรหัสสินค้า',
        detail: bc + ' → ' + mats.join(', '),
        options: mats.map(function (m) { return { value: m, label: 'เป็นของ ' + m }; })
          .concat([{ value: 'NONE', label: 'ไม่ใช้บาร์โค้ดนี้' }])
      });
      mats.forEach(function (m) {
        if (c.decision === null || mats.indexOf(c.decision) < 0 && c.decision !== 'NONE') {
          info[m].flags.pending = true;
          info[m].cands = info[m].cands.filter(function (x) { return x.bc !== bc; });
        } else if (c.decision !== m) {
          info[m].cands = info[m].cands.filter(function (x) { return x.bc !== bc; });
        }
      });
    });

    // ---------- แถว Barcode_Map และตารางเทียบ ----------
    var mapRows = [];
    var compare = [];
    var counts = { MATCH: 0, QTY_DIFF: 0, ONLY_SAP: 0, ONLY_POS: 0, FILLED: 0, CONFLICT: 0, NO_SAP: 0 };
    var stats = {
      materials: matList.length, sapMaterials: Object.keys(S).length, posItems: Object.keys(P).length,
      matched: 0, posFilled: 0, noBarcode: 0, sapQtyTotal: 0, posQtyTotal: 0, sapValueTotal: 0,
      specialStatus: 0, barcodes: 0
    };
    var onlyNonZero = [];
    var qtyDiff = [];
    var noBarcodeNonZero = [];
    var filled = [];
    var special = [];

    matList.forEach(function (mat) {
      var s = S[mat], p = P[mat], inf = info[mat];
      var sapQty = s ? s.qtyUR : 0;
      var posQty = p ? p.balQty : 0;
      var book = hasSap ? sapQty : posQty;
      var name = (s && s.desc) || (p && (p.style || p.custMat)) || mat;
      var custMat = (s && s.custMat) || (p && p.custMat) || '';
      var unitCost = s ? (s.unitCost || 0) : 0;
      if (s && p) stats.matched++;
      stats.sapQtyTotal += sapQty;
      stats.posQtyTotal += posQty;
      stats.sapValueTotal += sapQty * unitCost;
      if (s && (s.qtyIT || s.qtyQI || s.qtyBL)) { stats.specialStatus++; special.push(mat); }

      var status;
      if (inf.flags.pending) status = 'CONFLICT';
      else if (!hasSap) status = 'NO_SAP';
      else if (s && !p && hasPos) status = 'ONLY_SAP';
      else if (p && !s) status = 'ONLY_POS';
      else if (inf.cands.some(function (c) { return c.src === 'POS_FILL'; })) status = 'FILLED';
      else if (s && p && sapQty !== posQty) status = 'QTY_DIFF';
      else status = 'MATCH';
      // ยอดต่างสำคัญกว่าการเติมบาร์โค้ด ถ้าเกิดพร้อมกันให้แสดงยอดต่าง
      if (status === 'FILLED' && s && p && sapQty !== posQty) status = 'QTY_DIFF';
      counts[status]++;

      if (inf.cands.some(function (c) { return c.src === 'POS_FILL'; })) { stats.posFilled++; filled.push(mat); }
      if (hasSap && hasPos && ((s && !p && sapQty !== 0) || (p && !s && posQty !== 0))) onlyNonZero.push(mat);
      if (s && p && sapQty !== posQty) qtyDiff.push(mat);
      if (!inf.cands.length && !inf.flags.pending) {
        stats.noBarcode++;
        if (book !== 0) noBarcodeNonZero.push(mat);
      }

      compare.push({
        material: mat, custMat: custMat, name: name, status: status, statusTh: STATUS_TH[status],
        sapBarcodes: s ? s.barcodes.join(' ') + (s.zeroBarcode ? (s.barcodes.length ? ' ' : '') + '(0000)' : '') : '',
        posBarcode: p ? p.barcode : '',
        sapQty: s ? sapQty : '', posQty: p ? posQty : '', diff: s && p ? round3(sapQty - posQty) : '',
        sapIT: s ? s.qtyIT : '', sapQI: s ? s.qtyQI : '', sapBL: s ? s.qtyBL : '',
        custMismatch: inf.flags.custMismatch,
        finalBarcodes: inf.cands.map(function (c) { return c.bc; }).join(' ')
      });

      var base = {
        material: mat, custMat: custMat, name: name, sapQty: s ? sapQty : '', posQty: p ? posQty : '',
        bookQty: book, bookSource: hasSap ? 'SAP' : 'POS', unitCost: unitCost,
        sapIT: s ? s.qtyIT : 0, sapQI: s ? s.qtyQI : 0, sapBL: s ? s.qtyBL : 0,
        price: p ? p.price : '', status: status
      };
      if (inf.cands.length) {
        inf.cands.forEach(function (c) {
          stats.barcodes++;
          mapRows.push(Object.assign({ barcode: c.bc, source: c.src, sourceTh: SOURCE_TH[c.src] }, base));
        });
      } else {
        mapRows.push(Object.assign({ barcode: '', source: inf.flags.pending ? 'PENDING' : 'NONE',
          sourceTh: inf.flags.pending ? 'รอ Admin ตัดสิน' : SOURCE_TH.NONE }, base));
      }
    });
    stats.sapQtyTotal = round3(stats.sapQtyTotal);
    stats.posQtyTotal = round3(stats.posQtyTotal);
    stats.sapValueTotal = Math.round(stats.sapValueTotal * 100) / 100;

    var pendingConflicts = conflicts.filter(function (c) {
      return c.decision === null || !c.options.some(function (o) { return o.value === c.decision; });
    });

    // ---------- รายการตรวจความพร้อม ----------
    var checks = [];
    function chk(id, level, title, count, items, note) {
      checks.push({ id: id, level: level, title: title, count: count, pass: count === 0, items: (items || []).slice(0, 200), note: note || '' });
    }
    chk('ROUND_OPEN', 'BLOCK', meta.projectId ? 'รอบนับ ' + meta.projectId : 'ยังไม่เปิดรอบนับ', meta.projectId ? 0 : 1, [],
      meta.projectId ? 'วันนับ ' + (meta.countDate || '-') : 'Master ต้องผูกกับรอบนับ เปิดรอบก่อนอนุมัติ');
    chk('POS_LOADED', 'BLOCK', hasPos ? 'ไฟล์ POS (แหล่งบาร์โค้ด)' : 'ยังไม่มีไฟล์ POS', hasPos ? 0 : 1, [], hasPos ? pos.rowCount + ' แถว' : 'อัปโหลด POS ในแท็บนำเข้าไฟล์');
    chk('POS_DUP', 'BLOCK', 'Item_No ซ้ำใน POS', hasPos ? pos.duplicates.length : 0, hasPos ? pos.duplicates : []);
    chk('CONFLICT', 'BLOCK', 'บาร์โค้ดขัดแย้งที่ยังไม่ตัดสิน', pendingConflicts.length,
      pendingConflicts.map(function (c) { return c.detail; }));
    // ไม่มี SAP ไม่กระทบรายการบาร์โค้ดที่ส่งลงเครื่อง จึงเป็นข้อมูลแจ้ง (INFO) ไม่ต้องกดรับทราบตอนอนุมัติ
    chk('SAP_LOADED', 'INFO', hasSap ? 'ยอด SAP' : 'ยังไม่มียอด SAP', hasSap ? 0 : 1, [],
      hasSap ? sap.rowCount + ' แถว, Plant ' + sap.plants.join('/') : 'ใช้ยอด POS เป็นยอดชั่วคราว อัปโหลด SAP หลังบัญชียืนยันยอด D−1 ได้ ไม่ต้องอนุมัติใหม่');
    chk('POS_FILL', 'WARN', 'SAP ไม่มีบาร์โค้ด (เติมจาก POS)', filled.length, filled.map(function (m) {
      var p = P[m]; return m + ' → ' + (p ? p.barcode : '');
    }), 'ใส่ในตารางข้อยกเว้นเพื่อแจ้งทีม SAP');
    var zeroNonZeroQty = zeroMats.filter(function (m) { return (S[m] ? S[m].qtyUR : 0) !== 0 || (P[m] ? P[m].balQty : 0) !== 0; });
    var badCd = Object.keys(badCheckDigit);
    chk('BAD_BARCODE', 'WARN', 'บาร์โค้ด 0000 หรือ check digit ผิด', zeroMats.length + badCd.length,
      zeroMats.map(function (m) { return m + ' (0000)'; }).concat(badCd.map(function (b) { return b + ' (check digit ผิด) → ' + badCheckDigit[b]; })),
      zeroMats.length ? zeroMats.length + ' รหัสเป็น 0000' + (zeroNonZeroQty.length ? ' มียอดไม่เป็น 0 จำนวน ' + zeroNonZeroQty.length : ' ยอด 0 ทั้งหมด') : '');
    chk('ONLY_ONE_SIDE', 'WARN', 'มีเฉพาะ SAP หรือเฉพาะ POS ที่ยอดไม่เป็น 0', onlyNonZero.length, onlyNonZero);
    chk('QTY_DIFF', 'WARN', 'ยอด SAP ไม่เท่า POS ต่อ Material', hasSap && hasPos ? qtyDiff.length : 0, qtyDiff.map(function (m) {
      return m + ' SAP ' + S[m].qtyUR + ' / POS ' + P[m].balQty;
    }), hasSap && hasPos && qtyDiff.length > 20 ? 'ต่างกันหลายรหัส อาจเป็นเพราะบัญชียังปิดยอด D−1 ไม่ครบ' : '');
    chk('NO_BARCODE_STOCK', 'WARN', 'รหัสที่มียอดแต่ไม่มีบาร์โค้ด (ต้องป้อนเอง)', noBarcodeNonZero.length, noBarcodeNonZero);
    chk('CUST_MISMATCH', 'WARN', 'Cust-mat ของ SAP กับ POS ไม่ตรงกัน', matList.filter(function (m) { return info[m].flags.custMismatch; }).length,
      matList.filter(function (m) { return info[m].flags.custMismatch; }));
    var dateIssues = fileDateIssues(meta);
    chk('FILE_DATE', 'WARN', 'วันที่ไฟล์ห่างจากวันนับ', dateIssues.length, dateIssues);

    var blocking = checks.filter(function (c) { return c.level === 'BLOCK' && !c.pass; }).length;
    return {
      hasSap: hasSap, hasPos: hasPos, rows: mapRows, compare: compare, counts: counts,
      conflicts: conflicts, pendingConflicts: pendingConflicts.length, checks: checks,
      blocking: blocking, canApprove: blocking === 0, stats: stats, special: special
    };
  }

  function daysBetween(a, b) {
    var da = Date.parse(a + 'T00:00:00Z'), db = Date.parse(b + 'T00:00:00Z');
    if (isNaN(da) || isNaN(db)) return null;
    return Math.round((db - da) / 86400000);
  }

  /** เตือนเมื่อไฟล์เก่ากว่าวันนับเกิน 2 วัน หรือเป็นไฟล์จากอนาคต (ค่าวันที่ yyyy-mm-dd) */
  function fileDateIssues(meta) {
    var out = [];
    if (!meta.countDate) return out;
    [['SAP', meta.sapFileDate], ['POS', meta.posFileDate]].forEach(function (x) {
      if (!x[1]) return;
      var d = daysBetween(x[1], meta.countDate);
      if (d === null) return;
      if (d > 2) out.push('ไฟล์ ' + x[0] + ' ลงวันที่ ' + x[1] + ' เก่ากว่าวันนับ ' + d + ' วัน');
      if (d < -1) out.push('ไฟล์ ' + x[0] + ' ลงวันที่ ' + x[1] + ' หลังวันนับ ' + (-d) + ' วัน');
    });
    return out;
  }

  /** ข้อความที่ใช้ทำ checksum ของ Master ที่ส่งลงเครื่อง (เรียงแน่นอน) */
  function deviceMasterRows(rows) {
    return rows.filter(function (r) { return r.barcode; })
      .map(function (r) { return [r.barcode, r.material, r.custMat, r.name]; })
      .sort(function (a, b) { return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : (a[1] < b[1] ? -1 : 1); });
  }

  /** แปลงตารางเทียบเป็น CSV (มี BOM ให้ Excel อ่านภาษาไทยได้) */
  function toCsv(header, rows) {
    function esc(v) {
      var s = v === null || v === undefined ? '' : String(v);
      return /[",\r\n]/.test(s) || /^\d{8,}$/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }
    return '﻿' + [header].concat(rows).map(function (r) { return r.map(esc).join(','); }).join('\r\n');
  }

  return {
    SAP_REQUIRED: SAP_REQUIRED, POS_REQUIRED: POS_REQUIRED, STATUS_TH: STATUS_TH, SOURCE_TH: SOURCE_TH,
    str: str, num: num, normBarcode: normBarcode, isZeroBarcode: isZeroBarcode, checkDigitOk: checkDigitOk,
    findHeader: findHeader, parseTsv: parseTsv, parseSap: parseSap, parsePos: parsePos,
    buildMaster: buildMaster, fileDateIssues: fileDateIssues, deviceMasterRows: deviceMasterRows,
    decisionKey: decisionKey, toCsv: toCsv
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Core;
