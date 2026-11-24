'use strict';

// Branch "agent-stays-on-call".
// Simulates Twilio's webhooks against the real Express app with a fake Twilio
// REST client, so the call logic can be checked without placing calls.
// Requests are signed for PUBLIC_BASE_URL but sent to localhost, which is the
// same situation as running behind ngrok.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const twilio = require('twilio');
const { createApp, FALLBACK_FIRST_MESSAGE } = require('../src/app');

const AUTH_TOKEN = 'test-auth-token';
const PUBLIC = 'https://playground.example.test';
const TOOL_SECRET = 'test-tool-secret';
const TWILIO_NUMBER = '+15559990000';
const RESIDENT = `CA${'a'.repeat(32)}`;
const RESIDENT_NUMBER = '+15551110000';
const APP_SID = `AP${'b'.repeat(32)}`;
const CONFERENCE = `CF${'c'.repeat(32)}`;
const ROOM = `room-${RESIDENT}`;
const AGENT_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Stream url="wss://agent.example.test"/></Connect></Response>';
const FORGED = 'bm90LWEtcmVhbC1zaWduYXR1cmU=';

const tick = () => new Promise((resolve) => setTimeout(resolve, 25));

// holdDelayMs: null = no hold music (most tests), a number = music starts that long after the tool call.
async function setup({
  dialMode = 'sequential',
  techNumbers = ['+15550000001', '+15550000002'],
  holdDelayMs = null,
  inboundAllowedCallers = [],
  inboundPassThroughUrl = '',
} = {}) {
  const created = []; //        calls.create(...)            -> technician calls and /start-call
  const updates = []; //        calls(sid).update(...)
  const agentLegs = []; //      conferences(sid).participants.create(...) -> Ava joining
  const roomUpdates = []; //    conferences(sid).update(...) -> announcements, ending the room
  const registered = []; //     register-call requests to ElevenLabs
  const logs = [];
  const failUpdatesFor = new Set(); //   call SIDs whose REST updates throw
  const answeredMeanwhile = new Set(); // call SIDs that report in-progress when we try to cancel them
  const mutes = []; //          conferences(sid).participants(callSid).update(...) -> muting Ava
  const holds = []; //          same call with "hold" -> the resident's hold music
  const roomActions = []; //    mutes, announcements and room endings, in the order they were sent
  const flags = { failAgentAdd: false, failRegister: false, failConversations: false, failMute: false };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'warm-transfer-test-'));
  // Stand-in for the ElevenLabs conversations API: what it would return for a call.
  const elevenLabs = { details: [], lookups: [] };
  const conversations = {
    forCall: async (callSid, startedAfterUnix) => {
      elevenLabs.lookups.push({ callSid, startedAfterUnix });
      if (flags.failConversations) throw new Error('ElevenLabs HTTP 500: upstream error');
      return elevenLabs.details;
    },
  };

  const calls = (sid) => ({
    update: async (options) => {
      updates.push({ sid, ...options });
      if (failUpdatesFor.has(sid)) {
        throw Object.assign(new Error('Call is not in-progress'), { code: 21220 });
      }
      const ignored = options.status === 'canceled' && answeredMeanwhile.has(sid);
      return { sid, status: ignored ? 'in-progress' : options.status || 'in-progress' };
    },
  });
  calls.create = async (options) => {
    const sid = `CA${String(created.length + 1).padStart(32, '0')}`;
    created.push({ sid, ...options });
    return { sid, status: 'queued' };
  };

  const conferences = (sid) => {
    // conferences(sid).participants(callSid).update(...) mutes or unmutes one participant.
    // ...and with "hold" it puts one participant on hold music or takes them off it.
    const participants = (callSid) => ({
      update: async (options) => {
        if ('hold' in options) {
          roomActions.push(`hold:${options.hold}`);
          holds.push({ conferenceSid: sid, callSid, ...options });
          return { callSid, hold: options.hold };
        }
        roomActions.push(`mute:${options.muted}`);
        mutes.push({ conferenceSid: sid, callSid, ...options });
        if (flags.failMute) throw Object.assign(new Error('Participant not found'), { code: 20404 });
        return { callSid, muted: options.muted };
      },
    });
    participants.create = async (options) => {
      if (flags.failAgentAdd) throw Object.assign(new Error('Application not found'), { code: 21218 });
      const callSid = `CA${'e'.repeat(31)}${agentLegs.length + 1}`;
      agentLegs.push({ conferenceSid: sid, callSid, ...options });
      return { callSid, label: options.label };
    };
    return {
      update: async (options) => {
        roomActions.push(options.announceUrl ? `announce:${new URL(options.announceUrl).searchParams.get('kind')}` : `room:${options.status}`);
        roomUpdates.push({ sid, ...options });
        return { sid };
      },
      participants,
    };
  };

  const config = {
    publicBaseUrl: PUBLIC,
    twilioAuthToken: AUTH_TOKEN,
    twilioPhoneNumber: TWILIO_NUMBER,
    toolSecret: TOOL_SECRET,
    techNumbers,
    dialMode,
    ringTimeoutSec: 20,
    agentAppSid: APP_SID,
    inboundAllowedCallers,
    inboundPassThroughUrl,
    holdDelayMs,
    holdMusicUrl: 'http://twimlets.com/holdmusic?Bucket=com.twilio.music.classical',
    transcriptRetryMs: [5],
    reportsDir: path.join(tmp, 'reports'),
    publicDir: path.join(tmp, 'public'),
  };
  const registerCall = async (args) => {
    registered.push(args);
    if (flags.failRegister) throw new Error('register-call HTTP 401: invalid api key');
    return AGENT_TWIML;
  };

  const { app, state } = createApp({ config, client: { calls, conferences }, registerCall, conversations, logger: (line) => logs.push(line) });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const local = `http://localhost:${server.address().port}`;

  // POST a form body the way Twilio does, signed for the public URL.
  async function hook(urlPath, params, { signature } = {}) {
    const sig = signature || twilio.getExpectedTwilioSignature(AUTH_TOKEN, PUBLIC + urlPath, params);
    const response = await fetch(local + urlPath, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': sig },
      body: new URLSearchParams(params).toString(),
    });
    return { status: response.status, text: await response.text() };
  }

  async function json(urlPath, body, secret = TOOL_SECRET) {
    const response = await fetch(local + urlPath, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(secret ? { 'X-Tool-Secret': secret } : {}) },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  }

  async function get(urlPath, headers = {}) {
    const response = await fetch(local + urlPath, { headers });
    return { status: response.status, text: await response.text() };
  }

  // A conference status callback for the resident's room.
  async function room(event, params = {}, resident = RESIDENT) {
    const result = await hook(`/conference/status?resident=${resident}`, {
      StatusCallbackEvent: event, ConferenceSid: CONFERENCE, FriendlyName: `room-${resident}`, ...params,
    });
    await tick();
    return result;
  }

  // Ava's leg: Twilio asks the TwiML App URL for TwiML, then reports her in the room.
  async function avaJoins(resident = RESIDENT) {
    const leg = agentLegs.at(-1);
    const answer = await hook('/twilio/agent-leg', { CallSid: `CA${'d'.repeat(32)}`, From: TWILIO_NUMBER, To: `app:${APP_SID}`, resident });
    await room('participant-join', { CallSid: leg.callSid, ParticipantLabel: leg.label }, resident);
    return answer;
  }
  const avaLeaves = () => room('participant-leave', { CallSid: agentLegs.at(-1).callSid, ParticipantLabel: agentLegs.at(-1).label });

  // Resident calls in, lands in the room, Ava is added and joins.
  async function residentIsWithAva() {
    const inbound = await hook('/twilio/inbound', { CallSid: RESIDENT, From: RESIDENT_NUMBER, To: TWILIO_NUMBER, Direction: 'inbound' });
    await room('participant-join', { CallSid: RESIDENT });
    await avaJoins();
    return inbound;
  }

  // ...and then Ava asks for a transfer.
  async function residentAsksForTransfer() {
    await residentIsWithAva();
    const reply = await json('/tool/request-transfer', { call_sid: RESIDENT, summary: 'Leak under the kitchen sink in unit 4B.' });
    await tick();
    return reply;
  }

  const tech = (i) => {
    const query = `resident=${RESIDENT}&tech=${i}`;
    const sid = () => created.find((c) => c.url && c.url.includes(`tech=${i}`)).sid;
    return {
      sid,
      status: (CallStatus) => hook(`/tech/status?${query}`, { CallSid: sid(), CallStatus }),
      // Picks up: the status callback and the TwiML request, as Twilio sends them.
      answered: async (attempt) => {
        if (!attempt) await hook(`/tech/status?${query}`, { CallSid: sid(), CallStatus: 'in-progress' });
        return hook(`/tech/answered?${query}${attempt ? `&attempt=${attempt}` : ''}`, { CallSid: sid(), CallStatus: 'in-progress' });
      },
      amd: (AnsweredBy) => hook(`/tech/amd?${query}`, { CallSid: sid(), AnsweredBy, MachineDetectionDuration: '3200' }),
      press: (Digits) => hook(`/tech/accept?${query}`, { CallSid: sid(), Digits }),
      joins: () => room('participant-join', { CallSid: sid() }),
      leaves: () => room('participant-leave', { CallSid: sid() }),
    };
  };

  // Technician i takes the call and arrives in the room.
  async function techAcceptsAndJoins(i = 0) {
    await tech(i).answered();
    const accept = await tech(i).press('1');
    await tick();
    await tech(i).joins();
    return accept;
  }

  const techCalls = () => created.filter((c) => c.url && c.url.includes('/tech/answered'));
  // Status values sent to Twilio for one call, in order, e.g. ['canceled', 'completed'].
  const endedWith = (sid) => updates.filter((u) => u.sid === sid && u.status).map((u) => u.status);
  const announcements = () => roomUpdates.filter((u) => u.announceUrl).map((u) => new URL(u.announceUrl).searchParams.get('kind'));
  const roomEnded = () => roomUpdates.some((u) => u.status === 'completed');
  const transfer = () => state.transfers.get(RESIDENT);
  const outcomes = () => transfer().techs.map((x) => x.outcome);
  const report = () => JSON.parse(fs.readFileSync(path.join(config.reportsDir, `${RESIDENT}.json`), 'utf8'));
  const close = async () => {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tmp, { recursive: true, force: true });
  };

  return {
    config, state, created, updates, agentLegs, roomUpdates, mutes, holds, roomActions, registered, logs, failUpdatesFor, answeredMeanwhile, flags, elevenLabs,
    hook, json, get, room, avaJoins, avaLeaves, residentIsWithAva, residentAsksForTransfer, tech, techAcceptsAndJoins,
    techCalls, endedWith, announcements, roomEnded, transfer, outcomes, report, close,
  };
}

