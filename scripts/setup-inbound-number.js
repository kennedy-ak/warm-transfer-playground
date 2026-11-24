'use strict';

// Usage:
//   node scripts/setup-inbound-number.js             point the Twilio number at this server
//   node scripts/setup-inbound-number.js --restore   put the number back the way it was
//
// Changes ONE setting on TWILIO_PHONE_NUMBER: where Twilio sends incoming calls
// ("A call comes in"). The previous value is saved first, in .inbound-number-backup.json,
// so --restore can undo it. Nothing else on the number is touched.
const fs = require('fs');
const path = require('path');
const { envPath, setEnvValue } = require('./env-file');

require('dotenv').config({ path: envPath, quiet: true });

const twilio = require('twilio');

const backupPath = path.join(__dirname, '..', '.inbound-number-backup.json');
const restore = process.argv.includes('--restore');

const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER } = process.env;
const publicBaseUrl = (process.env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');

if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_PHONE_NUMBER || !/^https:\/\//.test(publicBaseUrl)) {
  console.error('TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER and an https PUBLIC_BASE_URL must be set in .env first.');
  process.exit(1);
}

const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const ourUrl = `${publicBaseUrl}/twilio/inbound`;
const describe = (url) => url || '(nothing)';

(async () => {
  const [number] = await client.incomingPhoneNumbers.list({ phoneNumber: TWILIO_PHONE_NUMBER, limit: 1 });
  if (!number) {
    console.error(`${TWILIO_PHONE_NUMBER} is not a number on this Twilio account.`);
    process.exit(1);
  }

  if (restore) {
    if (!fs.existsSync(backupPath)) {
      console.error('No backup file found, so there is nothing to restore.');
      process.exit(1);
    }
    const backup = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
    await client.incomingPhoneNumbers(number.sid).update({
      voiceUrl: backup.voiceUrl || '',
      voiceMethod: backup.voiceMethod || 'POST',
      voiceApplicationSid: backup.voiceApplicationSid || '',
    });
    fs.unlinkSync(backupPath);
    console.log(`Restored ${TWILIO_PHONE_NUMBER}: incoming calls go to ${describe(backup.voiceUrl || backup.voiceApplicationSid)} again.`);
    return;
  }

  if (number.voiceUrl === ourUrl) {
    console.log(`${TWILIO_PHONE_NUMBER} already sends incoming calls to ${ourUrl}. Nothing to do.`);
    return;
  }

  // Keep the first backup: running this twice (for example after the ngrok URL changed)
  // must not overwrite the original settings with our own.
  const ours = /\/twilio\/inbound$/.test(number.voiceUrl || '');
  if (!fs.existsSync(backupPath) && !ours) {
    fs.writeFileSync(backupPath, `${JSON.stringify({
      phoneNumber: TWILIO_PHONE_NUMBER,
      savedAt: new Date().toISOString(),
      voiceUrl: number.voiceUrl || '',
      voiceMethod: number.voiceMethod || 'POST',
      voiceApplicationSid: number.voiceApplicationSid || '',
    }, null, 2)}\n`);
    console.log(`Saved the current setting (${describe(number.voiceUrl || number.voiceApplicationSid)}) to .inbound-number-backup.json`);
    // Callers who are not on the allow-list can be handed to whatever was there before.
    if (number.voiceUrl) setEnvValue('INBOUND_PASS_THROUGH_URL', number.voiceUrl);
  }

  await client.incomingPhoneNumbers(number.sid).update({ voiceUrl: ourUrl, voiceMethod: 'POST', voiceApplicationSid: '' });
  console.log(`${TWILIO_PHONE_NUMBER} now sends incoming calls to ${ourUrl}`);
  console.log('Undo with: node scripts/setup-inbound-number.js --restore');
})().catch((err) => {
  console.error(`Twilio rejected the request: ${err.code ? `error ${err.code}: ` : ''}${err.message}`);
  process.exit(1);
});
