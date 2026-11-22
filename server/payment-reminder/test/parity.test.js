"use strict";
// 서버(core.js)와 결제 매니저 화면(index.html)이 같은 입력에 같은 결과를 내는지 비교
process.env.TZ = "Asia/Seoul";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const core = require("../core");

const html = fs.readFileSync(path.join(__dirname, "../../../index.html"), "utf8");
function grab(name) {
  const m = html.match(new RegExp(`\\n  function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}\\n`)) || html.match(new RegExp(`\\n  function ${name}\\([^)]*\\) \\{[^\\n]*\\}\\n`));
  if (!m) throw new Error("함수를 못 찾음: " + name);
  return m[0];
}
function grabConst(name) {
  const m = html.match(new RegExp(`\\n  const ${name} = (\`[\\s\\S]*?\`|[^\\n]*);\\n`));
  if (!m) throw new Error("상수를 못 찾음: " + name);
  return m[0];
}
const names = ["cleanNameForSms", "pad", "fmt", "fmtShort", "toDate", "addDays", "startOfDay", "nextWeekRange", "weeksBetween",
  "weeksLate", "mondayOf", "isBlocked", "computeNextTerm", "buildGroupedForWeek", "tuitionFor", "hasTuitionOverride", "amountFor",
  "fillTemplate", "autoReminderId", "autoReminderContent"];
const clientSrc = ["DAY_FULL", "DAY_OFFSET", "DEFAULT_SMS_TITLE", "DEFAULT_AUTO_TEMPLATE"].map(grabConst).join("") + names.map(grab).join("");

const roster = [
  { name: "정원준", classRaw: "1번(이선생)(화-1 15:10)", endDateISO: "2026-11-28", startDateISO: "2026-10-06", age: 10, phone: "010-1111-2222", teacher: "이시형", day: "화", time: "15:10", discount: "" },
  { name: "신지환A", classRaw: "2번(이현우)(화-2 16:50)", endDateISO: "2026-11-21", startDateISO: "2026-09-29", age: 7, phone: "010-3333-4444", teacher: "이현우", day: "화", time: "16:50", discount: "형제" },
  { name: "조이준", classRaw: "2번(허재홍)(화-2 16:50)", endDateISO: "2026-11-28", startDateISO: "2026-10-06", age: 5, phone: "010-5555-6666", teacher: "허재홍", day: "화", time: "16:50", discount: "장기 형제" },
  { name: "고도윤", classRaw: "3번(김민수)(수-1 18:30)", endDateISO: "2026-11-28", startDateISO: "2026-10-07", age: 6, phone: "", teacher: "김민수", day: "수", time: "18:30", discount: "우수" },
  { name: "다음주", classRaw: "1번(이선생)(화-1 15:10)", endDateISO: "2026-12-05", startDateISO: "2026-10-13", age: 8, phone: "010-7777-8888", teacher: "이시형", day: "화", time: "15:10", discount: "" },
];
const config = {
  tuitionSettings: { name: "자라다 평촌원", account: "신한 140-014-795068", base: 400000, sibling: 20000, longterm: 20000, both: 40000, etcAmount: 10000, etcKeyword: "우수" },
  calendar: { holidays: [{ date: "2026-12-22", label: "임시" }], vacations: [{ start: "2026-12-29", end: "2027-01-03", label: "겨울방학" }] },
  autoReminder: { enabled: true, time: "19:00", title: "수업 등록 안내_{센터명}", template: "{이름} {나이} {교사} {요일} {8회차토} {경과} {센터명} {다음텀시작} {다음텀종료} {다음텀} {지역원계좌정보} {원비금액}" },
};
const checklist = { "조이준__2번(허재홍)(화-2 16:50)__2026-11-28": { amount: 350000 } };

for (const [label, autoReminder] of [["원 설정 문자", config.autoReminder], ["기본 문자", { enabled: true }]]) {
  test(`서버와 화면이 같은 학생·문서 id·문자를 만듦 (${label})`, () => {
    const nextSaturday = new Date(2026, 10, 28);
    const state = { tuitionSettings: { ...core.DEFAULT_TUITION_SETTINGS, ...config.tuitionSettings }, calendar: config.calendar, checklist, autoReminder };
    const ctx = vm.createContext({ state, console });
    vm.runInContext(clientSrc + "\nthis.client = { buildGroupedForWeek, autoReminderId, autoReminderContent };", ctx);
    const grouped = ctx.client.buildGroupedForWeek(roster, nextSaturday).grouped;
    const clientList = Object.values(grouped).flat().sort((a, b) => a.id.localeCompare(b.id));
    const serverList = core.studentsForWeek(roster, nextSaturday, config.calendar).sort((a, b) => a.id.localeCompare(b.id));
    assert.deepStrictEqual(serverList.map(s => [s.id, s.late, s.endDate, s.session]), clientList.map(s => [s.id, s.late, s.endDate, s.session]));
    assert.strictEqual(serverList.length, 4, "다음 주 종료 학생은 빠짐");
    const sctx = { calendar: config.calendar, tuitionSettings: state.tuitionSettings, checklist, autoReminder };
    for (const s of serverList) {
      const cs = clientList.find(x => x.id === s.id);
      assert.strictEqual(core.autoReminderId("서초반포원", "2026-11-28", s.id), ctx.client.autoReminderId("서초반포원", "2026-11-28", cs.id));
      const a = core.reminderContent(s, sctx), b = ctx.client.autoReminderContent(cs);
      assert.strictEqual(a.message, b.message, s.name + " 문자 내용");
      assert.strictEqual(a.subject, b.subject, s.name + " 제목");
    }
    const jo = serverList.find(s => s.name === "조이준");
    assert.ok(core.reminderContent(jo, sctx).message.includes("350,000"), "고친 원비 반영");
  });
}