// ---------------------------------------------------------------- call start

test('call start: resident goes into a room and Ava is added to it as her own leg', async (t) => {
  const s = await setup();
  t.after(s.close);

  const inbound = await s.hook('/twilio/inbound', { CallSid: RESIDENT, From: RESIDENT_NUMBER, To: TWILIO_NUMBER, Direction: 'inbound' });
  assert.match(inbound.text, new RegExp(`<Dial><Conference[^>]*>${ROOM}</Conference></Dial>`));
  assert.match(inbound.text, /endConferenceOnExit="true"/, 'the resident leaving ends the call');
  assert.match(inbound.text, /waitUrl=""/, 'silence, not hold music, until Ava joins');
  assert.match(inbound.text, /record="record-from-start"/);
  assert.match(inbound.text, /statusCallbackEvent="start end join leave"/);
  assert.doesNotMatch(inbound.text, /<Connect>/, 'the ElevenLabs stream is not on the resident leg any more');
  assert.equal(s.registered.length, 0);
  assert.equal(s.agentLegs.length, 0, 'Ava is added once the resident is in the room');

  await s.room('participant-join', { CallSid: RESIDENT });
  assert.equal(s.agentLegs.length, 1);
  const leg = s.agentLegs[0];
  assert.equal(leg.conferenceSid, CONFERENCE);
  assert.equal(leg.to, `app:${APP_SID}?resident=${RESIDENT}`);
  assert.equal(leg.from, TWILIO_NUMBER);
  assert.equal(leg.label, 'ava-1');
  assert.equal(leg.endConferenceOnExit, false, 'Ava dropping does not end the call');

  // Twilio asks the TwiML App URL what to do with Ava's leg: the ElevenLabs stream.
  const answer = await s.avaJoins();
  assert.match(answer.text, /<Connect><Stream/);
  assert.deepEqual(s.registered[0], {
    fromNumber: RESIDENT_NUMBER, toNumber: TWILIO_NUMBER, direction: 'inbound', callSid: RESIDENT, firstMessage: null,
  });
  assert.equal(s.state.residentCalls.get(RESIDENT).agent.state, 'in');

  // A repeated join event does not add a second Ava.
  await s.room('participant-join', { CallSid: RESIDENT });
  assert.equal(s.agentLegs.length, 1);
});

