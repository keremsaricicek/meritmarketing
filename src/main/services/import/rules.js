'use strict';
/* What a spreadsheet row means as a guest.
 *
 * Pure functions: header guessing, normalisation and per-row validation. No
 * database access here, so every rule can be tested on its own and the
 * preview and the import cannot disagree about what a row is.
 */

/* The fields a column can be mapped to, in the order the mapping step shows
   them. `max` mirrors the customers:create schema so an imported value can
   never be one the form itself would refuse. */
const FIELDS = Object.freeze([
  { key: 'fullName', label: 'Full name', max: 160 },
  { key: 'firstName', label: 'Name', max: 80 },
  { key: 'lastName', label: 'Surname', max: 80 },
  { key: 'code', label: 'Guest ID', max: 40 },
  { key: 'phone', label: 'Phone', max: 40 },
  { key: 'email', label: 'Email', max: 160 },
  { key: 'passportNo', label: 'Passport no', max: 60 },
  { key: 'nationality', label: 'Nationality', max: 80 },
  { key: 'notes', label: 'Guest note', max: 3800 },
  { key: 'gamingPower', label: 'Gaming power', max: 120 },
  { key: 'owner', label: 'Owner (marketing name)', max: 160 },
]);
const FIELD_KEYS = FIELDS.map((f) => f.key);

/* Turkish and English header spellings, already folded (see fold()). Exact
   matches win over partial ones. */
const SYNONYMS = Object.freeze({
  fullName: ['adsoyad', 'adisoyadi', 'adsoyadi', 'isimsoyisim', 'isimsoyad', 'adivesoyadi', 'fullname',
    'namesurname', 'guestname', 'customername', 'misafir', 'misafiradi', 'musteri', 'musteriadi', 'guest'],
  firstName: ['ad', 'adi', 'isim', 'ismi', 'firstname', 'givenname', 'first', 'name'],
  lastName: ['soyad', 'soyadi', 'soyisim', 'soyismi', 'surname', 'lastname', 'familyname', 'last'],
  code: ['guestid', 'misafirid', 'misafirkodu', 'musterikodu', 'musterino', 'customerid', 'kod', 'code', 'id'],
  phone: ['telefon', 'telefonu', 'telefonno', 'telefonnumarasi', 'tel', 'telno', 'gsm', 'cep', 'ceptelefonu',
    'ceptel', 'phone', 'phonenumber', 'mobile', 'mobilephone', 'cell'],
  email: ['eposta', 'epostaadresi', 'email', 'emailadresi', 'mail', 'emailaddress'],
  passportNo: ['pasaport', 'pasaportno', 'pasaportnumarasi', 'passport', 'passportno', 'passportnumber'],
  nationality: ['uyruk', 'uyrugu', 'nationality', 'milliyet', 'ulke', 'country'],
  notes: ['not', 'notlar', 'notu', 'aciklama', 'misafirnotu', 'note', 'notes', 'guestnote', 'remarks', 'comment', 'comments'],
  gamingPower: ['oyungucu', 'oyunkapasitesi', 'gamingpower', 'gamepower', 'gamestrength', 'gamingstrength', 'oyun', 'power'],
  owner: ['marketing', 'pazarlama', 'pazarlamaci', 'sorumlu', 'temsilci', 'owner', 'atanan', 'assignedto',
    'marketingname', 'marketer', 'invitedby', 'daveteden'],
});

