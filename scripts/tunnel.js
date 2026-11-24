'use strict';

// Usage: npm run tunnel
// Opens an ngrok tunnel to the local server and writes its public URL into
// PUBLIC_BASE_URL in .env. Leave it running; start (or restart) the server after it.
const { envPath, setEnvValue } = require('./env-file');

require('dotenv').config({ path: envPath, quiet: true });

const ngrok = require('@ngrok/ngrok');

const port = Number(process.env.PORT) || 3000;
const authtoken = (process.env.NGROK_AUTHTOKEN || '').trim();

if (!authtoken) {
  console.error('NGROK_AUTHTOKEN is empty. Copy your token from https://dashboard.ngrok.com/get-started/your-authtoken into .env.');
  process.exit(1);
}

(async () => {
  const listener = await ngrok.forward({ addr: port, authtoken });
  const url = listener.url();
  const changed = setEnvValue('PUBLIC_BASE_URL', url);

  console.log(`ngrok tunnel: ${url} -> http://localhost:${port}`);
  if (changed) {
    console.log('PUBLIC_BASE_URL in .env was updated. Because the URL changed:');
    console.log('  1. run "node scripts/setup-agent-app.js" so Twilio reaches Ava\'s leg at the new URL');
    console.log('  2. run "node scripts/setup-inbound-number.js" so incoming calls reach the new URL');
    console.log('  3. restart the server');
    console.log('  4. update the tool URL in ElevenLabs');
  } else {
    console.log('PUBLIC_BASE_URL in .env already had this URL.');
  }
  console.log(`ElevenLabs tool URL: ${url}/tool/request-transfer`);
  console.log('Leave this running. Press Ctrl+C to close the tunnel.');

  // Keep the process (and with it the tunnel) alive.
  setInterval(() => {}, 1 << 30);
  process.on('SIGINT', async () => {
    await ngrok.disconnect();
    process.exit(0);
  });
})().catch((err) => {
  console.error(`Could not start the ngrok tunnel: ${err.message}`);
  process.exit(1);
});
