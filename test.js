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
const driveCalls = [];
const fakeLLM = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
    const body = JSON.parse(b);
    const reply = (obj) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.url === '/drive') {
      driveCalls.push(body);
      if (body.key !== 'drive-test-key') return reply({ error: 'Unauthorized' });
      if (body.action === 'create_doc') return reply({ id: 'doc1', title: body.title, url: 'https://docs.example/doc1' });
      if (body.action === 'search') return reply({ files: [{ id: 'f1', title: 'Budget 2026', url: 'https://docs.example/f1' }] });
      return reply({ error: 'unexpected action' });
    }
    llmCalls.push({ url: req.url, auth: req.headers.authorization, body });
    if (req.url.endsWith('/messages')) {
      if (body.model === 'tooltest') {
        const toolResult = body.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).find((c) => c.type === 'tool_result');
        if (!toolResult) return reply({ stop_reason: 'tool_use', content: [{ type: 'text', text: 'Looking.' }, { type: 'tool_use', id: 't1', name: 'drive_search', input: { query: 'budget' } }] });
        return reply({ stop_reason: 'end_turn', content: [{ type: 'text', text: `Found it: ${toolResult.content}` }] });
      }
      return reply({ content: [{ type: 'text', text: `claude says hi (${body.messages[0].role})` }] });
    }
    if (body.model === 'projtest') {
      const tool = body.messages.find((m) => m.role === 'tool');
      if (!tool) return reply({ choices: [{ message: { content: null, tool_calls: [{ id: 'p1', type: 'function', function: { name: 'open_project_channel', arguments: JSON.stringify({ name: 'Spring Concert', topic: 'Benefit concert', members: ['flo'], kickoff: '@flo can you draft the run of show?' }) } }] } }] });
      return reply({ choices: [{ message: { content: `Opened ${JSON.parse(tool.content).channel}` } }] });
    }
    if (body.model === 'tooltest') {
      const tool = body.messages.find((m) => m.role === 'tool');
      if (!tool) return reply({ choices: [{ message: { content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'drive_create_doc', arguments: JSON.stringify({ title: 'Concert plan', content: 'Step one' }) } }] } }] });
      return reply({ choices: [{ message: { content: `Saved: ${JSON.parse(tool.content).url}` } }] });
    }
    reply({ choices: [{ message: { content: `reply from ${body.model}` } }] });
  });
});
const LLM_PORT = PORT + 1;

