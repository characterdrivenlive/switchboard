// End-to-end smoke test: boots a throwaway server, exercises the API and the MCP server.
'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

const PORT = 3999 + Math.floor(Math.random() * 1000);
const BASE = `http://localhost:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-test-'));
const OWNER = 'sb_user_test_owner_token';

const call = async (token, method, p, body) => {
  const r = await fetch(BASE + p, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  const data = await r.json();
  if (!r.ok) throw Object.assign(new Error(data.error), { status: r.status });
  return data;
};

function mcpSession(token) {
  const p = spawn(process.execPath, ['--no-warnings', path.join(__dirname, 'mcp.js')], { env: { ...process.env, SWITCHBOARD_URL: BASE, SWITCHBOARD_TOKEN: token } });
  let buf = '', id = 0;
  const pending = new Map();
  p.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { const msg = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); pending.get(msg.id)?.(msg); }
  });
  const rpc = (method, params) => new Promise((res) => { const n = ++id; pending.set(n, res); p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n'); });
  const tool = async (name, args) => (await rpc('tools/call', { name, arguments: args })).result;
  return { rpc, tool, close: () => p.kill() };
}

const http = require('node:http');
const llmCalls = [];
const fakeLLM = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
    const body = JSON.parse(b); llmCalls.push({ url: req.url, auth: req.headers.authorization, body });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(req.url.endsWith('/messages') ? { content: [{ type: 'text', text: `claude says hi (${body.messages[0].role})` }] } : { choices: [{ message: { content: `reply from ${body.model}` } }] }));
  });
});
const LLM_PORT = PORT + 1;

(async () => {
  await new Promise((r) => fakeLLM.listen(LLM_PORT, r));
  const server = spawn(process.execPath, ['--no-warnings', path.join(__dirname, 'server.js')], { env: { ...process.env, PORT, DATA_DIR, OWNER_TOKEN: OWNER, OWNER_NAME: 'Joan', OWNER_HANDLE: 'joan', OPENAI_API_KEY: 'sk-test', OPENAI_BASE_URL: `http://localhost:${LLM_PORT}`, XAI_BASE_URL: `http://localhost:${LLM_PORT}`, ANTHROPIC_BASE_URL: `http://localhost:${LLM_PORT}`, ANTHROPIC_API_KEY: 'ant-test', SEED_MEMBERS: JSON.stringify([{ handle: 'flo', name: 'Flo' }, { handle: 'grokbot', name: 'Grok Bot' }, { handle: 'exec', name: 'Exec Producer' }]), AI_CONFIG: JSON.stringify({ flo: { provider: 'openai', prompt: 'You are Flo, a warm stage manager.' }, grokbot: { provider: 'xai' }, exec: { provider: 'anthropic' } }) }, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((res) => server.stdout.on('data', (d) => String(d).includes('running') && res()));
  let passed = 0;
  const step = async (name, fn) => { await fn(); passed++; console.log(`  ✓ ${name}`); };
  try {
    await step('owner auth + defaults', async () => {
      const me = await call(OWNER, 'GET', '/api/me');
      assert.equal(me.handle, 'joan'); assert.equal(me.role, 'owner');
      const chans = await call(OWNER, 'GET', '/api/channels');
      assert.deepEqual(chans.map((c) => c.name).sort(), ['agent-logs', 'general']);
    });
    let researcher, writer;
    await step('owner creates agents', async () => {
      researcher = await call(OWNER, 'POST', '/api/members', { handle: 'researcher', name: 'Research Bot', description: 'Finds things', channels: ['agent-logs'] });
      writer = await call(OWNER, 'POST', '/api/members', { handle: 'writer', name: 'Copy Writer' });
      assert.match(researcher.token, /^sb_agent_/);
      await assert.rejects(call(researcher.token, 'POST', '/api/members', { handle: 'x' }), { status: 403 });
      await assert.rejects(call(OWNER, 'POST', '/api/members', { handle: 'writer' }), { status: 409 });
    });
    let root;
    await step('mentions land in the right inbox', async () => {
      root = await call(OWNER, 'POST', '/api/channels/general/messages', { body: 'Hey @researcher, can you size the market?' });
      const inbox = await call(researcher.token, 'GET', '/api/inbox');
      assert.equal(inbox.items.length, 1); assert.equal(inbox.items[0].reason, 'mention');
      assert.equal((await call(writer.token, 'GET', '/api/inbox')).items.length, 0);
    });
    await step('threads notify participants', async () => {
      await call(researcher.token, 'POST', `/api/messages/${root.id}/replies`, { body: 'On it — about $4B TAM.' });
      const inbox = await call(OWNER, 'GET', '/api/inbox');
      assert.equal(inbox.items.at(-1).reason, 'thread');
      const t = await call(OWNER, 'GET', `/api/messages/${root.id}/thread`);
      assert.equal(t.replies.length, 1);
      const list = await call(OWNER, 'GET', '/api/channels/general/messages');
      assert.equal(list.messages[0].reply_count, 1);
    });
    await step('long-poll wakes on DM', async () => {
      const waiting = call(writer.token, 'GET', '/api/inbox/wait?timeout=10&ack=1');
      await new Promise((r) => setTimeout(r, 200));
      const t0 = Date.now();
      await call(OWNER, 'POST', '/api/dm', { to: 'writer', body: 'Draft the launch email please' });
      const got = await waiting;
      assert.ok(Date.now() - t0 < 2000);
      assert.equal(got.items[0].reason, 'dm');
      assert.equal((await call(writer.token, 'GET', '/api/inbox')).items.length, 0, 'ack=1 should mark seen');
    });
    await step('DM privacy', async () => {
      const dm = (await call(OWNER, 'GET', '/api/channels')).find((c) => c.is_dm);
      await assert.rejects(call(researcher.token, 'GET', `/api/channels/${dm.id}/messages`), { status: 403 });
      const results = (await call(researcher.token, 'GET', '/api/search?q=launch')).results;
      assert.equal(results.length, 0);
    });
    await step('reactions toggle', async () => {
      let m = await call(writer.token, 'POST', `/api/messages/${root.id}/reactions`, { emoji: '✅' });
      assert.equal(m.reactions[0].count, 1);
      m = await call(writer.token, 'POST', `/api/messages/${root.id}/reactions`, { emoji: '✅' });
      assert.equal(m.reactions.length, 0);
    });
    await step('SSE stream delivers messages', async () => {
      const ctrl = new AbortController();
      const res = await fetch(`${BASE}/api/events?token=${OWNER}`, { signal: ctrl.signal });
      const reader = res.body.getReader();
      await call(writer.token, 'POST', '/api/channels/general/messages', { body: 'sse check' });
      let text = '';
      while (!text.includes('sse check')) text += new TextDecoder().decode((await reader.read()).value);
      ctrl.abort();
    });
    await step('MCP server: tools work end to end', async () => {
      const mcp = mcpSession(researcher.token);
      const init = await mcp.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
      assert.equal(init.result.serverInfo.name, 'switchboard');
      const list = await mcp.rpc('tools/list', {});
      assert.ok(list.result.tools.length >= 10);
      assert.match((await mcp.tool('whoami', {})).content[0].text, /@researcher/);
      assert.match((await mcp.tool('post_message', { channel: 'agent-logs', text: 'Finished market sizing @joan' })).content[0].text, /Posted/);
      assert.match((await mcp.tool('read_channel', { channel: 'agent-logs' })).content[0].text, /Finished market sizing/);
      assert.match((await mcp.tool('send_dm', { to: 'joan', text: 'Need approval on budget' })).content[0].text, /DM sent/);
      assert.match((await mcp.tool('list_members', {})).content[0].text, /@writer/);
      const bad = await mcp.tool('read_channel', { channel: 'nope' });
      assert.equal(bad.isError, true);
      mcp.close();
      const inbox = await call(OWNER, 'GET', '/api/inbox');
      assert.ok(inbox.items.some((i) => i.reason === 'dm' && /budget/.test(i.message.body)));
    });
    await step('token rotation + removal revoke access', async () => {
      const { token } = await call(OWNER, 'POST', `/api/members/${writer.member.id}/rotate-token`);
      await assert.rejects(call(writer.token, 'GET', '/api/me'), { status: 401 });
      await call(token, 'GET', '/api/me');
      await call(OWNER, 'DELETE', `/api/members/${writer.member.id}`);
      await assert.rejects(call(token, 'GET', '/api/me'), { status: 401 });
    });
    await step('AI brains reply to mentions and DMs', async () => {
      const wait = async (fn) => { for (let i = 0; i < 50; i++) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 100)); } throw new Error('timed out'); };
      const root = await call(OWNER, 'POST', '/api/channels/general/messages', { body: '@flo what is the call time?' });
      const t = await wait(async () => { const t = await call(OWNER, 'GET', `/api/messages/${root.id}/thread`); return t.replies.find((r) => r.author === 'flo') && t; });
      assert.equal(t.replies[0].body, 'reply from gpt-5');
      const call0 = llmCalls.at(-1);
      assert.equal(call0.auth, 'Bearer sk-test');
      assert.match(call0.body.messages[0].content, /You are Flo, a warm stage manager/);
      assert.match(call0.body.messages[0].content, /@grokbot/);
      assert.equal(call0.body.messages.at(-1).content, '@joan: @flo what is the call time?');
      // Follow-up in the thread without re-mentioning still gets an answer.
      await call(OWNER, 'POST', `/api/messages/${root.id}/replies`, { body: 'and the end time?' });
      await wait(async () => (await call(OWNER, 'GET', `/api/messages/${root.id}/thread`)).replies.filter((r) => r.author === 'flo').length === 2);
      // Missing key → a friendly note instead of silence.
      const dm = await call(OWNER, 'POST', '/api/dm', { to: 'grokbot', body: 'hi' });
      const msgs = await wait(async () => { const r = await call(OWNER, 'GET', `/api/channels/${dm.channel.id}/messages`); return r.messages.length === 2 && r.messages; });
      assert.match(msgs[1].body, /XAI_API_KEY/);
      // Claude via the Messages API
      const dm2 = await call(OWNER, 'POST', '/api/dm', { to: 'exec', body: 'status?' });
      const m2 = await wait(async () => { const r = await call(OWNER, 'GET', `/api/channels/${dm2.channel.id}/messages`); return r.messages.length === 2 && r.messages; });
      assert.equal(m2[1].body, 'claude says hi (user)');
      const c = llmCalls.at(-1);
      assert.equal(c.url, '/messages'); assert.equal(c.body.model, 'claude-opus-5-5'); assert.match(c.body.system, /Exec Producer/);
      // Owner sees brain settings; owner rename applies.
      const flo = (await call(OWNER, 'GET', '/api/members')).find((m) => m.handle === 'flo');
      const full = await call(OWNER, 'GET', `/api/members/${flo.id}`);
      assert.equal(full.ai_provider, 'openai'); assert.equal(full.ai_key_set, true);
    });
    await step('DMs stay private: mentioning someone in a DM does not pull them in', async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const dm = await call(OWNER, 'POST', '/api/dm', { to: 'flo', body: 'hey @grokbot and @exec, thoughts?' });
      await wait(1500);
      const ch = await call(OWNER, 'GET', `/api/channels/${dm.channel.id}`);
      assert.deepEqual(ch.members.map((m) => m.handle).sort(), ['flo', 'joan']);
      const msgs = (await call(OWNER, 'GET', `/api/channels/${dm.channel.id}/messages`)).messages;
      assert.ok(msgs.every((m) => ['joan', 'flo'].includes(m.author)), 'only the two parties posted');
      const list = await call(OWNER, 'GET', '/api/channels');
      const floDms = list.filter((c) => c.is_dm && c.dm_with.handle === 'flo');
      assert.equal(floDms.length, 1);
      assert.equal(floDms[0].id, dm.channel.id);
    });
    await step('web UI is served', async () => {
      const html = await (await fetch(BASE + '/')).text();
      assert.match(html, /Switchboard/);
    });
    console.log(`\nAll ${passed} checks passed.`);
  } catch (e) {
    console.error('\nFAILED:', e);
    process.exitCode = 1;
  } finally {
    server.kill();
    fakeLLM.close();
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }
})();
