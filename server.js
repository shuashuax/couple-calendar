// 异地恋情侣同步日历 —— 后端服务
// Express 提供 REST API + 静态文件，ws 提供实时同步。
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { getDb, persist } from './lib/store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// ---------- 工具 ----------
const id = (p) => p + crypto.randomBytes(8).toString('hex');
const newToken = () => 't_' + crypto.randomBytes(24).toString('hex');

function genInviteCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去掉易混淆字符
  let s = '';
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function getSpaceByInvite(code) {
  const c = String(code || '').toUpperCase().trim();
  if (!c) return null;
  return getDb().spaces.find((s) => s.inviteCode === c);
}

function getAuth(req) {
  const h = req.headers['authorization'] || '';
  const bearer = h.startsWith('Bearer ') ? h.slice(7) : null;
  const token = bearer || req.query.token;
  if (!token) return null;
  const db = getDb();
  for (const space of db.spaces) {
    const member = space.members.find((m) => m.token === token);
    if (member) return { space, member };
  }
  return null;
}

function getMemberByToken(token) {
  const db = getDb();
  for (const space of db.spaces) {
    const member = space.members.find((m) => m.token === token);
    if (member) return { space, member };
  }
  return null;
}

// 对外返回时剥离 token，避免互相冒充
function publicSpace(space) {
  return {
    ...space,
    members: space.members.map(({ token, ...rest }) => rest),
  };
}

