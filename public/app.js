import {
  listTimeZones, guessTimezone, zonedParts, zonedToUTC, tzDiffMinutes,
  fmtTime, weekdayName, diffLabel, addToWall,
} from './tz.js';

// ---------- 基础工具 ----------
const pad = (n) => String(n).padStart(2, '0');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const $ = (id) => document.getElementById(id);

const calendarEl = $('calendar');
const WEEK_CN = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

// ---------- 状态 ----------
const state = {
  token: null,
  memberId: null,
  space: null,
  me: null,
  partner: null,
  events: [],
  view: 'month',
  cursor: new Date(),
  perspective: 'me',
  editingId: null,
  viewingEvent: null,
  freeTime: false,
};

// ---------- 墙钟日期工具（在某时区下）----------
function wallFromUtc(utc, tz) {
  const p = zonedParts(new Date(utc), tz);
  return { year: p.year, month: p.month, day: p.day };
}
function wallKey(w) { return `${w.year}-${String(w.month).padStart(2, '0')}-${String(w.day).padStart(2, '0')}`; }
function dayKeyOf(utc, tz) { return wallKey(wallFromUtc(utc, tz)); }
function addDaysWall(w, n) {
  const d = new Date(Date.UTC(w.year, w.month - 1, w.day));
  d.setUTCDate(d.getUTCDate() + n);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}
function compareWall(a, b) { return (a.year - b.year) || (a.month - b.month) || (a.day - b.day); }
function mondayIndexOfWall(w) { return (new Date(Date.UTC(w.year, w.month - 1, w.day)).getUTCDay() + 6) % 7; }
function localMidnight(w, tz) { return zonedToUTC({ year: w.year, month: w.month, day: w.day, hour: 0, minute: 0 }, tz); }
function localMinutesOf(utc, tz) { const p = zonedParts(new Date(utc), tz); return p.hour * 60 + p.minute; }
function parseDateStr(s) { const [y, m, d] = String(s).split('-').map(Number); return { year: y, month: m, day: d }; }

function displayTz() {
  if (state.perspective === 'partner' && state.partner) return state.partner.timezone;
  return state.me.timezone;
}
function memberColor(id) { const m = state.space.members.find((x) => x.id === id); return m ? m.color : '#999'; }
function memberName(id) { const m = state.space.members.find((x) => x.id === id); return m ? m.nickname : '?'; }

// ---------- API ----------
async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (state.token) headers['Authorization'] = 'Bearer ' + state.token;
  const res = await fetch(path, { ...opts, headers: { ...headers, ...(opts.headers || {}) } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || '请求失败');
  return data;
}

// ---------- Toast / 通知 ----------
function toast(msg, kind) {
  const el = document.createElement('div');
  el.className = 'toast' + (kind === 'warn' ? ' warn' : '');
  el.textContent = msg;
  $('toast-container').appendChild(el);
  setTimeout(() => el.remove(), 4000);
}
let notifPermission = false;
function ensureNotif() {
  if (!('Notification' in window)) return;
  if (Notification.permission === 'granted') notifPermission = true;
  else if (Notification.permission === 'default') Notification.requestPermission().then((p) => { notifPermission = p === 'granted'; });
}

// ---------- 重复日程展开 ----------
function authorTz(ev) { const m = state.space && state.space.members.find((x) => x.id === ev.authorId); return m ? m.timezone : state.me.timezone; }

function expandEvent(ev, fromUtc, toUtc) {
  const start0 = Date.parse(ev.start);
  const end0 = Date.parse(ev.end);
  const dur = end0 - start0;
  const tz = authorTz(ev);
  const out = [];
  const reps = ev.repeat && ev.repeat !== 'none' ? ev.repeat : null;
  if (!reps) {
    if (end0 > fromUtc && start0 < toUtc) out.push({ event: ev, start: start0, end: end0 });
    return out;
  }
  let wall = wallFromUtc(start0, tz);
  let start = start0;
  let guard = 0;
  while (start + dur <= fromUtc && guard < 3000) {
    wall = addToWall(wall, reps);
    start = zonedToUTC(wall, tz).getTime();
    guard++;
  }
  let i = 0;
  while (start < toUtc && i < 800) {
    if (start + dur > fromUtc) out.push({ event: ev, start, end: start + dur });
    wall = addToWall(wall, reps);
    start = zonedToUTC(wall, tz).getTime();
    i++;
  }
  return out;
}

function expandOccurrences(fromUtc, toUtc) {
  const out = [];
  for (const ev of state.events) out.push(...expandEvent(ev, fromUtc, toUtc));
  out.sort((a, b) => a.start - b.start);
  return out;
}