(async () => {
  await new Promise((r) => fakeLLM.listen(LLM_PORT, r));
  const server = spawn(process.execPath, ['--no-warnings', path.join(__dirname, 'server.js')], { env: { ...process.env, PORT, DATA_DIR, OWNER_TOKEN: OWNER, OWNER_NAME: 'Joan', OWNER_HANDLE: 'joan', OPENAI_API_KEY: 'sk-test', OPENAI_BASE_URL: `http://localhost:${LLM_PORT}`, XAI_BASE_URL: `http://localhost:${LLM_PORT}`, ANTHROPIC_BASE_URL: `http://localhost:${LLM_PORT}`, ANTHROPIC_API_KEY: 'ant-test', DRIVE_SCRIPT_URL: `http://localhost:${LLM_PORT}/drive`, DRIVE_SCRIPT_KEY: 'drive-test-key', AI_LEAD: 'exec', SEED_MEMBERS: JSON.stringify([{ handle: 'flo', name: 'Flo' }, { handle: 'grokbot', name: 'Grok Bot' }, { handle: 'exec', name: 'Exec Producer' }, { handle: 'drv', name: 'Drive GPT' }, { handle: 'drv2', name: 'Drive Claude' }, { handle: 'pm', name: 'Project Manager' }]), AI_CONFIG: JSON.stringify({ flo: { provider: 'openai', prompt: 'You are Flo, a warm stage manager.' }, grokbot: { provider: 'xai' }, exec: { provider: 'anthropic' }, drv: { provider: 'openai', model: 'tooltest' }, drv2: { provider: 'anthropic', model: 'tooltest' }, pm: { provider: 'openai', model: 'projtest' } }) }, stdio: ['ignore', 'pipe', 'inherit'] });
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
      const top = await wait(async () => (await call(OWNER, 'GET', '/api/channels/general/messages')).messages.find((m) => m.author === 'flo' && m.id > root.id));
      assert.equal(top.body, 'reply from gpt-5');
      assert.equal(top.parent_id, null, 'bots reply in the main conversation');
      const call0 = llmCalls.at(-1);
      assert.equal(call0.auth, 'Bearer sk-test');
      assert.match(call0.body.messages[0].content, /You are Flo, a warm stage manager/);
      assert.match(call0.body.messages[0].content, /@grokbot/);
      assert.equal(call0.body.messages.at(-1).content, '@joan: @flo what is the call time?');
      // Follow-up in the thread without re-mentioning still gets an answer.
      // In a thread the person started, the bot answers inside that thread.
      await call(OWNER, 'POST', `/api/messages/${root.id}/replies`, { body: '@flo and the end time?' });
      await wait(async () => (await call(OWNER, 'GET', `/api/messages/${root.id}/thread`)).replies.some((r) => r.author === 'flo'));
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
    await step('Exec Producer answers a team call last, with everyone else\'s replies in view', async () => {
      const wait = async (fn) => { for (let i = 0; i < 60; i++) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 100)); } throw new Error('timed out'); };
      const before = llmCalls.length;
      const root = await call(OWNER, 'POST', '/api/channels/general/messages', { body: '@channel quick check-in please' });
      await wait(async () => (await call(OWNER, 'GET', '/api/channels/general/messages')).messages.some((m) => m.author === 'exec' && m.id > root.id));
      const execCall = llmCalls.slice(before).find((c) => c.url === '/messages');
      const seen = execCall.body.messages.map((m) => m.content).join('\n');
      assert.match(seen, /@flo: reply from gpt-5/, 'exec saw Flo\'s answer');
      const msgs = (await call(OWNER, 'GET', '/api/channels/general/messages')).messages.filter((m) => m.id > root.id);
      assert.equal(msgs.at(-1).author, 'exec', 'exec spoke last');
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
    await step('A teammate mentioned in a private chat is brought in via the team channel', async () => {
      const wait = async (fn) => { for (let i = 0; i < 60; i++) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 100)); } throw new Error('timed out'); };
      await call(OWNER, 'POST', '/api/dm', { to: 'flo', body: 'please loop in @exec on this' });
      const fwd = await wait(async () => (await call(OWNER, 'GET', '/api/channels/general/messages')).messages.find((m) => m.body.includes('forwarded from my private chat with @flo') && m.body.includes('loop in')));
      assert.match(fwd.body, /loop in @exec/);
      await wait(async () => (await call(OWNER, 'GET', '/api/channels/general/messages')).messages.some((m) => m.author === 'exec' && m.id > fwd.id));
    });
    await step('Bots can hand off to each other a few times, then stop', async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      // flo's fake reply never mentions anyone, so drive the chain with a bot-authored post via the API.
      const flo = (await call(OWNER, 'GET', '/api/members')).find((m) => m.handle === 'flo');
      const { token } = await call(OWNER, 'POST', `/api/members/${flo.id}/rotate-token`);
      const before = llmCalls.length;
      await call(token, 'POST', '/api/channels/general/messages', { body: '@exec can you take this one?' });
      await wait(1500);
      assert.ok(llmCalls.length > before, 'a bot-to-bot mention gets an answer even right after a burst of bot replies');
    });
    await step('Agents can use Google Drive (ChatGPT/Grok style and Claude style)', async () => {
      const wait = async (fn) => { for (let i = 0; i < 60; i++) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 100)); } throw new Error('timed out'); };
      const a = await call(OWNER, 'POST', '/api/dm', { to: 'drv', body: 'save a plan to drive' });
      const r1 = await wait(async () => (await call(OWNER, 'GET', `/api/channels/${a.channel.id}/messages`)).messages.find((m) => m.author === 'drv'));
      assert.equal(r1.body, 'Saved: https://docs.example/doc1');
      assert.ok(driveCalls.some((c) => c.action === 'create_doc' && c.title === 'Concert plan' && c.key === 'drive-test-key'));
      const b = await call(OWNER, 'POST', '/api/dm', { to: 'drv2', body: 'find the budget' });
      const r2 = await wait(async () => (await call(OWNER, 'GET', `/api/channels/${b.channel.id}/messages`)).messages.find((m) => m.author === 'drv2'));
      assert.match(r2.body, /Found it: .*Budget 2026/);
      const sys = llmCalls.filter((c) => c.body.model === 'tooltest').at(-1).body.system;
      assert.match(sys, /Google Drive/);
    });
    await step('An agent can open a project channel and pull teammates in', async () => {
      const wait = async (fn) => { for (let i = 0; i < 60; i++) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 100)); } throw new Error('timed out'); };
      const dm = await call(OWNER, 'POST', '/api/dm', { to: 'pm', body: 'start the spring concert project' });
      const r = await wait(async () => (await call(OWNER, 'GET', `/api/channels/${dm.channel.id}/messages`)).messages.find((m) => m.author === 'pm'));
      assert.equal(r.body, 'Opened #spring-concert');
      const ch = await call(OWNER, 'GET', '/api/channels/spring-concert');
      assert.deepEqual(ch.members.map((m) => m.handle).sort(), ['flo', 'joan', 'pm']);
      const msgs = await wait(async () => { const m = (await call(OWNER, 'GET', '/api/channels/spring-concert/messages')).messages; return m.some((x) => x.author === 'flo') && m; });
      assert.equal(msgs[0].author, 'pm'); assert.match(msgs[0].body, /run of show/);
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