function sanitizeEvent(body, spaceId, authorId) {
  const title = String(body.title || '').trim();
  if (!title) return { error: '请填写标题' };
  if (!body.start || !body.end) return { error: '缺少时间' };
  const startMs = Date.parse(body.start);
  const endMs = Date.parse(body.end);
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) return { error: '时间格式无效' };
  if (endMs <= startMs) return { error: '结束时间必须晚于开始时间' };
  const type = ['event', 'todo', 'anniversary'].includes(body.type) ? body.type : 'event';
  const repeat = ['none', 'daily', 'weekly', 'monthly'].includes(body.repeat) ? body.repeat : 'none';
  let reminderMinutes = null;
  if (body.reminderMinutes !== undefined && body.reminderMinutes !== null && body.reminderMinutes !== '') {
    const n = Number(body.reminderMinutes);
    if (!Number.isNaN(n) && n >= 0) reminderMinutes = n;
  }
  return {
    id: body.id || id('ev_'),
    spaceId,
    authorId,
    title,
    start: new Date(startMs).toISOString(),
    end: new Date(endMs).toISOString(),
    allDay: !!body.allDay,
    notes: String(body.notes || ''),
    type,
    done: type === 'todo' ? !!body.done : false,
    repeat,
    reminderMinutes,
    createdAt: body.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

// ---------- REST API ----------
app.get('/api/health', (req, res) => res.json({ ok: true }));

// 创建情侣空间
app.post('/api/spaces', (req, res) => {
  const { name, nickname, timezone } = req.body || {};
  if (!nickname || !String(nickname).trim()) return res.status(400).json({ error: '请填写昵称' });
  const db = getDb();
  const member = {
    id: id('m_'),
    nickname: String(nickname).trim(),
    timezone: timezone || 'Asia/Shanghai',
    color: '#6ea8fe',
    token: newToken(),
  };
  const space = {
    id: id('sp_'),
    name: String(name || '').trim() || '我们的空间',
    inviteCode: genInviteCode(),
    togetherSince: null,
    members: [member],
    createdAt: new Date().toISOString(),
  };
  while (db.spaces.some((s) => s.inviteCode === space.inviteCode)) space.inviteCode = genInviteCode();
  db.spaces.push(space);
  persist();
  res.json({
    space: publicSpace(space),
    memberId: member.id,
    token: member.token,
    events: [],
  });
});

// 加入情侣空间
app.post('/api/spaces/join', (req, res) => {
  const { inviteCode, nickname, timezone } = req.body || {};
  const space = getSpaceByInvite(inviteCode);
  if (!space) return res.status(404).json({ error: '邀请码无效，请检查' });
  if (space.members.length >= 2) return res.status(409).json({ error: '这个空间已经有两个人啦' });
  if (!nickname || !String(nickname).trim()) return res.status(400).json({ error: '请填写昵称' });
  const member = {
    id: id('m_'),
    nickname: String(nickname).trim(),
    timezone: timezone || 'Asia/Shanghai',
    color: '#f472b6',
    token: newToken(),
  };
  space.members.push(member);
  persist();
  broadcast(space.id, { type: 'space:updated' });
  const events = getDb().events.filter((e) => e.spaceId === space.id);
  res.json({
    space: publicSpace(space),
    memberId: member.id,
    token: member.token,
    events,
  });
});

// 获取当前空间与全部日程
app.get('/api/space', (req, res) => {
  const auth = getAuth(req);
  if (!auth) return res.status(401).json({ error: '未登录' });
  const events = getDb().events.filter((e) => e.spaceId === auth.space.id);
  res.json({ space: publicSpace(auth.space), memberId: auth.member.id, events });
});

// 更新空间设置 + 自己的资料
app.patch('/api/space', (req, res) => {
  const auth = getAuth(req);
  if (!auth) return res.status(401).json({ error: '未登录' });
  const space = auth.space;
  const { name, togetherSince, member } = req.body || {};
  if (name !== undefined) space.name = String(name).trim() || space.name;
  if (togetherSince !== undefined) {
    // 支持 'YYYY-MM-DD' 或 null
    space.togetherSince = togetherSince === '' || togetherSince === null ? null : String(togetherSince);
  }
  if (member && typeof member === 'object') {
    const m = space.members.find((x) => x.id === auth.member.id);
    if (m) {
      if (member.nickname !== undefined) m.nickname = String(member.nickname).trim() || m.nickname;
      if (member.timezone !== undefined) m.timezone = member.timezone;
      if (member.color !== undefined) m.color = member.color;
    }
  }
  persist();
  broadcast(space.id, { type: 'space:updated' });
  res.json({ space: publicSpace(space), memberId: auth.member.id });
});

// 重新生成邀请码
app.post('/api/space/regenerate-invite', (req, res) => {
  const auth = getAuth(req);
  if (!auth) return res.status(401).json({ error: '未登录' });
  const space = auth.space;
  space.inviteCode = genInviteCode();
  while (getDb().spaces.some((s) => s.id !== space.id && s.inviteCode === space.inviteCode)) {
    space.inviteCode = genInviteCode();
  }
  persist();
  broadcast(space.id, { type: 'space:updated' });
  res.json({ inviteCode: space.inviteCode });
});

// 新建日程
app.post('/api/events', (req, res) => {
  const auth = getAuth(req);
  if (!auth) return res.status(401).json({ error: '未登录' });
  const ev = sanitizeEvent(req.body || {}, auth.space.id, auth.member.id);
  if (ev.error) return res.status(400).json({ error: ev.error });
  getDb().events.push(ev);
  persist();
  broadcast(auth.space.id, { type: 'event', action: 'create', event: ev });
  res.json({ event: ev });
});

// 更新日程
app.put('/api/events/:id', (req, res) => {
  const auth = getAuth(req);
  if (!auth) return res.status(401).json({ error: '未登录' });
  const db = getDb();
  const idx = db.events.findIndex((e) => e.id === req.params.id && e.spaceId === auth.space.id);
  if (idx === -1) return res.status(404).json({ error: '日程不存在' });
  const existing = db.events[idx];
  const merged = sanitizeEvent(
    { ...req.body, id: existing.id, createdAt: existing.createdAt },
    auth.space.id,
    existing.authorId,
  );
  if (merged.error) return res.status(400).json({ error: merged.error });
  db.events[idx] = merged;
  persist();
  broadcast(auth.space.id, { type: 'event', action: 'update', event: merged });
  res.json({ event: merged });
});

// 删除日程
app.delete('/api/events/:id', (req, res) => {
  const auth = getAuth(req);
  if (!auth) return res.status(401).json({ error: '未登录' });
  const db = getDb();
  const idx = db.events.findIndex((e) => e.id === req.params.id && e.spaceId === auth.space.id);
  if (idx === -1) return res.status(404).json({ error: '日程不存在' });
  const [ev] = db.events.splice(idx, 1);
  persist();
  broadcast(auth.space.id, { type: 'event', action: 'delete', event: { id: ev.id } });
  res.json({ ok: true });
});

// ---------- WebSocket 实时同步 ----------
function broadcast(spaceId, payload) {
  const msg = JSON.stringify(payload);
  for (const client of wss.clients) {
    if (client.spaceId === spaceId && client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  }
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.spaceId = null;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (msg.type === 'auth' && msg.token) {
      const auth = getMemberByToken(msg.token);
      if (auth) {
        ws.spaceId = auth.space.id;
        ws.memberId = auth.member.id;
        ws.send(JSON.stringify({ type: 'authed', memberId: auth.member.id }));
      } else {
        ws.send(JSON.stringify({ type: 'error', message: '认证失败' }));
      }
    }
  });
});

// 心跳，防止连接被中间层断开
setInterval(() => {
  for (const client of wss.clients) {
    if (!client.isAlive) { client.terminate(); continue; }
    client.isAlive = false;
    client.ping();
  }
}, 30000);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`❤ 情侣日历已启动：http://localhost:${PORT}`);
});