function occurrenceDays(occ, tz) {
  const s = zonedParts(new Date(occ.start), tz);
  const e = zonedParts(new Date(occ.end), tz);
  let last = { year: e.year, month: e.month, day: e.day };
  if (e.hour === 0 && e.minute === 0 && e.second === 0) last = addDaysWall(last, -1);
  const days = [];
  let d = { year: s.year, month: s.month, day: s.day };
  let guard = 0;
  while (compareWall(d, last) <= 0 && guard < 40) {
    days.push(d);
    d = addDaysWall(d, 1);
    guard++;
  }
  return days;
}

function buildDayMap(occs, tz) {
  const m = new Map();
  for (const o of occs) {
    for (const d of occurrenceDays(o, tz)) {
      const k = wallKey(d);
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(o);
    }
  }
  for (const arr of m.values()) arr.sort((a, b) => a.start - b.start);
  return m;
}

// ---------- 渲染 ----------
function render() {
  if (!state.space) return;
  renderHeader();
  updateNavTitle();
  const tz = displayTz();
  if (state.view === 'month') renderMonth(tz);
  else if (state.view === 'week') renderWeek(tz);
  else renderDay(tz);
  syncViewButtons();
}

function renderHeader() {
  $('space-name').textContent = state.space.name;
  const loveEl = $('love-days');
  if (state.space.togetherSince) {
    const tz = state.me.timezone;
    const since = zonedToUTC({ ...parseDateStr(state.space.togetherSince), hour: 0, minute: 0 }, tz).getTime();
    const days = Math.floor((Date.now() - since) / 86400000);
    if (days >= 0) { loveEl.textContent = `❤ 我们已经在一起 ${days} 天`; loveEl.hidden = false; }
    else loveEl.hidden = true;
  } else loveEl.hidden = true;

  const partnerNow = $('partner-now');
  if (state.partner) {
    const diff = tzDiffMinutes(new Date(), state.partner.timezone, state.me.timezone);
    partnerNow.textContent = `对方现在 ${fmtTime(new Date(), state.partner.timezone)} · ${diffLabel(diff)}`;
  } else {
    partnerNow.textContent = '等待对方加入…';
  }

  const banner = $('invite-banner');
  if (!state.partner) { banner.hidden = false; $('banner-invite').textContent = state.space.inviteCode; }
  else banner.hidden = true;

  $('legend').innerHTML = state.space.members.map((m) =>
    `<span><span class="dot" style="background:${m.color}"></span>${esc(m.nickname)}</span>`).join('');

  document.querySelector('#perspective-toggle [data-p="partner"]').disabled = !state.partner;
}

function updateNavTitle() {
  const tz = displayTz();
  const wall = wallFromUtc(state.cursor, tz);
  let title;
  if (state.view === 'month') title = `${wall.year}年${wall.month}月`;
  else if (state.view === 'week') {
    const monday = addDaysWall(wall, -mondayIndexOfWall(wall));
    const sunday = addDaysWall(monday, 6);
    title = `${monday.year}年${monday.month}月${monday.day}日 – ${sunday.month}月${sunday.day}日`;
  } else title = `${wall.year}年${wall.month}月${wall.day}日 ${weekdayName(state.cursor, tz)}`;
  $('nav-title').textContent = title;
}

function renderMonth(tz) {
  const wall = wallFromUtc(state.cursor, tz);
  const first = { year: wall.year, month: wall.month, day: 1 };
  const gridStart = addDaysWall(first, -mondayIndexOfWall(first));
  const fromUtc = localMidnight(gridStart, tz).getTime();
  const toUtc = localMidnight(addDaysWall(gridStart, 42), tz).getTime();
  const byDay = buildDayMap(expandOccurrences(fromUtc, toUtc), tz);
  const todayKey = dayKeyOf(new Date(), tz);

  const header = WEEK_CN.map((d) => `<div class="month-weekday">${d}</div>`).join('');
  let cells = '';
  for (let i = 0; i < 42; i++) {
    const w = addDaysWall(gridStart, i);
    const key = wallKey(w);
    const inMonth = w.month === wall.month;
    const isToday = key === todayKey;
    const occs = byDay.get(key) || [];
    const chips = occs.slice(0, 3).map((o) => {
      const ev = o.event;
      const color = memberColor(ev.authorId);
      const done = ev.type === 'todo' && ev.done;
      const t = ev.allDay ? '' : `<span class="t">${fmtTime(new Date(o.start), tz)}</span>`;
      return `<div class="month-chip" style="background:${color};${done ? 'opacity:.55' : ''}" data-ev="${ev.id}" data-start="${o.start}">${t}${esc(ev.title)}</div>`;
    }).join('');
    const more = occs.length > 3 ? `<div class="month-more">+${occs.length - 3} 更多</div>` : '';
    cells += `<div class="month-cell ${inMonth ? '' : 'other'} ${isToday ? 'today' : ''}" data-day="${key}">
      <div class="month-daynum">${w.day}</div>${chips}${more}</div>`;
  }
  calendarEl.innerHTML = `<div class="month-grid">${header}${cells}</div>`;
}

