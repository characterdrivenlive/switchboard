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

(async () => {
  const server = spawn(process.execPath, ['--no-warnings', path.join(__dirname, 'server.js')], { env: { ...process.env, PORT, DATA_DIR, OWNER_TOKEN: OWNER, OWNER_NAME: 'Joan', OWNER_HANDLE: 'joan' }, stdio: ['ignore', 'pipe', 'inherit'] });
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
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }
})();
