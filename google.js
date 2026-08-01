'use strict';

const crypto = require('crypto');
const fs = require('fs');

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';
const API_BASE = 'https://searchconsole.googleapis.com/webmasters/v3';

// Render mounts uploaded secret files here.
const SECRET_DIR = '/etc/secrets';

let cachedToken = null;
let cachedExpiry = 0;

function present(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function normaliseKey(key) {
  // Environment variables often arrive with literal \n sequences rather than
  // real newlines, and sometimes wrapped in stray quotes.
  let k = String(key).trim();
  if ((k.startsWith('"') && k.endsWith('"')) || (k.startsWith("'") && k.endsWith("'"))) {
    k = k.slice(1, -1);
  }
  return k.replace(/\\n/g, '\n');
}

function fromJsonString(raw, source) {
  let sa;
  try {
    sa = JSON.parse(raw.trim());
  } catch (e) {
    throw new Error(
      `${source} is not valid JSON. Paste the service account file exactly as ` +
      `downloaded, including the outer braces. If your host strips line breaks, ` +
      `minify the file to a single line first.`
    );
  }
  if (!present(sa.client_email) || !present(sa.private_key)) {
    throw new Error(`${source} is missing client_email or private_key.`);
  }
  return { client_email: sa.client_email.trim(), private_key: normaliseKey(sa.private_key) };
}

function findSecretFile() {
  const explicit = process.env.GOOGLE_SA_JSON_PATH;
  if (present(explicit)) {
    if (!fs.existsSync(explicit.trim())) {
      throw new Error(`GOOGLE_SA_JSON_PATH points at ${explicit.trim()}, which does not exist.`);
    }
    return explicit.trim();
  }

  if (!fs.existsSync(SECRET_DIR)) return null;
  const candidates = fs.readdirSync(SECRET_DIR).filter((f) => f.toLowerCase().endsWith('.json'));
  if (candidates.length === 1) return `${SECRET_DIR}/${candidates[0]}`;

  const named = candidates.find((f) => /service.?account|landfall|google/i.test(f));
  return named ? `${SECRET_DIR}/${named}` : null;
}

/**
 * Credentials can arrive three ways, checked in this order:
 *   1. GOOGLE_SA_JSON, the whole key file as a string
 *   2. A secret file, either at GOOGLE_SA_JSON_PATH or any .json in /etc/secrets
 *   3. GOOGLE_CLIENT_EMAIL plus GOOGLE_PRIVATE_KEY as separate variables
 * The last two exist because multi-line values are easy to mangle when pasted
 * into a hosting dashboard.
 */
function loadCredentials() {
  if (present(process.env.GOOGLE_SA_JSON)) {
    return fromJsonString(process.env.GOOGLE_SA_JSON, 'GOOGLE_SA_JSON');
  }

  const file = findSecretFile();
  if (file) {
    return fromJsonString(fs.readFileSync(file, 'utf8'), `The secret file ${file}`);
  }

  if (present(process.env.GOOGLE_CLIENT_EMAIL) && present(process.env.GOOGLE_PRIVATE_KEY)) {
    return {
      client_email: process.env.GOOGLE_CLIENT_EMAIL.trim(),
      private_key: normaliseKey(process.env.GOOGLE_PRIVATE_KEY)
    };
  }

  return null;
}

function credentialsOrThrow() {
  const creds = loadCredentials();
  if (!creds) {
    throw new Error(
      'No Google service account credentials found. Set GOOGLE_SA_JSON to the ' +
      'contents of the key file, or upload the file as a Render secret file, or ' +
      'set GOOGLE_CLIENT_EMAIL and GOOGLE_PRIVATE_KEY separately.'
    );
  }
  return creds;
}

function credentialsProblem() {
  try {
    return credentialsOrThrow() ? null : null;
  } catch (err) {
    return err.message;
  }
}

function serviceAccountEmail() {
  try {
    return credentialsOrThrow().client_email;
  } catch (e) {
    return null;
  }
}

function base64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

function signAssertion(sa) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claim = {
    iss: sa.client_email,
    scope: SCOPE,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600
  };
  const input = `${base64url(header)}.${base64url(claim)}`;
  const signature = crypto
    .createSign('RSA-SHA256')
    .update(input)
    .sign(sa.private_key, 'base64url');
  return `${input}.${signature}`;
}

async function getAccessToken() {
  if (cachedToken && Date.now() < cachedExpiry - 60000) return cachedToken;

  const sa = credentialsOrThrow();

  let assertion;
  try {
    assertion = signAssertion(sa);
  } catch (err) {
    throw new Error(
      `Could not sign with the service account private key: ${err.message}. ` +
      `The key is probably truncated or had its line breaks removed.`
    );
  }

  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion
  });

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Google token exchange failed (${res.status}): ${text.slice(0, 400)}`);
  }

  const json = JSON.parse(text);
  cachedToken = json.access_token;
  cachedExpiry = Date.now() + (json.expires_in || 3600) * 1000;
  return cachedToken;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function apiFetch(path, options = {}, attempt = 1) {
  const token = await getAccessToken();
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });

  if (res.status === 401 && attempt === 1) {
    cachedToken = null;
    return apiFetch(path, options, attempt + 1);
  }

  if ((res.status === 429 || res.status >= 500) && attempt <= 4) {
    const wait = Math.min(2000 * Math.pow(2, attempt - 1), 15000);
    await sleep(wait);
    return apiFetch(path, options, attempt + 1);
  }

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Search Console API ${res.status}: ${text.slice(0, 400)}`);
  }
  return text ? JSON.parse(text) : {};
}

/**
 * Every property the service account has been granted access to.
 * Returns both domain properties (sc-domain:example.com) and
 * URL-prefix properties (https://example.com/).
 */
async function listSites() {
  const json = await apiFetch('/sites');
  return (json.siteEntry || []).map((s) => ({
    siteUrl: s.siteUrl,
    permission: s.permissionLevel,
    propertyType: s.siteUrl.startsWith('sc-domain:') ? 'domain' : 'url_prefix'
  }));
}

async function searchAnalytics(siteUrl, body) {
  const path = `/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`;
  const json = await apiFetch(path, {
    method: 'POST',
    body: JSON.stringify({ type: 'web', dataState: 'final', ...body })
  });
  return json.rows || [];
}

module.exports = {
  listSites,
  searchAnalytics,
  getAccessToken,
  serviceAccountEmail,
  credentialsProblem,
  loadCredentials
};