/** Lower-case ASCII fold that treats Turkish letters as their base letter. */
function fold(text) {
  return String(text || '')
    .replace(/İ/g, 'i').replace(/I/g, 'i').replace(/ı/g, 'i')
    .toLowerCase()
    .replace(/ş/g, 's').replace(/ğ/g, 'g').replace(/ü/g, 'u').replace(/ö/g, 'o').replace(/ç/g, 'c')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

/** { field: columnIndex } guessed from a header row. */
function guessMapping(headers) {
  const folded = headers.map(fold);
  const mapping = {};
  const taken = new Set();
  const claim = (field, index) => { mapping[field] = index; taken.add(index); };

  /* Pass 1: exact matches. */
  for (const field of FIELD_KEYS) {
    const index = folded.findIndex((h, i) => !taken.has(i) && h && SYNONYMS[field].includes(h));
    if (index >= 0) claim(field, index);
  }
  /* Pass 2: a header that contains a distinctive synonym ("Cep Telefonu 1"). */
  for (const field of FIELD_KEYS) {
    if (mapping[field] !== undefined) continue;
    const index = folded.findIndex((h, i) => !taken.has(i) && h
      && SYNONYMS[field].some((syn) => syn.length >= 4 && h.includes(syn)));
    if (index >= 0) claim(field, index);
  }
  /* A lone "Name"/"Ad" column with no surname column next to it is a full
     name, not a first name. */
  if (mapping.firstName !== undefined && mapping.lastName === undefined && mapping.fullName === undefined) {
    mapping.fullName = mapping.firstName;
    delete mapping.firstName;
  }
  if (mapping.fullName !== undefined && mapping.firstName !== undefined && mapping.lastName !== undefined) {
    /* Both shapes present: prefer the explicit full name column. */
    delete mapping.firstName; delete mapping.lastName;
  }
  return mapping;
}

/** Digits only, keeping a leading + (and reading a leading 00 as +). */
function normalisePhone(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';
  const plus = /^\s*\+/.test(text);
  let digits = text.replace(/\D/g, '');
  if (!plus && digits.startsWith('00')) return `+${digits.slice(2)}`;
  return plus ? `+${digits}` : digits;
}

/* Duplicate keys are the SAME ones the duplicate warning on the guest form
   uses (guest-service), so an import and the form never disagree about
   whether two guests are one: digits only, leading zeros dropped, last ten
   digits — +90 532…, 0532… and 532… are one line. */
function phoneKey(phone) {
  const { normalizePhone, MIN_PHONE_DIGITS } = require('../guest-service');
  const key = normalizePhone(phone);
  return key.length >= MIN_PHONE_DIGITS ? key : '';
}

function passportKey(passport) {
  const key = require('../guest-service').normalizePassport(passport);
  return key.length >= 3 ? key : '';
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function collapse(text) { return String(text || '').replace(/\s+/g, ' ').trim(); }

/**
 * One spreadsheet row → { values, problems }.
 * `values` are what would be written; `problems` are reasons the row cannot be.
 */
function interpretRow(cells, mapping) {
  const pick = (field) => {
    const index = mapping[field];
    return Number.isInteger(index) && index >= 0 && index < cells.length ? collapse(cells[index]) : '';
  };
  const problems = [];
  const values = {};

  let fullName = pick('fullName');
  if (!fullName) fullName = collapse(`${pick('firstName')} ${pick('lastName')}`);
  values.fullName = fullName;
  if (!fullName) problems.push('Name is missing');

  values.code = pick('code');
  values.phone = normalisePhone(pick('phone'));
  if (values.phone && values.phone.replace(/\D/g, '').length < 7) problems.push('Phone number is too short');
  values.email = pick('email').toLowerCase();
  if (values.email && !EMAIL.test(values.email)) problems.push('Email is not valid');
  values.passportNo = pick('passportNo').toUpperCase();
  values.nationality = pick('nationality');
  values.owner = pick('owner');

  const note = pick('notes');
  const power = pick('gamingPower');
  /* There is no gaming-power column on a guest, so it is kept where an
     operator will read it: in the guest note, labelled. */
  values.notes = [note, power ? `Gaming power: ${power}` : ''].filter(Boolean).join('\n');

  for (const field of FIELDS) {
    const value = field.key === 'notes' ? values.notes : values[field.key];
    if (value && value.length > field.max) problems.push(`${field.label} is longer than ${field.max} characters`);
  }
  return { values, problems };
}

/** Validates a mapping the renderer sent back: known fields, sane columns. */
function cleanMapping(mapping, width) {
  const out = {};
  for (const [field, index] of Object.entries(mapping || {})) {
    if (!FIELD_KEYS.includes(field)) continue;
    if (!Number.isInteger(index) || index < 0 || index >= width) continue;
    out[field] = index;
  }
  return out;
}

module.exports = {
  FIELDS, FIELD_KEYS, SYNONYMS, fold, guessMapping, normalisePhone, phoneKey, passportKey,
  interpretRow, cleanMapping,
};
