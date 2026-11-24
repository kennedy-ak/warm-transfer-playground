'use strict';

// Branch "agent-stays-on-call": the resident, Ava and the technician share one
// Twilio conference. The resident is in the room from the first second, Ava is
// added to it as her own call leg (a TwiML App that returns the ElevenLabs
// register-call TwiML), and a technician who presses 1 simply joins the same room.
// Nobody is moved, so Ava's conversation carries on while the technician is there.
// While the technician is in the room Ava is muted: she listens but is not heard.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const twilio = require('twilio');
const { E164_RE } = require('./config');
const { createReportStore, buildReport, buildTranscript, renderList, renderDetail } = require('./reports');

const { VoiceResponse } = twilio.twiml;

const CALL_SID_RE = /^CA[0-9a-f]{32}$/i;
const CALL_ENDED = new Set(['completed', 'busy', 'no-answer', 'failed', 'canceled']);
const MAX_PROMPTS = 3;
const FALLBACK_FIRST_MESSAGE = 'Sorry, no technician is available right now. Can I take a message?';
const TECH_ANNOUNCEMENT = 'Connecting you to the resident.';
// Spoken into the room for everyone. Ava hears them like anything else said on the
// call, so her prompt can react to these exact phrases.
const ANNOUNCEMENTS = {
  joined: 'A technician has joined the call.',
  unavailable: 'No technician is available right now.',
};
const LOGGED_FIELDS = [
  'CallSid', 'ParentCallSid', 'CallStatus', 'Direction', 'From', 'To', 'AnsweredBy', 'MachineDetectionDuration',
  'Digits', 'StatusCallbackEvent', 'ConferenceSid', 'FriendlyName', 'ParticipantLabel', 'RecordingSid',
  'RecordingStatus', 'CallDuration', 'SipResponseCode',
];

const secs = (from, to) => `${((to - from) / 1000).toFixed(1)}s`;
const roomName = (residentCallSid) => `room-${residentCallSid}`;

/**
 * Live call state is in memory (it's a playground): restart the server and running
 * calls are forgotten. Finished transfer reports are kept as JSON files in reports/.
 *
 * @param {object} deps
 * @param {object} deps.config        from loadConfig()
 * @param {object} deps.client        Twilio REST client (or a fake in tests)
 * @param {Function} deps.registerCall  from createRegisterCall()
 * @param {object} [deps.conversations] from createConversationApi(); without it reports have no transcript
 * @param {Function} [deps.logger]
 */
