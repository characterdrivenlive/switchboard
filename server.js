// Switchboard — a Slack-like workspace for you and your AI agents.
// Zero dependencies: Node 22+ built-ins only (http, crypto, node:sqlite).
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');
fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------
const db = new DatabaseSync(path.join(DATA_DIR, 'switchboard.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS members (
    id INTEGER PRIMARY KEY,
    handle TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('human','agent')),
    role TEXT NOT NULL DEFAULT 'member',
    description TEXT NOT NULL DEFAULT '',
    color TEXT NOT NULL,
    token_hash TEXT UNIQUE NOT NULL,
    webhook_url TEXT,
    status TEXT NOT NULL DEFAULT '',
    last_seen INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS channels (
    id INTEGER PRIMARY KEY,
    name TEXT UNIQUE NOT NULL,
    topic TEXT NOT NULL DEFAULT '',
    is_dm INTEGER NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0,
    created_by INTEGER REFERENCES members(id),
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS channel_members (
    channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    last_read_id INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (channel_id, member_id)
  );
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY,
    channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    member_id INTEGER NOT NULL REFERENCES members(id),
    parent_id INTEGER REFERENCES messages(id) ON DELETE CASCADE,
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    edited_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id, parent_id, id);
  CREATE INDEX IF NOT EXISTS idx_messages_parent ON messages(parent_id, id);
  CREATE TABLE IF NOT EXISTS reactions (
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    emoji TEXT NOT NULL,
    PRIMARY KEY (message_id, member_id, emoji)
  );
  CREATE TABLE IF NOT EXISTS inbox (
    id INTEGER PRIMARY KEY,
    member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    reason TEXT NOT NULL,
    seen INTEGER NOT NULL DEFAULT 0,
    UNIQUE (member_id, message_id)
  );
  CREATE INDEX IF NOT EXISTS idx_inbox_member ON inbox(member_id, seen, id);
`);
// AI brain columns (added after v1; ALTER is a no-op error if they already exist).
for (const col of ['ai_provider TEXT', 'ai_model TEXT', "ai_prompt TEXT NOT NULL DEFAULT ''"]) {
  try { db.exec(`ALTER TABLE members ADD COLUMN ${col}`); } catch {}
}

const now = () => Date.now();
const hashToken = (t) => crypto.createHash('sha256').update(t).digest('hex');
const newToken = (kind) => `sb_${kind === 'agent' ? 'agent' : 'user'}_${crypto.randomBytes(24).toString('base64url')}`;
const COLORS = ['#e8912d', '#2bac76', '#1d9bd1', '#cd2553', '#7c3aed', '#0ea5a4', '#d97706', '#4f46e5', '#db2777', '#65a30d'];
const pickColor = (seed) => COLORS[[...seed].reduce((a, c) => a + c.charCodeAt(0), 0) % COLORS.length];
const HANDLE_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const CHANNEL_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function createMember({ handle, name, kind, role = 'member', description = '', webhook_url = null }, token) {
  token = token || newToken(kind);
  const r = db.prepare(`INSERT INTO members (handle, name, kind, role, description, color, token_hash, webhook_url, created_at)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(handle, name, kind, role, description, pickColor(handle), hashToken(token), webhook_url, now());
  const id = Number(r.lastInsertRowid);
  // Everyone joins #general.
  const general = db.prepare(`SELECT id FROM channels WHERE name = 'general'`).get();
  if (general) joinChannel(general.id, id);
  return { member: getMember(id), token };
}

function getMember(id) {
  const m = db.prepare(`SELECT id, handle, name, kind, role, description, color, webhook_url, status, last_seen, created_at, ai_provider, ai_model, ai_prompt FROM members WHERE id = ?`).get(id);
  return m || null;
}
const publicMember = (m) => m && ({ id: m.id, handle: m.handle, name: m.name, kind: m.kind, role: m.role, description: m.description, color: m.color, status: m.status, last_seen: m.last_seen, online: isOnline(m.id) || !!m.ai_provider, ai_provider: m.ai_provider || null });

function joinChannel(channelId, memberId) {
  const latest = db.prepare(`SELECT COALESCE(MAX(id),0) AS id FROM messages WHERE channel_id = ?`).get(channelId).id;
  db.prepare(`INSERT OR IGNORE INTO channel_members (channel_id, member_id, last_read_id) VALUES (?,?,?)`).run(channelId, memberId, latest);
}

// First boot: create the owner account and default channels.
function bootstrap() {
  const owner = db.prepare(`SELECT id FROM members WHERE role = 'owner'`).get();
  if (owner) {
    if (process.env.OWNER_TOKEN) {
      db.prepare(`UPDATE members SET token_hash = ? WHERE id = ?`).run(hashToken(process.env.OWNER_TOKEN), owner.id);
    }
    if (process.env.OWNER_NAME) db.prepare(`UPDATE members SET name = ? WHERE id = ?`).run(process.env.OWNER_NAME, owner.id);
    return;
  }
  const t = now();
  db.prepare(`INSERT INTO channels (name, topic, created_at) VALUES ('general', 'Company-wide announcements and coordination', ?)`).run(t);
  db.prepare(`INSERT INTO channels (name, topic, created_at) VALUES ('agent-logs', 'Status updates and progress reports from agents', ?)`).run(t);
  const token = process.env.OWNER_TOKEN || newToken('human');
  const { member } = createMember({
    handle: process.env.OWNER_HANDLE || 'boss',
    name: process.env.OWNER_NAME || 'Boss',
    kind: 'human', role: 'owner', description: 'Workspace owner',
  }, token);
  const logs = db.prepare(`SELECT id FROM channels WHERE name = 'agent-logs'`).get();
  joinChannel(logs.id, member.id);
  fs.writeFileSync(path.join(DATA_DIR, 'owner_token.txt'), token + '\n', { mode: 0o600 });
  console.log('\n================ SWITCHBOARD FIRST RUN ================');
  console.log(` Owner login token: ${token}`);
  console.log(` (also saved to ${path.join(DATA_DIR, 'owner_token.txt')})`);
  console.log('=======================================================\n');
}
bootstrap();

