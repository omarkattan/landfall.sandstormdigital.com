'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';
const API_BASE = 'https://searchconsole.googleapis.com/webmasters/v3';

// Render exposes uploaded secret files in both of these locations. Other hosts
// vary, so the project directory is searched too.
const SEARCH_DIRS = ['/etc/secrets', process.cwd(), __dirname];

// Repo files that are JSON but are obviously not credentials.
const IGNORE_FILES = new Set([
  'package.json', 'package-lock.json', 'tsconfig.json', 'jsconfig.json',
  'composer.json', 'renovate.json', 'vercel.json', 'now.json'
]);

let cachedToken = null;
let cachedExpiry = 0;

function present(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function normaliseKey(key) {
  // Values often arrive with literal \n sequences rather than real newlines,
  // and sometimes wrapped in stray quotes.
  let k = String(key).trim();
  if ((k.startsWith('"') && k.endsWith('"')) || (k.startsWith("'") && k.endsWith("'"))) {
    k = k.slice(1, -1);
  }
  return k.replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n').replace(/\r\n/g, '\n');
}

function looksLikeServiceAccount(obj) {
  return Boolean(obj && typeof obj === 'object' && obj.client_email && obj.private_key);
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
  if (!looksLikeServiceAccount(sa)) {
    throw new Error(
      `${source} parsed as JSON but has no client_email and private_key. ` +
      `Make sure it is the service account key file, not an OAuth client file.`
    );
  }
  return { client_email: String(sa.client_email).trim(), private_key: normaliseKey(sa.private_key) };
}

function readDir(dir) {
  try {
    if (!fs.existsSync(dir)) return null;
    return fs.readdirSync(dir).filter((f) => {
      try {
        return fs.statSync(path.join(dir, f)).isFile();
      } catch (e) {
        return false;
      }
    });
  } catch (e) {
    return null;
  }
}

/**
 * Collects every readable file that parses as a service account key, along with
 * a record of where it looked. The survey is used to build a useful error when
 * nothing is found.
 */
function surveySecretFiles() {
  const survey = [];
  const found = [];
  const seen = new Set();

  for (const dir of SEARCH_DIRS) {
    const resolved = path.resolve(dir);
    if (seen.has(resolved)) continue;
    seen.add(resolved);

    const files = readDir(resolved);
    if (files === null) {
      survey.push({ dir: resolved, exists: false, files: [] });
      continue;
    }

    survey.push({ dir: resolved, exists: true, files });

    for (const name of files) {
      if (IGNORE_FILES.has(name)) continue;
      const full = path.join(resolved, name);
      let raw;
      try {
        raw = fs.readFileSync(full, 'utf8');
      } catch (e) {
        continue;
      }
      if (!raw.trim().startsWith('{')) continue;
      try {
        const parsed = JSON.parse(raw.trim());
        if (looksLikeServiceAccount(parsed)) found.push(full);
      } catch (e) {
        // not JSON, ignore
      }
    }
  }

  return { survey, found };
}

function describeSurvey(survey) {
  return survey.map((s) => {
    if (!s.exists) return `  ${s.dir} - directory not present`;
    if (!s.files.length) return `  ${s.dir} - empty`;
    const shown = s.files.slice(0, 12).join(', ');
    const more = s.files.length > 12 ? `, and ${s.files.length - 12} more` : '';
    return `  ${s.dir} - ${shown}${more}`;
  }).join('\n');
}

/**
 * Credentials can arrive four ways, checked in this order:
 *   1. GOOGLE_SA_JSON, the whole key file as a string
 *   2. GOOGLE_SA_JSON_PATH, an explicit path to the key file
 *   3. Any uploaded secret file that parses as a service account key
 *   4. GOOGLE_CLIENT_EMAIL plus GOOGLE_PRIVATE_KEY as separate variables
 * The file options exist because multi-line values are easy to mangle when
 * pasted into a hosting dashboard.
 */
function loadCredentials() {
  if (present(process.env.GOOGLE_SA_JSON)) {
    return fromJsonString(process.env.GOOGLE_SA_JSON, 'GOOGLE_SA_JSON');
  }

  if (present(process.env.GOOGLE_SA_JSON_PATH)) {
    const p = process.env.GOOGLE_SA_JSON_PATH.trim();
    if (!fs.existsSync(p)) {
      throw new Error(`GOOGLE_SA_JSON_PATH points at ${p}, which does not exist.`);
    }
    return fromJsonString(fs.readFileSync(p, 'utf8'), `The file ${p}`);
  }

  const { found } = surveySecretFiles();
  if (found.length) {
    return fromJsonString(fs.readFileSync(found[0], 'utf8'), `The secret file ${found[0]}`);
  }

  if (present(process.env.GOOGLE_CLIENT_EMAIL) && present(process.env.GOOGLE_PRIVATE_KEY)) {
    return {
      client_email: process.env.GOOGLE_CLIENT_EMAIL.trim(),
      private_key: normaliseKey(process.env.GOOGLE_PRIVATE_KEY)
    };
  }

  return null;
}

function notFoundMessage() {
  const { survey } = surveySecretFiles();
  const googleVars = Object.keys(process.env).filter((k) => /google|^GCP|service.?account/i.test(k));

  return [
    'No Google service account credentials found.',
    '',
    'Use any one of these:',
    '  1. Upload the key file under Environment, Secret Files. Name it service-account.json.',
    '  2. Set GOOGLE_SA_JSON to the whole file contents, minified to one line.',
    '  3. Set GOOGLE_CLIENT_EMAIL and GOOGLE_PRIVATE_KEY separately.',
    '',
    'Searched these locations:',
    describeSurvey(survey),
    '',
    googleVars.length
      ? `Google-related variables currently set: ${googleVars.join(', ')}`
      : 'No Google-related environment variables are set.'
  ].join('\n');
}

function credentialsOrThrow() {
  const creds = loadCredentials();
  if (!creds) throw new Error(notFoundMessage());
  return creds;
}

function credentialsProblem() {
  try {
    credentialsOrThrow();
    return null;
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
      `The key is probably truncated or had its line breaks removed. ` +
      `Uploading the key file as a secret file avoids this.`
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

async function apiFetch(apiPath, options = {}, attempt = 1) {
  const token = await getAccessToken();
  const res = await fetch(`${API_BASE}${apiPath}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });

  if (res.status === 401 && attempt === 1) {
    cachedToken = null;
    return apiFetch(apiPath, options, attempt + 1);
  }

  if ((res.status === 429 || res.status >= 500) && attempt <= 4) {
    const wait = Math.min(2000 * Math.pow(2, attempt - 1), 15000);
    await sleep(wait);
    return apiFetch(apiPath, options, attempt + 1);
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
  const apiPath = `/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`;
  const json = await apiFetch(apiPath, {
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
  loadCredentials,
  surveySecretFiles
};
