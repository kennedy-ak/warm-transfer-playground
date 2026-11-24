'use strict';

const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..');
const E164_RE = /^\+[1-9]\d{6,14}$/;

const REQUIRED = [
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'TWILIO_PHONE_NUMBER',
  'ELEVENLABS_API_KEY',
  'ELEVENLABS_AGENT_ID',
  'TECH_NUMBERS',
  'PUBLIC_BASE_URL',
  'TOOL_SECRET',
  'TWILIO_AGENT_APP_SID',
];

function loadConfig(env = process.env) {
  const missing = REQUIRED.filter((key) => !(env[key] || '').trim());
  if (missing.length) {
    const hint = missing.length === 1 && missing[0] === 'TWILIO_AGENT_APP_SID'
      ? 'run "node scripts/setup-agent-app.js" to create the TwiML App and fill it in'
      : 'copy .env.example to .env and fill it in';
    throw new Error(`Missing required env vars: ${missing.join(', ')} (${hint})`);
  }

  const agentAppSid = env.TWILIO_AGENT_APP_SID.trim();
  if (!/^AP[0-9a-f]{32}$/i.test(agentAppSid)) {
    throw new Error('TWILIO_AGENT_APP_SID must be a TwiML App SID (AP followed by 32 hex characters)');
  }

  const techNumbers = env.TECH_NUMBERS.split(',').map((n) => n.trim()).filter(Boolean);
  const badNumbers = [...techNumbers, env.TWILIO_PHONE_NUMBER.trim()].filter((n) => !E164_RE.test(n));
  if (badNumbers.length) {
    throw new Error(`These numbers are not E.164 (e.g. +15551234567): ${badNumbers.join(', ')}`);
  }

  const dialMode = (env.DIAL_MODE || 'sequential').trim().toLowerCase();
  if (!['sequential', 'parallel'].includes(dialMode)) {
    throw new Error(`DIAL_MODE must be "sequential" or "parallel", got "${env.DIAL_MODE}"`);
  }

  const holdSetting = (env.HOLD_MUSIC_DELAY_SEC || '5').trim().toLowerCase();
  const holdDelayMs = holdSetting === 'off' ? null : Number(holdSetting) * 1000;
  if (holdDelayMs !== null && !(holdDelayMs >= 0)) {
    throw new Error(`HOLD_MUSIC_DELAY_SEC must be a number of seconds or "off", got "${env.HOLD_MUSIC_DELAY_SEC}"`);
  }

  // Optional: only these callers reach Ava when they ring the number. Empty = everyone does.
  const inboundAllowedCallers = (env.INBOUND_ALLOWED_CALLERS || '').split(',').map((n) => n.trim()).filter(Boolean);
  const notE164 = inboundAllowedCallers.filter((n) => !E164_RE.test(n));
  if (notE164.length) {
    throw new Error(`INBOUND_ALLOWED_CALLERS has numbers that are not E.164: ${notE164.join(', ')}`);
  }
  const inboundPassThroughUrl = (env.INBOUND_PASS_THROUGH_URL || '').trim();
  if (inboundPassThroughUrl && !/^https?:\/\//.test(inboundPassThroughUrl)) {
    throw new Error('INBOUND_PASS_THROUGH_URL must be an http(s) URL');
  }

  const publicBaseUrl = env.PUBLIC_BASE_URL.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//.test(publicBaseUrl)) {
    throw new Error('PUBLIC_BASE_URL must start with https:// (your ngrok URL, no trailing path)');
  }

  return {
    port: Number(env.PORT) || 3000,
    publicBaseUrl,
    twilioAccountSid: env.TWILIO_ACCOUNT_SID.trim(),
    twilioAuthToken: env.TWILIO_AUTH_TOKEN.trim(),
    twilioPhoneNumber: env.TWILIO_PHONE_NUMBER.trim(),
    elevenLabsApiKey: env.ELEVENLABS_API_KEY.trim(),
    elevenLabsAgentId: env.ELEVENLABS_AGENT_ID.trim(),
    elevenLabsApiBase: (env.ELEVENLABS_API_BASE || 'https://api.elevenlabs.io').trim().replace(/\/+$/, ''),
    toolSecret: env.TOOL_SECRET.trim(),
    techNumbers,
    dialMode,
    ringTimeoutSec: Number(env.RING_TIMEOUT_SEC) || 20,
    // TwiML App whose Voice URL is PUBLIC_BASE_URL/twilio/agent-leg. Ava joins the call through it.
    agentAppSid,
    // Who may reach Ava by calling the number (empty = anyone), and where other callers are sent.
    inboundAllowedCallers,
    inboundPassThroughUrl,
    // Hold music for the resident while technicians are called. It starts this long after
    // the tool call, so Ava can finish saying "please hold". null = no hold music.
    holdDelayMs,
    holdMusicUrl: (env.HOLD_MUSIC_URL || 'http://twimlets.com/holdmusic?Bucket=com.twilio.music.classical').trim(),
    // After a call ends, when to ask ElevenLabs for the transcript (it takes a moment to be ready).
    transcriptRetryMs: [5_000, 20_000, 60_000],
    // Transfer reports (one JSON file per resident call) and optional audio such as connecting.mp3.
    reportsDir: path.join(PROJECT_ROOT, 'reports'),
    publicDir: path.join(PROJECT_ROOT, 'public'),
  };
}

module.exports = { loadConfig, E164_RE };