// Optional: SEED_MEMBERS='[{"handle":"flo","name":"Flo","description":"..."}]' creates any
// members that don't exist yet and prints their tokens once to the server log.
function seedMembers() {
  if (!process.env.SEED_MEMBERS) return;
  let list;
  try { list = JSON.parse(process.env.SEED_MEMBERS); } catch { return console.warn('[seed] SEED_MEMBERS is not valid JSON'); }
  const created = [];
  for (const s of list) {
    const handle = String(s.handle || '').toLowerCase();
    if (!HANDLE_RE.test(handle) || db.prepare(`SELECT 1 FROM members WHERE handle = ?`).get(handle)) continue;
    const { token } = createMember({ handle, name: s.name || handle, kind: s.kind === 'human' ? 'human' : 'agent', description: s.description || '' });
    created.push(`  @${handle.padEnd(20)} ${token}`);
  }
  if (created.length) console.log(`\n================ NEW MEMBER TOKENS ================\n${created.join('\n')}\n===================================================\n`);
}
seedMembers();

// Optional: AI_CONFIG='{"flo":{"provider":"openai","model":"gpt-5"}}' sets each bot's brain on boot.
// A prompt here is only used if the bot has no instructions yet (UI edits are never overwritten).
function applyAIConfig() {
  if (!process.env.AI_CONFIG) return;
  let cfg;
  try { cfg = JSON.parse(process.env.AI_CONFIG); } catch { return console.warn('[ai] AI_CONFIG is not valid JSON'); }
  for (const [handle, c] of Object.entries(cfg)) {
    const m = db.prepare(`SELECT id, ai_prompt FROM members WHERE handle = ?`).get(handle);
    if (!m) continue;
    if (c.provider !== undefined) db.prepare(`UPDATE members SET ai_provider = ? WHERE id = ?`).run(AI_PROVIDERS[c.provider] ? c.provider : null, m.id);
    if (c.model) db.prepare(`UPDATE members SET ai_model = ? WHERE id = ?`).run(c.model, m.id);
    if (c.prompt && !m.ai_prompt) db.prepare(`UPDATE members SET ai_prompt = ? WHERE id = ?`).run(c.prompt, m.id);
  }
}

// ---------------------------------------------------------------------------
// Real-time: Server-Sent Events + long-poll waiters
// ---------------------------------------------------------------------------
const streams = new Map(); // memberId -> Set<res>
const waiters = new Map(); // memberId -> Set<fn>
const isOnline = (id) => (streams.get(id)?.size || 0) > 0;

function channelAudience(channelId) {
  const ch = db.prepare(`SELECT is_dm FROM channels WHERE id = ?`).get(channelId);
  if (!ch) return [];
  if (ch.is_dm) return db.prepare(`SELECT member_id FROM channel_members WHERE channel_id = ?`).all(channelId).map((r) => r.member_id);
  return [...new Set([...streams.keys()])]; // public channels: everyone connected
}

function emit(memberIds, event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const id of memberIds) {
    for (const res of streams.get(id) || []) res.write(payload);
  }
}
const broadcast = (event, data) => emit([...streams.keys()], event, data);

function wakeWaiters(memberId) {
  const set = waiters.get(memberId);
  if (!set) return;
  waiters.delete(memberId);
  for (const fn of set) fn();
}

setInterval(() => {
  for (const set of streams.values()) for (const res of set) res.write(': ping\n\n');
}, 25000).unref();

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------
function hydrate(rows, viewerId) {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const qs = ids.map(() => '?').join(',');
  const reacts = db.prepare(`SELECT message_id, emoji, member_id FROM reactions WHERE message_id IN (${qs}) ORDER BY rowid`).all(...ids);
  const replies = db.prepare(`SELECT parent_id, COUNT(*) AS n, MAX(created_at) AS last FROM messages WHERE parent_id IN (${qs}) GROUP BY parent_id`).all(...ids);
  const handles = new Map(db.prepare(`SELECT id, handle FROM members`).all().map((m) => [m.id, m.handle]));
  return rows.map((r) => {
    const grouped = {};
    for (const x of reacts.filter((x) => x.message_id === r.id)) {
      (grouped[x.emoji] ||= { emoji: x.emoji, count: 0, members: [], mine: false });
      grouped[x.emoji].count++;
      grouped[x.emoji].members.push(handles.get(x.member_id));
      if (x.member_id === viewerId) grouped[x.emoji].mine = true;
    }
    const rep = replies.find((x) => x.parent_id === r.id);
    return { ...r, author: handles.get(r.member_id), reactions: Object.values(grouped), reply_count: rep ? rep.n : 0, last_reply_at: rep ? rep.last : null };
  });
}
const SELECT_MSG = `SELECT m.id, m.channel_id, c.name AS channel, c.is_dm, m.member_id, m.parent_id, m.body, m.created_at, m.edited_at FROM messages m JOIN channels c ON c.id = m.channel_id`;
const getMessage = (id, viewerId) => hydrate(db.prepare(`${SELECT_MSG} WHERE m.id = ?`).all(id), viewerId)[0] || null;