function renderWeek(tz) {
  const wall = wallFromUtc(state.cursor, tz);
  const monday = addDaysWall(wall, -mondayIndexOfWall(wall));
  const days = Array.from({ length: 7 }, (_, i) => addDaysWall(monday, i));
  renderTimeGrid(days, tz);
}

function renderDay(tz) {
  renderTimeGrid([wallFromUtc(state.cursor, tz)], tz);
}

function renderTimeGrid(days, tz) {
  const pxPerHour = 48;
  const n = days.length;
  const fromUtc = localMidnight(days[0], tz).getTime();
  const toUtc = localMidnight(addDaysWall(days[n - 1], 1), tz).getTime();
  const byDay = buildDayMap(expandOccurrences(fromUtc, toUtc), tz);
  const todayKey = dayKeyOf(new Date(), tz);

  let labels = '';
  for (let h = 0; h < 24; h++) labels += `<div class="time-label" style="top:${h * pxPerHour}px">${pad(h)}:00</div>`;

  let heads = '';
  let cols = '';
  for (const w of days) {
    const key = wallKey(w);
    const ds = localMidnight(w, tz).getTime();
    const de = localMidnight(addDaysWall(w, 1), tz).getTime();
    const isToday = key === todayKey;
    const dayOccs = byDay.get(key) || [];
    const allday = dayOccs.filter((o) => o.event.allDay);
    const timed = dayOccs.filter((o) => !o.event.allDay);

    const alldayChips = allday.map((o) =>
      `<div class="event-block allday" style="background:${memberColor(o.event.authorId)}" data-ev="${o.event.id}" data-start="${o.start}">${esc(o.event.title)}</div>`).join('');
    heads += `<div class="day-head ${isToday ? 'today' : ''}"><div class="wd">${WEEK_CN[mondayIndexOfWall(w)]}</div><div>${w.month}/${w.day}</div><div class="all-day-row">${alldayChips}</div></div>`;

    let lines = '';
    for (let h = 0; h < 24; h++) lines += `<div class="hour-line" style="top:${h * pxPerHour}px"></div>`;

    let blocks = '';
    for (const o of timed) {
      const s = Math.max(o.start, ds);
      const e = Math.min(o.end, de);
      if (e <= s) continue;
      const top = (localMinutesOf(s, tz) / 60) * pxPerHour;
      const hgt = Math.max(20, ((e - s) / 3600000) * pxPerHour);
      const done = o.event.type === 'todo' && o.event.done;
      blocks += `<div class="event-block" style="top:${top}px;height:${hgt}px;background:${memberColor(o.event.authorId)};${done ? 'opacity:.55' : ''}" data-ev="${o.event.id}" data-start="${o.start}">
        <span class="et">${esc(o.event.title)}</span> ${fmtTime(new Date(s), tz)}–${fmtTime(new Date(e), tz)}</div>`;
    }

    let nowLine = '';
    if (isToday) {
      const nm = localMinutesOf(Date.now(), tz);
      if (nm >= 0 && nm <= 1440) nowLine = `<div class="now-line" style="top:${(nm / 60) * pxPerHour}px"><span class="now-dot"></span></div>`;
    }

    let freeBands = '';
    if (state.freeTime) {
      freeBands = freeIntervals(ds, de, tz, dayOccs).map((f) =>
        `<div class="free-band" style="top:${(f.startMin / 60) * pxPerHour}px;height:${((f.endMin - f.startMin) / 60) * pxPerHour}px"></div>`).join('');
    }

    cols += `<div class="day-col" data-day="${key}">${lines}${freeBands}${blocks}${nowLine}</div>`;
  }

  calendarEl.innerHTML = `<div class="time-grid-wrap">
    <div class="week-head" style="grid-template-columns:44px repeat(${n},1fr)"><div></div>${heads}</div>
    <div class="time-grid" style="min-width:${n === 1 ? 300 : 660}px">
      <div class="time-labels">${labels}</div>
      <div class="day-cols" style="grid-template-columns:repeat(${n},1fr)">${cols}</div>
    </div></div>`;
}

