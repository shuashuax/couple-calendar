// 时区工具：基于 Intl，自动处理夏令时（DST）
// 所有时间一律以 UTC 存储，展示时按指定 IANA 时区换算。

export function validTz(tz) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

export function listTimeZones() {
  try {
    return Intl.supportedValuesOf('timeZone');
  } catch {
    return ['UTC', 'Asia/Shanghai', 'America/New_York', 'Europe/London', 'Asia/Tokyo'];
  }
}

export function guessTimezone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return 'Asia/Shanghai'; }
}

// 返回某 UTC 时刻在某时区下的墙钟各字段（year 1-12 月、day 1-31、hour 0-23）
export function zonedParts(utcDate, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = {};
  for (const p of dtf.formatToParts(utcDate)) parts[p.type] = p.value;
  return {
    year: +parts.year,
    month: +parts.month,
    day: +parts.day,
    hour: +parts.hour,
    minute: +parts.minute,
    second: +parts.second,
  };
}

// 某 UTC 时刻在某时区相对 UTC 的偏移（分钟）。东为正。
export function tzOffsetMinutes(utcDate, tz) {
  const p = zonedParts(utcDate, tz);
  const asUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUTC - utcDate.getTime()) / 60000);
}

// 将某时区的墙钟时间转为 UTC Date（两步校正，DST 安全）
export function zonedToUTC(wall, tz) {
  let utc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, 0);
  let offset = tzOffsetMinutes(new Date(utc), tz);
  utc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, 0) - offset * 60000;
  const offset2 = tzOffsetMinutes(new Date(utc), tz);
  if (offset2 !== offset) utc -= (offset2 - offset) * 60000;
  return new Date(utc);
}

// tzA 相对 tzB 在某时刻的时差（分钟）。正数表示 tzA 更快。
export function tzDiffMinutes(utcDate, tzA, tzB) {
  return tzOffsetMinutes(utcDate, tzA) - tzOffsetMinutes(utcDate, tzB);
}

export function fmtTime(utcDate, tz, withSec = false) {
  const p = zonedParts(utcDate, tz);
  const hh = String(p.hour).padStart(2, '0');
  const mm = String(p.minute).padStart(2, '0');
  return withSec ? `${hh}:${mm}:${String(p.second).padStart(2, '0')}` : `${hh}:${mm}`;
}

export function fmtDate(utcDate, tz) {
  const p = zonedParts(utcDate, tz);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

export function weekdayName(utcDate, tz) {
  const p = zonedParts(utcDate, tz);
  return WEEK[new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay()];
}

// 时差的人类可读描述（正数=对方更快）
export function diffLabel(minutes) {
  if (minutes === 0) return '无时差';
  const sign = minutes > 0 ? '+' : '-';
  const abs = Math.abs(minutes);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  const who = minutes > 0 ? '对方比我快' : '对方比我慢';
  const parts = [];
  if (h) parts.push(`${h} 小时`);
  if (m) parts.push(`${m} 分钟`);
  return `${sign}${h ? h + 'h' : ''}${m ? m + 'm' : ''}（${who} ${parts.join('')}）`;
}

// 墙钟时间按重复规则推进（日历算术，保持本地墙钟稳定）
export function addToWall(p, repeat) {
  const dt = new Date(Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute));
  if (repeat === 'daily') dt.setUTCDate(dt.getUTCDate() + 1);
  else if (repeat === 'weekly') dt.setUTCDate(dt.getUTCDate() + 7);
  else if (repeat === 'monthly') dt.setUTCMonth(dt.getUTCMonth() + 1);
  return {
    year: dt.getUTCFullYear(),
    month: dt.getUTCMonth() + 1,
    day: dt.getUTCDate(),
    hour: dt.getUTCHours(),
    minute: dt.getUTCMinutes(),
  };
}