function postMessage(channelId, author, body, parentId = null) {
  body = String(body || '').trim();
  if (!body) throw httpError(400, 'Message body is required');
  if (body.length > 40000) throw httpError(400, 'Message too long (max 40000 chars)');
  if (parentId) {
    const parent = db.prepare(`SELECT id, channel_id, parent_id FROM messages WHERE id = ?`).get(parentId);
    if (!parent || parent.channel_id !== channelId) throw httpError(400, 'parent_id not found in this channel');
    if (parent.parent_id) parentId = parent.parent_id; // flatten: threads are one level deep
  }
  joinChannel(channelId, author.id);
  const r = db.prepare(`INSERT INTO messages (channel_id, member_id, parent_id, body, created_at) VALUES (?,?,?,?,?)`).run(channelId, author.id, parentId, body, now());
  const id = Number(r.lastInsertRowid);
  db.prepare(`UPDATE channel_members SET last_read_id = ? WHERE channel_id = ? AND member_id = ?`).run(id, channelId, author.id);

  // Figure out who needs to be notified: @mentions, DMs, thread participants.
  const notify = new Map();
  const channel = db.prepare(`SELECT * FROM channels WHERE id = ?`).get(channelId);
  const members = db.prepare(`SELECT id, handle FROM members`).all();
  const channelMemberIds = new Set(db.prepare(`SELECT member_id FROM channel_members WHERE channel_id = ?`).all(channelId).map((r) => r.member_id));
  const mentioned = new Set([...body.matchAll(/@([a-z0-9][a-z0-9_-]*)/gi)].map((m) => m[1].toLowerCase()));
  for (const m of members) if (mentioned.has(m.handle)) notify.set(m.id, 'mention');
  if (mentioned.has('channel') || mentioned.has('here') || mentioned.has('all')) {
    for (const mid of channelMemberIds) if (!notify.has(mid)) notify.set(mid, 'channel');
  }
  if (channel.is_dm) for (const mid of channelMemberIds) if (!notify.has(mid)) notify.set(mid, 'dm');
  if (parentId) {
    const participants = db.prepare(`SELECT DISTINCT member_id FROM messages WHERE id = ? OR parent_id = ?`).all(parentId, parentId);
    for (const p of participants) if (!notify.has(p.member_id)) notify.set(p.member_id, 'thread');
  }
  notify.delete(author.id);
  const ins = db.prepare(`INSERT OR IGNORE INTO inbox (member_id, message_id, reason) VALUES (?,?,?)`);
  for (const [mid, reason] of notify) ins.run(mid, id, reason);

  const msg = getMessage(id, null);
  emit(channelAudience(channelId), 'message', msg);
  for (const [mid, reason] of notify) {
    emit([mid], 'inbox', { reason, message: msg });
    wakeWaiters(mid);
    fireWebhook(mid, reason, msg);
    maybeRespondAsAI(mid, reason, msg, author);
  }
  return msg;
}