test('inbound allow-list: listed callers reach Ava, everyone else is handed to the app the number used before', async (t) => {
  const previousApp = 'https://other-app.example.test/twilio/voice';
  const s = await setup({ inboundAllowedCallers: [RESIDENT_NUMBER], inboundPassThroughUrl: previousApp });
  t.after(s.close);

  const stranger = await s.hook('/twilio/inbound', { CallSid: `CA${'9'.repeat(32)}`, From: '+15557770000', To: TWILIO_NUMBER, Direction: 'inbound' });
  assert.match(stranger.text, new RegExp(`<Redirect method="POST">${previousApp}</Redirect>`));
  assert.doesNotMatch(stranger.text, /<Conference/);
  assert.equal(s.state.residentCalls.size, 0, 'the playground keeps no record of that call');
  assert.ok(s.logs.some((line) => line.includes('not on the allow-list') && line.includes('passed through')));

  const tester = await s.hook('/twilio/inbound', { CallSid: RESIDENT, From: RESIDENT_NUMBER, To: TWILIO_NUMBER, Direction: 'inbound' });
  assert.match(tester.text, new RegExp(`<Conference[^>]*>${ROOM}</Conference>`));
});

test('inbound allow-list: with nowhere to pass other callers to, their call is rejected; no list means everyone reaches Ava', async (t) => {
  const strict = await setup({ inboundAllowedCallers: [RESIDENT_NUMBER] });
  t.after(strict.close);
  const stranger = await strict.hook('/twilio/inbound', { CallSid: `CA${'9'.repeat(32)}`, From: '+15557770000', To: TWILIO_NUMBER, Direction: 'inbound' });
  assert.match(stranger.text, /<Reject\/>/);

  const open = await setup();
  t.after(open.close);
  const anyone = await open.hook('/twilio/inbound', { CallSid: `CA${'9'.repeat(32)}`, From: '+15557770000', To: TWILIO_NUMBER, Direction: 'inbound' });
  assert.match(anyone.text, /<Conference/);
});

test('agent leg: the resident call is found from Param_resident, or from the one call waiting for Ava', async (t) => {
  const s = await setup();
  t.after(s.close);
  await s.hook('/twilio/inbound', { CallSid: RESIDENT, From: RESIDENT_NUMBER, To: TWILIO_NUMBER, Direction: 'inbound' });
  await s.room('participant-join', { CallSid: RESIDENT });

  const prefixed = await s.hook('/twilio/agent-leg', { CallSid: `CA${'d'.repeat(32)}`, Param_resident: RESIDENT });
  assert.match(prefixed.text, /<Connect>/);
  const bare = await s.hook('/twilio/agent-leg', { CallSid: `CA${'d'.repeat(32)}` });
  assert.match(bare.text, /<Connect>/);
  assert.deepEqual(s.registered.map((r) => r.callSid), [RESIDENT, RESIDENT]);
});

test('agent leg: if ElevenLabs refuses, the resident hears an apology on that leg', async (t) => {
  const s = await setup();
  t.after(s.close);
  s.flags.failRegister = true;
  await s.hook('/twilio/inbound', { CallSid: RESIDENT, From: RESIDENT_NUMBER, To: TWILIO_NUMBER, Direction: 'inbound' });
  await s.room('participant-join', { CallSid: RESIDENT });

  const answer = await s.hook('/twilio/agent-leg', { CallSid: `CA${'d'.repeat(32)}`, resident: RESIDENT });
  assert.match(answer.text, /<Say>Sorry, we are having trouble connecting you right now/);
  assert.match(answer.text, /<Hangup\/>/);
});

test('Ava cannot be added (for example a wrong TwiML App SID): the resident is told and the call ends', async (t) => {
  const s = await setup();
  t.after(s.close);
  s.flags.failAgentAdd = true;
  await s.hook('/twilio/inbound', { CallSid: RESIDENT, From: RESIDENT_NUMBER, To: TWILIO_NUMBER, Direction: 'inbound' });
  await s.room('participant-join', { CallSid: RESIDENT });

  const told = s.updates.find((u) => u.sid === RESIDENT && u.twiml);
  assert.match(told.twiml, /Sorry, we are having trouble connecting you right now/);
  assert.match(told.twiml, /<Hangup\/>/);
  assert.ok(s.logs.some((line) => line.includes('ERROR could not add Ava') && line.includes('Twilio error 21218')));
});

test('outbound start: /start-call rings the resident, who lands in the room; Ava registers as outbound', async (t) => {
  const s = await setup();
  t.after(s.close);

  assert.equal((await s.json('/start-call', { to: RESIDENT_NUMBER }, null)).status, 401);
  assert.equal((await s.json('/start-call', { to: 'not-a-number' })).status, 400);

  const started = await s.json('/start-call', { to: RESIDENT_NUMBER });
  assert.equal(started.status, 200);
  const sid = started.body.call_sid;
  assert.equal(s.created[0].url, `${PUBLIC}/twilio/outbound-answer`);
  assert.equal(s.created[0].statusCallback, `${PUBLIC}/twilio/resident-status`);

  const answer = await s.hook('/twilio/outbound-answer', { CallSid: sid, From: TWILIO_NUMBER, To: RESIDENT_NUMBER, Direction: 'outbound-api' });
  assert.match(answer.text, new RegExp(`<Conference[^>]*>room-${sid}</Conference>`));

  await s.room('participant-join', { CallSid: sid }, sid);
  assert.equal(s.agentLegs[0].to, `app:${APP_SID}?resident=${sid}`);
  await s.avaJoins(sid);
  assert.deepEqual(s.registered[0], {
    fromNumber: TWILIO_NUMBER, toNumber: RESIDENT_NUMBER, direction: 'outbound', callSid: sid, firstMessage: null,
  });
});

// ---------------------------------------------------------------- transfer

