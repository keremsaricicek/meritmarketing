'use strict';
/* Runtime payload validation for every IPC channel.
 *
 * The renderer is not a trusted client. Even setting XSS aside, a bug that
 * sends a string where a number belongs should be refused at the boundary
 * rather than reaching SQL. Every schema uses `.strict()`, so an unexpected
 * field is a rejection rather than something silently carried into an UPDATE —
 * that is what closes mass assignment on ownership, timestamps and row_version.
 */

const { z } = require('zod');

const id = z.number().int().positive();
const idLike = z.union([id, z.string().regex(/^\d+$/).transform(Number)]);
const businessDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected a YYYY-MM-DD date');
const text = (max) => z.string().max(max);
const optionalText = (max) => text(max).nullish();
const profileRef = z.union([idLike, z.literal(''), z.null()]).nullish();

/* Paging and sorting are bounded here rather than trusted: an unbounded
   pageSize is a denial-of-service against the main process, and a free-text
   sort field is a SQL injection vector if it ever reaches string concatenation.
   The repositories additionally whitelist sort names. */
const paging = {
  page: z.number().int().positive().max(100000).optional(),
  pageSize: z.number().int().positive().max(5000).optional(),
  sort: z.string().max(40).optional(),
  dir: z.enum(['asc', 'desc', 'ASC', 'DESC']).optional(),
  search: text(200).optional(),
};

const empty = z.object({}).strict();
const byId = z.object({ id: idLike }).strict();

