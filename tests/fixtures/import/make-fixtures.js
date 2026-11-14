'use strict';
/* Regenerates the import fixtures. The committed files are the source of
 * truth for the tests; this script only documents how they were made.
 *
 *   node tests/fixtures/import/make-fixtures.js
 *
 * Both files use Turkish headers and the phone formats people actually type:
 * spaces, brackets, dots, a leading 0, a leading +90 or 0090, and a number
 * Excel stored as a number. They also carry the rows an import must refuse or
 * flag: a missing name, a bad email, a too-short phone, and the same guest
 * twice in one file.
 */

const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');

const HERE = __dirname;

async function xlsx() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Misafirler');
  ws.addRow(['Ad', 'Soyad', 'Telefon', 'E-posta', 'Pasaport No', 'Uyruk', 'Not', 'Pazarlamacı', 'Oyun Gücü']);
  ws.addRow(['Ayşe', 'Yıldız', '0532 123 45 67', 'ayse@example.com', 'u1234567', 'TR', 'VIP masa ister', 'Sena Yilmaz', 'Yüksek']);
  ws.addRow(['Mehmet', 'Öztürk', '+90 (533) 765-43-21', '', 'U7654321', 'TR', '', 'Sena Yilmaz', 'Orta']);
  ws.addRow(['Dimitri', 'Ivanov', 905551112233, 'dimitri@example', 'RU998877', 'RU', 'Poker', 'Nobody Known', '']);
  ws.addRow(['', '', '0532 000 00 00', '', '', '', 'İsimsiz satır', '', '']);
  ws.addRow(['Ayşe', 'Yıldız', '+905321234567', '', '', 'TR', 'Aynı misafir', '', '']);
  ws.addRow(['Can', 'Kaya', '12', '', '', 'TR', '', '', '']);
  /* A formula: the import must read the cached result and never evaluate it. */
  ws.addRow(['Selin', 'Çelik', '0090 212 555 66 77', '', '', 'TR',
    { formula: 'CONCATENATE("Ziyaret ","2026")', result: 'Ziyaret 2026' }, '', '']);
  ws.addRow(['Thomas', 'Weber', '532.444.55.66', 'thomas@example.de', 'C01X00T47', 'DE', 'Prefers sea view', '', 'Low']);
  const second = wb.addWorksheet('Notlar');
  second.addRow(['Bu sayfa misafir içermez']);
  await wb.xlsx.writeFile(path.join(HERE, 'misafirler.xlsx'));
}

function csv() {
  const rows = [
    ['Ad Soyad', 'GSM', 'Mail', 'Pasaport', 'Uyruğu', 'Misafir Notu', 'Sorumlu', 'Oyun gücü'],
    ['Zeynep Arslan', '0 (544) 321 98 76', 'zeynep@example.com', 'u5550001', 'TR', 'Doğum günü Mart', 'Sena Yilmaz', '50.000 TL'],
    ['Hans Müller', '+49 151 2345 6789', '', 'C55X11Q22', 'DE', 'Rulet; blackjack', '', 'Yüksek'],
    ['Avi Cohen', '0532-765-43-21', 'avi@example.com', '', 'IL', '"Kosher" menü', '', ''],
    ['Kötü Eposta', '0555 555 55 55', 'not-an-email', '', 'TR', '', '', ''],
    ['', '0505 505 05 05', '', '', '', 'Boş isim', '', ''],
  ];
  const cell = (v) => (/[;"\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const text = rows.map((r) => r.map(cell).join(';')).join('\r\n') + '\r\n';
  fs.writeFileSync(path.join(HERE, 'misafirler.csv'), `﻿${text}`, 'utf8');
}

xlsx().then(csv).then(() => console.log('fixtures written'));