function freeIntervals(dayStartUtc, dayEndUtc, tz, occs) {
  const slot = 30;
  const busy = new Array(48).fill(false);
  for (const o of occs) {
    if (o.event.allDay) { busy.fill(true); break; }
    const s = Math.max(o.start, dayStartUtc);
    const e = Math.min(o.end, dayEndUtc);
    if (e <= s) continue;
    const si = Math.max(0, Math.floor(localMinutesOf(s, tz) / slot));
    const ei = Math.min(48, Math.ceil(localMinutesOf(e, tz) / slot));
    for (let i = si; i < ei; i++) busy[i] = true;
  }
  const out = [];
  let i = 0;
  while (i < 48) {
    if (!busy[i]) {
      const st = i;
      while (i < 48 && !busy[i]) i++;
      out.push({ startMin: st * slot, endMin: i * slot });
    } else i++;
  }
  return out;
}

function syncViewButtons() {
  document.querySelectorAll('.view-switch button').forEach((b) => b.classList.toggle('active', b.dataset.view === state.view));
  document.querySelectorAll('#perspective-toggle button').forEach((b) => b.classList.toggle('active', b.dataset.p === state.perspective));
}

// ---------- 导航 ----------
function nav(delta) {
  const tz = displayTz();
  const wall = wallFromUtc(state.cursor, tz);
  let next;
  if (state.view === 'month') next = { year: wall.year, month: wall.month + delta, day: 1 };
  else if (state.view === 'week') next = addDaysWall(wall, delta * 7);
  else next = addDaysWall(wall, delta);
  state.cursor = zonedToUTC({ ...next, hour: 12, minute: 0 }, tz);
  render();
}
function goToDay(key) {
  const w = parseDateStr(key);
  state.cursor = zonedToUTC({ ...w, hour: 12, minute: 0 }, displayTz());
  state.view = 'day';
  render();
}

// ---------- 弹窗 ----------
function openModal(id) { $(id).hidden = false; }
function closeModal(id) { $(id).hidden = true; }

function fmtRange(startMs, endMs, tz, allDay) {
  if (allDay) {
    const s = wallFromUtc(startMs, tz);
    const ePrev = addDaysWall(wallFromUtc(endMs, tz), -1);
    if (compareWall(s, ePrev) === 0) return `${s.year}年${s.month}月${s.day}日（全天）`;
    return `${s.year}年${s.month}月${s.day}日 – ${ePrev.year}年${ePrev.month}月${ePrev.day}日（全天）`;
  }
  const s = zonedParts(new Date(startMs), tz);
  const e = zonedParts(new Date(endMs), tz);
  const wd = weekdayName(new Date(startMs), tz);
  if (s.year === e.year && s.month === e.month && s.day === e.day) {
    return `${wd} ${s.month}月${s.day}日 ${pad(s.hour)}:${pad(s.minute)} – ${pad(e.hour)}:${pad(e.minute)}`;
  }
  return `${s.month}月${s.day}日 ${pad(s.hour)}:${pad(s.minute)} – ${e.month}月${e.day}日 ${pad(e.hour)}:${pad(e.minute)}`;
}

function openDetail(evId, occStart) {
  const ev = state.events.find((e) => e.id === evId);
  if (!ev) return;
  state.viewingEvent = { ev, occStart: occStart != null ? occStart : null };
  renderDetail();
  openModal('modal-detail');
}

