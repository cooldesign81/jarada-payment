"use strict";
// 결제 매니저(index.html)와 같은 규칙으로 명단·원비·다음 텀·문자 내용을 계산하는 함수 모음.
// 화면 쪽 코드를 그대로 옮긴 것이라, 규칙을 바꿀 때는 index.html 의 같은 이름 함수도 함께 바꿔야 함.
// 날짜는 한국 시간 기준 — index.js 에서 process.env.TZ = "Asia/Seoul" 을 먼저 설정함.

const DAY_FULL = { "월": "월요일", "화": "화요일", "수": "수요일", "목": "목요일", "금": "금요일", "토": "토요일", "일": "일요일" };
const DAY_OFFSET = { "월": 0, "화": 1, "수": 2, "목": 3, "금": 4, "토": 5, "일": 6 };
const DAY_LETTERS = ["일", "월", "화", "수", "목", "금", "토"];

const DEFAULT_TUITION_SETTINGS = {
  name: "", account: "",
  base: 440000, sibling: 20000, longterm: 20000, both: 40000,
  etcAmount: 0, etcKeyword: "",
};
const DEFAULT_SMS_TITLE = "수업 등록 안내_{센터명}";
const DEFAULT_AUTO_TEMPLATE = `안녕하세요? {센터명}입니다. 

{이름} 연구원 수업등록 안내드립니다. 
등록기간: {다음텀}
원비 {원비금액}원 (2개월 8회) 

내방 후 카드 결제 또는 계좌이체, 제로페이 가능합니다. 
계좌이체 시 연구원 이름으로 입금 부탁드립니다.
계좌정보 : {지역원계좌정보}

감사합니다.`;

