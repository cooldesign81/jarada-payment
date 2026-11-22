"use strict";
process.env.TZ = "Asia/Seoul";
const test = require("node:test");
const assert = require("node:assert");
const { runReminders } = require("../reminder");
const { fakeDb } = require("./fake-db");

const raw = (name, day, phone, end = "2026-11-28") => ({ name, classRaw: `1번(이선생)(${day}-1 15:00)`, endDateISO: end, startDateISO: "2026-10-06", age: 7, phone, teacher: "이선생", day, time: "15:00", discount: "" });
const sms = { apiKey: "k", userId: "u", senderNumber: "0212345678" };
const A = "서초반포원";
const sid = r => `${r.name}__${r.classRaw}__${r.endDateISO}`;
const R = { jw: raw("정원준", "화", "010-1111-2222"), jo: raw("조이준", "화", "010-5555-6666"), go: raw("고도윤", "화", ""), kh: raw("김하나", "화", "010-0000-1111"), sj: raw("신지환A", "수", "010-3333-4444") };
const idOf = (r, wk = "2026-11-28") => `smsQueue/auto|${A}|${wk}|${sid(r)}`;
function seed(extra = {}) {
  return {
    [`centers/${A}/data/config`]: { smsSettings: sms, autoReminder: { enabled: true, time: "19:00", testMode: true, template: "{이름} 원비 {원비금액}원", title: "안내_{센터명}" }, tuitionSettings: { name: "자라다 서초", base: 440000 } },
    [`centers/${A}/data/roster`]: { rows: Object.values(R) },
    [`centers/${A}/weeks/2026-11-28`]: { checklist: { [sid(R.jo)]: { paid: true } } },
    [idOf(R.jo)]: { status: "pending", center: A },
    [idOf(R.kh)]: { status: "sent", center: A },
    "centers/안양평촌원/data/config": { autoReminder: { enabled: true } },
    "centers/안양평촌원/data/roster": { rows: [raw("안양학생", "화", "010-9999-9999")] },
    "centers/강남대치원/data/config": { smsSettings: sms, autoReminder: { enabled: false } },
    "centers/강남대치원/data/roster": { rows: [raw("강남학생", "화", "010-8888-8888")] },
    ...extra,
  };
}
const MON_9AM = new Date("2026-11-23T09:00:00+09:00");

test("월요일 오전 9시: 화요일 수업 중 결제 안 한 학생만 월 19:00로 예약", async () => {
  const db = fakeDb(seed());
  const out = await runReminders({ db, now: MON_9AM });
  const a = out.results.find(r => r.center === A);
  assert.strictEqual(out.classDate, "2026-11-24");
  assert.deepStrictEqual(a.created.map(c => c.name), ["정원준"], "결제한 조이준, 연락처 없는 고도윤, 이미 보낸 김하나, 수요일 신지환A 제외");
  assert.strictEqual(a.paid, 1); assert.strictEqual(a.noPhone, 1); assert.strictEqual(a.alreadyScheduled, 1);
  const doc = db.store.get(idOf(R.jw));
  assert.strictEqual(doc.scheduleAt, "2026-11-23T10:00:00.000Z");
  assert.strictEqual(doc.status, "pending"); assert.strictEqual(doc.testMode, true); assert.strictEqual(doc.auto, true);
  assert.strictEqual(doc.autoKey, `${A}|2026-11-28`); assert.strictEqual(doc.week, "2026-11-28"); assert.strictEqual(doc.studentId, sid(R.jw));
  assert.deepStrictEqual(doc.recipients, [{ phone: "01011112222", name: "정원준", message: "정원준 원비 440,000원", subject: "안내_자라다 서초" }]);
  assert.strictEqual(db.store.get(idOf(R.jo)).status, "cancelled", "결제했는데 대기 중이던 예약은 취소");
  assert.strictEqual(db.store.get(idOf(R.jo)).cancelReason, "paid");
  assert.strictEqual(db.store.get(idOf(R.kh)).status, "sent", "이미 보낸 문자는 건드리지 않음");
  const hb = db.store.get(`centers/${A}/data/config`).autoReminderServer;
  assert.strictEqual(hb.created, 1); assert.strictEqual(hb.classDate, "2026-11-24"); assert.strictEqual(hb.day, "화");
  assert.strictEqual(out.results.find(r => r.center === "안양평촌원").note, "문자 발송 설정 없음");
  assert.strictEqual(out.results.find(r => r.center === "강남대치원").note, "자동 예약 꺼짐");
  assert.ok(![...db.store.keys()].some(k => k.includes("강남학생") || k.includes("안양학생")), "꺼진 원·문자 계정 없는 원은 예약 안 함");
  assert.strictEqual(db.store.get("centers/강남대치원/data/config").autoReminderServer, undefined, "꺼진 원에는 실행 기록도 안 남김");
});

test("두 번 실행해도 한 건만 (이미 있으면 건너뜀)", async () => {
  const db = fakeDb(seed());
  await runReminders({ db, now: MON_9AM });
  const out2 = await runReminders({ db, now: MON_9AM });
  const a = out2.results.find(r => r.center === A);
  assert.strictEqual(a.created.length, 0); assert.strictEqual(a.alreadyScheduled, 2);
});

test("시험 실행은 아무것도 쓰지 않음", async () => {
  const db = fakeDb(seed());
  const out = await runReminders({ db, now: MON_9AM, dryRun: true });
  assert.deepStrictEqual(out.results.find(r => r.center === A).created.map(c => c.name), ["정원준"]);
  assert.strictEqual(db.writes.length, 0);
  assert.strictEqual(db.store.get(idOf(R.jo)).status, "pending");
});

test("보낼 시각이 이미 지났으면 예약 안 함", async () => {
  const db = fakeDb(seed());
  const out = await runReminders({ db, now: new Date("2026-11-23T19:30:00+09:00") });
  assert.strictEqual(out.results.find(r => r.center === A).note, "보낼 시각이 이미 지남");
  assert.ok(!db.store.has(idOf(R.jw)));
});

test("날짜를 지정해 수요일 수업 예약, 보내는 시각 설정 반영", async () => {
  const db = fakeDb(seed({ [`centers/${A}/data/config`]: { smsSettings: sms, autoReminder: { enabled: true, time: "18:30" } } }));
  const out = await runReminders({ db, now: MON_9AM, targetDate: "2026-11-25" });
  const a = out.results.find(r => r.center === A);
  assert.deepStrictEqual(a.created.map(c => c.name), ["신지환A"]);
  assert.strictEqual(db.store.get(idOf(R.sj)).scheduleAt, "2026-11-24T09:30:00.000Z");
  assert.ok(db.store.get(idOf(R.sj)).recipients[0].message.includes("신지환 연구원 수업등록 안내드립니다"), "원 설정에 문자 내용이 없으면 기본 문자");
});

test("일요일에 실행하면 월요일 수업(다음 주)을 일 19:00로 예약", async () => {
  const mon = raw("월학생", "월", "010-1212-3434");
  const db = fakeDb(seed({ [`centers/${A}/data/roster`]: { rows: [mon] } }));
  const out = await runReminders({ db, now: new Date("2026-11-22T09:00:00+09:00"), onlyCenter: A });
  const a = out.results[0];
  assert.strictEqual(a.week, "2026-11-28");
  assert.deepStrictEqual(a.created.map(c => c.name), ["월학생"]);
  assert.strictEqual(db.store.get(`smsQueue/auto|${A}|2026-11-28|${sid(mon)}`).scheduleAt, "2026-11-22T10:00:00.000Z");
});
