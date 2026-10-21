// Supabase 持久化层：数据存入 Supabase Postgres，重启 / 休眠 / 重新部署都不会丢。
// 服务端使用 service_role 密钥（绕过 RLS），浏览器永不直接接触 Supabase。
import { createClient } from '@supabase/supabase-js';

let client = null;

export function getSupabase() {
  if (client) return client;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('缺少环境变量 SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY，请先配置（见 SUPABASE-迁移.md）');
  }
  client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  return client;
}

// ---------- 字段映射（JS 驼峰 ↔ 数据库下划线）----------
function spaceToDb(s) {
  const o = {};
  if (s.id !== undefined) o.id = s.id;
  if (s.name !== undefined) o.name = s.name;
  if (s.inviteCode !== undefined) o.invite_code = s.inviteCode;
  if (s.togetherSince !== undefined) o.together_since = s.togetherSince;
  if (s.createdAt !== undefined) o.created_at = s.createdAt;
  return o;
}
function spaceFromDb(r) {
  return { id: r.id, name: r.name, inviteCode: r.invite_code, togetherSince: r.together_since, members: [], createdAt: r.created_at };
}
function memberToDb(m) {
  return { id: m.id, space_id: m.spaceId, nickname: m.nickname, timezone: m.timezone, color: m.color, token: m.token };
}
function memberFromDb(r) {
  return { id: r.id, spaceId: r.space_id, nickname: r.nickname, timezone: r.timezone, color: r.color, token: r.token };
}
function evToDb(e) {
  return {
    id: e.id, space_id: e.spaceId, author_id: e.authorId, title: e.title,
    start_at: e.start, end_at: e.end, all_day: e.allDay, notes: e.notes,
    type: e.type, done: e.done, repeat: e.repeat,
    reminder_minutes: e.reminderMinutes, created_at: e.createdAt, updated_at: e.updatedAt,
  };
}
function evFromDb(r) {
  return {
    id: r.id, spaceId: r.space_id, authorId: r.author_id, title: r.title,
    start: r.start_at, end: r.end_at, allDay: r.all_day, notes: r.notes,
    type: r.type, done: r.done, repeat: r.repeat,
    reminderMinutes: r.reminder_minutes, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

// ---------- 空间 ----------
export async function insertSpace(space) {
  const { error } = await getSupabase().from('spaces').insert(spaceToDb(space));
  if (error) throw error;
}
export async function findSpaceByInvite(code) {
  const { data, error } = await getSupabase().from('spaces').select('*').eq('invite_code', code).maybeSingle();
  if (error) throw error;
  return data ? spaceFromDb(data) : null;
}
export async function findSpaceById(id) {
  const { data, error } = await getSupabase().from('spaces').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return data ? spaceFromDb(data) : null;
}
export async function updateSpace(id, patch) {
  const allowed = {};
  if (patch.name !== undefined) allowed.name = patch.name;
  if (patch.togetherSince !== undefined) allowed.together_since = patch.togetherSince;
  if (patch.inviteCode !== undefined) allowed.invite_code = patch.inviteCode;
  if (Object.keys(allowed).length === 0) return;
  const { error } = await getSupabase().from('spaces').update(allowed).eq('id', id);
  if (error) throw error;
}

// ---------- 成员 ----------
export async function insertMember(member) {
  const { error } = await getSupabase().from('members').insert(memberToDb(member));
  if (error) throw error;
}
export async function updateMember(id, patch) {
  const allowed = {};
  if (patch.nickname !== undefined) allowed.nickname = patch.nickname;
  if (patch.timezone !== undefined) allowed.timezone = patch.timezone;
  if (patch.color !== undefined) allowed.color = patch.color;
  if (Object.keys(allowed).length === 0) return;
  const { error } = await getSupabase().from('members').update(allowed).eq('id', id);
  if (error) throw error;
}
export async function findMemberByToken(token) {
  const { data, error } = await getSupabase().from('members').select('*').eq('token', token).maybeSingle();
  if (error) throw error;
  return data ? memberFromDb(data) : null;
}
export async function listMembers(spaceId) {
  const { data, error } = await getSupabase().from('members').select('*').eq('space_id', spaceId).order('created_at', { ascending: true });
  if (error) throw error;
  return (data || []).map(memberFromDb);
}

// ---------- 事件 ----------
export async function listEvents(spaceId) {
  const { data, error } = await getSupabase().from('events').select('*').eq('space_id', spaceId);
  if (error) throw error;
  return (data || []).map(evFromDb);
}
export async function insertEvent(ev) {
  const { error } = await getSupabase().from('events').insert(evToDb(ev));
  if (error) throw error;
}
export async function findEvent(id, spaceId) {
  const { data, error } = await getSupabase().from('events').select('*').eq('id', id).eq('space_id', spaceId).maybeSingle();
  if (error) throw error;
  return data ? evFromDb(data) : null;
}
export async function updateEvent(ev) {
  const { error } = await getSupabase().from('events').update(evToDb(ev)).eq('id', ev.id);
  if (error) throw error;
}
export async function deleteEvent(id) {
  const { error } = await getSupabase().from('events').delete().eq('id', id);
  if (error) throw error;
}