function renderDetail() {
  const { ev, occStart } = state.viewingEvent;
  const tzMe = state.me.timezone;
  const startMs = occStart != null ? occStart : Date.parse(ev.start);
  const endMs = startMs + (Date.parse(ev.end) - Date.parse(ev.start));
  const allDay = !!ev.allDay;

  $('detail-title').innerHTML = `${esc(ev.title)} <span class="tag" style="background:${memberColor(ev.authorId)};color:#fff">${esc(memberName(ev.authorId))}</span>`;

  const typeName = { event: '普通日程', todo: '待办', anniversary: '纪念日' }[ev.type] || '日程';
  const repeatName = { daily: '每天重复', weekly: '每周重复', monthly: '每月重复' }[ev.repeat];
  let html = `<div class="detail-row"><span class="tag">${typeName}</span>`;
  if (repeatName) html += `<span class="tag">${repeatName}</span>`;
  if (ev.type === 'todo') html += `<span class="tag ${ev.done ? 'done' : ''}">${ev.done ? '已完成' : '未完成'}</span>`;
  html += `</div>`;

  html += `<div class="detail-row"><div class="k">时间</div><div class="detail-times">
    <div class="time-card"><div class="who">我的时间</div><div class="when">${esc(fmtRange(startMs, endMs, tzMe, allDay))}</div><div class="tz-name">${esc(tzMe)}</div></div>`;
  if (state.partner) {
    const tzP = state.partner.timezone;
    html += `<div class="time-card"><div class="who">对方时间</div><div class="when">${esc(fmtRange(startMs, endMs, tzP, allDay))}</div><div class="tz-name">${esc(tzP)}</div></div></div>`;
    html += `<div class="diff-badge">时差：${esc(diffLabel(tzDiffMinutes(new Date(startMs), state.partner.timezone, tzMe)))}</div></div>`;
  } else {
    html += `</div><div class="diff-badge">对方还没加入，暂时只有我的时间</div></div>`;
  }

  if (ev.reminderMinutes !== null && ev.reminderMinutes !== undefined) {
    const rem = ev.reminderMinutes === 0 ? '开始前即时' : ev.reminderMinutes < 60 ? `提前 ${ev.reminderMinutes} 分钟` : `提前 ${ev.reminderMinutes / 60} 小时`;
    html += `<div class="detail-row"><div class="k">提醒</div>${esc(rem)}</div>`;
  }
  if (ev.notes) html += `<div class="detail-row"><div class="k">备注</div>${esc(ev.notes)}</div>`;
  $('detail-body').innerHTML = html;
}

// ---------- 编辑日程 ----------
function fillDateTimeFields(startMs, endMs, tz, allDay) {
  const s = zonedParts(new Date(startMs), tz);
  const e = allDay ? zonedParts(new Date(endMs - 1000), tz) : zonedParts(new Date(endMs), tz);
  $('e-start-date').value = `${s.year}-${pad(s.month)}-${pad(s.day)}`;
  $('e-start-time').value = `${pad(s.hour)}:${pad(s.minute)}`;
  $('e-end-date').value = `${e.year}-${pad(e.month)}-${pad(e.day)}`;
  $('e-end-time').value = `${pad(e.hour)}:${pad(e.minute)}`;
  toggleAlldayUI(allDay);
}
function toggleAlldayUI(allDay) {
  $('e-start-time').disabled = allDay;
  $('e-end-time').disabled = allDay;
}

function collectForm() {
  const title = $('e-title').value.trim();
  const type = $('e-type').value;
  const allDay = $('e-allday').checked;
  const repeat = $('e-repeat').value;
  const reminder = $('e-reminder').value;
  const notes = $('e-notes').value;
  const startDate = $('e-start-date').value;
  const endDate = $('e-end-date').value;
  const startTime = $('e-start-time').value || '00:00';
  const endTime = $('e-end-time').value || startTime;
  const tz = state.me.timezone;
  if (!title) return { error: '请填写标题' };
  if (!startDate) return { error: '请选择开始日期' };
  let start, end;
  if (allDay) {
    const [sy, sm, sd] = startDate.split('-').map(Number);
    start = zonedToUTC({ year: sy, month: sm, day: sd, hour: 0, minute: 0 }, tz);
    const ref = endDate && endDate >= startDate ? endDate : startDate;
    const [ey, em, ed] = ref.split('-').map(Number);
    end = zonedToUTC({ year: ey, month: em, day: ed + 1, hour: 0, minute: 0 }, tz);
  } else {
    if (!endDate) return { error: '请选择结束日期' };
    const [sy, sm, sd] = startDate.split('-').map(Number);
    const [sh, smm] = startTime.split(':').map(Number);
    const [ey, em, ed] = endDate.split('-').map(Number);
    const [eh, emm] = endTime.split(':').map(Number);
    start = zonedToUTC({ year: sy, month: sm, day: sd, hour: sh, minute: smm }, tz);
    end = zonedToUTC({ year: ey, month: em, day: ed, hour: eh, minute: emm }, tz);
  }
  if (end <= start) return { error: '结束时间必须晚于开始时间' };
  return { title, type, allDay, repeat, reminderMinutes: reminder === '' ? null : Number(reminder), notes, start, end };
}

function updateTzPreview() {
  const el = $('e-tz-preview');
  if (!state.partner) { el.textContent = `按我的时间（${state.me.timezone}）输入`; return; }
  const form = collectForm();
  if (form.error) { el.textContent = ''; return; }
  const tzP = state.partner.timezone;
  const s = zonedParts(form.start, tzP);
  const e = zonedParts(form.end, tzP);
  const diff = tzDiffMinutes(form.start, tzP, state.me.timezone);
  el.textContent = `按我的时间（${state.me.timezone}）输入 · 对方时间：${s.month}月${s.day}日 ${pad(s.hour)}:${pad(s.minute)}–${e.month}月${e.day}日 ${pad(e.hour)}:${pad(e.minute)} · ${diffLabel(diff)}`;
}