test('accept: the technician joins the same room, nobody is moved, and Ava is still there', async (t) => {
  const s = await setup();
  t.after(s.close);

  const reply = await s.residentAsksForTransfer();
  assert.equal(reply.status, 200);
  assert.equal(reply.body.status, 'searching');
  assert.match(reply.body.message, /When you hear "A technician has joined the call\.".*say nothing at all/, 'the tool reply tells Ava to go silent');

  // Sequential: only the first technician is dialled, with async AMD, 20s timeout and status callbacks.
  assert.equal(s.techCalls().length, 1);
  const dialled = s.techCalls()[0];
  assert.equal(dialled.to, '+15550000001');
  assert.equal(dialled.machineDetection, 'Enable');
  assert.equal(dialled.asyncAmd, 'true');
  assert.equal(dialled.asyncAmdStatusCallback, `${PUBLIC}/tech/amd?resident=${RESIDENT}&tech=0`);
  assert.equal(dialled.timeout, 20);
  assert.deepEqual(dialled.statusCallbackEvent, ['initiated', 'ringing', 'answered', 'completed']);

  await s.tech(0).status('ringing');
  const prompt = await s.tech(0).answered();
  assert.match(prompt.text, /<Gather[^>]*numDigits="1"/);
  assert.match(prompt.text, /Leak under the kitchen sink in unit 4B\. Press 1 to connect to the resident\./);
  await s.tech(0).amd('human');

  const accept = await s.tech(0).press('1');
  assert.match(accept.text, new RegExp(`<Say>Connecting you to the resident\\.</Say><Dial><Conference[^>]*>${ROOM}</Conference>`));
  assert.match(accept.text, /endConferenceOnExit="false"/, 'the technician leaving does not end the call');
  await tick();
  assert.equal(s.transfer().status, 'bridging');

  await s.tech(0).joins();
  assert.equal(s.transfer().status, 'connected');

  // The point of this branch: the resident's call is never touched, so Ava's stream keeps running.
  assert.deepEqual(s.updates.filter((u) => u.sid === RESIDENT), [], 'resident call is not updated');
  assert.equal(s.agentLegs.length, 1, 'Ava was added once and never replaced');
  assert.equal(s.state.residentCalls.get(RESIDENT).agent.state, 'in');
  assert.equal(s.state.residentCalls.get(RESIDENT).present.size, 3, 'resident, Ava and the technician are in the room');
  assert.equal(s.roomEnded(), false);
  assert.equal(s.registered.length, 1, 'no second ElevenLabs conversation');

  // Ava is silenced first, then the room is told the technician has arrived.
  assert.deepEqual(s.roomActions, ['mute:true', 'announce:joined']);
  assert.deepEqual(s.mutes, [{ conferenceSid: CONFERENCE, callSid: s.agentLegs[0].callSid, muted: true }], "it is Ava's leg that is muted");
  assert.equal(s.state.residentCalls.get(RESIDENT).agent.muted, true);
  assert.equal(s.roomUpdates[0].sid, CONFERENCE);
  assert.ok(s.logs.some((line) => line.includes('AGENT Ava muted')));
  assert.equal(s.techCalls().length, 1, 'second technician is never dialled');

  const logText = s.logs.join('\n');
  for (const event of ['tool_call', 'first_tech_ringing', 'tech_answered', 'tech_pressed_1', 'technician_joined', 'TIMING SUMMARY']) {
    assert.ok(logText.includes(event), `timing log has ${event}`);
  }
  assert.equal(s.logs.filter((line) => line.includes('TRANSFER CONNECTED')).length, 1, 'one-line summary printed once');

  const report = s.report();
  assert.equal(report.resident_call_sid, RESIDENT);
  assert.equal(report.resident_number, RESIDENT_NUMBER);
  assert.equal(report.summary, 'Leak under the kitchen sink in unit 4B.');
  assert.equal(report.dial_mode, 'sequential');
  assert.equal(report.transfer_style, 'agent stays on the call');
  assert.equal(report.result, 'connected');
  assert.equal(report.connected_technician, '+15550000001');
  assert.equal(typeof report.resident_wait_seconds, 'number');
  assert.ok(report.agent_muted_at, 'the report records when Ava was muted');
  assert.equal(report.agent_unmuted_at, null);
  const [first, second] = report.technicians;
  assert.equal(first.outcome, 'accepted');
  assert.equal(first.answered_by, 'human');
  for (const key of ['dialled', 'ringing', 'answered', 'outcome']) {
    assert.equal(typeof first.seconds_from_tool_call[key], 'number', `seconds_from_tool_call.${key}`);
  }
  assert.equal(second.outcome, 'not-called');

  // If Ava checks again, she is told the technician is there.
  const again = await s.json('/tool/request-transfer', { call_sid: RESIDENT, summary: 'again' });
  assert.equal(again.body.status, 'connected');
});

test('announcements: spoken lines by default, public/connecting.mp3 for "joined" when the file exists', async (t) => {
  const s = await setup();
  t.after(s.close);

  assert.match((await s.hook('/conference/announce?kind=joined', { ConferenceSid: CONFERENCE })).text, /<Say>A technician has joined the call\.<\/Say>/);
  assert.match((await s.hook('/conference/announce?kind=unavailable', { ConferenceSid: CONFERENCE })).text, /<Say>No technician is available right now\.<\/Say>/);
  assert.equal((await s.hook('/conference/announce?kind=joined', { ConferenceSid: CONFERENCE }, { signature: FORGED })).status, 403);

  fs.mkdirSync(s.config.publicDir, { recursive: true });
  fs.writeFileSync(path.join(s.config.publicDir, 'connecting.mp3'), 'not really audio');
  const played = await s.hook('/conference/announce?kind=joined', { ConferenceSid: CONFERENCE });
  assert.match(played.text, new RegExp(`<Play>${PUBLIC}/public/connecting\\.mp3</Play>`));
  assert.doesNotMatch(played.text, /<Say>/);
  assert.equal((await s.get('/public/connecting.mp3')).text, 'not really audio');
});

test('after connecting: the call survives the technician or Ava leaving, and ends when the resident is left alone', async (t) => {
  const s = await setup();
  t.after(s.close);
  await s.residentAsksForTransfer();
  await s.techAcceptsAndJoins(0);

  // Technician hangs up: the resident is still with Ava, who gets her voice back.
  await s.tech(0).leaves();
  assert.equal(s.roomEnded(), false);
  assert.equal(s.state.residentCalls.get(RESIDENT).present.size, 2);
  assert.deepEqual(s.roomActions, ['mute:true', 'announce:joined', 'mute:false']);
  assert.equal(s.state.residentCalls.get(RESIDENT).agent.muted, false);
  assert.ok(s.report().agent_unmuted_at);

  // Then Ava's conversation ends too: nobody is left for the resident to talk to.
  await s.avaLeaves();
  assert.equal(s.roomEnded(), true);
  assert.equal(s.roomUpdates.at(-1).sid, CONFERENCE);
});

test('muting: if Twilio refuses the mute it is logged and the room is still told; no mute is attempted when Ava is not there', async (t) => {
  const s = await setup();
  t.after(s.close);
  await s.residentAsksForTransfer();
  s.flags.failMute = true;
  await s.techAcceptsAndJoins(0);

  assert.deepEqual(s.roomActions, ['mute:true', 'announce:joined']);
  assert.ok(s.logs.some((line) => line.includes('ERROR could not mute Ava') && line.includes('Twilio error 20404')));
  assert.equal(s.state.residentCalls.get(RESIDENT).agent.muted, false);
  assert.equal(s.report().agent_muted_at, null, 'the report does not claim she was muted');

  const other = await setup();
  t.after(other.close);
  await other.residentAsksForTransfer();
  await other.avaLeaves();
  await other.techAcceptsAndJoins(0);
  assert.deepEqual(other.roomActions, ['announce:joined']);
});

