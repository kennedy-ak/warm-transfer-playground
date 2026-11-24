'use strict';

require('dotenv').config({ quiet: true });

const twilio = require('twilio');
const { loadConfig } = require('./src/config');
const { createRegisterCall, createConversationApi } = require('./src/elevenlabs');
const { createApp } = require('./src/app');

let config;
try {
  config = loadConfig();
} catch (err) {
  console.error(`Config error: ${err.message}`);
  process.exit(1);
}

const client = twilio(config.twilioAccountSid, config.twilioAuthToken);
const { app } = createApp({
  config,
  client,
  registerCall: createRegisterCall(config),
  conversations: createConversationApi(config),
});

app.listen(config.port, () => {
  console.log(`Warm-transfer playground listening on http://localhost:${config.port}`);
  console.log(`  public URL  : ${config.publicBaseUrl}`);
  console.log(`  dial mode   : ${config.dialMode}`);
  console.log(`  technicians : ${config.techNumbers.join(', ')}`);
  console.log(`  ring timeout: ${config.ringTimeoutSec}s`);
  console.log(`  transfer    : agent stays on the call (Ava leg via TwiML App ${config.agentAppSid})`);
  console.log(`  hold music  : ${config.holdDelayMs === null ? 'off' : `starts ${config.holdDelayMs / 1000}s after the tool call`}`);
  console.log(`  callers     : ${config.inboundAllowedCallers.length ? `only ${config.inboundAllowedCallers.join(', ')}` : 'anyone who rings the number'}`);
  console.log(`  reports     : http://localhost:${config.port}/reports`);
  console.log(`To test, call ${config.twilioPhoneNumber} from a phone.`);
});