// ---------------------------------------------------------------------------
// AI brains: members with ai_provider set answer @mentions / DMs via an LLM API.
// Both OpenAI and xAI speak the same chat-completions format.
// ---------------------------------------------------------------------------
const AI_PROVIDERS = {
  openai: { label: 'ChatGPT', base: () => process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1', key: () => process.env.OPENAI_API_KEY, keyName: 'OPENAI_API_KEY', model: () => process.env.OPENAI_MODEL || 'gpt-5' },
  xai: { label: 'Grok', base: () => process.env.XAI_BASE_URL || 'https://api.x.ai/v1', key: () => process.env.XAI_API_KEY, keyName: 'XAI_API_KEY', model: () => process.env.XAI_MODEL || 'grok-4' },
};
const MAX_BOT_CHAIN = 4; // stop bots talking to each other forever

function maybeRespondAsAI(memberId, reason, msg, author) {
  const bot = getMember(memberId);
  if (!bot || !bot.ai_provider || !AI_PROVIDERS[bot.ai_provider]) return;
  const authorIsBot = !!getMember(author.id)?.ai_provider;
  // Bots answer humans on mention/DM/thread; other bots only when explicitly @mentioned.
  if (authorIsBot ? reason !== 'mention' : !['mention', 'dm', 'thread', 'channel'].includes(reason)) return;
  const rootId = msg.parent_id || null;
  if (authorIsBot) {
    const recent = db.prepare(`SELECT m.member_id FROM messages m WHERE m.channel_id = ? AND ${rootId ? 'm.parent_id = ?' : 'm.parent_id IS NULL AND ?=?'} ORDER BY m.id DESC LIMIT ?`)
      .all(msg.channel_id, ...(rootId ? [rootId] : [1, 1]), MAX_BOT_CHAIN);
    if (recent.length >= MAX_BOT_CHAIN && recent.every((r) => getMember(r.member_id)?.ai_provider)) return;
  }
  setTimeout(() => respondAsAI(bot, msg).catch((e) => console.warn(`[ai] @${bot.handle}: ${e.message}`)), 50);
}

function conversationFor(bot, msg) {
  let rows;
  if (msg.parent_id) {
    rows = db.prepare(`${SELECT_MSG} WHERE m.id = ? OR m.parent_id = ? ORDER BY m.id DESC LIMIT 30`).all(msg.parent_id, msg.parent_id).reverse();
  } else {
    rows = db.prepare(`${SELECT_MSG} WHERE m.channel_id = ? AND m.parent_id IS NULL AND m.id <= ? ORDER BY m.id DESC LIMIT 20`).all(msg.channel_id, msg.id).reverse();
  }
  const handles = new Map(db.prepare(`SELECT id, handle FROM members`).all().map((m) => [m.id, m.handle]));
  return rows.map((r) => r.member_id === bot.id
    ? { role: 'assistant', content: r.body }
    : { role: 'user', content: `@${handles.get(r.member_id)}: ${r.body}` });
}

async function respondAsAI(bot, msg) {
  const p = AI_PROVIDERS[bot.ai_provider];
  const channel = db.prepare(`SELECT * FROM channels WHERE id = ?`).get(msg.channel_id);
  const replyParent = channel.is_dm && !msg.parent_id ? null : (msg.parent_id || msg.id);
  const say = (text) => postMessage(channel.id, bot, text, replyParent);
  if (!p.key()) return say(`_(I'm not connected yet. The workspace owner needs to add ${p.keyName} in Railway.)_`);

  const roster = db.prepare(`SELECT handle, name, description FROM members WHERE status != 'removed' ORDER BY handle`).all()
    .map((m) => `- @${m.handle}: ${m.name}${m.description ? ` (${m.description})` : ''}`).join('\n');
  const system = [
    bot.ai_prompt || `You are ${bot.name}. ${bot.description}`,
    `\n---\nYou are @${bot.handle} in Switchboard, the team's shared chat. You are replying ${channel.is_dm ? 'in a direct message' : `in #${channel.name}`}.`,
    `Team members:\n${roster}`,
    (() => { const o = db.prepare(`SELECT handle, name FROM members WHERE role = 'owner'`).get(); return o ? `${o.name} (@${o.handle}) is the owner and boss of this team. Messages marked "@${o.handle}:" come directly from ${o.name}; talk to ${o.name} directly, never as if relaying to someone else.` : ''; })(),
    `Reply as yourself only, in your own voice. Keep replies concise and conversational. Use @handle only when you need someone specific to respond. Do not prefix your reply with your name.`,
  ].join('\n');

  db.prepare(`UPDATE members SET status = 'typing…' WHERE id = ?`).run(bot.id);
  broadcast('member', publicMember(getMember(bot.id)));
  try {
    const res = await fetch(`${p.base()}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${p.key()}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: bot.ai_model || p.model(), messages: [{ role: 'system', content: system }, ...conversationFor(bot, msg)] }),
      signal: AbortSignal.timeout(120000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error?.message || `HTTP ${res.status}`);
    const text = String(data.choices?.[0]?.message?.content || '').trim();
    if (text) say(text);
  } catch (e) {
    say(`_(I couldn't reply: ${String(e.message).slice(0, 200)})_`);
  } finally {
    db.prepare(`UPDATE members SET status = '' WHERE id = ?`).run(bot.id);
    broadcast('member', publicMember(getMember(bot.id)));
  }
}

function fireWebhook(memberId, reason, msg) {
  const m = getMember(memberId);
  if (!m || !m.webhook_url) return;
  const payload = JSON.stringify({ type: 'switchboard.notification', reason, recipient: m.handle, message: msg });
  fetch(m.webhook_url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: payload, signal: AbortSignal.timeout(10000) })
    .catch((e) => console.warn(`[webhook] ${m.handle}: ${e.message}`));
}

function dmChannelFor(a, b) {
  const [x, y] = [a, b].sort((p, q) => p.id - q.id);
  const name = `dm-${x.id}-${y.id}`;
  let ch = db.prepare(`SELECT * FROM channels WHERE name = ?`).get(name);
  if (!ch) {
    const r = db.prepare(`INSERT INTO channels (name, topic, is_dm, created_by, created_at) VALUES (?,?,1,?,?)`).run(name, '', a.id, now());
    ch = db.prepare(`SELECT * FROM channels WHERE id = ?`).get(Number(r.lastInsertRowid));
    joinChannel(ch.id, x.id);
    joinChannel(ch.id, y.id);
  }
  return ch;
}

function listChannels(viewer) {
  const rows = db.prepare(`
    SELECT c.id, c.name, c.topic, c.is_dm, c.archived, c.created_at,
      cm.member_id IS NOT NULL AS joined,
      (SELECT COUNT(*) FROM channel_members x WHERE x.channel_id = c.id) AS member_count,
      (SELECT COUNT(*) FROM messages m WHERE m.channel_id = c.id AND m.parent_id IS NULL AND m.id > COALESCE(cm.last_read_id, 1e18) AND m.member_id != ?) AS unread,
      (SELECT MAX(id) FROM messages m WHERE m.channel_id = c.id) AS last_message_id
    FROM channels c
    LEFT JOIN channel_members cm ON cm.channel_id = c.id AND cm.member_id = ?
    WHERE c.archived = 0 AND (c.is_dm = 0 OR cm.member_id IS NOT NULL)
    ORDER BY c.is_dm, c.name`).all(viewer.id, viewer.id);
  return rows.map((c) => {
    c.joined = !!c.joined; c.is_dm = !!c.is_dm;
    if (c.is_dm) {
      const other = db.prepare(`SELECT m.id, m.handle, m.name, m.kind, m.color FROM channel_members cm JOIN members m ON m.id = cm.member_id WHERE cm.channel_id = ? AND m.id != ?`).get(c.id, viewer.id) || viewer;
      c.dm_with = { ...other, online: isOnline(other.id) };
    }
    return c;
  });
}

function resolveChannel(ref, viewer) {
  let ch;
  if (/^\d+$/.test(String(ref))) ch = db.prepare(`SELECT * FROM channels WHERE id = ?`).get(Number(ref));
  else {
    const name = String(ref).replace(/^#/, '').toLowerCase();
    ch = db.prepare(`SELECT * FROM channels WHERE name = ?`).get(name);
    if (!ch && name.startsWith('@')) {
      const other = db.prepare(`SELECT * FROM members WHERE handle = ?`).get(name.slice(1));
      if (other) ch = dmChannelFor(viewer, other);
    }
  }
  if (!ch) throw httpError(404, `Channel not found: ${ref}`);
  if (ch.is_dm && !db.prepare(`SELECT 1 FROM channel_members WHERE channel_id = ? AND member_id = ?`).get(ch.id, viewer.id) && viewer.role !== 'owner') {
    throw httpError(403, 'Not a member of this DM');
  }
  return ch;
}

function canSee(viewer, channelId) {
  const ch = db.prepare(`SELECT is_dm FROM channels WHERE id = ?`).get(channelId);
  if (!ch) return false;
  if (!ch.is_dm || viewer.role === 'owner') return true;
  return !!db.prepare(`SELECT 1 FROM channel_members WHERE channel_id = ? AND member_id = ?`).get(channelId, viewer.id);
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------
function httpError(status, message) { const e = new Error(message); e.status = status; return e; }

function send(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 1e6) throw httpError(413, 'Body too large');
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw httpError(400, 'Invalid JSON body'); }
}

function authenticate(req, url) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : url.searchParams.get('token');
  if (!token) throw httpError(401, 'Missing token. Send "Authorization: Bearer <token>".');
  const row = db.prepare(`SELECT id FROM members WHERE token_hash = ?`).get(hashToken(token));
  if (!row) throw httpError(401, 'Invalid token');
  db.prepare(`UPDATE members SET last_seen = ? WHERE id = ?`).run(now(), row.id);
  return getMember(row.id);
}
const requireOwner = (me) => { if (me.role !== 'owner') throw httpError(403, 'Only the workspace owner can do that'); };

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
function serveStatic(res, pathname) {
  const file = path.normalize(path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname));
  if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    return serveStatic(res, '/'); // SPA fallback
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
const routes = [];
const route = (method, pattern, handler) => {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '/?$');
  routes.push({ method, re, keys, handler });
};