function cleanNameForSms(name) {
  return String(name).replace(/\s*[A-Za-z]+$/, "").trim();
}
function pad(n) { return String(n).padStart(2, "0"); }
function fmt(d) {
  if (!d) return "-";
  const date = d instanceof Date ? d : new Date(d);
  if (isNaN(date.getTime())) return String(d);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
function fmtShort(d) {
  if (!d) return "-";
  const date = d instanceof Date ? d : new Date(d);
  if (isNaN(date.getTime())) return String(d);
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
function toDate(v) {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  if (isNaN(d.getTime())) return null;
  return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}
function addDays(d, n) { const r = new Date(d); r.setDate(r.getDate() + n); return r; }
function startOfDay(d) { const r = new Date(d); r.setHours(0, 0, 0, 0); return r; }
function nextWeekRange(ref) {
  const day = ref.getDay();
  const diffToMonday = day === 0 ? -6 : 1 - day;
  const thisMonday = startOfDay(addDays(ref, diffToMonday));
  const nextSaturday = addDays(thisMonday, 5);
  return { nextMonday: thisMonday, nextSaturday };
}
function weeksBetween(start, end) {
  if (!start || !end) return null;
  return Math.round((end.getTime() - start.getTime()) / (7 * 86400000)) + 1;
}
function mondayOf(d) {
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  return addDays(d, diff);
}
function isBlocked(date, cal) {
  const iso = fmt(date);
  if ((cal.holidays || []).some(h => h.date === iso)) return true;
  return (cal.vacations || []).some(v => iso >= v.start && iso <= v.end);
}
function weeksLate(end, asOf, cal, dayLetter) {
  if (!end || !asOf) return 0;
  if (asOf.getTime() <= end.getTime()) return 0;
  const offset = DAY_OFFSET[dayLetter];
  let candidate = addDays(end, 7);
  let counted = 0, guard = 0;
  while (candidate.getTime() <= asOf.getTime() && guard < 60) {
    const classDate = offset !== undefined ? addDays(mondayOf(candidate), offset) : candidate;
    if (!cal || !isBlocked(classDate, cal)) counted++;
    candidate = addDays(candidate, 7);
    guard++;
  }
  return counted;
}
function computeNextTerm(entry, cal) {
  if (!entry.endDateISO) return null;
  const endDate = toDate(entry.endDateISO);
  const offset = DAY_OFFSET[entry.day];
  if (offset === undefined) return null;
  const nextMonday = addDays(mondayOf(endDate), 7);
  let candidate = addDays(nextMonday, offset);
  let count = 0, firstDate = null, lastDate = null, guard = 0;
  while (count < 8 && guard < 60) {
    if (!isBlocked(candidate, cal)) {
      if (count === 0) firstDate = candidate;
      count += 1;
      lastDate = candidate;
    }
    candidate = addDays(candidate, 7);
    guard += 1;
  }
  if (!firstDate || !lastDate) return null;
  return { termStart: firstDate, termEnd: lastDate };
}
// 그 주(토요일 nextSaturday 까지)에 결제 대상인 학생 목록 — 화면의 buildGroupedForWeek 와 같은 결과
function studentsForWeek(rawRows, nextSaturday, cal) {
  const list = [];
  (rawRows || []).forEach(r => {
    const end = toDate(r.endDateISO);
    if (!end) return;
    if (end.getTime() > nextSaturday.getTime()) return;
    const start = r.startDateISO ? toDate(r.startDateISO) : null;
    list.push({
      id: `${r.name}__${r.classRaw}__${r.endDateISO}`,
      name: r.name, age: r.age, phone: r.phone,
      teacher: r.teacher, day: r.day, time: r.time,
      endDate: fmtShort(end), endDateISO: r.endDateISO,
      session: weeksBetween(start, end) ?? "-",
      late: weeksLate(end, nextSaturday, cal, r.day),
      discount: r.discount,
    });
  });
  return list;
}
function tuitionFor(entry, t) {
  const base = Number(t.base) || 0;
  const d = entry.discount || "";
  const hasSibling = d.includes("형제");
  const hasLongTerm = d.includes("장기");
  const hasEtc = t.etcKeyword && d.includes(t.etcKeyword);
  let discount = 0;
  if (hasSibling && hasLongTerm) discount = Number(t.both) || 0;
  else if (hasSibling) discount = Number(t.sibling) || 0;
  else if (hasLongTerm) discount = Number(t.longterm) || 0;
  else if (hasEtc) discount = Number(t.etcAmount) || 0;
  return base - discount;
}
function hasTuitionOverride(c) { return !!c && c.amount !== undefined && c.amount !== null && c.amount !== ""; }
function amountFor(entry, checklist, t) {
  const c = checklist[entry.id];
  return hasTuitionOverride(c) ? Number(c.amount) || 0 : tuitionFor(entry, t);
}
function fillTemplate(tpl, s, ctx) {
  const nt = computeNextTerm(s, ctx.calendar);
  const tuition = amountFor(s, ctx.checklist, ctx.tuitionSettings);
  return String(tpl)
    .replaceAll("{이름}", cleanNameForSms(s.name))
    .replaceAll("{나이}", String(s.age))
    .replaceAll("{교사}", s.teacher)
    .replaceAll("{요일}", DAY_FULL[s.day] || s.day)
    .replaceAll("{8회차토}", s.endDate)
    .replaceAll("{경과}", s.late >= 1 ? `${s.late}주` : "0주")
    .replaceAll("{센터명}", ctx.tuitionSettings.name || "학원")
    .replaceAll("{다음텀시작}", nt ? fmtShort(nt.termStart) : "-")
    .replaceAll("{다음텀종료}", nt ? fmtShort(nt.termEnd) : "-")
    .replaceAll("{다음텀}", nt ? `${fmtShort(nt.termStart)}~${fmtShort(nt.termEnd)}` : "-")
    .replaceAll("{지역원계좌정보}", (ctx.tuitionSettings.account && ctx.tuitionSettings.account.trim()) || "-")
    .replaceAll("{원비금액}", tuition !== null ? tuition.toLocaleString("en-US") : "-");
}
// 화면의 autoReminderId 와 같은 문서 id — 서버와 화면이 같은 학생을 예약해도 한 건만 남음
function autoReminderId(center, wk, sid) { return `auto|${center}|${wk}|${sid}`.replace(/\//g, "／"); }
function autoReminderKey(center, wk) { return `${center}|${wk}`; }
function reminderTime(ar) {
  const t = String((ar && ar.time) || "");
  return /^\d{2}:\d{2}$/.test(t) ? t : "19:00";
}
function reminderContent(s, ctx) {
  const ar = ctx.autoReminder || {};
  const message = fillTemplate(ar.template || DEFAULT_AUTO_TEMPLATE, s, ctx);
  const subject = (fillTemplate(ar.title || DEFAULT_SMS_TITLE, s, ctx) || "결제 안내").trim().slice(0, 40);
  return { message, subject };
}

module.exports = {
  DAY_FULL, DAY_OFFSET, DAY_LETTERS, DEFAULT_TUITION_SETTINGS, DEFAULT_SMS_TITLE, DEFAULT_AUTO_TEMPLATE,
  fmt, fmtShort, toDate, addDays, startOfDay, nextWeekRange, studentsForWeek, tuitionFor, amountFor,
  fillTemplate, computeNextTerm, autoReminderId, autoReminderKey, reminderTime, reminderContent,
};
