'use strict';

// Checks the register-call request we send, against a local stand-in for the ElevenLabs API.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createRegisterCall, createConversationApi } = require('../src/elevenlabs');

const TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Stream url="wss://agent.example.test"/></Connect></Response>';

async function stubApi(respond) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      seen.push({ url: req.url, headers: req.headers, body: JSON.parse(raw) });
      respond(res);
    });
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const config = {
    elevenLabsApiBase: `http://localhost:${server.address().port}`,
    elevenLabsApiKey: 'test-key',
    elevenLabsAgentId: 'agent_test',
  };
  return { seen, registerCall: createRegisterCall(config), close: () => new Promise((resolve) => server.close(resolve)) };
}

test('register-call request shape, and raw XML response', async (t) => {
  const api = await stubApi((res) => res.setHeader('Content-Type', 'application/xml').end(TWIML));
  t.after(api.close);

  const twiml = await api.registerCall({ fromNumber: '+15559990000', toNumber: '+15551110000', direction: 'outbound', callSid: 'CA123' });
  assert.equal(twiml, TWIML);
  assert.equal(api.seen[0].url, '/v1/convai/twilio/register-call');
  assert.equal(api.seen[0].headers['xi-api-key'], 'test-key');
  assert.deepEqual(api.seen[0].body, {
    agent_id: 'agent_test',
    from_number: '+15559990000',
    to_number: '+15551110000',
    direction: 'outbound',
    conversation_initiation_client_data: { dynamic_variables: { call_sid: 'CA123', parent_call_sid: 'CA123' } },
  });
});

test('first-message override and JSON-encoded string response', async (t) => {
  const api = await stubApi((res) => res.setHeader('Content-Type', 'application/json').end(JSON.stringify(TWIML)));
  t.after(api.close);

  const twiml = await api.registerCall({ fromNumber: '+1555', toNumber: '+1666', direction: 'inbound', callSid: 'CA123', firstMessage: 'Hello again' });
  assert.equal(twiml, TWIML);
  assert.deepEqual(api.seen[0].body.conversation_initiation_client_data, {
    dynamic_variables: { call_sid: 'CA123', parent_call_sid: 'CA123' },
    conversation_config_override: { agent: { first_message: 'Hello again' } },
  });
});

test('API error is thrown with status and body', async (t) => {
  const api = await stubApi((res) => {
    res.statusCode = 401;
    res.end('{"detail":"invalid api key"}');
  });
  t.after(api.close);

  await assert.rejects(
    api.registerCall({ fromNumber: '+1555', toNumber: '+1666', direction: 'inbound', callSid: 'CA123' }),
    /register-call HTTP 401.*invalid api key/
  );
});

// ---------------------------------------------------------------- conversations (transcripts)

const CALL = 'CA' + 'a'.repeat(32);

// A stand-in for GET /v1/convai/conversations and /v1/convai/conversations/{id}.
async function stubConversations({ rejectFilter = false } = {}) {
  const seen = [];
  const details = {
    conv_ours: { conversation_id: 'conv_ours', status: 'done', transcript: [], conversation_initiation_client_data: { dynamic_variables: { call_sid: CALL } } },
    conv_other: { conversation_id: 'conv_other', status: 'done', transcript: [], conversation_initiation_client_data: { dynamic_variables: { call_sid: 'CA' + 'f'.repeat(32) } } },
  };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://stub');
    seen.push({ path: url.pathname, query: Object.fromEntries(url.searchParams), key: req.headers['xi-api-key'] });
    res.setHeader('Content-Type', 'application/json');
    if (url.pathname === '/v1/convai/conversations') {
      if (rejectFilter && url.searchParams.has('dynamic_variable_filter')) {
        res.statusCode = 422;
        return res.end('{"detail":"unknown parameter"}');
      }
      return res.end(JSON.stringify({ conversations: [{ conversation_id: 'conv_ours' }, { conversation_id: 'conv_other' }], has_more: false }));
    }
    const detail = details[url.pathname.split('/').pop()];
    if (!detail) {
      res.statusCode = 404;
      return res.end('{"detail":"not found"}');
    }
    res.end(JSON.stringify(detail));
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const api = createConversationApi({
    elevenLabsApiBase: `http://localhost:${server.address().port}`,
    elevenLabsApiKey: 'test-key',
    elevenLabsAgentId: 'agent_test',
  });
  return { seen, api, close: () => new Promise((resolve) => server.close(resolve)) };
}

test('conversations for a call: filtered by the call_sid dynamic variable, and only real matches are kept', async (t) => {
  const stub = await stubConversations();
  t.after(stub.close);

  const found = await stub.api.forCall(CALL, 1700000000);
  assert.deepEqual(found.map((c) => c.conversation_id), ['conv_ours'], 'a conversation for another call is dropped');

  const list = stub.seen[0];
  assert.equal(list.path, '/v1/convai/conversations');
  assert.equal(list.key, 'test-key');
  assert.deepEqual(list.query, {
    agent_id: 'agent_test',
    page_size: '20',
    call_start_after_unix: '1700000000',
    dynamic_variable_filter: `call_sid:eq:${CALL}`,
  });
  assert.deepEqual(stub.seen.slice(1).map((r) => r.path), ['/v1/convai/conversations/conv_ours', '/v1/convai/conversations/conv_other']);
});

test('conversations for a call: if the filter is rejected, recent conversations are listed and matched instead', async (t) => {
  const stub = await stubConversations({ rejectFilter: true });
  t.after(stub.close);

  const found = await stub.api.forCall(CALL, 1700000000);
  assert.deepEqual(found.map((c) => c.conversation_id), ['conv_ours']);
  assert.equal(stub.seen[1].path, '/v1/convai/conversations');
  assert.equal('dynamic_variable_filter' in stub.seen[1].query, false, 'second attempt has no filter');
});