route('GET', '/api/health', () => ({ ok: true }));

route('GET', '/api/me', ({ me }) => ({ ...publicMember(me), webhook_url: me.webhook_url }));
route('PATCH', '/api/me', ({ me, body }) => {
  if (body.name !== undefined) db.prepare(`UPDATE members SET name = ? WHERE id = ?`).run(String(body.name).slice(0, 80), me.id);
  if (body.status !== undefined) db.prepare(`UPDATE members SET status = ? WHERE id = ?`).run(String(body.status).slice(0, 140), me.id);
  if (body.description !== undefined) db.prepare(`UPDATE members SET description = ? WHERE id = ?`).run(String(body.description).slice(0, 500), me.id);
  if (body.webhook_url !== undefined) db.prepare(`UPDATE members SET webhook_url = ? WHERE id = ?`).run(body.webhook_url || null, me.id);
  const m = publicMember(getMember(me.id));
  broadcast('member', m);
  return m;
});

// Members / agents
route('GET', '/api/members', () => db.prepare(`SELECT id FROM members ORDER BY kind DESC, handle`).all().map((r) => publicMember(getMember(r.id))));
route('POST', '/api/members', ({ me, body }) => {
  requireOwner(me);
  const handle = String(body.handle || '').toLowerCase().replace(/^@/, '');
  if (!HANDLE_RE.test(handle)) throw httpError(400, 'handle must be lowercase letters, digits, - or _ (max 32)');
  if (['channel', 'here', 'all'].includes(handle)) throw httpError(400, 'That handle is reserved');
  if (db.prepare(`SELECT 1 FROM members WHERE handle = ?`).get(handle)) throw httpError(409, `@${handle} already exists`);
  const kind = body.kind === 'human' ? 'human' : 'agent';
  const { member, token } = createMember({ handle, name: String(body.name || handle).slice(0, 80), kind, description: String(body.description || '').slice(0, 500), webhook_url: body.webhook_url || null });
  for (const name of body.channels || []) {
    const ch = db.prepare(`SELECT id FROM channels WHERE name = ? AND is_dm = 0`).get(String(name).replace(/^#/, ''));
    if (ch) joinChannel(ch.id, member.id);
  }
  broadcast('member', publicMember(member));
  return { member: { ...publicMember(member), webhook_url: member.webhook_url }, token };
});
route('GET', '/api/members/:id', ({ me, params }) => {
  const m = getMember(Number(params.id));
  if (!m) throw httpError(404, 'Member not found');
  const out = publicMember(m);
  if (me.role === 'owner') Object.assign(out, { webhook_url: m.webhook_url, ai_model: m.ai_model, ai_prompt: m.ai_prompt, ai_default_model: m.ai_provider ? AI_PROVIDERS[m.ai_provider]?.model() : null, ai_key_set: m.ai_provider ? !!AI_PROVIDERS[m.ai_provider]?.key() : null });
  return out;
});
route('PATCH', '/api/members/:id', ({ me, params, body }) => {
  requireOwner(me);
  const m = getMember(Number(params.id));
  if (!m) throw httpError(404, 'Member not found');
  for (const f of ['name', 'description', 'status']) if (body[f] !== undefined) db.prepare(`UPDATE members SET ${f} = ? WHERE id = ?`).run(String(body[f]), m.id);
  if (body.webhook_url !== undefined) db.prepare(`UPDATE members SET webhook_url = ? WHERE id = ?`).run(body.webhook_url || null, m.id);
  if (body.ai_provider !== undefined) db.prepare(`UPDATE members SET ai_provider = ? WHERE id = ?`).run(AI_PROVIDERS[body.ai_provider] ? body.ai_provider : null, m.id);
  if (body.ai_model !== undefined) db.prepare(`UPDATE members SET ai_model = ? WHERE id = ?`).run(String(body.ai_model || '').trim() || null, m.id);
  if (body.ai_prompt !== undefined) db.prepare(`UPDATE members SET ai_prompt = ? WHERE id = ?`).run(String(body.ai_prompt).slice(0, 20000), m.id);
  const out = getMember(m.id);
  broadcast('member', publicMember(out));
  return { ...publicMember(out), webhook_url: out.webhook_url, ai_model: out.ai_model, ai_prompt: out.ai_prompt };
});
route('POST', '/api/members/:id/rotate-token', ({ me, params }) => {
  requireOwner(me);
  const m = getMember(Number(params.id));
  if (!m) throw httpError(404, 'Member not found');
  const token = newToken(m.kind);
  db.prepare(`UPDATE members SET token_hash = ? WHERE id = ?`).run(hashToken(token), m.id);
  for (const res of streams.get(m.id) || []) res.end();
  return { token };
});
route('DELETE', '/api/members/:id', ({ me, params }) => {
  requireOwner(me);
  const m = getMember(Number(params.id));
  if (!m) throw httpError(404, 'Member not found');
  if (m.role === 'owner') throw httpError(400, 'Cannot remove the owner');
  // Keep their messages for history; revoke access by scrambling the token.
  db.prepare(`UPDATE members SET token_hash = ?, handle = handle || '-removed-' || id, status = 'removed' WHERE id = ?`).run(hashToken(crypto.randomBytes(32).toString('hex')), m.id);
  db.prepare(`DELETE FROM channel_members WHERE member_id = ?`).run(m.id);
  for (const res of streams.get(m.id) || []) res.end();
  broadcast('member', publicMember(getMember(m.id)));
  return { ok: true };
});

// Channels
route('GET', '/api/channels', ({ me }) => listChannels(me));
route('POST', '/api/channels', ({ me, body }) => {
  const name = String(body.name || '').toLowerCase().replace(/^#/, '').replace(/\s+/g, '-');
  if (!CHANNEL_RE.test(name) || name.startsWith('dm-')) throw httpError(400, 'Channel names: lowercase letters, digits, - or _');
  if (db.prepare(`SELECT 1 FROM channels WHERE name = ?`).get(name)) throw httpError(409, `#${name} already exists`);
  const r = db.prepare(`INSERT INTO channels (name, topic, created_by, created_at) VALUES (?,?,?,?)`).run(name, String(body.topic || '').slice(0, 250), me.id, now());
  const id = Number(r.lastInsertRowid);
  joinChannel(id, me.id);
  for (const h of body.members || []) {
    const m = db.prepare(`SELECT id FROM members WHERE handle = ?`).get(String(h).replace(/^@/, ''));
    if (m) joinChannel(id, m.id);
  }
  const ch = db.prepare(`SELECT * FROM channels WHERE id = ?`).get(id);
  broadcast('channel', ch);
  return ch;
});
route('GET', '/api/channels/:ref', ({ me, params }) => {
  const ch = resolveChannel(decodeURIComponent(params.ref), me);
  const members = db.prepare(`SELECT member_id FROM channel_members WHERE channel_id = ?`).all(ch.id).map((r) => publicMember(getMember(r.member_id)));
  return { ...ch, is_dm: !!ch.is_dm, members };
});
route('PATCH', '/api/channels/:ref', ({ me, params, body }) => {
  const ch = resolveChannel(decodeURIComponent(params.ref), me);
  if (body.topic !== undefined) db.prepare(`UPDATE channels SET topic = ? WHERE id = ?`).run(String(body.topic).slice(0, 250), ch.id);
  if (body.archived !== undefined) { requireOwner(me); db.prepare(`UPDATE channels SET archived = ? WHERE id = ?`).run(body.archived ? 1 : 0, ch.id); }
  const out = db.prepare(`SELECT * FROM channels WHERE id = ?`).get(ch.id);
  broadcast('channel', out);
  return out;
});
route('POST', '/api/channels/:ref/join', ({ me, params }) => { const ch = resolveChannel(decodeURIComponent(params.ref), me); joinChannel(ch.id, me.id); return { ok: true }; });
route('POST', '/api/channels/:ref/leave', ({ me, params }) => { const ch = resolveChannel(decodeURIComponent(params.ref), me); db.prepare(`DELETE FROM channel_members WHERE channel_id = ? AND member_id = ?`).run(ch.id, me.id); return { ok: true }; });
route('POST', '/api/channels/:ref/read', ({ me, params, body }) => {
  const ch = resolveChannel(decodeURIComponent(params.ref), me);
  joinChannel(ch.id, me.id);
  const upTo = Number(body.message_id) || db.prepare(`SELECT COALESCE(MAX(id),0) AS id FROM messages WHERE channel_id = ?`).get(ch.id).id;
  db.prepare(`UPDATE channel_members SET last_read_id = MAX(last_read_id, ?) WHERE channel_id = ? AND member_id = ?`).run(upTo, ch.id, me.id);
  db.prepare(`UPDATE inbox SET seen = 1 WHERE member_id = ? AND message_id IN (SELECT id FROM messages WHERE channel_id = ? AND id <= ? AND parent_id IS NULL)`).run(me.id, ch.id, upTo);
  return { ok: true };
});
route('GET', '/api/channels/:ref/messages', ({ me, params, url }) => {
  const ch = resolveChannel(decodeURIComponent(params.ref), me);
  const limit = Math.min(Number(url.searchParams.get('limit')) || 50, 200);
  const before = Number(url.searchParams.get('before')) || null;
  const after = Number(url.searchParams.get('after')) || null;
  let rows;
  if (after) rows = db.prepare(`${SELECT_MSG} WHERE m.channel_id = ? AND m.parent_id IS NULL AND m.id > ? ORDER BY m.id ASC LIMIT ?`).all(ch.id, after, limit);
  else rows = db.prepare(`${SELECT_MSG} WHERE m.channel_id = ? AND m.parent_id IS NULL AND m.id < ? ORDER BY m.id DESC LIMIT ?`).all(ch.id, before || Number.MAX_SAFE_INTEGER, limit).reverse();
  return { channel: { id: ch.id, name: ch.name, topic: ch.topic, is_dm: !!ch.is_dm }, messages: hydrate(rows, me.id) };
});
route('POST', '/api/channels/:ref/messages', ({ me, params, body }) => {
  const ch = resolveChannel(decodeURIComponent(params.ref), me);
  if (ch.archived) throw httpError(400, 'Channel is archived');
  return postMessage(ch.id, me, body.body ?? body.text, body.parent_id || body.thread_id || null);
});

// Direct messages
route('POST', '/api/dm', ({ me, body }) => {
  const other = db.prepare(`SELECT * FROM members WHERE handle = ?`).get(String(body.to || body.handle || '').replace(/^@/, '').toLowerCase());
  if (!other) throw httpError(404, 'No such member');
  const ch = dmChannelFor(me, other);
  const message = body.body || body.text ? postMessage(ch.id, me, body.body ?? body.text) : null;
  return { channel: { id: ch.id, name: ch.name, is_dm: true }, message };
});

// Individual messages & threads
route('GET', '/api/messages/:id', ({ me, params }) => {
  const msg = getMessage(Number(params.id), me.id);
  if (!msg || !canSee(me, msg.channel_id)) throw httpError(404, 'Message not found');
  return msg;
});
route('GET', '/api/messages/:id/thread', ({ me, params }) => {
  let root = getMessage(Number(params.id), me.id);
  if (!root || !canSee(me, root.channel_id)) throw httpError(404, 'Message not found');
  if (root.parent_id) root = getMessage(root.parent_id, me.id);
  const replies = hydrate(db.prepare(`${SELECT_MSG} WHERE m.parent_id = ? ORDER BY m.id`).all(root.id), me.id);
  db.prepare(`UPDATE inbox SET seen = 1 WHERE member_id = ? AND message_id IN (SELECT id FROM messages WHERE id = ? OR parent_id = ?)`).run(me.id, root.id, root.id);
  return { root, replies };
});
route('POST', '/api/messages/:id/replies', ({ me, params, body }) => {
  const msg = getMessage(Number(params.id), me.id);
  if (!msg || !canSee(me, msg.channel_id)) throw httpError(404, 'Message not found');
  return postMessage(msg.channel_id, me, body.body ?? body.text, msg.parent_id || msg.id);
});
route('PATCH', '/api/messages/:id', ({ me, params, body }) => {
  const msg = getMessage(Number(params.id), me.id);
  if (!msg) throw httpError(404, 'Message not found');
  if (msg.member_id !== me.id) throw httpError(403, 'You can only edit your own messages');
  const text = String(body.body ?? body.text ?? '').trim();
  if (!text) throw httpError(400, 'Message body is required');
  db.prepare(`UPDATE messages SET body = ?, edited_at = ? WHERE id = ?`).run(text, now(), msg.id);
  const out = getMessage(msg.id, null);
  emit(channelAudience(msg.channel_id), 'message_updated', out);
  return out;
});
route('DELETE', '/api/messages/:id', ({ me, params }) => {
  const msg = getMessage(Number(params.id), me.id);
  if (!msg) throw httpError(404, 'Message not found');
  if (msg.member_id !== me.id && me.role !== 'owner') throw httpError(403, 'Not allowed');
  db.prepare(`DELETE FROM messages WHERE id = ?`).run(msg.id);
  emit(channelAudience(msg.channel_id), 'message_deleted', { id: msg.id, channel_id: msg.channel_id, parent_id: msg.parent_id });
  return { ok: true };
});
route('POST', '/api/messages/:id/reactions', ({ me, params, body }) => {
  const msg = getMessage(Number(params.id), me.id);
  if (!msg || !canSee(me, msg.channel_id)) throw httpError(404, 'Message not found');
  const emoji = String(body.emoji || '').trim().slice(0, 32);
  if (!emoji) throw httpError(400, 'emoji is required');
  const exists = db.prepare(`SELECT 1 FROM reactions WHERE message_id = ? AND member_id = ? AND emoji = ?`).get(msg.id, me.id, emoji);
  if (exists && body.toggle !== false) db.prepare(`DELETE FROM reactions WHERE message_id = ? AND member_id = ? AND emoji = ?`).run(msg.id, me.id, emoji);
  else db.prepare(`INSERT OR IGNORE INTO reactions (message_id, member_id, emoji) VALUES (?,?,?)`).run(msg.id, me.id, emoji);
  const out = getMessage(msg.id, null);
  emit(channelAudience(msg.channel_id), 'message_updated', out);
  return out;
});

// Inbox: everything that needs this member's attention (mentions, DMs, thread replies)
function inboxFor(me, { unseenOnly = true, limit = 50 } = {}) {
  const rows = db.prepare(`SELECT i.id AS inbox_id, i.reason, i.seen, i.message_id FROM inbox i WHERE i.member_id = ? ${unseenOnly ? 'AND i.seen = 0' : ''} ORDER BY i.id DESC LIMIT ?`).all(me.id, limit).reverse();
  return rows.map((r) => ({ inbox_id: r.inbox_id, reason: r.reason, seen: !!r.seen, message: getMessage(r.message_id, me.id) })).filter((r) => r.message);
}
route('GET', '/api/inbox', ({ me, url }) => {
  const items = inboxFor(me, { unseenOnly: url.searchParams.get('all') !== '1', limit: Math.min(Number(url.searchParams.get('limit')) || 50, 200) });
  if (url.searchParams.get('ack') === '1' && items.length) {
    db.prepare(`UPDATE inbox SET seen = 1 WHERE member_id = ? AND id <= ?`).run(me.id, items[items.length - 1].inbox_id);
  }
  return { items };
});
route('POST', '/api/inbox/ack', ({ me, body }) => {
  if (Array.isArray(body.ids) && body.ids.length) {
    const ack = db.prepare(`UPDATE inbox SET seen = 1 WHERE member_id = ? AND id = ?`);
    for (const id of body.ids) ack.run(me.id, Number(id));
  } else db.prepare(`UPDATE inbox SET seen = 1 WHERE member_id = ?`).run(me.id);
  return { ok: true };
});
// Long-poll: blocks until something lands in the inbox (or timeout). Ideal for agent loops.
route('GET', '/api/inbox/wait', ({ me, url, req }) => new Promise((resolve) => {
  const timeout = Math.min(Math.max(Number(url.searchParams.get('timeout')) || 30, 1), 300) * 1000;
  const ack = url.searchParams.get('ack') === '1';
  const finish = () => {
    clearTimeout(timer);
    waiters.get(me.id)?.delete(finish);
    const items = inboxFor(me);
    if (ack && items.length) db.prepare(`UPDATE inbox SET seen = 1 WHERE member_id = ? AND id <= ?`).run(me.id, items[items.length - 1].inbox_id);
    resolve({ items });
  };
  if (inboxFor(me, { limit: 1 }).length) return finish();
  const timer = setTimeout(finish, timeout);
  if (!waiters.has(me.id)) waiters.set(me.id, new Set());
  waiters.get(me.id).add(finish);
  req.on('close', () => { clearTimeout(timer); waiters.get(me.id)?.delete(finish); });
}));

route('GET', '/api/search', ({ me, url }) => {
  const q = String(url.searchParams.get('q') || '').trim();
  if (!q) return { results: [] };
  let sql = `${SELECT_MSG} WHERE m.body LIKE ? ESCAPE '\\'`;
  const args = [`%${q.replace(/[\\%_]/g, (c) => '\\' + c)}%`];
  const chRef = url.searchParams.get('channel');
  if (chRef) { sql += ` AND m.channel_id = ?`; args.push(resolveChannel(chRef, me).id); }
  const from = url.searchParams.get('from');
  if (from) { sql += ` AND m.member_id = (SELECT id FROM members WHERE handle = ?)`; args.push(from.replace(/^@/, '')); }
  sql += ` ORDER BY m.id DESC LIMIT 100`;
  const rows = db.prepare(sql).all(...args).filter((r) => canSee(me, r.channel_id)).slice(0, Math.min(Number(url.searchParams.get('limit')) || 25, 100));
  return { results: hydrate(rows, me.id) };
});

// Server-Sent Events stream
route('GET', '/api/events', ({ me, req, res }) => {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'access-control-allow-origin': '*' });
  res.write(`event: hello\ndata: ${JSON.stringify({ member: publicMember(me) })}\n\n`);
  if (!streams.has(me.id)) streams.set(me.id, new Set());
  const wasOnline = isOnline(me.id);
  streams.get(me.id).add(res);
  if (!wasOnline) broadcast('presence', { id: me.id, online: true });
  req.on('close', () => {
    streams.get(me.id)?.delete(res);
    if (!streams.get(me.id)?.size) { streams.delete(me.id); broadcast('presence', { id: me.id, online: false }); }
  });
  return undefined; // keep open
});

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, content-type', 'access-control-allow-methods': 'GET, POST, PATCH, DELETE, OPTIONS' });
    return res.end();
  }
  if (!url.pathname.startsWith('/api/')) return serveStatic(res, url.pathname);
  try {
    const r = routes.find((x) => x.method === req.method && x.re.test(url.pathname));
    if (!r) throw httpError(404, `No route: ${req.method} ${url.pathname}`);
    const params = {};
    url.pathname.match(r.re).slice(1).forEach((v, i) => { params[r.keys[i]] = v; });
    const me = url.pathname === '/api/health' ? null : authenticate(req, url);
    const body = ['POST', 'PATCH', 'PUT'].includes(req.method) ? await readBody(req) : {};
    const out = await r.handler({ req, res, url, params, me, body });
    if (out !== undefined && !res.headersSent) send(res, 200, out);
  } catch (e) {
    if (!e.status) console.error(e);
    if (!res.headersSent) send(res, e.status || 500, { error: e.message || 'Internal error' });
  }
});

applyAIConfig();
server.listen(PORT, () => console.log(`Switchboard running on http://localhost:${PORT}`));
module.exports = server;
