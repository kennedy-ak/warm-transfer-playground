'use strict';

// One JSON file per resident call in reports/, plus the HTML views for GET /reports.

const fs = require('fs');
const path = require('path');

const CALL_SID_RE = /^CA[0-9a-f]{32}$/i;

function createReportStore(dir) {
  fs.mkdirSync(dir, { recursive: true });

  function read(file) {
    try {
      return JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    } catch {
      return null;
    }
  }

  return {
    dir,
    save(report) {
      fs.writeFileSync(path.join(dir, `${report.resident_call_sid}.json`), `${JSON.stringify(report, null, 2)}\n`);
    },
    // The SID check also stops anything like "../.env" being read through /reports/:sid.
    get(sid) {
      return CALL_SID_RE.test(sid) ? read(`${sid}.json`) : null;
    },
    list() {
      return fs.readdirSync(dir)
        .filter((file) => CALL_SID_RE.test(file.replace(/\.json$/, '')) && file.endsWith('.json'))
        .map(read)
        .filter(Boolean)
        .sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)));
    },
  };
}

// Turns the in-memory transfer into the record that is saved and shown.
function buildReport(t, dialMode) {
  const start = t.startedAt;
  const iso = (ms) => (ms ? new Date(ms).toISOString() : null);
  const after = (ms) => (ms ? Math.round((ms - start) / 100) / 10 : null);
  const winner = t.winner === null ? null : t.techs[t.winner];

  return {
    resident_call_sid: t.residentCallSid,
    resident_number: t.residentNumber,
    direction: t.direction,
    summary: t.summary,
    dial_mode: dialMode,
    // This branch keeps Ava in the room; on main she leaves when the technician joins.
    transfer_style: 'agent stays on the call',
    started_at: iso(start),
    finished_at: iso(t.finishedAt),
    // null while the search is still running
    result: t.result,
    connected_technician: t.result === 'connected' && winner ? winner.number : null,
    resident_wait_seconds: after(t.finishedAt),
    // The resident hears hold music while technicians are being called.
    hold_started_at: iso(t.holdStartedAt),
    hold_ended_at: iso(t.holdEndedAt),
    // Ava is muted (listening, not heard) during the hold and while the technician is in the room.
    agent_muted_at: iso(t.agentMutedAt),
    agent_unmuted_at: iso(t.agentUnmutedAt),
    // Filled in from ElevenLabs after the call (see buildTranscript).
    transcript: t.transcript || null,
    technicians: t.techs.map((tech) => ({
      number: tech.number,
      call_sid: tech.callSid,
      outcome: tech.outcome || (tech.dialledAt ? 'calling' : 'not-called'),
      detail: tech.detail,
      answered_by: tech.answeredBy || null,
      dialled_at: iso(tech.dialledAt),
      ringing_at: iso(tech.ringingAt),
      answered_at: iso(tech.answeredAt),
      pressed_1_at: iso(tech.pressedAt),
      outcome_at: iso(tech.outcomeAt),
      seconds_from_tool_call: {
        dialled: after(tech.dialledAt),
        ringing: after(tech.ringingAt),
        answered: after(tech.answeredAt),
        pressed_1: after(tech.pressedAt),
        outcome: after(tech.outcomeAt),
      },
    })),
  };
}

// Turns ElevenLabs conversation details into the transcript stored with a report.
function buildTranscript(details, fetchedAt = Date.now()) {
  const conversations = [...details]
    .sort((a, b) => (a.metadata?.start_time_unix_secs || 0) - (b.metadata?.start_time_unix_secs || 0))
    .map((detail) => {
      const startMs = (detail.metadata?.start_time_unix_secs || 0) * 1000;
      const at = (seconds) => (startMs ? new Date(startMs + seconds * 1000).toISOString() : null);
      const entries = [];
      for (const turn of detail.transcript || []) {
        const seconds = turn.time_in_call_secs || 0;
        if (turn.message) {
          entries.push({ role: turn.role === 'agent' ? 'agent' : 'user', text: turn.message, seconds, at: at(seconds), interrupted: Boolean(turn.interrupted) });
        }
        for (const call of turn.tool_calls || []) {
          entries.push({ role: 'tool', text: `called ${call.tool_name}`, seconds, at: at(seconds), interrupted: false });
        }
      }
      return {
        conversation_id: detail.conversation_id,
        status: detail.status,
        started_at: startMs ? new Date(startMs).toISOString() : null,
        duration_seconds: detail.metadata?.call_duration_secs ?? null,
        summary: detail.analysis?.transcript_summary || null,
        entries,
      };
    });

  // ElevenLabs finishes a transcript ("done") a little after the conversation ends.
  const settled = conversations.length > 0 && conversations.every((c) => c.status === 'done' || c.status === 'failed');
  return {
    status: settled ? 'final' : conversations.length ? 'partial' : 'pending',
    fetched_at: new Date(fetchedAt).toISOString(),
    error: null,
    conversations,
  };
}