// ---------------------------------------------------------------- hold music

test('hold music: shortly after the tool call the resident hears music and Ava is muted; both end when the technician joins', async (t) => {
  const s = await setup({ holdDelayMs: 10 });
  t.after(s.close);

  const reply = await s.residentAsksForTransfer();
  assert.match(reply.body.message, /asking the resident to hold/, 'Ava is told to say "please hold" first');
  await tick();

  assert.deepEqual(s.roomActions, ['hold:true', 'mute:true']);
  assert.deepEqual(s.holds[0], {
    conferenceSid: CONFERENCE,
    callSid: RESIDENT,
    hold: true,
    holdUrl: 'http://twimlets.com/holdmusic?Bucket=com.twilio.music.classical',
    holdMethod: 'GET',
  });
  assert.equal(s.mutes[0].callSid, s.agentLegs[0].callSid);
  assert.ok(s.report().hold_started_at);
  assert.ok(s.report().agent_muted_at);
  assert.ok(s.logs.some((line) => line.includes('HOLD') && line.includes('on hold with music')));

  await s.techAcceptsAndJoins(0);
  // Music off first, then the announcement, so the resident hears it. Ava stays muted.
  assert.deepEqual(s.roomActions, ['hold:true', 'mute:true', 'hold:false', 'announce:joined']);
  assert.deepEqual(s.holds[1], { conferenceSid: CONFERENCE, callSid: RESIDENT, hold: false });
  assert.equal(s.state.residentCalls.get(RESIDENT).agent.muted, true);
  const report = s.report();
  assert.ok(report.hold_ended_at >= report.hold_started_at);
  assert.equal(report.agent_unmuted_at, null);
});

test('hold music: when nobody is available the music stops and Ava gets her voice back before the announcement', async (t) => {
  const s = await setup({ holdDelayMs: 10 });
  t.after(s.close);
  await s.residentAsksForTransfer();
  await tick();

  await s.tech(0).status('busy');
  await tick();
  await s.tech(1).status('no-answer');
  await tick();

  assert.deepEqual(s.roomActions, ['hold:true', 'mute:true', 'hold:false', 'mute:false', 'announce:unavailable']);
  const report = s.report();
  assert.equal(report.result, 'no technician');
  assert.ok(report.hold_ended_at);
  assert.ok(report.agent_unmuted_at);
});

test('hold music: not started if the search is already over, and can be switched off', async (t) => {
  // Resident hangs up before the music would have started.
  const gone = await setup({ holdDelayMs: 60 });
  t.after(gone.close);
  await gone.residentAsksForTransfer();
  await gone.room('participant-leave', { CallSid: RESIDENT });
  await new Promise((resolve) => setTimeout(resolve, 90));
  assert.deepEqual(gone.holds, []);

  // A technician accepted before the music would have started.
  const quick = await setup({ holdDelayMs: 150 });
  t.after(quick.close);
  await quick.residentAsksForTransfer();
  await quick.techAcceptsAndJoins(0);
  await new Promise((resolve) => setTimeout(resolve, 180));
  assert.deepEqual(quick.holds, []);
  assert.deepEqual(quick.roomActions, ['mute:true', 'announce:joined']);

  // HOLD_MUSIC_DELAY_SEC=off
  const off = await setup({ holdDelayMs: null });
  t.after(off.close);
  const reply = await off.residentAsksForTransfer();
  assert.match(reply.body.message, /keep talking with them/);
  await tick();
  assert.deepEqual(off.roomActions, []);
});

test('after connecting: Ava can drop out and the resident and technician carry on', async (t) => {
  const s = await setup();
  t.after(s.close);
  await s.residentAsksForTransfer();
  await s.techAcceptsAndJoins(0);

  await s.avaLeaves();
  assert.equal(s.roomEnded(), false);
  assert.equal(s.state.residentCalls.get(RESIDENT).agent.state, 'left');

  await s.tech(0).leaves();
  assert.equal(s.roomEnded(), true);
});

test('before any transfer: Ava ending the conversation ends the resident call', async (t) => {
  const s = await setup();
  t.after(s.close);
  await s.residentIsWithAva();
  await s.avaLeaves();
  assert.equal(s.roomEnded(), true);
});

// ---------------------------------------------------------------- technician outcomes

test('decline: first technician presses 2, the second is called and accepts', async (t) => {
  const s = await setup();
  t.after(s.close);
  await s.residentAsksForTransfer();

  await s.tech(0).answered();
  const declined = await s.tech(0).press('2');
  assert.match(declined.text, /<Hangup\/>/);
  await tick();
  assert.equal(s.techCalls().length, 2);
  assert.equal(s.techCalls()[1].to, '+15550000002');

  // The declined call finishing afterwards must not advance the search a second time.
  await s.tech(0).status('completed');
  await tick();
  assert.equal(s.techCalls().length, 2);

  await s.techAcceptsAndJoins(1);
  assert.equal(s.transfer().winner, 1);
  assert.deepEqual(s.outcomes(), ['declined', 'accepted']);
  assert.equal(s.report().connected_technician, '+15550000002');
});

test('no answer and busy: recorded as such and the next technician is tried', async (t) => {
  const s = await setup({ techNumbers: ['+15550000001', '+15550000002', '+15550000003'] });
  t.after(s.close);
  await s.residentAsksForTransfer();

  await s.tech(0).status('no-answer');
  await tick();
  assert.equal(s.techCalls().length, 2);
  await s.tech(1).status('busy');
  await tick();
  assert.equal(s.techCalls().length, 3);
  assert.deepEqual(s.outcomes(), ['no-answer', 'busy', null]);
});

test('voicemail (async AMD): brief starts on pickup, a machine result hangs up that technician only', async (t) => {
  const s = await setup();
  t.after(s.close);
  await s.residentAsksForTransfer();

  const prompt = await s.tech(0).answered();
  assert.match(prompt.text, /<Gather/, 'brief starts without waiting for detection');
  assert.equal(s.techCalls().length, 1);

  await s.tech(0).amd('machine_start');
  await tick();
  assert.deepEqual(s.outcomes(), ['voicemail', null]);
  assert.deepEqual(s.endedWith(s.tech(0).sid()), ['completed'], 'answered call is ended with completed');
  assert.equal(s.techCalls().length, 2, 'next technician is dialled');
  assert.equal(s.transfer().status, 'searching');
});

test('async AMD: human and unknown results change nothing, and a machine result after pressing 1 is ignored', async (t) => {
  const s = await setup();
  t.after(s.close);
  await s.residentAsksForTransfer();

  await s.tech(0).answered();
  await s.tech(0).amd('unknown');
  assert.deepEqual(s.outcomes(), [null, null]);
  assert.deepEqual(s.endedWith(s.tech(0).sid()), []);

  await s.tech(0).press('1');
  await tick();
  await s.tech(0).amd('machine_start');
  await tick();
  assert.deepEqual(s.outcomes(), ['accepted', null]);
  assert.deepEqual(s.endedWith(s.tech(0).sid()), [], 'winner is not hung up');
});