function openEdit(ev, prefill = {}) {
  state.editingId = ev ? ev.id : null;
  $('edit-heading').textContent = ev ? '编辑日程' : '添加日程';
  const tz = state.me.timezone;
  let startMs, endMs, allDay;
  if (ev) {
    startMs = Date.parse(ev.start);
    endMs = Date.parse(ev.end);
    allDay = !!ev.allDay;
    $('e-title').value = ev.title;
    $('e-type').value = ev.type;
    $('e-repeat').value = ev.repeat || 'none';
    $('e-reminder').value = ev.reminderMinutes === null || ev.reminderMinutes === undefined ? '' : String(ev.reminderMinutes);
    $('e-notes').value = ev.notes || '';
    $('e-allday').checked = allDay;
  } else {
    const wall = prefill.day ? parseDateStr(prefill.day) : wallFromUtc(new Date(), tz);
    const hour = prefill.hour != null ? prefill.hour : (new Date().getHours() + 1) % 24;
    startMs = zonedToUTC({ ...wall, hour, minute: 0 }, tz).getTime();
    endMs = startMs + 3600000;
    allDay = false;
    $('e-title').value = '';
    $('e-type').value = 'event';
    $('e-repeat').value = 'none';
    $('e-reminder').value = '';
    $('e-notes').value = '';
    $('e-allday').checked = false;
  }
  fillDateTimeFields(startMs, endMs, tz, allDay);
  updateTzPreview();
  openModal('modal-edit');
}

// ---------- 会话 ----------
function applySessionData(data) {
  state.space = data.space;
  state.events = data.events || [];
  state.memberId = data.memberId || state.memberId;
  state.me = state.space.members.find((m) => m.id === state.memberId);
  state.partner = state.space.members.find((m) => m.id !== state.memberId) || null;
  if (state.perspective === 'partner' && !state.partner) state.perspective = 'me';
  render();
}
async function refreshData() {
  const data = await api('/api/space');
  applySessionData(data);
}
function enterSession(data) {
  state.token = data.token;
  state.memberId = data.memberId;
  localStorage.setItem('cc_token', data.token);
  localStorage.setItem('cc_memberId', data.memberId);
  applySessionData(data);
  $('auth-view').hidden = true;
  $('app-view').hidden = false;
  connectWS();
  toast('已进入「' + data.space.name + '」');
}
function logout() {
  localStorage.removeItem('cc_token');
  localStorage.removeItem('cc_memberId');
  Object.assign(state, { token: null, memberId: null, space: null, me: null, partner: null, events: [] });
  if (ws) { try { ws.close(); } catch {} ws = null; }
  $('app-view').hidden = true;
  $('auth-view').hidden = false;
  $('auth-error').textContent = '';
}

// ---------- WebSocket ----------
let ws = null;
function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  try { ws = new WebSocket(`${proto}://${location.host}/ws`); } catch { return; }
  ws.onopen = () => { if (state.token) ws.send(JSON.stringify({ type: 'auth', token: state.token })); };
  ws.onmessage = (e) => {
    let msg; try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.type === 'event' || msg.type === 'space:updated') refreshData().catch(() => {});
  };
  ws.onclose = () => { if (state.token) setTimeout(connectWS, 2000); };
}

// ---------- 提醒 ----------
function fmtRangeShort(ev) {
  return fmtRange(Date.parse(ev.start), Date.parse(ev.end), state.me.timezone, ev.allDay);
}
function checkReminders() {
  if (!state.space) return;
  const now = Date.now();
  let notified = {};
  try { notified = JSON.parse(localStorage.getItem('cc_notified') || '{}'); } catch {}
  let changed = false;
  for (const ev of state.events) {
    if (ev.reminderMinutes === null || ev.reminderMinutes === undefined) continue;
    if (ev.type === 'todo' && ev.done) continue;
    const start = Date.parse(ev.start);
    if (now >= start - ev.reminderMinutes * 60000 && now <= start + 1000) {
      if (!notified[ev.id]) {
        const when = fmtRangeShort(ev);
        toast(`提醒：${ev.title}（${when}）`, 'warn');
        if (notifPermission && 'Notification' in window) {
          try { new Notification('我们的日历', { body: `${ev.title} · ${when}` }); } catch {}
        }
        notified[ev.id] = true;
        changed = true;
      }
    }
  }
  if (changed) localStorage.setItem('cc_notified', JSON.stringify(notified));
}

