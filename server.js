// 异地恋情侣同步日历 —— 后端服务
// Express 提供 REST API + 静态文件，ws 提供实时同步，数据存 Supabase Postgres。
import { config as loadEnv } from 'dotenv';
loadEnv({ quiet: true });
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  insertSpace, findSpaceByInvite, findSpaceById, updateSpace,
  insertMember, updateMember, findMemberByToken, findMemberByLoginCode, setMemberLoginCode, listMembers,
  listEvents, insertEvent, findEvent, updateEvent, deleteEvent, deleteEventsBySpace,
} from './lib/store.js';

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

async function uniqueInviteCode() {
  let code;
  let guard = 0;
  do {
    code = genInviteCode();
    guard++;
  } while (guard < 20 && (await findSpaceByInvite(code)));
  return code;
}

function genLoginCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const g = () => { let s = ''; for (let i = 0; i < 4; i++) s += chars[Math.floor(Math.random() * chars.length)]; return s; };
  return `${g()}-${g()}-${g()}`;
}

async function uniqueLoginCode() {
  let code;
  let guard = 0;
  do {
    code = genLoginCode();
    guard++;
  } while (guard < 20 && (await findMemberByLoginCode(code)));
  return code;
}

async function getAuth(req) {
  const h = req.headers['authorization'] || '';
  const bearer = h.startsWith('Bearer ') ? h.slice(7) : null;
  const token = bearer || req.query.token;
  if (!token) return null;
  const member = await findMemberByToken(token);
  if (!member) return null;
  const space = await findSpaceById(member.spaceId);
  if (!space) return null;
  return { space, member };
}

async function attachMembers(space) {
  space.members = await listMembers(space.id);
  return space;
}