test('prompt repeats 3 times, then the technician is hung up and the next is tried', async (t) => {
  const s = await setup();
  t.after(s.close);
  await s.residentAsksForTransfer();

  const first = await s.tech(0).answered();
  assert.match(first.text, /<Redirect[^>]*>[^<]*attempt=2<\/Redirect>/);
  assert.match((await s.tech(0).answered(2)).text, /<Gather/);
  assert.match((await s.tech(0).answered(3)).text, /attempt=4/);
  const last = await s.tech(0).answered(4);
  assert.doesNotMatch(last.text, /<Gather/);
  assert.match(last.text, /<Hangup\/>/);
  await tick();
  assert.equal(s.techCalls().length, 2);
  assert.equal(s.outcomes()[0], 'declined');
});

test('accepted but dropped before reaching the room: counts as no technician and Ava is told', async (t) => {
  const s = await setup({ techNumbers: ['+15550000001'] });
  t.after(s.close);
  await s.residentAsksForTransfer();

  await s.tech(0).answered();
  await s.tech(0).press('1');
  await tick();
  await s.tech(0).status('completed');
  await tick();

  assert.equal(s.transfer().status, 'failed');
  assert.equal(s.report().result, 'no technician');
  assert.deepEqual(s.announcements(), ['unavailable']);
});

// ---------------------------------------------------------------- nobody available

test('all fail: Ava is still in the room, so she is told by an announcement and nobody is moved', async (t) => {
  const s = await setup();
  t.after(s.close);
  await s.residentAsksForTransfer();

  await s.tech(0).status('busy');
  await tick();
  await s.tech(1).status('no-answer');
  await tick();

  assert.equal(s.transfer().status, 'failed');
  assert.deepEqual(s.announcements(), ['unavailable']);
  assert.deepEqual(s.updates.filter((u) => u.sid === RESIDENT), [], 'resident call is not updated');
  assert.equal(s.agentLegs.length, 1, 'no second Ava');
  assert.equal(s.registered.length, 1, 'same ElevenLabs conversation');
  assert.equal(s.roomEnded(), false);

  const report = s.report();
  assert.equal(report.result, 'no technician');
  assert.equal(report.connected_technician, null);
  assert.equal(typeof report.resident_wait_seconds, 'number');
  assert.deepEqual(report.technicians.map((x) => x.outcome), ['busy', 'no-answer']);
  assert.equal(s.logs.filter((line) => line.includes('TRANSFER NO TECHNICIAN')).length, 1);

  // Ava asking again on the same call does not restart the search.
  const retry = await s.json('/tool/request-transfer', { call_sid: RESIDENT, summary: 'again' });
  assert.equal(retry.body.status, 'unavailable');
  assert.equal(s.techCalls().length, 2);
});

test('all fail after Ava dropped: she is brought back with the first-message override', async (t) => {
  const s = await setup();
  t.after(s.close);
  await s.residentAsksForTransfer();

  await s.avaLeaves();
  assert.equal(s.roomEnded(), false, 'the search is still running, so the resident keeps waiting');

  await s.tech(0).status('busy');
  await tick();
  await s.tech(1).status('no-answer');
  await tick();

  assert.equal(s.agentLegs.length, 2);
  assert.equal(s.agentLegs[1].label, 'ava-2');
  assert.deepEqual(s.announcements(), []);

  await s.avaJoins();
  assert.equal(s.registered.at(-1).firstMessage, FALLBACK_FIRST_MESSAGE);
  assert.equal(s.registered.at(-1).callSid, RESIDENT);
  assert.equal(s.roomEnded(), false);
});

// ---------------------------------------------------------------- resident hangs up

test('resident hangs up while waiting (inbound call): the room ending cancels the ringing technician', async (t) => {
  const s = await setup();
  t.after(s.close);
  await s.residentAsksForTransfer();
  await s.tech(0).status('ringing');

  // No status callback is configured on an inbound number; the conference tells us.
  await s.room('participant-leave', { CallSid: RESIDENT });
  await s.room('conference-end');
  assert.equal(s.transfer().status, 'cancelled');
  assert.deepEqual(s.endedWith(s.tech(0).sid()), ['canceled'], 'ringing call is ended with canceled');
  assert.ok(s.logs.some((line) => line.includes('CANCEL tech#0') && line.includes('resident hung up')));

  // The cancelled technician call ending must not dial the next technician.
  await s.tech(0).status('canceled');
  await tick();
  assert.equal(s.techCalls().length, 1);
  assert.deepEqual(s.announcements(), []);

  const report = s.report();
  assert.equal(report.result, 'resident hung up');
  assert.deepEqual(report.technicians.map((x) => x.outcome), ['canceled', 'not-called']);
  assert.equal(s.logs.filter((line) => line.includes('TRANSFER RESIDENT HUNG UP')).length, 1);

  // A technician who was already listening and presses 1 is told the resident left.
  const late = await s.tech(0).press('1');
  assert.match(late.text, /resident has hung up/);
  assert.doesNotMatch(late.text, /<Conference/);

  // And the tool no longer accepts that call.
  assert.equal((await s.json('/tool/request-transfer', { call_sid: RESIDENT, summary: 'x' })).status, 404);
});

test('resident hangs up while a technician is listening to the brief: that call is ended with completed', async (t) => {
  const s = await setup();
  t.after(s.close);
  await s.residentAsksForTransfer();
  await s.tech(0).answered();

  await s.hook('/twilio/resident-status', { CallSid: RESIDENT, CallStatus: 'completed' });
  await tick();
  assert.deepEqual(s.endedWith(s.tech(0).sid()), ['completed']);
  assert.equal(s.report().result, 'resident hung up');
});

// ---------------------------------------------------------------- parallel mode

