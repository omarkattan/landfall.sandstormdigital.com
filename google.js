'use strict';

const crypto = require('crypto');

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';
const API_BASE = 'https://searchconsole.googleapis.com/webmasters/v3';

let cachedToken = null;
let cachedExpiry = 0;

function serviceAccount() {
  const raw = process.env.GOOGLE_SA_JSON;
  if (!raw) {
    throw new Error('GOOGLE_SA_JSON is not set. Paste the full service account JSON into that environment variable.');
  }
  let sa;
  try {
    sa = JSON.parse(raw);
  } catch (e) {
    throw new Error('GOOGLE_SA_JSON is not valid JSON. Paste the file contents exactly, including the outer braces.');
  }
  if (!sa.client_email || !sa.private_key) {
    throw new Error('GOOGLE_SA_JSON is missing client_email or private_key.');
  }
  // Render env vars often arrive with literal \n sequences instead of newlines.
  sa.private_key = sa.private_key.replace(/\\n/g, '\n');
  return sa;
}

function serviceAccountEmail() {
  try {
    return serviceAccount().client_email;
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

  const sa = serviceAccount();
  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: signAssertion(sa)
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

module.exports = { listSites, searchAnalytics, getAccessToken, serviceAccountEmail };
