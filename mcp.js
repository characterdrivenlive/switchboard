#!/usr/bin/env node
// Switchboard MCP server (stdio). Lets any MCP-capable agent (Claude Code,
// Claude Desktop, etc.) chat in your Switchboard workspace.
//
//   SWITCHBOARD_URL=http://localhost:3000 SWITCHBOARD_TOKEN=sb_agent_... node mcp.js
'use strict';

const BASE = (process.env.SWITCHBOARD_URL || 'http://localhost:3000').replace(/\/$/, '');
const TOKEN = process.env.SWITCHBOARD_TOKEN;

async function api(method, path, body) {
  if (!TOKEN) throw new Error('SWITCHBOARD_TOKEN is not set');
  const res = await fetch(BASE + path, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

const enc = encodeURIComponent;
const ts = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 16);
const where = (m) => (m.is_dm ? 'DM' : `#${m.channel}`);
function fmt(m, indent = '') {
  const meta = [m.reply_count ? `${m.reply_count} replies` : '', ...(m.reactions || []).map((r) => `${r.emoji}×${r.count}`)].filter(Boolean).join(', ');
  return `${indent}[id:${m.id}] ${ts(m.created_at)} @${m.author}: ${m.body}${meta ? `  (${meta})` : ''}`;
}
const fmtInbox = (items) => items.length
  ? items.map((i) => `(${i.reason}) in ${where(i.message)}${i.message.parent_id ? ` thread:${i.message.parent_id}` : ''}\n${fmt(i.message, '  ')}`).join('\n')
  : 'Inbox empty — nothing needs your attention.';

const tools = [
  {
    name: 'whoami', description: 'Show your Switchboard identity (handle, role).',
    inputSchema: { type: 'object', properties: {} },
    run: async () => { const me = await api('GET', '/api/me'); return `You are @${me.handle} (${me.name}), a ${me.kind} with role ${me.role}. ${me.description}`; },
  },
  {
    name: 'check_inbox',
    description: 'Get unread items that need your attention: @mentions, direct messages, and replies in threads you are part of. Call this at the start of a task and periodically.',
    inputSchema: { type: 'object', properties: { mark_seen: { type: 'boolean', description: 'Mark returned items as seen (default true)' } } },
    run: async ({ mark_seen = true }) => fmtInbox((await api('GET', `/api/inbox${mark_seen ? '?ack=1' : ''}`)).items),
  },
  {
    name: 'wait_for_messages',
    description: 'Block until a new mention/DM/thread reply arrives for you, or until timeout. Use when waiting for a human or another agent to respond.',
    inputSchema: { type: 'object', properties: { timeout_seconds: { type: 'number', description: '1-300, default 60' } } },
    run: async ({ timeout_seconds = 60 }) => fmtInbox((await api('GET', `/api/inbox/wait?ack=1&timeout=${Math.min(Math.max(timeout_seconds, 1), 300)}`)).items),
  },
  {
    name: 'list_channels', description: 'List channels and your DMs with unread counts.',
    inputSchema: { type: 'object', properties: {} },
    run: async () => (await api('GET', '/api/channels')).map((c) => c.is_dm
      ? `DM with @${c.dm_with.handle}${c.unread ? ` — ${c.unread} unread` : ''}`
      : `#${c.name}${c.joined ? '' : ' (not joined)'} — ${c.topic || 'no topic'}${c.unread ? ` — ${c.unread} unread` : ''}`).join('\n'),
  },
  {
    name: 'read_channel', description: 'Read recent messages in a channel (e.g. "general") or a DM (e.g. "@boss"). Marks the channel read.',
    inputSchema: { type: 'object', properties: { channel: { type: 'string' }, limit: { type: 'number', description: 'default 30, max 200' }, before_id: { type: 'number', description: 'Page back from this message id' } }, required: ['channel'] },
    run: async ({ channel, limit = 30, before_id }) => {
      const ref = enc(channel);
      const data = await api('GET', `/api/channels/${ref}/messages?limit=${limit}${before_id ? `&before=${before_id}` : ''}`);
      await api('POST', `/api/channels/${ref}/read`, {});
      const head = data.channel.is_dm ? `DM ${channel}` : `#${data.channel.name}${data.channel.topic ? ` — ${data.channel.topic}` : ''}`;
      return `${head}\n${data.messages.map((m) => fmt(m)).join('\n') || '(no messages yet)'}`;
    },
  },
  {
    name: 'post_message', description: 'Post a message to a channel ("general") or DM ("@boss"). Use @handle to mention someone. Supports markdown. To reply in a thread, pass thread_id.',
    inputSchema: { type: 'object', properties: { channel: { type: 'string' }, text: { type: 'string' }, thread_id: { type: 'number', description: 'Message id of the thread root to reply to' } }, required: ['channel', 'text'] },
    run: async ({ channel, text, thread_id }) => { const m = await api('POST', `/api/channels/${enc(channel)}/messages`, { body: text, parent_id: thread_id }); return `Posted [id:${m.id}] in ${where(m)}${m.parent_id ? ` (thread ${m.parent_id})` : ''}.`; },
  },
  {
    name: 'reply_in_thread', description: 'Reply in the thread of a given message id.',
    inputSchema: { type: 'object', properties: { message_id: { type: 'number' }, text: { type: 'string' } }, required: ['message_id', 'text'] },
    run: async ({ message_id, text }) => { const m = await api('POST', `/api/messages/${message_id}/replies`, { body: text }); return `Replied [id:${m.id}] in thread ${m.parent_id} (${where(m)}).`; },
  },
  {
    name: 'read_thread', description: 'Read a full thread given any message id in it.',
    inputSchema: { type: 'object', properties: { message_id: { type: 'number' } }, required: ['message_id'] },
    run: async ({ message_id }) => { const t = await api('GET', `/api/messages/${message_id}/thread`); return `Thread in ${where(t.root)}\n${fmt(t.root)}\n${t.replies.map((r) => fmt(r, '  ↳ ')).join('\n')}`; },
  },
  {
    name: 'send_dm', description: 'Send a direct message to a member by handle.',
    inputSchema: { type: 'object', properties: { to: { type: 'string', description: 'Handle, e.g. "boss" or "@researcher"' }, text: { type: 'string' } }, required: ['to', 'text'] },
    run: async ({ to, text }) => { const r = await api('POST', '/api/dm', { to, body: text }); return `DM sent to ${to} [id:${r.message.id}].`; },
  },
  {
    name: 'react', description: 'Add (or toggle off) an emoji reaction on a message. Use ✅ to acknowledge, 👀 for "looking at it".',
    inputSchema: { type: 'object', properties: { message_id: { type: 'number' }, emoji: { type: 'string' } }, required: ['message_id', 'emoji'] },
    run: async ({ message_id, emoji }) => { await api('POST', `/api/messages/${message_id}/reactions`, { emoji }); return `Reacted ${emoji} on ${message_id}.`; },
  },
  {
    name: 'search_messages', description: 'Search message history.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, channel: { type: 'string' }, from: { type: 'string', description: 'Author handle' } }, required: ['query'] },
    run: async ({ query, channel, from }) => {
      const qs = new URLSearchParams({ q: query, ...(channel && { channel }), ...(from && { from }) });
      const r = await api('GET', `/api/search?${qs}`);
      return r.results.map((m) => `${where(m)} ${fmt(m)}`).join('\n') || 'No results.';
    },
  },
  {
    name: 'list_members', description: 'List humans and agents in the workspace.',
    inputSchema: { type: 'object', properties: {} },
    run: async () => (await api('GET', '/api/members')).filter((m) => m.status !== 'removed').map((m) => `@${m.handle} — ${m.name} (${m.kind}${m.role === 'owner' ? ', owner' : ''})${m.online ? ' ●online' : ''}${m.status ? ` [${m.status}]` : ''}${m.description ? ` — ${m.description}` : ''}`).join('\n'),
  },
  {
    name: 'create_channel', description: 'Create a new channel, optionally inviting members.',
    inputSchema: { type: 'object', properties: { name: { type: 'string' }, topic: { type: 'string' }, members: { type: 'array', items: { type: 'string' } } }, required: ['name'] },
    run: async (a) => { const c = await api('POST', '/api/channels', a); return `Created #${c.name}.`; },
  },
  {
    name: 'set_status', description: 'Set your status line (e.g. "Researching competitors", "Idle").',
    inputSchema: { type: 'object', properties: { status: { type: 'string' } }, required: ['status'] },
    run: async ({ status }) => { await api('PATCH', '/api/me', { status }); return `Status set: ${status}`; },
  },
];

// --- Minimal MCP (JSON-RPC 2.0 over newline-delimited stdio) ---------------
const write = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
const reply = (id, result) => write({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => write({ jsonrpc: '2.0', id, error: { code, message } });

async function handle(msg) {
  const { id, method, params = {} } = msg;
  if (id === undefined) return; // notification
  switch (method) {
    case 'initialize':
      return reply(id, {
        protocolVersion: params.protocolVersion || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'switchboard', version: '1.0.0' },
        instructions: 'Switchboard is the team chat shared by the human owner and their AI agents. Check your inbox when starting work, post progress to the relevant channel, @mention the owner when you need a decision, and reply in threads to keep channels tidy.',
      });
    case 'ping': return reply(id, {});
    case 'tools/list': return reply(id, { tools: tools.map(({ run, ...t }) => t) });
    case 'tools/call': {
      const tool = tools.find((t) => t.name === params.name);
      if (!tool) return fail(id, -32602, `Unknown tool: ${params.name}`);
      try { return reply(id, { content: [{ type: 'text', text: await tool.run(params.arguments || {}) }] }); }
      catch (e) { return reply(id, { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true }); }
    }
    default: return fail(id, -32601, `Method not found: ${method}`);
  }
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { fail(null, -32700, 'Parse error'); continue; }
    handle(msg).catch((e) => fail(msg.id ?? null, -32603, e.message));
  }
});
