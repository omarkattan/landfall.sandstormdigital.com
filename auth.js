'use strict';

const crypto = require('crypto');
const { query } = require('./db');

/**
 * Sessions are stateless signed tokens rather than rows in a table. At this
 * scale a database round trip per request buys nothing, and a signed token
 * with a short life is easy to reason about. The signing secret is ADMIN_KEY,
 * which is already required for the app to start.
 */

const SESSION_DAYS = 30;
const SCRYPT_KEYLEN = 64;

function secret() {
  const key = process.env.ADMIN_KEY;
  if (!key) throw new Error('ADMIN_KEY is not set, so sessions cannot be signed.');
  return key;
}

function sign(payload) {
  return crypto.createHmac('sha256', secret()).update(payload).digest('base64url');
}

function issueSession(userId) {
  const expires = Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000;
  const payload = `${userId}.${expires}`;
  return `${payload}.${sign(payload)}`;
}

function readSession(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [userId, expires, signature] = parts;
  const expected = sign(`${userId}.${expires}`);

  // Constant-time compare, so a wrong signature cannot be narrowed down by
  // timing how long the rejection took.
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  if (Number(expires) < Date.now()) return null;

  return { userId: parseInt(userId, 10) };
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.startsWith('scrypt$')) return false;
  const [, salt, hash] = stored.split('$');
  const candidate = crypto.scryptSync(password, salt, SCRYPT_KEYLEN);
  const known = Buffer.from(hash, 'hex');
  if (candidate.length !== known.length) return false;
  return crypto.timingSafeEqual(candidate, known);
}

function normaliseEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function validEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);
}

function passwordProblem(password) {
  const p = String(password || '');
  if (p.length < 10) return 'Use at least 10 characters.';
  if (!/[a-zA-Z]/.test(p) || !/[0-9]/.test(p)) return 'Include at least one letter and one number.';
  return null;
}

async function findUserByEmail(email) {
  const r = await query('select * from users where email = $1', [normaliseEmail(email)]);
  return r.rows[0] || null;
}

async function findUserById(id) {
  const r = await query('select * from users where id = $1', [id]);
  return r.rows[0] || null;
}

async function countUsers() {
  const r = await query('select count(*)::int as n from users');
  return r.rows[0].n;
}

/**
 * The first account created becomes an active admin, so a fresh deployment is
 * usable without touching the database. Everyone after that starts pending and
 * has to be let in.
 */
async function createUser({ email, name, password, googleSub }) {
  const clean = normaliseEmail(email);
  const first = (await countUsers()) === 0;

  const r = await query(
    `insert into users (email, name, password_hash, google_sub, role, status)
     values ($1, $2, $3, $4, $5, $6)
     returning *`,
    [
      clean,
      String(name || '').trim() || null,
      password ? hashPassword(password) : null,
      googleSub || null,
      first ? 'admin' : 'member',
      first ? 'active' : 'pending'
    ]
  );
  return r.rows[0];
}

async function touchLogin(id) {
  await query('update users set last_login_at = now() where id = $1', [id]);
}

/**
 * Verifies a Google ID token. Google's own tokeninfo endpoint does the
 * signature and expiry checks; the audience check has to be ours, since a
 * token minted for a different site would otherwise validate here too.
 */
async function verifyGoogleToken(credential) {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  if (!clientId) {
    throw new Error('Google sign-in is not configured. Set GOOGLE_OAUTH_CLIENT_ID.');
  }
  if (!credential) throw new Error('No Google credential was supplied.');

  const res = await fetch(
    `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`
  );
  if (!res.ok) throw new Error('Google could not verify that sign-in. Try again.');

  const info = await res.json();
  if (info.aud !== clientId) throw new Error('That sign-in was issued for a different site.');
  if (info.email_verified !== 'true' && info.email_verified !== true) {
    throw new Error('That Google account has no verified email address.');
  }
  return { email: normaliseEmail(info.email), name: info.name || null, sub: info.sub };
}

async function addToWaitlist({ email, name, company, website, note }) {
  const clean = normaliseEmail(email);
  if (!validEmail(clean)) throw new Error('That does not look like an email address.');

  const r = await query(
    `insert into waitlist (email, name, company, website, note)
     values ($1,$2,$3,$4,$5)
     on conflict (email) do update set
       name = coalesce(excluded.name, waitlist.name),
       company = coalesce(excluded.company, waitlist.company),
       website = coalesce(excluded.website, waitlist.website),
       note = coalesce(excluded.note, waitlist.note)
     returning id, (xmax = 0) as created`,
    [
      clean,
      String(name || '').trim() || null,
      String(company || '').trim() || null,
      String(website || '').trim() || null,
      String(note || '').trim().slice(0, 1000) || null
    ]
  );
  return r.rows[0];
}

module.exports = {
  issueSession,
  readSession,
  hashPassword,
  verifyPassword,
  normaliseEmail,
  validEmail,
  passwordProblem,
  findUserByEmail,
  findUserById,
  createUser,
  countUsers,
  touchLogin,
  verifyGoogleToken,
  addToWaitlist,
  SESSION_DAYS
};