// 对外返回时剥离 token，避免互相冒充
function publicSpace(space) {
  return {
    ...space,
    members: space.members.map(({ token, spaceId, loginCode, ...rest }) => rest),
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
app.get('/api/health', (req, res) => {
  res.json({ ok: true, supabase: !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) });
});

// 创建情侣空间
app.post('/api/spaces', async (req, res, next) => {
  try {
    const { name, nickname, timezone } = req.body || {};
    if (!nickname || !String(nickname).trim()) return res.status(400).json({ error: '请填写昵称' });
    const space = {
      id: id('sp_'),
      name: String(name || '').trim() || '我们的空间',
      inviteCode: await uniqueInviteCode(),
      togetherSince: null,
      createdAt: new Date().toISOString(),
    };
    await insertSpace(space);
    const member = {
      id: id('m_'), spaceId: space.id, nickname: String(nickname).trim(),
      timezone: timezone || 'Asia/Shanghai', color: '#6ea8fe', token: newToken(), loginCode: await uniqueLoginCode(),
    };
    await insertMember(member);
    await attachMembers(space);
    res.json({ space: publicSpace(space), memberId: member.id, token: member.token, events: [] });
  } catch (e) { next(e); }
});

// 加入情侣空间
app.post('/api/spaces/join', async (req, res, next) => {
  try {
    const { inviteCode, nickname, timezone } = req.body || {};
    if (!nickname || !String(nickname).trim()) return res.status(400).json({ error: '请填写昵称' });
    const space = await findSpaceByInvite(String(inviteCode || '').toUpperCase().trim());
    if (!space) return res.status(404).json({ error: '邀请码无效，请检查' });
    const members = await listMembers(space.id);
    if (members.length >= 2) return res.status(409).json({ error: '这个空间已经有两个人啦' });
    const member = {
      id: id('m_'), spaceId: space.id, nickname: String(nickname).trim(),
      timezone: timezone || 'Asia/Shanghai', color: '#f472b6', token: newToken(), loginCode: await uniqueLoginCode(),
    };
    await insertMember(member);
    await attachMembers(space);
    broadcast(space.id, { type: 'space:updated' });
    const events = await listEvents(space.id);
    res.json({ space: publicSpace(space), memberId: member.id, token: member.token, events });
  } catch (e) { next(e); }
});

// 获取当前空间与全部日程
app.get('/api/space', async (req, res, next) => {
  try {
    const auth = await getAuth(req);
    if (!auth) return res.status(401).json({ error: '未登录' });
    await attachMembers(auth.space);
    const events = await listEvents(auth.space.id);
    res.json({ space: publicSpace(auth.space), memberId: auth.member.id, events });
  } catch (e) { next(e); }
});

// 更新空间设置 + 自己的资料
app.patch('/api/space', async (req, res, next) => {
  try {
    const auth = await getAuth(req);
    if (!auth) return res.status(401).json({ error: '未登录' });
    const { name, togetherSince, member } = req.body || {};
    const spacePatch = {};
    if (name !== undefined) spacePatch.name = String(name).trim() || auth.space.name;
    if (togetherSince !== undefined) spacePatch.togetherSince = togetherSince === '' || togetherSince === null ? null : String(togetherSince);
    await updateSpace(auth.space.id, spacePatch);
    if (member && typeof member === 'object') {
      const mPatch = {};
      if (member.nickname !== undefined) { const nn = String(member.nickname).trim(); if (nn) mPatch.nickname = nn; }
      if (member.timezone !== undefined) mPatch.timezone = member.timezone;
      if (member.color !== undefined) mPatch.color = member.color;
      await updateMember(auth.member.id, mPatch);
    }
    const space = await findSpaceById(auth.space.id);
    await attachMembers(space);
    broadcast(space.id, { type: 'space:updated' });
    res.json({ space: publicSpace(space), memberId: auth.member.id });
  } catch (e) { next(e); }
});

// 重新生成邀请码
app.post('/api/space/regenerate-invite', async (req, res, next) => {
  try {
    const auth = await getAuth(req);
    if (!auth) return res.status(401).json({ error: '未登录' });
    const code = await uniqueInviteCode();
    await updateSpace(auth.space.id, { inviteCode: code });
    broadcast(auth.space.id, { type: 'space:updated' });
    res.json({ inviteCode: code });
  } catch (e) { next(e); }
});

// 新建日程
app.post('/api/events', async (req, res, next) => {
  try {
    const auth = await getAuth(req);
    if (!auth) return res.status(401).json({ error: '未登录' });
    const ev = sanitizeEvent(req.body || {}, auth.space.id, auth.member.id);
    if (ev.error) return res.status(400).json({ error: ev.error });
    await insertEvent(ev);
    broadcast(auth.space.id, { type: 'event', action: 'create', event: ev });
    res.json({ event: ev });
  } catch (e) { next(e); }
});

// 更新日程
app.put('/api/events/:id', async (req, res, next) => {
  try {
    const auth = await getAuth(req);
    if (!auth) return res.status(401).json({ error: '未登录' });
    const existing = await findEvent(req.params.id, auth.space.id);
    if (!existing) return res.status(404).json({ error: '日程不存在' });
    const merged = sanitizeEvent({ ...req.body, id: existing.id, createdAt: existing.createdAt }, auth.space.id, existing.authorId);
    if (merged.error) return res.status(400).json({ error: merged.error });
    await updateEvent(merged);
    broadcast(auth.space.id, { type: 'event', action: 'update', event: merged });
    res.json({ event: merged });
  } catch (e) { next(e); }
});

// 删除日程
app.delete('/api/events/:id', async (req, res, next) => {
  try {
    const auth = await getAuth(req);
    if (!auth) return res.status(401).json({ error: '未登录' });
    const existing = await findEvent(req.params.id, auth.space.id);
    if (!existing) return res.status(404).json({ error: '日程不存在' });
    await deleteEvent(req.params.id);
    broadcast(auth.space.id, { type: 'event', action: 'delete', event: { id: req.params.id } });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// 用登录码登录（换设备/退出后回到自己的空间）
app.post('/api/login', async (req, res, next) => {
  try {
    const { loginCode } = req.body || {};
    const member = await findMemberByLoginCode(String(loginCode || '').toUpperCase().trim());
    if (!member) return res.status(404).json({ error: '登录码无效，请检查' });
    const space = await findSpaceById(member.spaceId);
    if (!space) return res.status(404).json({ error: '空间不存在' });
    await attachMembers(space);
    const events = await listEvents(space.id);
    res.json({ space: publicSpace(space), memberId: member.id, token: member.token, events });
  } catch (e) { next(e); }
});

// 获取（或首次生成）我的登录码
app.post('/api/me/login-code', async (req, res, next) => {
  try {
    const auth = await getAuth(req);
    if (!auth) return res.status(401).json({ error: '未登录' });
    let code = auth.member.loginCode;
    if (!code) {
      code = await uniqueLoginCode();
      await setMemberLoginCode(auth.member.id, code);
    }
    res.json({ loginCode: code });
  } catch (e) { next(e); }
});

// 导出全部数据（备份）
app.get('/api/export', async (req, res, next) => {
  try {
    const auth = await getAuth(req);
    if (!auth) return res.status(401).json({ error: '未登录' });
    await attachMembers(auth.space);
    const events = await listEvents(auth.space.id);
    const backup = {
      app: 'couple-calendar',
      version: 1,
      exportedAt: new Date().toISOString(),
      space: {
        name: auth.space.name,
        inviteCode: auth.space.inviteCode,
        togetherSince: auth.space.togetherSince,
        members: auth.space.members.map((m) => ({ id: m.id, nickname: m.nickname, timezone: m.timezone, color: m.color })),
      },
      events,
    };
    res.setHeader('Content-Disposition', 'attachment; filename="couple-calendar-backup.json"');
    res.json(backup);
  } catch (e) { next(e); }
});

// 导入备份（覆盖当前空间日程）
app.post('/api/import', async (req, res, next) => {
  try {
    const auth = await getAuth(req);
    if (!auth) return res.status(401).json({ error: '未登录' });
    const data = req.body || {};
    if (!Array.isArray(data.events)) return res.status(400).json({ error: '备份文件格式不正确' });
    await attachMembers(auth.space);
    const currentMembers = auth.space.members;
    const backupMembers = Array.isArray(data.space && data.space.members) ? data.space.members : [];
    const authorMap = {};
    backupMembers.forEach((bm, i) => { if (bm && bm.id && currentMembers[i]) authorMap[bm.id] = currentMembers[i].id; });

    if (data.space) {
      const spacePatch = {};
      if (typeof data.space.name === 'string' && data.space.name.trim()) spacePatch.name = data.space.name.trim();
      if (data.space.togetherSince !== undefined) spacePatch.togetherSince = data.space.togetherSince || null;
      await updateSpace(auth.space.id, spacePatch);
    }

    await deleteEventsBySpace(auth.space.id);
    const now = new Date().toISOString();
    for (const ev of data.events) {
      const startMs = Date.parse(ev.start);
      const endMs = Date.parse(ev.end);
      if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs <= startMs) continue;
      const type = ['event', 'todo', 'anniversary'].includes(ev.type) ? ev.type : 'event';
      const repeat = ['none', 'daily', 'weekly', 'monthly'].includes(ev.repeat) ? ev.repeat : 'none';
      await insertEvent({
        id: id('ev_'),
        spaceId: auth.space.id,
        authorId: authorMap[ev.authorId] || auth.member.id,
        title: String(ev.title || '').trim() || '(无标题)',
        start: new Date(startMs).toISOString(),
        end: new Date(endMs).toISOString(),
        allDay: !!ev.allDay,
        notes: String(ev.notes || ''),
        type,
        done: type === 'todo' ? !!ev.done : false,
        repeat,
        reminderMinutes: (ev.reminderMinutes === null || ev.reminderMinutes === undefined) ? null : Number(ev.reminderMinutes),
        createdAt: now,
        updatedAt: now,
      });
    }
    broadcast(auth.space.id, { type: 'event', action: 'bulk-import' });
    res.json({ ok: true, imported: data.events.length });
  } catch (e) { next(e); }
});

// ---------- WebSocket 实时同步 ----------
function broadcast(spaceId, payload) {
  const msg = JSON.stringify(payload);
  for (const client of wss.clients) {
    if (client.spaceId === spaceId && client.readyState === WebSocket.OPEN) client.send(msg);
  }
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.spaceId = null;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', async (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (msg.type === 'auth' && msg.token) {
      try {
        const member = await findMemberByToken(msg.token);
        if (member) {
          ws.spaceId = member.spaceId;
          ws.memberId = member.id;
          ws.send(JSON.stringify({ type: 'authed', memberId: member.id }));
        } else {
          ws.send(JSON.stringify({ type: 'error', message: '认证失败' }));
        }
      } catch {
        ws.send(JSON.stringify({ type: 'error', message: '服务器错误' }));
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

// ---------- 错误处理 ----------
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: '服务器错误：' + (err && err.message ? err.message : '未知错误') });
});

server.listen(PORT, '0.0.0.0', () => {
  const hasSupabase = !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
  console.log(`❤ 情侣日历已启动：http://localhost:${PORT}（Supabase：${hasSupabase ? '已连接' : '未配置'}）`);
});
