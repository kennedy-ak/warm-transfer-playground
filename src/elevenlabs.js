'use strict';

// Wraps the ElevenLabs register-call API. It hands back TwiML (<Connect><Stream>)
// that we pass straight to Twilio; Twilio stays in control of the call.
function createRegisterCall(config) {
  return async function registerCall({ fromNumber, toNumber, direction, callSid, firstMessage }) {
    // Both names carry the resident's Twilio call SID. The agent's tools may use either;
    // ElevenLabs refuses to start a conversation if a tool needs a variable we did not send.
    const clientData = { dynamic_variables: { call_sid: callSid, parent_call_sid: callSid } };
    if (firstMessage) {
      // Only honoured if "first message" overrides are enabled in the agent's security settings.
      clientData.conversation_config_override = { agent: { first_message: firstMessage } };
    }

    const response = await fetch(`${config.elevenLabsApiBase}/v1/convai/twilio/register-call`, {
      method: 'POST',
      headers: { 'xi-api-key': config.elevenLabsApiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent_id: config.elevenLabsAgentId,
        from_number: fromNumber,
        to_number: toNumber,
        direction,
        conversation_initiation_client_data: clientData,
      }),
      // Twilio gives a webhook 15s; fail before that so we can still answer with a spoken error.
      signal: AbortSignal.timeout(10_000),
    });

    const text = (await response.text()).trim();
    if (!response.ok) {
      throw new Error(`register-call HTTP ${response.status}: ${text.slice(0, 300)}`);
    }

    // The API reference types the body as a string, so tolerate both raw XML and a JSON-encoded string.
    const twiml = text.startsWith('"') ? JSON.parse(text) : text;
    if (!twiml.includes('<Response')) {
      throw new Error(`register-call returned something that is not TwiML: ${text.slice(0, 200)}`);
    }
    return twiml;
  };
}

// Reads conversations (and their transcripts) back from ElevenLabs.
function createConversationApi(config) {
  async function api(pathAndQuery) {
    const response = await fetch(`${config.elevenLabsApiBase}${pathAndQuery}`, {
      headers: { 'xi-api-key': config.elevenLabsApiKey },
      signal: AbortSignal.timeout(8_000),
    });
    const text = await response.text();
    if (!response.ok) {
      throw Object.assign(new Error(`ElevenLabs HTTP ${response.status}: ${text.slice(0, 200)}`), { status: response.status });
    }
    return JSON.parse(text);
  }

  function list(callSid, startedAfterUnix, withFilter) {
    const query = new URLSearchParams({
      agent_id: config.elevenLabsAgentId,
      page_size: '20',
      call_start_after_unix: String(startedAfterUnix),
    });
    // Every call is registered with the dynamic variable call_sid = the resident's Twilio call SID.
    if (withFilter) query.set('dynamic_variable_filter', `call_sid:eq:${callSid}`);
    return api(`/v1/convai/conversations?${query}`);
  }

  return {
    // Full details (including the transcript) of every conversation that belongs to one
    // resident call. Usually one; two if Ava had to be brought back during the call.
    async forCall(callSid, startedAfterUnix) {
      let page;
      try {
        page = await list(callSid, startedAfterUnix, true);
      } catch (err) {
        if (!(err.status >= 400 && err.status < 500) || err.status === 401) throw err;
        // The filter was not accepted: list recent conversations and pick ours out below.
        page = await list(callSid, startedAfterUnix, false);
      }

      const details = [];
      for (const item of page.conversations || []) {
        const detail = await api(`/v1/convai/conversations/${encodeURIComponent(item.conversation_id)}`);
        // Never trust the filter alone: only keep conversations that really carry this call SID.
        const variables = (detail.conversation_initiation_client_data || {}).dynamic_variables || {};
        if (variables.call_sid === callSid) details.push(detail);
      }
      return details;
    },
  };
}

module.exports = { createRegisterCall, createConversationApi };