// ---------------------------------------------------------------- HTML

const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const dash = (value) => (value === null || value === undefined || value === '' ? '-' : esc(value));
const seconds = (value) => (value === null || value === undefined ? '-' : `${esc(value)}s`);
const time = (isoString) => (isoString ? esc(isoString.replace('T', ' ').replace(/\.\d+Z$/, ' UTC')) : '-');

function resultLabel(report) {
  if (!report.result) return 'searching';
  if (report.result === 'connected') return `connected to ${esc(report.connected_technician)}`;
  return esc(report.result);
}

function page(title, body) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  body { font: 14px/1.5 system-ui, sans-serif; margin: 24px; color: #1a1a1a; background: #fff; }
  h1 { font-size: 20px; }
  h2 { font-size: 16px; margin-top: 28px; }
  .wrap { overflow-x: auto; }
  table { border-collapse: collapse; }
  th, td { border: 1px solid #ccc; padding: 6px 10px; text-align: left; vertical-align: top; white-space: nowrap; }
  td.text { white-space: normal; min-width: 240px; }
  th { background: #f2f2f2; }
  pre { background: #f6f6f6; padding: 12px; overflow-x: auto; }
  table.transcript td.text { min-width: 420px; max-width: 760px; }
  tr.agent td { background: #f3f8ff; }
  tr.tool td { color: #666; font-style: italic; }
  tr.unheard td { color: #999; background: #f7f7f7; text-decoration: line-through; }
  tr.marker td { background: #fff6d6; font-weight: 600; }
  .note { color: #8a5a00; }
  .connected { color: #116611; font-weight: 600; }
  .other { color: #a33; font-weight: 600; }
</style>
</head>
<body>
${body}
</body>
</html>`;
}

function renderList(reports) {
  const rows = reports.map((r) => `<tr>
  <td>${time(r.started_at)}</td>
  <td>${dash(r.resident_number)}</td>
  <td>${dash(r.dial_mode)}</td>
  <td>${r.transfer_style ? 'stays' : 'leaves'}</td>
  <td class="${r.result === 'connected' ? 'connected' : 'other'}">${resultLabel(r)}</td>
  <td>${seconds(r.resident_wait_seconds)}</td>
  <td>${(r.technicians || []).filter((tech) => tech.outcome !== 'not-called').map((tech) => `${esc(tech.number)}: ${esc(tech.outcome)}`).join('<br>') || '-'}</td>
  <td class="text">${dash(r.summary)}</td>
  <td><a href="/reports/${esc(r.resident_call_sid)}">${transcriptLineCount(r) ? `${transcriptLineCount(r)} lines` : 'open'}</a></td>
  <td><a href="/reports/${esc(r.resident_call_sid)}">${esc(r.resident_call_sid)}</a></td>
</tr>`);

  return page('Transfer reports', `<h1>Transfer reports (${reports.length})</h1>
${reports.length === 0 ? '<p>No transfers yet. A report appears here as soon as Ava calls request_transfer.</p>' : `<div class="wrap"><table>
<tr><th>Started</th><th>Resident</th><th>Mode</th><th>Agent</th><th>Result</th><th>Resident waited</th><th>Technicians</th><th>Summary</th><th>Transcript</th><th>Call SID</th></tr>
${rows.join('\n')}
</table></div>`}`);
}

// ElevenLabs' own tools. They are not the transfer request, so they cannot be used to line up the clocks.
const SYSTEM_TOOLS = /called (skip_turn|end_call|language_detection|transfer_to_number|transfer_to_agent|play_keypad_touch_tone|voicemail_detection)\b/;

function transcriptLineCount(r) {
  return ((r.transcript && r.transcript.conversations) || []).reduce((n, c) => n + c.entries.filter((e) => e.role !== 'tool').length, 0);
}

// The conversation as ElevenLabs heard it, with the transfer's key moments placed in between.
function renderTranscript(r) {
  const transcript = r.transcript;
  if (!transcript) {
    return '<h2>Transcript</h2>\n<p>Not fetched yet. It is collected from ElevenLabs shortly after the call ends. Reload this page to try again.</p>';
  }

  const notes = [];
  if (transcript.status === 'partial') notes.push('The call is still in progress, or ElevenLabs is still processing it. Reload this page for the latest.');
  if (transcript.status === 'pending') notes.push('ElevenLabs has no conversation for this call yet. Reload this page in a few seconds.');
  if (transcript.status === 'unavailable') notes.push(`Could not fetch the transcript from ElevenLabs: ${esc(transcript.error)}`);

  // ElevenLabs' clock and this server's clock can be a minute or more apart, so its
  // timestamps cannot be compared with ours as they are. One moment is known on both
  // clocks: when Ava called the transfer tool. ElevenLabs says how many seconds into the
  // conversation that was, and the report's started_at is when the server received it.
  // Every line is placed relative to that.
  const first = transcript.conversations[0];
  const toolCall = first && first.entries.find((e) => e.role === 'tool' && !SYSTEM_TOOLS.test(e.text));
  const clockOffsetMs = toolCall && r.started_at && first.started_at
    ? Date.parse(r.started_at) - toolCall.seconds * 1000 - Date.parse(first.started_at)
    : 0;
  const onOurClock = (conversation, entry) => {
    const startMs = Date.parse(conversation.started_at);
    return Number.isFinite(startMs) ? new Date(startMs + clockOffsetMs + entry.seconds * 1000).toISOString() : entry.at;
  };

  const rows = [];
  transcript.conversations.forEach((conversation, index) => {
    if (index > 0) rows.push({ at: onOurClock(conversation, { seconds: 0 }), role: 'marker', text: 'Ava rejoined the call (new ElevenLabs conversation)' });
    rows.push(...conversation.entries.map((entry) => ({ ...entry, at: onOurClock(conversation, entry) })));
  });
  rows.push({ at: r.started_at, role: 'marker', text: 'Ava asked for a technician (request_transfer)' });
  const joinedAt = r.result === 'connected' ? r.finished_at : null;
  if (r.result && r.finished_at) {
    const ending = {
      connected: `Technician ${r.connected_technician} joined the call`,
      'no technician': 'No technician was available',
      'resident hung up': 'Resident hung up',
    }[r.result];
    if (ending) rows.push({ at: r.finished_at, role: 'marker', text: ending });
  }
  if (r.hold_started_at) rows.push({ at: r.hold_started_at, role: 'marker', text: 'Resident put on hold with music' });
  if (r.hold_ended_at) rows.push({ at: r.hold_ended_at, role: 'marker', text: 'Resident taken off hold' });
  if (r.agent_muted_at) rows.push({ at: r.agent_muted_at, role: 'marker', text: 'Ava muted: she keeps listening but nobody hears her' });
  if (r.agent_unmuted_at) rows.push({ at: r.agent_unmuted_at, role: 'marker', text: 'Ava unmuted' });
  rows.sort((a, b) => String(a.at || '9').localeCompare(String(b.at || '9')));

  // Anything the model "said" while its leg was muted was never heard on the call.
  const whileMuted = (row) => Boolean(r.agent_muted_at && row.at && row.at >= r.agent_muted_at && (!r.agent_unmuted_at || row.at < r.agent_unmuted_at));

  // ElevenLabs hears one audio stream, so once the technician is in the room it
  // cannot tell the resident and the technician apart.
  const speaker = (row) => {
    if (row.role === 'agent') return whileMuted(row) ? 'Ava (muted, not heard)' : 'Ava';
    if (row.role === 'tool') return 'Ava (tool)';
    if (joinedAt && row.at && row.at >= joinedAt && r.transfer_style) return 'Resident or technician';
    return 'Resident';
  };

  const body = rows.map((row) => (row.role === 'marker'
    ? `<tr class="marker"><td>${row.at ? esc(row.at.slice(11, 19)) : '-'}</td><td colspan="2">${esc(row.text)}</td></tr>`
    : `<tr class="${esc(row.role)}${row.role === 'agent' && whileMuted(row) ? ' unheard' : ''}"><td>${row.at ? esc(row.at.slice(11, 19)) : '-'}</td><td>${esc(speaker(row))}</td><td class="text">${esc(row.text)}${row.interrupted ? ' <em>(interrupted)</em>' : ''}</td></tr>`));

  const summaries = transcript.conversations.filter((c) => c.summary).map((c) => `<p><strong>ElevenLabs summary:</strong> ${esc(c.summary)}</p>`);
  const lines = transcriptLineCount(r);

  return `<h2>Transcript</h2>
${notes.map((note) => `<p class="note">${note}</p>`).join('\n')}
${summaries.join('\n')}
${lines === 0 && notes.length === 0 ? '<p>ElevenLabs returned no spoken lines for this call.</p>' : ''}
${lines === 0 ? '' : `<p>Times are UTC. ${r.transfer_style ? 'After the technician joins, ElevenLabs hears the resident and the technician as one voice, so those lines are labelled "Resident or technician". Ava is muted while the resident is on hold and while the technician is on the call: lines marked "muted, not heard" are things the model produced that nobody on the call heard.' : 'Ava leaves when the technician joins, so the conversation between the resident and the technician is not included.'}</p>
<div class="wrap"><table class="transcript">
<tr><th>Time</th><th>Speaker</th><th>Said</th></tr>
${body.join('\n')}
</table></div>`}`;
}

function renderDetail(r) {
  const techRows = (r.technicians || []).map((tech, i) => {
    const s = tech.seconds_from_tool_call || {};
    return `<tr>
  <td>${i + 1}</td>
  <td>${dash(tech.number)}</td>
  <td>${dash(tech.outcome)}</td>
  <td>${time(tech.dialled_at)}<br>${seconds(s.dialled)}</td>
  <td>${time(tech.ringing_at)}<br>${seconds(s.ringing)}</td>
  <td>${time(tech.answered_at)}<br>${seconds(s.answered)}</td>
  <td>${time(tech.outcome_at)}<br>${seconds(s.outcome)}</td>
  <td>${dash(tech.answered_by)}</td>
  <td class="text">${dash(tech.detail)}</td>
  <td>${dash(tech.call_sid)}</td>
</tr>`;
  });

  return page(`Transfer ${r.resident_call_sid}`, `<p><a href="/reports">&larr; All transfers</a></p>
<h1>Transfer for ${dash(r.resident_number)}</h1>
<div class="wrap"><table>
<tr><th>Result</th><td class="${r.result === 'connected' ? 'connected' : 'other'}">${resultLabel(r)}</td></tr>
<tr><th>Resident waited</th><td>${seconds(r.resident_wait_seconds)}</td></tr>
<tr><th>Resident number</th><td>${dash(r.resident_number)}</td></tr>
<tr><th>Resident call SID</th><td>${dash(r.resident_call_sid)}</td></tr>
<tr><th>Call direction</th><td>${dash(r.direction)}</td></tr>
<tr><th>Dial mode</th><td>${dash(r.dial_mode)}</td></tr>
<tr><th>Transfer style</th><td>${dash(r.transfer_style || 'agent leaves the call')}</td></tr>
<tr><th>Tool call (start)</th><td>${time(r.started_at)}</td></tr>
<tr><th>Finished</th><td>${time(r.finished_at)}</td></tr>
<tr><th>Summary</th><td class="text">${dash(r.summary)}</td></tr>
</table></div>

<h2>Technicians</h2>
<p>Each time is shown with the seconds since the tool call underneath.</p>
<div class="wrap"><table>
<tr><th>#</th><th>Number</th><th>Outcome</th><th>Dialled</th><th>Ringing</th><th>Answered</th><th>Outcome at</th><th>Machine detection</th><th>Detail</th><th>Call SID</th></tr>
${techRows.join('\n')}
</table></div>

${renderTranscript(r)}

<h2>Raw record</h2>
<pre>${esc(JSON.stringify(r, null, 2))}</pre>`);
}

module.exports = { createReportStore, buildReport, buildTranscript, renderList, renderDetail };
