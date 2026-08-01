'use strict';

const { setMeta, getMeta } = require('./db');

/**
 * Outbound email through Resend's HTTP API.
 *
 * Chosen over SMTP because it needs no dependency, no connection pooling, and
 * no long-lived socket on a free-tier host that sleeps. If it is not
 * configured, everything still works and the app records why, rather than
 * failing a sign-up because a notification could not be sent.
 */

const ENDPOINT = 'https://api.resend.com/emails';

function config() {
  return {
    apiKey: (process.env.RESEND_API_KEY || '').trim(),
    from: (process.env.MAIL_FROM || '').trim(),
    to: (process.env.MAIL_TO || '').trim(),
    appUrl: (process.env.APP_URL || '').trim().replace(/\/$/, '')
  };
}

function status() {
  const c = config();
  const missing = [];
  if (!c.apiKey) missing.push('RESEND_API_KEY');
  if (!c.from) missing.push('MAIL_FROM');
  if (!c.to) missing.push('MAIL_TO');
  return {
    configured: missing.length === 0,
    missing,
    from: c.from || null,
    to: c.to || null
  };
}

async function send({ to, subject, text, replyTo }) {
  const c = config();
  if (!c.apiKey || !c.from) {
    throw new Error('Email is not configured. Set RESEND_API_KEY and MAIL_FROM.');
  }

  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${c.apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: c.from,
      to: Array.isArray(to) ? to : [to],
      subject,
      text,
      ...(replyTo ? { reply_to: replyTo } : {})
    })
  });

  const body = await res.text();
  if (!res.ok) {
    // Resend returns a readable message; surface it rather than a bare status.
    let detail = body.slice(0, 300);
    try {
      const parsed = JSON.parse(body);
      detail = parsed.message || parsed.error || detail;
    } catch (e) { /* keep the raw text */ }
    throw new Error(`Resend rejected the send (${res.status}): ${detail}`);
  }

  return JSON.parse(body);
}

/**
 * Notifications must never fail the action that triggered them. Somebody
 * requesting access should not see an error because a mail provider is down.
 */
async function attempt(label, fn) {
  const c = config();
  if (!c.apiKey || !c.from || !c.to) {
    await setMeta('mail_last_error', `Not configured: ${status().missing.join(', ')}`);
    return false;
  }
  try {
    await fn();
    await setMeta('mail_last_sent', new Date().toISOString());
    await setMeta('mail_last_error', '');
    return true;
  } catch (err) {
    console.error(`[mail] ${label} failed:`, err.message);
    await setMeta('mail_last_error', `${label}: ${err.message}`.slice(0, 500));
    return false;
  }
}

function line(label, value) {
  return value ? `${label}: ${value}\n` : '';
}

async function notifyAccessRequest(entry) {
  const c = config();
  const link = c.appUrl ? `\n\nReview it: ${c.appUrl}\n` : '\n';

  await attempt('access request notice', () => send({
    to: c.to,
    replyTo: entry.email,
    subject: `Landfall access request: ${entry.email}`,
    text:
      `Somebody asked for access to Landfall.\n\n` +
      line('Email', entry.email) +
      line('Name', entry.name) +
      line('Company', entry.company) +
      line('Site', entry.website) +
      (entry.note ? `\nWhat they said:\n${entry.note}\n` : '') +
      link +
      `\nReply to this message to reach them directly.\n`
  }));

  // Confirmation to the person who asked, sent separately so a failure on one
  // does not suppress the other.
  await attempt('access request confirmation', () => send({
    to: entry.email,
    replyTo: c.to,
    subject: 'Your Landfall access request',
    text:
      `Thanks for asking about Landfall.\n\n` +
      `Landfall reads your Search Console data against every ranking update Google\n` +
      `publishes, then tells you which part of your site was hit and what to do.\n\n` +
      `It is invite only while we build it. We have your details and will be in\n` +
      `touch when there is a place for you.\n\n` +
      `Reply to this message if you want to add anything in the meantime.\n\n` +
      `Landfall\nAnother Sandstorm Digital Production\nhttps://sandstormdigital.com\n`
  }));
}

async function notifyNewAccount(user) {
  const c = config();
  const link = c.appUrl ? `\n\nApprove or block: ${c.appUrl}\n` : '\n';

  await attempt('new account notice', () => send({
    to: c.to,
    replyTo: user.email,
    subject: `Landfall account waiting: ${user.email}`,
    text:
      `A new Landfall account is waiting for approval.\n\n` +
      line('Email', user.email) +
      line('Name', user.name) +
      line('Signed up with', user.google_sub ? 'Google' : 'email and password') +
      link +
      `\nThey cannot see anything until you let them in.\n`
  }));
}

async function notifyApproved(user) {
  const c = config();
  const link = c.appUrl ? `${c.appUrl}` : 'the Landfall site';

  await attempt('approval notice', () => send({
    to: user.email,
    replyTo: c.to,
    subject: 'Your Landfall account is ready',
    text:
      `You are in.\n\n` +
      `Sign in at ${link} with the details you used to sign up.\n\n` +
      `First step is connecting a Search Console property. We will walk you\n` +
      `through it, or reply here and we will do it with you.\n\n` +
      `Landfall\nAnother Sandstorm Digital Production\n`
  }));
}

async function sendTest(to) {
  const c = config();
  return send({
    to: to || c.to,
    subject: 'Landfall test message',
    text:
      `This is a test from Landfall.\n\n` +
      `If you are reading it, outbound email works.\n\n` +
      `Sent from: ${c.from}\nDelivered to: ${to || c.to}\n`
  });
}

async function lastError() {
  return getMeta('mail_last_error');
}

async function lastSent() {
  return getMeta('mail_last_sent');
}

module.exports = {
  send,
  status,
  sendTest,
  notifyAccessRequest,
  notifyNewAccount,
  notifyApproved,
  lastError,
  lastSent
};