test('parallel: winner cancels the others at once, canceled for ringing calls and completed for answered ones', async (t) => {
  const s = await setup({ dialMode: 'parallel', techNumbers: ['+15550000001', '+15550000002', '+15550000003'] });
  t.after(s.close);
  await s.residentAsksForTransfer();
  assert.equal(s.techCalls().length, 3, 'one separate call per technician');

  await s.tech(0).status('ringing'); //  still ringing when someone wins
  await s.tech(1).answered(); //         both of these are listening to the brief
  await s.tech(2).answered();
  const [a, b] = await Promise.all([s.tech(1).press('1'), s.tech(2).press('1')]);
  await tick();

  const winners = [a, b].filter((r) => /<Conference/.test(r.text));
  const losers = [a, b].filter((r) => /Another technician has already taken this call/.test(r.text));
  assert.equal(winners.length, 1, 'exactly one technician wins the lock');
  assert.equal(losers.length, 1);

  const winner = s.transfer().winner;
  const loser = winner === 1 ? 2 : 1;
  assert.deepEqual(s.endedWith(s.tech(0).sid()), ['canceled'], 'ringing technician: canceled');
  assert.deepEqual(s.endedWith(s.tech(loser).sid()), ['completed'], 'answered technician: completed');
  assert.deepEqual(s.endedWith(s.tech(winner).sid()), [], 'winner is not hung up');

  const expected = [];
  expected[0] = 'canceled';
  expected[winner] = 'accepted';
  expected[loser] = 'canceled';
  assert.deepEqual(s.outcomes(), expected);
  for (const i of [0, loser]) {
    assert.ok(s.logs.some((line) => line.includes(`CANCEL tech#${i}`) && line.includes('another technician accepted')), `cancellation of tech#${i} is logged`);
  }
});

test('cancel: a call picked up while we were cancelling is ended with completed, and Twilio errors are logged', async (t) => {
  const s = await setup({ dialMode: 'parallel', techNumbers: ['+15550000001', '+15550000002', '+15550000003'] });
  t.after(s.close);
  await s.residentAsksForTransfer();

  await s.tech(0).status('ringing');
  await s.tech(1).status('ringing');
  s.answeredMeanwhile.add(s.tech(0).sid()); // Twilio ignores "canceled": the call is already in progress
  s.failUpdatesFor.add(s.tech(1).sid()); //    Twilio rejects every update for this call

  await s.tech(2).answered();
  await s.tech(2).press('1');
  await tick();

  assert.deepEqual(s.endedWith(s.tech(0).sid()), ['canceled', 'completed']);
  assert.deepEqual(s.endedWith(s.tech(1).sid()), ['canceled', 'completed'], 'falls back to completed after an error');
  const errors = s.logs.filter((line) => line.includes('ERROR cancel tech#1'));
  assert.equal(errors.length, 2);
  assert.ok(errors[0].includes('Twilio error 21220'));
});

test('parallel: voicemail does not win, and "no technician" only after every technician has failed', async (t) => {
  const s = await setup({ dialMode: 'parallel' });
  t.after(s.close);
  await s.residentAsksForTransfer();

  await s.tech(0).answered();
  await s.tech(0).amd('machine_start');
  await tick();
  assert.equal(s.transfer().status, 'searching', 'the other technician can still accept');
  assert.deepEqual(s.announcements(), []);

  await s.tech(1).status('busy');
  await tick();
  assert.equal(s.transfer().status, 'failed');
  assert.deepEqual(s.outcomes(), ['voicemail', 'busy']);
  assert.deepEqual(s.announcements(), ['unavailable']);
});

// ---------------------------------------------------------------- reports and security

test('reports: HTML list and detail, local browser only', async (t) => {
  const s = await setup();
  t.after(s.close);

  assert.match((await s.get('/reports')).text, /No transfers yet/);

  await s.residentAsksForTransfer();
  await s.techAcceptsAndJoins(0);

  const list = await s.get('/reports');
  assert.equal(list.status, 200);
  assert.match(list.text, /<table>/);
  assert.ok(list.text.includes(RESIDENT_NUMBER));
  assert.ok(list.text.includes('connected to +15550000001'));
  assert.ok(list.text.includes(`/reports/${RESIDENT}`));

  const detail = await s.get(`/reports/${RESIDENT}`);
  assert.equal(detail.status, 200);
  assert.ok(detail.text.includes('Leak under the kitchen sink in unit 4B.'));
  assert.ok(detail.text.includes('accepted'));
  assert.ok(detail.text.includes('agent stays on the call'));

  assert.equal(JSON.parse((await s.get(`/reports/${RESIDENT}?format=json`)).text).result, 'connected');
  assert.equal((await s.get(`/reports/CA${'f'.repeat(32)}`)).status, 404);
  assert.equal((await s.get('/reports/..%2F.env')).status, 404);

  // A request that came through the tunnel carries forwarding headers and is refused.
  assert.equal((await s.get('/reports', { 'X-Forwarded-For': '203.0.113.9' })).status, 403);
  assert.equal((await s.get(`/reports/${RESIDENT}`, { 'X-Forwarded-Host': 'x.ngrok-free.dev' })).status, 403);
});

test('reports: summary text is HTML-escaped', async (t) => {
  const s = await setup();
  t.after(s.close);
  await s.residentIsWithAva();
  await s.json('/tool/request-transfer', { call_sid: RESIDENT, summary: '<script>alert(1)</script> & more' });
  await tick();

  const detail = await s.get(`/reports/${RESIDENT}`);
  assert.ok(!detail.text.includes('<script>alert(1)</script>'));
  assert.ok(detail.text.includes('&lt;script&gt;alert(1)&lt;/script&gt; &amp; more'));
});

// ---------------------------------------------------------------- transcripts

// An ElevenLabs conversation that began 30 seconds before the tool call.
function conversationFor(report, { status = 'done', turns } = {}) {
  const start = Math.floor(Date.parse(report.started_at) / 1000) - 30;
  return {
    conversation_id: 'conv_test1',
    status,
    metadata: { start_time_unix_secs: start, call_duration_secs: 60 },
    analysis: { transcript_summary: 'Resident reported a leak and was connected to a technician.' },
    conversation_initiation_client_data: { dynamic_variables: { call_sid: RESIDENT } },
    transcript: turns || [
      { role: 'agent', time_in_call_secs: 2, message: 'Hello, this is Ava. How can I help?' },
      { role: 'user', time_in_call_secs: 10, message: 'My kitchen sink is leaking.' },
      { role: 'agent', time_in_call_secs: 27, message: 'Let me find a technician for you.', tool_calls: [{ tool_name: 'request_transfer' }] },
      { role: 'user', time_in_call_secs: 45, message: 'Hi, this is Kofi from maintenance.', interrupted: true },
      { role: 'agent', time_in_call_secs: 50, message: 'Kofi, I have Kennedy from unit 4B on the line.' },
    ],
  };
}