function createApp({ config, client, registerCall, conversations = null, logger = console.log }) {
  const app = express();
  app.disable('x-powered-by');

  const base = config.publicBaseUrl;
  const reports = createReportStore(config.reportsDir);
  const connectingFile = path.join(config.publicDir, 'connecting.mp3');
  const residentCalls = new Map(); // resident CallSid -> call record (see newResidentCall)
  const transfers = new Map(); //     resident CallSid -> transfer (see /tool/request-transfer)

  const log = (message) => logger(`${new Date().toISOString()} ${message}`);

  // ---------------------------------------------------------------- middleware

  // Twilio signs the *public* URL it called. Behind ngrok the local URL is
  // http://localhost:3000/..., so we must rebuild the URL from PUBLIC_BASE_URL.
  function validateTwilio(req, res, next) {
    const url = base + req.originalUrl;
    const signature = req.get('X-Twilio-Signature') || '';
    const valid = twilio.validateRequest(config.twilioAuthToken, signature, url, req.body || {});

    const fields = LOGGED_FIELDS.filter((key) => req.body && req.body[key] !== undefined)
      .map((key) => `${key}=${req.body[key]}`)
      .join(' ');
    log(`WEBHOOK ${req.method} ${req.originalUrl} ${fields}${valid ? '' : ' [INVALID SIGNATURE - rejected]'}`);

    if (!valid) return res.status(403).send('Invalid Twilio signature');
    next();
  }

  // ElevenLabs tool calls (and our own /start-call) are not Twilio requests,
  // so they authenticate with a shared secret header instead.
  function requireToolSecret(req, res, next) {
    const given = Buffer.from(req.get('X-Tool-Secret') || '');
    const expected = Buffer.from(config.toolSecret);
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
      log(`REJECTED ${req.method} ${req.originalUrl}: missing or wrong X-Tool-Secret`);
      return res.status(401).json({ status: 'error', message: 'Missing or wrong X-Tool-Secret header' });
    }
    next();
  }

  // Reports contain phone numbers and call summaries, so they are only served to a
  // browser on this machine. Anything that came in through the tunnel carries
  // forwarding headers added by ngrok, which the sender cannot remove.
  function localOnly(req, res, next) {
    const remote = req.socket.remoteAddress || '';
    const loopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
    const forwarded = req.headers['x-forwarded-for'] || req.headers['x-forwarded-host'] || req.headers.forwarded;
    if (!loopback || forwarded) {
      log(`REJECTED ${req.method} ${req.originalUrl}: reports are local-only`);
      return res.status(403).send('Reports are only available at http://localhost on the machine running the server.');
    }
    next();
  }

  const twilioHook = [express.urlencoded({ extended: false }), validateTwilio];
  const secretHook = [express.json(), requireToolSecret];
  const wrap = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
  const sendTwiml = (res, vr) => res.type('text/xml').send(vr.toString());

  // ---------------------------------------------------------------- helpers

  const twilioError = (err) => `${err.code ? `Twilio error ${err.code}: ` : ''}${err.message}`;

  function timing(t, event, detail = '') {
    const now = Date.now();
    log(`TIMING resident=${t.residentCallSid} ${event} +${secs(t.startedAt, now)} after tool call${detail ? ` ${detail}` : ''}`);
    return now;
  }

  function logTimingSummary(t) {
    const start = t.startedAt;
    const winner = t.techs[t.winner];
    const rows = [
      ['tool_call', start],
      ['first_tech_ringing', t.timings.first_tech_ringing],
      ['tech_answered', winner.answeredAt],
      ['tech_pressed_1', winner.pressedAt],
      ['technician_joined', t.timings.technician_joined],
    ].map(([name, at]) => `  ${name.padEnd(19)} ${at ? `${new Date(at).toISOString()}  +${secs(start, at)}` : '(not seen)'}`);
    log(
      `TIMING SUMMARY resident=${t.residentCallSid} winner=tech#${t.winner} ${winner.number}\n${rows.join('\n')}\n` +
        `  => resident waited ${secs(start, t.timings.technician_joined)} from tool call to the technician joining`
    );
  }

  function saveReport(t) {
    try {
      reports.save(buildReport(t, config.dialMode));
    } catch (err) {
      log(`ERROR could not save report for resident=${t.residentCallSid}: ${err.message}`);
    }
  }

  // ---------------------------------------------------------------- transcripts

  const transcriptFetches = new Map(); // resident CallSid -> fetch in progress

  function storeTranscript(residentCallSid, transcript) {
    const t = transfers.get(residentCallSid);
    if (t) {
      t.transcript = transcript;
      return saveReport(t);
    }
    // After a restart the call is no longer in memory: update the saved file directly.
    const stored = reports.get(residentCallSid);
    if (stored) reports.save({ ...stored, transcript });
  }

  // Fetches the conversation(s) for one resident call from ElevenLabs and stores the
  // transcript with the report. Does nothing once the transcript is final.
  function refreshTranscript(residentCallSid) {
    if (!conversations) return Promise.resolve();
    const stored = reports.get(residentCallSid);
    if (!stored || (stored.transcript && stored.transcript.status === 'final')) return Promise.resolve();
    if (transcriptFetches.has(residentCallSid)) return transcriptFetches.get(residentCallSid);

    const fetching = (async () => {
      let transcript;
      try {
        // Ava's conversation starts before the tool call, so look back generously.
        const startedAfter = Math.floor(Date.parse(stored.started_at) / 1000) - 6 * 3600;
        transcript = buildTranscript(await conversations.forCall(residentCallSid, startedAfter));
        const lines = transcript.conversations.reduce((n, c) => n + c.entries.length, 0);
        log(`TRANSCRIPT resident=${residentCallSid} ${transcript.status}: ${transcript.conversations.length} conversation(s), ${lines} line(s)`);
      } catch (err) {
        log(`ERROR could not fetch transcript for resident=${residentCallSid}: ${err.message}`);
        // Keep whatever we already had and say why it could not be refreshed.
        transcript = {
          status: 'unavailable',
          fetched_at: new Date().toISOString(),
          error: err.message,
          conversations: (stored.transcript && stored.transcript.conversations) || [],
        };
      }
      storeTranscript(residentCallSid, transcript);
    })().finally(() => transcriptFetches.delete(residentCallSid));

    transcriptFetches.set(residentCallSid, fetching);
    return fetching;
  }

  // ElevenLabs needs a little while after the call to finish the transcript, so try a few times.
  function scheduleTranscript(residentCallSid) {
    if (!conversations || !transfers.has(residentCallSid)) return;
    for (const delay of config.transcriptRetryMs || []) {
      setTimeout(() => refreshTranscript(residentCallSid), delay).unref();
    }
  }

  // The transfer is over, one way or another: store the result and print the one-line summary.
  function finish(t, result, at = Date.now()) {
    if (t.result) return;
    t.result = result;
    t.finishedAt = at;
    saveReport(t);

    const outcomes = t.techs
      .filter((tech) => tech.dialledAt)
      .map((tech) => `${tech.number}=${tech.outcome || 'calling'}`)
      .join(', ');
    const who = result === 'connected' ? ` technician=${t.techs[t.winner].number}` : '';
    log(
      `TRANSFER ${result.toUpperCase()} resident=${t.residentNumber} call=${t.residentCallSid}${who} ` +
        `waited=${secs(t.startedAt, at)} mode=${config.dialMode} tried=[${outcomes || 'nobody'}] report=/reports/${t.residentCallSid}`
    );
  }

  function newResidentCall({ direction, number, twilioNumber }) {
    return {
      direction,
      number,
      twilioNumber,
      ended: false,
      conferenceSid: null,
      present: new Set(), // call SIDs in the room right now
      // state: none -> joining -> in -> left
      agent: { state: 'none', callSid: null, joins: 0, firstMessage: null, muted: false },
      onHold: false, //                    resident is hearing hold music
      roomQueue: Promise.resolve(), //     see inOrder()
    };
  }

  // The shared room. Only the resident ends it by leaving: if the technician hangs up
  // the resident is still with Ava, and if Ava drops the resident and technician carry on.
  function conferenceTwiml(residentCallSid, { say, endConferenceOnExit }) {
    const callback = `${base}/conference/status?resident=${residentCallSid}`;
    const vr = new VoiceResponse();
    if (say) vr.say(say);
    vr.dial().conference(
      {
        startConferenceOnEnter: true,
        endConferenceOnExit,
        beep: false,
        // Silence instead of hold music for the second or two before Ava joins.
        waitUrl: '',
        // Ava's replies now pass through the conference mixer, so keep its buffering low.
        jitterBufferSize: 'small',
        record: 'record-from-start',
        recordingStatusCallback: callback,
        recordingStatusCallbackMethod: 'POST',
        recordingStatusCallbackEvent: 'completed',
        statusCallback: callback,
        statusCallbackMethod: 'POST',
        statusCallbackEvent: ['start', 'end', 'join', 'leave'],
      },
      roomName(residentCallSid)
    );
    return vr;
  }

  function sayAndHangup(res, text) {
    const vr = new VoiceResponse();
    if (text) vr.say(text);
    vr.hangup();
    sendTwiml(res, vr);
  }

  // ---------------------------------------------------------------- Ava's leg

  // Adds Ava to the resident's room as a separate call leg. Twilio "calls" our TwiML
  // App, which asks /twilio/agent-leg for TwiML, and that returns the ElevenLabs stream.
  async function addAgent(residentCallSid, { firstMessage = null } = {}) {
    const resident = residentCalls.get(residentCallSid);
    if (!resident || resident.ended || !resident.conferenceSid) return;
    const { agent } = resident;
    if (agent.state === 'joining' || agent.state === 'in') return;

    agent.state = 'joining';
    agent.firstMessage = firstMessage;
    agent.joins += 1;
    try {
      const participant = await client.conferences(resident.conferenceSid).participants.create({
        from: config.twilioPhoneNumber,
        to: `app:${config.agentAppSid}?resident=${residentCallSid}`,
        label: `ava-${agent.joins}`,
        beep: 'false',
        startConferenceOnEnter: true,
        endConferenceOnExit: false,
        jitterBufferSize: 'off',
      });
      if (!agent.callSid) agent.callSid = participant.callSid;
      log(`AGENT adding Ava to ${roomName(residentCallSid)} leg=${participant.callSid}${firstMessage ? ' with first-message override' : ''}`);
    } catch (err) {
      agent.state = 'none';
      log(`ERROR could not add Ava to the call resident=${residentCallSid}: ${twilioError(err)}`);
      const vr = new VoiceResponse();
      vr.say('Sorry, we are having trouble connecting you right now. Please try again later.');
      vr.hangup();
      client.calls(residentCallSid).update({ twiml: vr.toString() }).catch(() => {});
    }
  }

  // Which resident call is this Ava leg for? Normally the custom parameter says so.
  function residentForAgentLeg(body) {
    const named = body.resident || body.Param_resident;
    if (named && residentCalls.has(named)) return named;
    // Fallback if Twilio did not pass the parameter through: the one call waiting for Ava.
    const waiting = [...residentCalls].filter(([, call]) => !call.ended && call.agent.state === 'joining');
    return waiting.length === 1 ? waiting[0][0] : null;
  }

  // Voice URL of the TwiML App. Returns the ElevenLabs <Connect><Stream> for Ava's leg.
  app.post('/twilio/agent-leg', twilioHook, wrap(async (req, res) => {
    const residentCallSid = residentForAgentLeg(req.body);
    const resident = residentCallSid && residentCalls.get(residentCallSid);
    if (!resident) {
      log('ERROR /twilio/agent-leg could not tell which resident call this is for');
      return sayAndHangup(res);
    }
    const outbound = resident.direction === 'outbound';
    const { firstMessage } = resident.agent;
    try {
      const xml = await registerCall({
        fromNumber: outbound ? resident.twilioNumber : resident.number,
        toNumber: outbound ? resident.number : resident.twilioNumber,
        direction: resident.direction,
        // Ava's {{call_sid}} is the resident's call, which is what request_transfer needs.
        callSid: residentCallSid,
        firstMessage,
      });
      log(`REGISTER-CALL ok resident=${residentCallSid} direction=${resident.direction}${firstMessage ? ' with first-message override' : ''}`);
      res.type('text/xml').send(xml);
    } catch (err) {
      log(`ERROR register-call failed resident=${residentCallSid}: ${err.message}`);
      // Spoken on Ava's leg, so the resident hears it in the room.
      sayAndHangup(res, 'Sorry, we are having trouble connecting you right now. Please try again later.');
    }
  }));

  // While a technician is in the room Ava must not be heard. Muting her leg guarantees
  // that whatever the model decides to say. She still hears everything, so her
  // transcript keeps covering the conversation. Resolves to true if the change was made.
  function setAgentMuted(residentCallSid, muted, why) {
    const resident = residentCalls.get(residentCallSid);
    if (!resident || resident.ended || !resident.conferenceSid) return Promise.resolve(false);
    const { agent } = resident;
    if (agent.state !== 'in' || !agent.callSid || agent.muted === muted) return Promise.resolve(false);
    agent.muted = muted;
    return inOrder(resident, async () => {
      try {
        await client.conferences(resident.conferenceSid).participants(agent.callSid).update({ muted });
        log(`AGENT Ava ${muted ? 'muted' : 'unmuted'} in ${roomName(residentCallSid)} (${why})`);
        return true;
      } catch (err) {
        agent.muted = !muted;
        log(`ERROR could not ${muted ? 'mute' : 'unmute'} Ava in ${roomName(residentCallSid)}: ${twilioError(err)}`);
        return false;
      }
    });
  }

  // Changes to one room (hold, mute, announcements) are sent to Twilio one after
  // another, so that for example "take off hold" can never overtake "put on hold".
  function inOrder(resident, task) {
    const run = resident.roomQueue.then(task);
    resident.roomQueue = run.catch(() => {});
    return run;
  }

  // Hold music for the resident while technicians are being called. A participant on
  // hold hears the music instead of the room, and the room does not hear them.
  // Resolves to true if the change was made.
  function setResidentHold(residentCallSid, hold, why) {
    const resident = residentCalls.get(residentCallSid);
    if (!resident || resident.ended || !resident.conferenceSid || resident.onHold === hold) return Promise.resolve(false);
    resident.onHold = hold;
    const options = hold ? { hold: true, holdUrl: config.holdMusicUrl, holdMethod: 'GET' } : { hold: false };
    return inOrder(resident, async () => {
      try {
        await client.conferences(resident.conferenceSid).participants(residentCallSid).update(options);
        log(`HOLD resident=${residentCallSid} ${hold ? 'on hold with music' : 'off hold'} (${why})`);
        return true;
      } catch (err) {
        resident.onHold = !hold;
        log(`ERROR could not ${hold ? 'put resident on hold' : 'take resident off hold'} resident=${residentCallSid}: ${twilioError(err)}`);
        return false;
      }
    });
  }

  // A few seconds after Ava asks for a technician (long enough for her to say
  // "please hold"), the resident gets music and Ava is muted until the search ends.
  function startHold(t) {
    if (t.status !== 'searching') return;
    const stamp = (field) => (changed) => {
      if (!changed) return;
      t[field] = Date.now();
      saveReport(t);
    };
    setResidentHold(t.residentCallSid, true, 'searching for a technician').then(stamp('holdStartedAt'));
    setAgentMuted(t.residentCallSid, true, 'resident is on hold').then(stamp('agentMutedAt'));
  }

  function endHold(t, why) {
    return setResidentHold(t.residentCallSid, false, why).then((released) => {
      if (!released) return;
      t.holdEndedAt = Date.now();
      saveReport(t);
    });
  }

  // Plays a short line (or public/connecting.mp3) to everyone in the room.
  // Queued behind any pending hold or mute change, so the resident is off hold (and
  // Ava silenced or given her voice back) before the line is spoken.
  function announce(residentCallSid, kind) {
    const resident = residentCalls.get(residentCallSid);
    if (!resident || !resident.conferenceSid) return;
    inOrder(resident, () => client.conferences(resident.conferenceSid)
      .update({ announceUrl: `${base}/conference/announce?kind=${kind}`, announceMethod: 'POST' })
      .then(() => log(`ANNOUNCE "${ANNOUNCEMENTS[kind]}" in ${roomName(residentCallSid)}`))
      .catch((err) => log(`ERROR could not announce "${kind}" in ${roomName(residentCallSid)}: ${twilioError(err)}`)));
  }

  app.post('/conference/announce', twilioHook, (req, res) => {
    const kind = req.query.kind;
    const vr = new VoiceResponse();
    if (kind === 'joined' && fs.existsSync(connectingFile)) vr.play(`${base}/public/connecting.mp3`);
    else vr.say(ANNOUNCEMENTS[kind] || ANNOUNCEMENTS.joined);
    sendTwiml(res, vr);
  });

  // ---------------------------------------------------------------- technician calls

  // Ends one technician call. Twilio needs a different status depending on where the
  // call is: "canceled" for queued/ringing, "completed" for a call that was answered.
  async function endTechCall(t, i, why) {
    const tech = t.techs[i];
    if (!tech.callSid || tech.callEnded) return;
    const label = `tech#${i} ${tech.number} call=${tech.callSid}`;
    const status = tech.callStatus === 'in-progress' ? 'completed' : 'canceled';

    try {
      const call = await client.calls(tech.callSid).update({ status });
      log(`CANCEL ${label} was=${tech.callStatus} sent status=${status} (${why})`);
      // "canceled" does nothing to a call that was picked up in the meantime.
      if (status !== 'canceled' || !call || call.status !== 'in-progress') return;
      log(`CANCEL ${label} was answered in the meantime, sending status=completed`);
    } catch (err) {
      log(`ERROR cancel ${label} with status=${status} failed (${why}): ${twilioError(err)}`);
      if (status !== 'canceled') return;
    }

    try {
      await client.calls(tech.callSid).update({ status: 'completed' });
      log(`CANCEL ${label} sent status=completed (${why})`);
    } catch (err) {
      log(`ERROR cancel ${label} with status=completed failed (${why}): ${twilioError(err)}`);
    }
  }

  // Ends every technician call for this resident (optionally sparing the winner).
  function cancelTechs(t, { except = -1, why }) {
    t.techs.forEach((tech, i) => {
      if (i === except) return;
      if (tech.dialledAt) setOutcome(t, i, 'canceled', why);
      endTechCall(t, i, why);
    });
  }

  function startSearch(t) {
    log(`SEARCH start resident=${t.residentCallSid} mode=${config.dialMode} techs=${t.techs.map((x) => x.number).join(',')}`);
    if (config.dialMode === 'parallel') {
      // One separate call per technician (not one <Dial> with several <Number>s),
      // so a voicemail picking up can only ever fail its own leg.
      t.techs.forEach((_, i) => dialTech(t, i));
    } else {
      dialNext(t);
    }
  }

  function dialNext(t) {
    if (t.status !== 'searching') return;
    t.cursor += 1;
    if (t.cursor >= t.techs.length) return allFailed(t);
    dialTech(t, t.cursor);
  }

  async function dialTech(t, i) {
    const tech = t.techs[i];
    const query = `resident=${t.residentCallSid}&tech=${i}`;
    tech.dialledAt = Date.now();
    tech.callStatus = 'queued';
    saveReport(t);
    try {
      const call = await client.calls.create({
        to: tech.number,
        from: config.twilioPhoneNumber,
        url: `${base}/tech/answered?${query}`,
        method: 'POST',
        timeout: config.ringTimeoutSec,
        // Async AMD: the brief starts as soon as the technician picks up, and the
        // detection result arrives separately on /tech/amd a few seconds later.
        machineDetection: 'Enable',
        asyncAmd: 'true',
        asyncAmdStatusCallback: `${base}/tech/amd?${query}`,
        asyncAmdStatusCallbackMethod: 'POST',
        statusCallback: `${base}/tech/status?${query}`,
        statusCallbackMethod: 'POST',
        statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
      });
      tech.callSid = call.sid;
      log(`DIAL tech#${i} ${tech.number} call=${call.sid} resident=${t.residentCallSid}`);
      saveReport(t);
      // The search may have ended (winner found / resident hung up) while Twilio was creating the call.
      if (t.status !== 'searching') {
        setOutcome(t, i, 'canceled', 'dialled after the search ended');
        endTechCall(t, i, 'dialled after the search ended');
      }
    } catch (err) {
      log(`ERROR could not dial tech#${i} ${tech.number}: ${twilioError(err)}`);
      resolveTech(t, i, 'failed', `could not dial: ${twilioError(err)}`);
    }
  }

  // Records a technician's final outcome exactly once:
  // accepted | declined | no-answer | busy | voicemail | canceled | failed
  function setOutcome(t, i, outcome, detail) {
    const tech = t.techs[i];
    if (tech.outcome) return false;
    tech.outcome = outcome;
    tech.detail = detail;
    tech.outcomeAt = Date.now();
    log(`TECH tech#${i} ${tech.number} call=${tech.callSid || '-'} -> ${outcome} (${detail}) resident=${t.residentCallSid}`);
    saveReport(t);
    return true;
  }

  // Same, for outcomes that mean "this technician is not taking it": moves the search on.
  function resolveTech(t, i, outcome, detail) {
    if (!setOutcome(t, i, outcome, detail)) return;
    if (t.status !== 'searching') return;

    if (config.dialMode === 'parallel') {
      if (t.techs.every((tech) => tech.outcome)) allFailed(t);
    } else if (i === t.cursor) {
      dialNext(t);
    }
  }

  // Nobody took it. Ava is normally still in the room, so she is told by an
  // announcement; if her leg has dropped she is brought back with the fallback line.
  function noTechnician(t) {
    t.status = 'failed';
    t.timings.all_failed = timing(t, 'all_technicians_failed');
    finish(t, 'no technician', t.timings.all_failed);

    const resident = residentCalls.get(t.residentCallSid);
    if (!resident || resident.ended) return;
    // The resident goes back to talking with Ava: music off, Ava's voice back on.
    endHold(t, 'no technician available');
    if (resident.agent.state === 'in' || resident.agent.state === 'joining') {
      setAgentMuted(t.residentCallSid, false, 'no technician available').then((unmuted) => {
        if (!unmuted) return;
        t.agentUnmutedAt = Date.now();
        saveReport(t);
      });
      announce(t.residentCallSid, 'unavailable');
    } else {
      log(`AGENT Ava is not in the room, bringing her back for resident=${t.residentCallSid}`);
      addAgent(t.residentCallSid, { firstMessage: FALLBACK_FIRST_MESSAGE });
    }
  }

  function allFailed(t) {
    if (t.status === 'searching') noTechnician(t);
  }

  // The resident's call is over. Stops a running search.
  function residentGone(residentCallSid, why) {
    const resident = residentCalls.get(residentCallSid);
    if (!resident || resident.ended) return;
    resident.ended = true;
    log(`RESIDENT gone resident=${residentCallSid} (${why})`);
    scheduleTranscript(residentCallSid);

    const t = transfers.get(residentCallSid);
    if (t && (t.status === 'searching' || t.status === 'bridging')) {
      t.status = 'cancelled';
      t.timings.resident_hung_up = timing(t, 'resident_hung_up', '-> cancelling all technician calls');
      cancelTechs(t, { why: 'resident hung up' });
      finish(t, 'resident hung up', t.timings.resident_hung_up);
    }
  }

  // A resident left alone in the room would just hear silence, so end the call.
  function endIfResidentAlone(residentCallSid) {
    const resident = residentCalls.get(residentCallSid);
    if (!resident || resident.ended || !resident.conferenceSid) return;
    const t = transfers.get(residentCallSid);
    const searching = t && (t.status === 'searching' || t.status === 'bridging');
    const alone = resident.present.size === 1 && resident.present.has(residentCallSid);
    if (!alone || searching || resident.agent.state === 'joining') return;

    log(`CONFERENCE resident=${residentCallSid} is alone in the room, ending the call`);
    client.conferences(resident.conferenceSid)
      .update({ status: 'completed' })
      .catch((err) => log(`ERROR could not end conference ${resident.conferenceSid}: ${twilioError(err)}`));
  }

  // ---------------------------------------------------------------- resident call

  app.get('/health', (req, res) => res.json({ ok: true }));

  // Optional audio files, e.g. public/connecting.mp3 for the "technician joined" announcement.
  app.use('/public', express.static(config.publicDir));

  // Outbound start (default way to test): rings the person playing the resident.
  app.post('/start-call', secretHook, wrap(async (req, res) => {
    const to = String((req.body && req.body.to) || '').trim();
    if (!E164_RE.test(to)) {
      return res.status(400).json({ status: 'error', message: 'Body must be {"to": "+15551234567"} (E.164)' });
    }
    const call = await client.calls.create({
      to,
      from: config.twilioPhoneNumber,
      url: `${base}/twilio/outbound-answer`,
      method: 'POST',
      statusCallback: `${base}/twilio/resident-status`,
      statusCallbackMethod: 'POST',
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
    });
    residentCalls.set(call.sid, newResidentCall({ direction: 'outbound', number: to, twilioNumber: config.twilioPhoneNumber }));
    log(`START-CALL resident=${call.sid} to=${to}`);
    res.json({ status: 'calling', call_sid: call.sid });
  }));

  // Both ways in put the resident straight into their own room. Ava is added as soon
  // as Twilio reports the resident has joined (see /conference/status).
  function residentIntoRoom(res, residentCallSid) {
    log(`RESIDENT resident=${residentCallSid} -> ${roomName(residentCallSid)}, Ava will be added`);
    sendTwiml(res, conferenceTwiml(residentCallSid, { endConferenceOnExit: true }));
  }

  app.post('/twilio/outbound-answer', twilioHook, (req, res) => {
    const { CallSid, From, To } = req.body;
    if (!residentCalls.has(CallSid)) {
      residentCalls.set(CallSid, newResidentCall({ direction: 'outbound', number: To, twilioNumber: From }));
    }
    residentIntoRoom(res, CallSid);
  });

  // The resident rings the Twilio number. This is the normal way in on this branch.
  app.post('/twilio/inbound', twilioHook, (req, res) => {
    const { CallSid, From, To } = req.body;

    // On a number that other people also call, an allow-list keeps the playground to
    // the testers: everyone else is handed to the app the number pointed at before.
    const allowed = config.inboundAllowedCallers || [];
    if (allowed.length && !allowed.includes(From)) {
      const vr = new VoiceResponse();
      if (config.inboundPassThroughUrl) {
        log(`INBOUND caller ${From} is not on the allow-list: passed through to ${config.inboundPassThroughUrl} call=${CallSid}`);
        vr.redirect({ method: 'POST' }, config.inboundPassThroughUrl);
      } else {
        log(`INBOUND caller ${From} is not on the allow-list: call rejected call=${CallSid}`);
        vr.reject();
      }
      return sendTwiml(res, vr);
    }

    residentCalls.set(CallSid, newResidentCall({ direction: 'inbound', number: From, twilioNumber: To }));
    residentIntoRoom(res, CallSid);
  });

  // Status of an outbound-started resident call. (For inbound calls the conference
  // ending tells us the same thing, so the number's own settings stay untouched.)
  app.post('/twilio/resident-status', twilioHook, (req, res) => {
    const { CallSid, CallStatus } = req.body;
    res.sendStatus(204);
    if (CALL_ENDED.has(CallStatus)) residentGone(CallSid, `call ${CallStatus}`);
  });

  // ---------------------------------------------------------------- ElevenLabs tool

  app.post('/tool/request-transfer', secretHook, (req, res) => {
    const callSid = String((req.body && (req.body.call_sid || req.body.parent_call_sid)) || '').trim();
    const summary = String((req.body && req.body.summary) || '').replace(/\s+/g, ' ').trim().slice(0, 600);
    log(`TOOL request-transfer call_sid=${callSid || '(missing)'} summary=${JSON.stringify(summary)}`);

    if (!CALL_SID_RE.test(callSid)) {
      return res.status(400).json({ status: 'error', message: 'call_sid is missing or not a Twilio call SID. Is the tool sending the {{call_sid}} dynamic variable?' });
    }
    const resident = residentCalls.get(callSid);
    if (!resident || resident.ended) {
      return res.status(404).json({ status: 'error', message: 'No live call with that call_sid on this server.' });
    }

    const existing = transfers.get(callSid);
    if (existing) {
      if (existing.status === 'failed') {
        return res.json({ status: 'unavailable', message: 'No technician is available right now. Offer to take a message.' });
      }
      if (existing.status === 'connected') {
        return res.json({ status: 'connected', message: 'A technician is on the call with the resident now. Say nothing and let them talk.' });
      }
      return res.json({ status: 'searching', message: 'A technician search is already running for this call. Ask the resident to keep holding.' });
    }

    const now = Date.now();
    const t = {
      residentCallSid: callSid,
      residentNumber: resident.number,
      direction: resident.direction,
      summary: summary || 'A resident needs help from a technician.',
      status: 'searching', // searching -> bridging -> connected -> ended | failed | cancelled
      result: null, //        connected | no technician | resident hung up
      winner: null,
      cursor: -1,
      startedAt: now,
      finishedAt: null,
      techs: config.techNumbers.map((number) => ({
        number,
        callSid: null,
        callStatus: null, // last status Twilio reported for the call
        callEnded: false,
        outcome: null,
        detail: null,
        answeredBy: null,
        dialledAt: null,
        ringingAt: null,
        answeredAt: null,
        pressedAt: null,
        outcomeAt: null,
      })),
      timings: {},
    };
    transfers.set(callSid, t);
    timing(t, 'tool_call');
    saveReport(t);

    const holdDelayMs = config.holdDelayMs;
    const whileSearching = holdDelayMs === null
      ? 'Tell the resident you are finding someone and keep talking with them. '
      : 'Say one short sentence asking the resident to hold while you connect them with a technician, then say nothing more. ' +
        `Hold music starts for the resident in about ${Math.round(holdDelayMs / 1000)} seconds and they cannot hear you while it plays. `;

    // Answer the tool straight away; the search carries on after this response.
    res.json({
      status: 'searching',
      message:
        `Searching for a technician now. ${whileSearching}` +
        `You stay on the call. When you hear "${ANNOUNCEMENTS.joined}", a technician is talking with the resident: say nothing at all from then on, do not introduce anyone and do not answer, even if spoken to. ` +
        `If you hear "${ANNOUNCEMENTS.unavailable}", the resident can hear you again: apologise and offer to take a message.`,
    });
    setImmediate(() => startSearch(t));
    // Give Ava time to say "please hold" before the music replaces her.
    if (holdDelayMs !== null) setTimeout(() => startHold(t), holdDelayMs).unref();
  });

  // ---------------------------------------------------------------- technician legs

  function techContext(req) {
    const t = transfers.get(req.query.resident);
    const i = Number.parseInt(req.query.tech, 10);
    if (!t || !t.techs[i]) return null;
    const tech = t.techs[i];
    if (!tech.callSid && req.body.CallSid) tech.callSid = req.body.CallSid;
    return { t, i, tech };
  }

  function markAnswered(t, i) {
    const tech = t.techs[i];
    tech.callStatus = 'in-progress';
    if (tech.answeredAt) return;
    tech.answeredAt = timing(t, 'tech_answered', `tech#${i} ${tech.number}`);
    saveReport(t);
  }

  // Technician picked up (attempt 1), or the prompt is being repeated (attempt 2, 3).
  // With async AMD this runs immediately on pickup, before we know if it is a machine.
  app.post('/tech/answered', twilioHook, (req, res) => {
    const ctx = techContext(req);
    if (!ctx) return sayAndHangup(res, 'This request is no longer active. Goodbye.');
    const { t, i, tech } = ctx;
    const attempt = Number.parseInt(req.query.attempt, 10) || 1;

    if (attempt === 1) markAnswered(t, i);

    if (t.status !== 'searching' || tech.outcome) {
      setOutcome(t, i, 'canceled', 'search already over');
      return sayAndHangup(res, 'This request has already been handled. Goodbye.');
    }
    if (attempt > MAX_PROMPTS) {
      resolveTech(t, i, 'declined', `no key pressed after ${MAX_PROMPTS} prompts`);
      return sayAndHangup(res, 'No response received. Goodbye.');
    }

    const query = `resident=${t.residentCallSid}&tech=${i}`;
    const vr = new VoiceResponse();
    const gather = vr.gather({ numDigits: 1, timeout: 6, action: `${base}/tech/accept?${query}`, method: 'POST' });
    gather.say(`${t.summary} Press 1 to connect to the resident.`);
    // No key pressed: Twilio falls through to here and we ask again.
    vr.redirect({ method: 'POST' }, `${base}/tech/answered?${query}&attempt=${attempt + 1}`);
    sendTwiml(res, vr);
  });

  // Async answering-machine detection result. Only a machine changes anything.
  app.post('/tech/amd', twilioHook, (req, res) => {
    res.sendStatus(204);
    const ctx = techContext(req);
    if (!ctx) return;
    const { t, i, tech } = ctx;
    const answeredBy = req.body.AnsweredBy || 'unknown';
    tech.answeredBy = answeredBy;
    tech.callStatus = 'in-progress'; // detection only runs on a call that was picked up
    log(`AMD tech#${i} ${tech.number} call=${tech.callSid} answeredBy=${answeredBy} resident=${t.residentCallSid}`);

    if (!/^(machine|fax)/.test(answeredBy)) return saveReport(t);
    if (tech.outcome === 'accepted') {
      // They pressed 1, so a person is there whatever the detector thinks.
      log(`AMD tech#${i} reported ${answeredBy} after the technician accepted: ignored`);
      return saveReport(t);
    }
    // Voicemail counts as a decline for this technician only.
    resolveTech(t, i, 'voicemail', `answering machine (${answeredBy})`);
    endTechCall(t, i, 'answering machine detected');
  });

  // Technician pressed a key.
  app.post('/tech/accept', twilioHook, (req, res) => {
    const ctx = techContext(req);
    if (!ctx) return sayAndHangup(res, 'This request is no longer active. Goodbye.');
    const { t, i, tech } = ctx;
    const digits = req.body.Digits || '';

    if (digits !== '1') {
      resolveTech(t, i, 'declined', `pressed ${digits || 'nothing'}`);
      return sayAndHangup(res, 'Okay. Goodbye.');
    }

    // The lock. Node handles one request at a time and there is no await between
    // this check and the assignment below, so only one technician can get through.
    const resident = residentCalls.get(t.residentCallSid);
    const gone = t.status === 'cancelled' || !resident || resident.ended;
    if (gone || t.status !== 'searching' || tech.outcome) {
      setOutcome(t, i, 'canceled', gone ? 'resident already hung up' : 'another technician accepted first');
      return sayAndHangup(res, gone ? 'Sorry, the resident has hung up. Goodbye.' : 'Another technician has already taken this call. Goodbye.');
    }
    t.status = 'bridging';
    t.winner = i;
    tech.pressedAt = timing(t, 'tech_pressed_1', `tech#${i} ${tech.number}`);
    setOutcome(t, i, 'accepted', 'pressed 1');
    log(`WINNER tech#${i} ${tech.number} call=${tech.callSid} resident=${t.residentCallSid}`);

    // Straight away: stop every other technician's phone.
    cancelTechs(t, { except: i, why: 'another technician accepted' });

    // The technician joins the room where the resident and Ava already are. Nobody is
    // moved, so Ava stays. The technician leaving does not end the call for the others.
    sendTwiml(res, conferenceTwiml(t.residentCallSid, { say: TECH_ANNOUNCEMENT, endConferenceOnExit: false }));
  });

  // Status callbacks for technician calls: ringing, answered, and how the call ended.
  app.post('/tech/status', twilioHook, (req, res) => {
    res.sendStatus(204);
    const ctx = techContext(req);
    if (!ctx) return;
    const { t, i, tech } = ctx;
    const status = req.body.CallStatus;
    tech.callStatus = status;

    if (status === 'ringing') {
      if (!tech.ringingAt) tech.ringingAt = Date.now();
      if (!t.timings.first_tech_ringing) {
        t.timings.first_tech_ringing = timing(t, 'first_tech_ringing', `tech#${i} ${tech.number}`);
      }
      saveReport(t);
    } else if (status === 'in-progress') {
      markAnswered(t, i);
      // Picked up at the same moment we cancelled: "canceled" no longer works, so hang up.
      if (tech.outcome === 'canceled') endTechCall(t, i, 'answered after being cancelled');
    } else if (CALL_ENDED.has(status)) {
      tech.callEnded = true;
      if (t.winner === i && t.status === 'bridging') {
        // Pressed 1 but dropped before reaching the room.
        log(`TECH tech#${i} ${tech.number} accepted but the call ended before joining the room`);
        return noTechnician(t);
      }
      // "completed" means they picked up and the call ended without them accepting.
      if (status === 'completed') resolveTech(t, i, 'declined', 'call ended without pressing 1');
      else if (status === 'no-answer' || status === 'busy' || status === 'canceled') resolveTech(t, i, status, `Twilio reported ${status}`);
      else resolveTech(t, i, 'failed', `Twilio reported ${status}`);
    }
  });

  // ---------------------------------------------------------------- conference

  function whoIs(residentCallSid, resident, t, body) {
    if (body.CallSid === residentCallSid) return 'resident';
    if (String(body.ParticipantLabel || '').startsWith('ava-') || body.CallSid === resident.agent.callSid) return 'agent';
    if (t && t.winner !== null && t.techs[t.winner].callSid === body.CallSid) return 'technician';
    return 'unknown';
  }

  // Conference events (start / join / leave / end) and the recording callback.
  // This is where we learn who is actually in the room.
  app.post('/conference/status', twilioHook, (req, res) => {
    res.sendStatus(204);
    const residentCallSid = req.query.resident;
    const resident = residentCalls.get(residentCallSid);
    const t = transfers.get(residentCallSid);
    const body = req.body;

    if (body.RecordingSid) {
      log(`RECORDING ${body.RecordingStatus} sid=${body.RecordingSid} conference=${body.ConferenceSid} duration=${body.RecordingDuration}s url=${body.RecordingUrl}`);
      return;
    }
    if (!resident) return;
    if (body.ConferenceSid && !resident.conferenceSid) resident.conferenceSid = body.ConferenceSid;

    const event = body.StatusCallbackEvent;
    if (event === 'participant-join') {
      const who = whoIs(residentCallSid, resident, t, body);
      resident.present.add(body.CallSid);
      log(`CONFERENCE ${who} joined ${roomName(residentCallSid)} call=${body.CallSid} (now ${resident.present.size} in the room)`);

      if (who === 'resident') {
        addAgent(residentCallSid);
      } else if (who === 'agent') {
        resident.agent.state = 'in';
        resident.agent.callSid = body.CallSid;
        resident.agent.muted = false; // a leg always joins unmuted
      } else if (who === 'technician' && t.status === 'bridging') {
        t.status = 'connected';
        t.timings.technician_joined = timing(t, 'technician_joined', `conference=${body.ConferenceSid}`);
        logTimingSummary(t);
        finish(t, 'connected', t.timings.technician_joined);
        // Silence Ava, stop the resident's hold music, then tell the room. In this order
        // nobody hears Ava react to the announcement and the resident does not miss it.
        setAgentMuted(residentCallSid, true, 'technician joined').then((muted) => {
          if (!muted) return;
          t.agentMutedAt = Date.now();
          saveReport(t);
        });
        endHold(t, 'technician joined');
        announce(residentCallSid, 'joined');
      }
    } else if (event === 'participant-leave') {
      const who = whoIs(residentCallSid, resident, t, body);
      resident.present.delete(body.CallSid);
      log(`CONFERENCE ${who} left ${roomName(residentCallSid)} call=${body.CallSid} (now ${resident.present.size} in the room)`);

      if (who === 'agent') resident.agent.state = 'left';
      if (who === 'technician') {
        // The resident is alone with Ava again, so she needs her voice back.
        setAgentMuted(residentCallSid, false, 'technician left').then((unmuted) => {
          if (unmuted) {
            t.agentUnmutedAt = Date.now();
            saveReport(t);
          }
        });
      }
      if (who === 'resident') residentGone(residentCallSid, 'left the room');
      else endIfResidentAlone(residentCallSid);
    } else if (event === 'conference-end') {
      log(`CONFERENCE ended ${body.FriendlyName} conference=${body.ConferenceSid}`);
      if (t && t.status === 'connected') t.status = 'ended';
      residentGone(residentCallSid, 'conference ended');
    }
  });

  // ---------------------------------------------------------------- reports

  app.get('/reports', localOnly, (req, res) => {
    const all = reports.list();
    if (req.query.format === 'json') return res.json(all);
    res.type('html').send(renderList(all));
  });

  app.get('/reports/:sid', localOnly, wrap(async (req, res) => {
    if (!reports.get(req.params.sid)) return res.status(404).send('No report for that call SID.');
    // Opening the page fetches the latest transcript (until it is final), but never
    // keeps the browser waiting long if ElevenLabs is slow.
    await Promise.race([
      refreshTranscript(req.params.sid),
      new Promise((resolve) => { setTimeout(resolve, 9000).unref(); }),
    ]);
    const report = reports.get(req.params.sid);
    if (req.query.format === 'json') return res.json(report);
    res.type('html').send(renderDetail(report));
  }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    log(`ERROR ${req.method} ${req.originalUrl}: ${err.stack || err.message}`);
    if (!res.headersSent) res.status(500).json({ status: 'error', message: err.message });
  });

  return { app, state: { residentCalls, transfers } };
}

module.exports = { createApp, FALLBACK_FIRST_MESSAGE, ANNOUNCEMENTS };