const SCHEMAS = {
  'app:info': empty,
  'app:needsSetup': empty,

  'auth:setup': z.object({
    username: text(64),
    password: text(200),
    passwordConfirm: text(200),
    fullName: optionalText(120),
  }).strict(),
  'auth:login': z.object({ username: text(64), password: text(200) }).strict(),
  'auth:logout': empty,
  'auth:session': empty,
  'auth:changePassword': z.object({
    currentPassword: text(200),
    newPassword: text(200),
    newPasswordConfirm: text(200),
  }).strict(),

  'customers:list': z.object({
    ...paging,
    status: z.enum(['ACTIVE', 'COLD', 'NO_RECORD']).optional(),
    noRecord: z.boolean().optional(),
    registeredOnly: z.boolean().optional(),
    unregisteredOnly: z.boolean().optional(),
    assignedTo: profileRef,
    createdBy: profileRef,
  }).strict(),
  'customers:get': byId,
  'customers:history': byId,
  'customers:summary': byId,
  'customers:picker': z.object({ search: text(200).optional(), pageSize: z.number().int().positive().max(200).optional() }).strict(),
  'customers:create': z.object({
    code: text(40),
    fullName: text(160),
    registered: z.boolean().optional(),
    phone: optionalText(40),
    email: optionalText(160),
    passportNo: optionalText(60),
    nationality: optionalText(80),
    photoName: optionalText(120),
    notes: optionalText(4000),
    marketingProfileId: profileRef,
  }).strict(),
  'customers:update': z.object({
    id: idLike,
    code: text(40).optional(),
    fullName: text(160).optional(),
    registered: z.boolean().optional(),
    phone: optionalText(40),
    email: optionalText(160),
    passportNo: optionalText(60),
    nationality: optionalText(80),
    photoName: optionalText(120),
    notes: optionalText(4000),
    /* Accepted only so a round-tripping edit form still works; the service
       refuses any value that differs from the current owner. */
    marketingProfileId: profileRef,
  }).strict(),
  'customers:assign': z.object({ id: idLike, profileId: profileRef, reason: optionalText(200) }).strict(),
  'customers:delete': byId,
  'customers:protection': byId,

  'reservations:list': z.object({
    ...paging,
    view: z.enum(['active', 'cancelled']).optional(),
    status: z.enum(['UPCOMING', 'CHECKED_IN', 'COMPLETED']).optional(),
    customerId: idLike.optional(),
    invitedBy: profileRef,
    from: businessDate.optional(),
    to: businessDate.optional(),
  }).strict(),
  'reservations:listDeleted': z.object({
    ...paging,
    customerId: idLike.optional(),
    invitedBy: profileRef,
    from: businessDate.optional(),
    to: businessDate.optional(),
  }).strict(),
  'reservations:get': byId,
  'reservations:create': z.object({
    customerId: idLike,
    checkIn: businessDate,
    checkOut: businessDate,
    invitedByProfileId: profileRef,
    note: optionalText(2000),
    force: z.boolean().optional(),
  }).strict(),
  'reservations:update': z.object({
    id: idLike,
    customerId: idLike.optional(),
    checkIn: businessDate.optional(),
    checkOut: businessDate.optional(),
    invitedByProfileId: profileRef,
    note: optionalText(2000),
    force: z.boolean().optional(),
  }).strict(),
  'reservations:cancel': z.object({ id: idLike, reason: optionalText(300) }).strict(),
  'reservations:delete': z.object({ id: idLike, reason: text(300) }).strict(),

  'crmNotes:list': z.object({ customerId: idLike }).strict(),
  'crmNotes:create': z.object({ customerId: idLike, note: text(4000) }).strict(),
  'crmNotes:update': z.object({ id: idLike, note: text(4000) }).strict(),
  'crmNotes:delete': byId,

  'profiles:list': z.object({ includeStaff: z.boolean().optional() }).strict(),
  'profiles:get': byId,
  'profiles:related': byId,
  'profiles:create': z.object({
    fullName: text(160),
    kind: z.enum(['marketing', 'staff']).optional(),
    passportNo: optionalText(60),
    phone: optionalText(40),
    nationality: optionalText(80),
    email: optionalText(160),
    notes: optionalText(4000),
  }).strict(),
  'profiles:update': z.object({
    id: idLike,
    fullName: text(160).optional(),
    passportNo: optionalText(60),
    phone: optionalText(40),
    nationality: optionalText(80),
    email: optionalText(160),
    notes: optionalText(4000),
    inactive: z.boolean().optional(),
  }).strict(),
  'profiles:delete': byId,

  'users:list': empty,
  'users:create': z.object({
    username: text(64),
    password: text(200),
    role: z.enum(['ADMIN', 'MANAGER', 'MARKETING']),
    profileId: profileRef,
    fullName: optionalText(120),
    active: z.boolean().optional(),
  }).strict(),
  'users:update': z.object({
    id: idLike,
    username: text(64).optional(),
    password: text(200).optional(),
    role: z.enum(['ADMIN', 'MANAGER', 'MARKETING']).optional(),
    profileId: profileRef,
    fullName: optionalText(120),
    active: z.boolean().optional(),
  }).strict(),
  'users:delete': byId,

  'settings:all': empty,
  'settings:set': z.object({ key: text(80), value: text(2000) }).strict(),
  'settings:permissions': empty,
  'settings:setPermissions': z.object({ matrix: z.record(z.string(), z.record(z.string(), z.boolean())) }).strict(),

  'notifications:list': empty,
  'notifications:unreadCount': empty,
  'notifications:markRead': byId,
  'notifications:markAllRead': empty,
  'notifications:delete': byId,

  'dashboard:load': z.object({
    periodDays: z.union([z.literal('all'), z.number().int().positive().max(3650),
      z.string().regex(/^\d+$/).transform(Number)]).optional(),
  }).strict(),
  'calendar:month': z.object({
    year: z.number().int().min(1970).max(2200),
    month: z.number().int().min(1).max(12),
  }).strict(),
  'calendar:day': z.object({ date: businessDate }).strict(),

  'audit:list': z.object({
    ...paging,
    action: text(60).optional(),
    entityType: text(40).optional(),
    from: text(40).optional(),
    to: text(40).optional(),
  }).strict(),

  'export:run': z.object({
    entity: z.enum(['customerlist', 'norecord', 'reservations', 'cancelled', 'deleted', 'profiles', 'audit']),
    params: z.record(z.string(), z.unknown()).optional(),
  }).strict(),

  'photos:import': empty,
  'photos:read': z.object({ name: z.string().max(120) }).strict(),
  'photos:remove': z.object({ name: z.string().max(120) }).strict(),

  'backup:list': empty,
  'backup:create': z.object({ label: optionalText(80) }).strict(),
  'backup:restore': z.object({ name: z.string().max(200) }).strict(),

  'updates:check': empty,
  'updates:install': empty,
};

module.exports = { SCHEMAS };