test('transcript: fetched from ElevenLabs after the call and shown on the report with speakers and key moments', async (t) => {
  const s = await setup();
  t.after(s.close);
  await s.residentAsksForTransfer();
  await s.techAcceptsAndJoins(0);
  assert.equal(s.report().transcript, null, 'nothing is fetched while the call is running');

  s.elevenLabs.details = [conversationFor(s.report())];
  await s.room('participant-leave', { CallSid: RESIDENT });
  await s.room('conference-end');
  await tick();

  assert.deepEqual(s.elevenLabs.lookups.map((l) => l.callSid), [RESIDENT], 'looked up by the resident call SID');
  const transcript = s.report().transcript;
  assert.equal(transcript.status, 'final');
  assert.equal(transcript.conversations[0].conversation_id, 'conv_test1');
  assert.equal(transcript.conversations[0].entries.length, 6, '5 spoken lines and 1 tool call');
  assert.ok(s.logs.some((line) => line.includes('TRANSCRIPT') && line.includes('final')));

  const detail = (await s.get(`/reports/${RESIDENT}`)).text;
  assert.ok(detail.includes('<h2>Transcript</h2>'));
  assert.ok(detail.includes('ElevenLabs summary:</strong> Resident reported a leak'));
  const order = [
    'My kitchen sink is leaking.',
    'called request_transfer',
    'Ava asked for a technician (request_transfer)',
    'Technician +15550000001 joined the call',
    'Ava muted: she keeps listening but nobody hears her',
    'Hi, this is Kofi from maintenance.',
    'Kofi, I have Kennedy from unit 4B on the line.',
  ].map((text) => detail.indexOf(text));
  assert.ok(order.every((index) => index > 0), 'every line and marker is on the page');
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'lines and key moments are in time order');

  // Before the technician joins the caller side is the resident; afterwards it could be either person.
  assert.match(detail, /<td>Resident<\/td><td class="text">My kitchen sink is leaking\.<\/td>/);
  assert.match(detail, /<td>Resident or technician<\/td><td class="text">Hi, this is Kofi from maintenance\. <em>\(interrupted\)<\/em><\/td>/);
  assert.match(detail, /<td>Ava<\/td><td class="text">Hello, this is Ava\. How can I help\?<\/td>/);
  // Whatever the model produced after she was muted was never heard on the call.
  assert.match(detail, /<tr class="agent unheard"><td>[^<]*<\/td><td>Ava \(muted, not heard\)<\/td><td class="text">Kofi, I have Kennedy from unit 4B on the line\.<\/td>/);

  assert.ok((await s.get('/reports')).text.includes('5 lines'));
  assert.equal(s.elevenLabs.lookups.length, 1, 'a final transcript is not fetched again');
});

test('transcript: opening the report during the call shows what there is so far and refreshes on reload', async (t) => {
  const s = await setup();
  t.after(s.close);
  await s.residentAsksForTransfer();

  s.elevenLabs.details = [conversationFor(s.report(), {
    status: 'in-progress',
    turns: [{ role: 'agent', time_in_call_secs: 2, message: 'Hello, this is Ava.' }],
  })];
  const during = (await s.get(`/reports/${RESIDENT}`)).text;
  assert.ok(during.includes('Hello, this is Ava.'));
  assert.ok(during.includes('still in progress'));
  assert.equal(s.report().transcript.status, 'partial');

  s.elevenLabs.details = [conversationFor(s.report())];
  const after = (await s.get(`/reports/${RESIDENT}`)).text;
  assert.ok(after.includes('My kitchen sink is leaking.'));
  assert.ok(!after.includes('still in progress'));
  assert.equal(s.elevenLabs.lookups.length, 2);
});

test('transcript: nothing found yet, and an ElevenLabs error, are both explained on the page', async (t) => {
  const s = await setup();
  t.after(s.close);
  await s.residentAsksForTransfer();

  assert.ok((await s.get(`/reports/${RESIDENT}`)).text.includes('ElevenLabs has no conversation for this call yet'));
  assert.equal(s.report().transcript.status, 'pending');

  s.elevenLabs.details = [conversationFor(s.report(), { status: 'in-progress' })];
  await s.get(`/reports/${RESIDENT}`);
  s.flags.failConversations = true;
  const failed = (await s.get(`/reports/${RESIDENT}`)).text;
  assert.ok(failed.includes('Could not fetch the transcript from ElevenLabs: ElevenLabs HTTP 500'));
  assert.ok(failed.includes('My kitchen sink is leaking.'), 'lines fetched earlier are kept');
  assert.equal(s.report().transcript.status, 'unavailable');
});

test('transcript: still fetched for an old report after the server has restarted, and text is HTML-escaped', async (t) => {
  const s = await setup();
  t.after(s.close);
  await s.residentAsksForTransfer();
  await s.techAcceptsAndJoins(0);
  const saved = s.report();

  // A fresh server with the same reports folder and no memory of the call.
  const details = [conversationFor(saved, { turns: [{ role: 'user', time_in_call_secs: 5, message: '<b>water</b> & more' }] })];
  const restarted = createApp({ config: s.config, client: {}, registerCall: async () => '', conversations: { forCall: async () => details }, logger: () => {} });
  const server = await new Promise((resolve) => {
    const listening = restarted.app.listen(0, () => resolve(listening));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const page = await (await fetch(`http://localhost:${server.address().port}/reports/${RESIDENT}`)).text();
  assert.ok(page.includes('&lt;b&gt;water&lt;/b&gt; &amp; more'));
  assert.ok(!page.includes('<b>water</b>'));

  const onDisk = s.report();
  assert.equal(onDisk.transcript.status, 'final');
  assert.equal(onDisk.result, 'connected', 'the rest of the saved report is untouched');
  assert.equal(onDisk.connected_technician, saved.connected_technician);
});

test('security: bad Twilio signature is 403, tool endpoint needs X-Tool-Secret and not a Twilio signature', async (t) => {
  const s = await setup();
  t.after(s.close);

  const forged = await s.hook('/twilio/inbound', { CallSid: RESIDENT, From: RESIDENT_NUMBER, To: TWILIO_NUMBER }, { signature: FORGED });
  assert.equal(forged.status, 403);
  assert.equal(s.state.residentCalls.size, 0);

  for (const urlPath of ['/twilio/agent-leg', `/tech/amd?resident=${RESIDENT}&tech=0`, `/conference/status?resident=${RESIDENT}`]) {
    assert.equal((await s.hook(urlPath, { CallSid: RESIDENT }, { signature: FORGED })).status, 403, urlPath);
  }
  assert.equal(s.registered.length, 0);

  assert.equal((await s.json('/tool/request-transfer', { call_sid: RESIDENT, summary: 'x' }, null)).status, 401);
  assert.equal((await s.json('/tool/request-transfer', { call_sid: RESIDENT, summary: 'x' }, 'wrong-secret')).status, 401);
  assert.equal((await s.json('/tool/request-transfer', { call_sid: 'nope', summary: 'x' })).status, 400);
  assert.equal((await s.json('/tool/request-transfer', { call_sid: RESIDENT, summary: 'x' })).status, 404, 'unknown call');
});