// ---------- 事件绑定 ----------
function bindEvents() {
  document.querySelectorAll('.auth-tab').forEach((t) => {
    t.addEventListener('click', () => {
      document.querySelectorAll('.auth-tab').forEach((x) => x.classList.toggle('active', x === t));
      const mode = t.dataset.tab;
      $('form-space-name').hidden = mode !== 'create';
      $('form-invite').hidden = mode !== 'join';
      $('form-login').hidden = mode !== 'login';
      $('form-profile').hidden = mode === 'login';
      $('auth-submit').textContent = mode === 'create' ? '创建空间' : mode === 'join' ? '加入空间' : '登录';
    });
  });

  $('auth-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errEl = $('auth-error');
    errEl.textContent = '';
    const mode = document.querySelector('.auth-tab.active').dataset.tab;
    const btn = $('auth-submit');
    btn.disabled = true;
    try {
      let data;
      if (mode === 'create') {
        const nickname = $('inp-nickname').value.trim();
        if (!nickname) { errEl.textContent = '请填写昵称'; return; }
        const name = $('inp-space-name').value.trim();
        data = await api('/api/spaces', { method: 'POST', body: JSON.stringify({ name, nickname, timezone: $('inp-timezone').value }) });
      } else if (mode === 'join') {
        const nickname = $('inp-nickname').value.trim();
        if (!nickname) { errEl.textContent = '请填写昵称'; return; }
        const inviteCode = $('inp-invite').value.trim();
        if (!inviteCode) { errEl.textContent = '请输入邀请码'; return; }
        data = await api('/api/spaces/join', { method: 'POST', body: JSON.stringify({ inviteCode, nickname, timezone: $('inp-timezone').value }) });
      } else {
        const loginCode = $('inp-login').value.trim();
        if (!loginCode) { errEl.textContent = '请输入登录码'; return; }
        data = await api('/api/login', { method: 'POST', body: JSON.stringify({ loginCode }) });
      }
      enterSession(data);
    } catch (err) { errEl.textContent = err.message; }
    finally { btn.disabled = false; }
  });

  document.querySelectorAll('#perspective-toggle button').forEach((b) => {
    b.addEventListener('click', () => {
      if (b.dataset.p === 'partner' && !state.partner) return;
      state.perspective = b.dataset.p;
      render();
    });
  });
  document.querySelectorAll('.view-switch button').forEach((b) => {
    b.addEventListener('click', () => { state.view = b.dataset.view; render(); });
  });
  $('btn-prev').addEventListener('click', () => nav(-1));
  $('btn-next').addEventListener('click', () => nav(1));
  $('btn-today').addEventListener('click', () => { state.cursor = new Date(); render(); });
  $('btn-add').addEventListener('click', () => openEdit(null));
  $('freetime-check').addEventListener('change', (e) => { state.freeTime = e.target.checked; render(); });

  calendarEl.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-ev]');
    if (chip) { openDetail(chip.dataset.ev, chip.dataset.start ? Number(chip.dataset.start) : null); return; }
    const cell = e.target.closest('.month-cell');
    if (cell) { goToDay(cell.dataset.day); return; }
    const col = e.target.closest('.day-col');
    if (col) {
      const rect = col.getBoundingClientRect();
      const hour = Math.min(23, Math.max(0, Math.floor((e.clientY - rect.top) / 48)));
      openEdit(null, { day: col.dataset.day, hour });
    }
  });

  $('btn-detail-delete').addEventListener('click', async () => {
    const ev = state.viewingEvent && state.viewingEvent.ev;
    if (!ev) return;
    if (!confirm(`确定删除「${ev.title}」吗？重复日程会一并删除。`)) return;
    try { await api(`/api/events/${ev.id}`, { method: 'DELETE' }); closeModal('modal-detail'); await refreshData(); toast('已删除'); }
    catch (err) { toast(err.message, 'warn'); }
  });
  $('btn-detail-edit').addEventListener('click', () => {
    const ev = state.viewingEvent && state.viewingEvent.ev;
    if (!ev) return;
    closeModal('modal-detail');
    openEdit(ev);
  });

  $('edit-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = collectForm();
    if (form.error) { toast(form.error, 'warn'); return; }
    const payload = { ...form, start: form.start.toISOString(), end: form.end.toISOString() };
    try {
      if (state.editingId) await api(`/api/events/${state.editingId}`, { method: 'PUT', body: JSON.stringify(payload) });
      else await api('/api/events', { method: 'POST', body: JSON.stringify(payload) });
      closeModal('modal-edit');
      await refreshData();
      toast('已保存');
    } catch (err) { toast(err.message, 'warn'); }
  });
  $('e-allday').addEventListener('change', () => { toggleAlldayUI($('e-allday').checked); updateTzPreview(); });
  ['e-start-date', 'e-start-time', 'e-end-date', 'e-end-time'].forEach((id) => $(id).addEventListener('change', updateTzPreview));

  $('btn-settings').addEventListener('click', async () => {
    $('s-space-name').value = state.space.name;
    $('s-nickname').value = state.me.nickname;
    $('s-timezone').value = state.me.timezone;
    $('s-color').value = state.me.color;
    $('s-together').value = state.space.togetherSince || '';
    $('s-invite').textContent = state.space.inviteCode;
    $('s-logincode').textContent = '加载中…';
    openModal('modal-settings');
    try {
      const r = await api('/api/me/login-code', { method: 'POST' });
      $('s-logincode').textContent = r.loginCode;
    } catch (e) {
      $('s-logincode').textContent = '获取失败，请重试';
    }
  });
  $('settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = {
      name: $('s-space-name').value,
      togetherSince: $('s-together').value,
      member: { nickname: $('s-nickname').value, timezone: $('s-timezone').value, color: $('s-color').value },
    };
    try { await api('/api/space', { method: 'PATCH', body: JSON.stringify(body) }); closeModal('modal-settings'); await refreshData(); toast('已保存'); }
    catch (err) { toast(err.message, 'warn'); }
  });
  async function copyText(t, label = '已复制') {
    try { await navigator.clipboard.writeText(t); toast(label); }
    catch { toast('复制失败，请手动复制'); }
  }
  $('btn-copy-invite').addEventListener('click', () => copyText($('s-invite').textContent, '已复制邀请码'));
  $('banner-copy').addEventListener('click', () => copyText($('banner-invite').textContent, '已复制邀请码'));
  $('btn-copy-logincode').addEventListener('click', () => copyText($('s-logincode').textContent, '已复制登录码'));
  $('btn-regen-invite').addEventListener('click', async () => {
    try { const r = await api('/api/space/regenerate-invite', { method: 'POST' }); $('s-invite').textContent = r.inviteCode; await refreshData(); toast('邀请码已更新'); }
    catch (err) { toast(err.message, 'warn'); }
  });

  // 导出数据（备份）
  $('btn-export').addEventListener('click', async () => {
    try {
      const res = await fetch('/api/export', { headers: { Authorization: 'Bearer ' + state.token } });
      if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || '导出失败'); }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'couple-calendar-backup.json';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast('已导出备份文件');
    } catch (err) { toast(err.message, 'warn'); }
  });

  // 导入数据（恢复）
  $('btn-import').addEventListener('click', () => $('import-file').click());
  $('import-file').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!confirm('导入会覆盖当前空间里的所有日程，确定继续吗？')) return;
      const res = await fetch('/api/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + state.token },
        body: JSON.stringify(data),
      });
      const r = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(r.error || '导入失败');
      await refreshData();
      toast(`已导入 ${r.imported} 条日程`);
    } catch (err) { toast(err.message, 'warn'); }
    finally { e.target.value = ''; }
  });

  $('btn-leave').addEventListener('click', () => {
    if (!confirm('确定退出吗？\n\n退出后可在「登录」页用「我的登录码」重新进入本空间。\n（请先确认已保存上面的登录码）')) return;
    logout();
  });

  document.addEventListener('click', (e) => {
    const closer = e.target.closest('[data-close]');
    if (closer) { closeModal(closer.dataset.close); return; }
    if (e.target.classList && e.target.classList.contains('modal-backdrop')) e.target.hidden = true;
  });
  document.addEventListener('pointerdown', ensureNotif, { once: true });
}

function populateTimezones() {
  const zones = listTimeZones();
  const gz = guessTimezone();
  for (const selId of ['inp-timezone', 's-timezone']) {
    $(selId).innerHTML = zones.map((z) => `<option value="${z}" ${z === gz ? 'selected' : ''}>${z.replace(/_/g, ' ')}</option>`).join('');
  }
  $('tz-hint').textContent = `已自动识别：${gz}`;
}

// ---------- 启动 ----------
async function init() {
  populateTimezones();
  bindEvents();
  const tok = localStorage.getItem('cc_token');
  if (tok) {
    state.token = tok;
    state.memberId = localStorage.getItem('cc_memberId');
    try {
      await refreshData();
      $('auth-view').hidden = true;
      $('app-view').hidden = false;
      connectWS();
    } catch (e) { logout(); }
  }
  setInterval(checkReminders, 30000);
}
init();
