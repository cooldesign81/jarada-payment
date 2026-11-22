"use strict";
// 매일 한 번 실행: 다음 날 수업이 있는 학생 중 결제 안 한 학생을 "수업 전날 정한 시각"(기본 19:00)으로
// smsQueue 에 예약. 실제 발송은 지금처럼 sms-relay 가 1분마다 대기열을 보고 처리함.
// - 원마다 결제 매니저 설정의 autoReminder.enabled 가 켜져 있고 문자 계정(smsSettings)이 있을 때만
// - 문서 id 는 결제 매니저 화면과 같은 "auto|원|주차|학생" → 이미 있으면 만들지 않음(create)
// - 이미 결제 체크된 학생은 예약하지 않고, 대기 중인 예약이 있으면 취소
// - 보낼 시각이 이미 지났으면 예약하지 않음
const core = require("./core");

const CANCEL_PAID = () => ({ status: "cancelled", cancelReason: "paid", cancelledAt: Date.now(), cancelledBy: "server" });

function isAlreadyExists(e) {
  return !!e && (e.code === 6 || e.code === "already-exists" || /ALREADY_EXISTS|already exists/i.test(String(e.message || "")));
}

function parseYmd(v) {
  const [y, m, d] = String(v).split("-").map(Number);
  return new Date(y, m - 1, d);
}

async function runForCenter({ db, center, now, classDate, dryRun }) {
  const out = { center, classDate: core.fmt(classDate), created: [], alreadyScheduled: 0, paid: 0, cancelled: 0, noPhone: 0, note: "" };
  const configSnap = await db.doc(`centers/${center}/data/config`).get();
  const config = (configSnap.exists && configSnap.data()) || {};
  const ar = { enabled: false, time: "19:00", title: "", template: "", testMode: false, ...(config.autoReminder || {}) };
  const sms = config.smsSettings || {};
  if (!ar.enabled) { out.note = "자동 예약 꺼짐"; return out; }
  if (!(sms.apiKey && sms.userId && sms.senderNumber)) { out.note = "문자 발송 설정 없음"; return out; }

  const letter = core.DAY_LETTERS[classDate.getDay()];
  const { nextSaturday } = core.nextWeekRange(classDate);
  const wk = core.fmt(nextSaturday);
  const sendAt = new Date(`${core.fmt(core.addDays(classDate, -1))}T${core.reminderTime(ar)}:00+09:00`);
  out.week = wk;
  out.day = letter;
  out.sendAt = sendAt.toISOString();
  if (sendAt.getTime() <= now.getTime() + 60 * 1000) { out.note = "보낼 시각이 이미 지남"; return out; }

  const [rosterSnap, weekSnap] = await Promise.all([
    db.doc(`centers/${center}/data/roster`).get(),
    db.doc(`centers/${center}/weeks/${wk}`).get(),
  ]);
  const rows = (rosterSnap.exists && rosterSnap.data().rows) || [];
  const checklist = ((weekSnap.exists && weekSnap.data()) || {}).checklist || {};
  const ctx = {
    calendar: config.calendar || { holidays: [], vacations: [] },
    tuitionSettings: { ...core.DEFAULT_TUITION_SETTINGS, ...(config.tuitionSettings || {}) },
    checklist,
    autoReminder: ar,
  };
  const students = core.studentsForWeek(rows, nextSaturday, ctx.calendar).filter(s => s.day === letter);

  for (const s of students) {
    const id = core.autoReminderId(center, wk, s.id);
    const ref = db.collection("smsQueue").doc(id);
    const c = checklist[s.id] || {};
    if (c.paid) {
      out.paid++;
      if (!dryRun) {
        const did = await db.runTransaction(async tx => {
          const snap = await tx.get(ref);
          if (!snap.exists || snap.data().status !== "pending") return false;
          tx.update(ref, CANCEL_PAID());
          return true;
        });
        if (did) out.cancelled++;
      }
      continue;
    }
    const phone = String(s.phone || "").replace(/[^0-9]/g, "");
    if (!phone) { out.noPhone++; continue; }
    const { message, subject } = core.reminderContent(s, ctx);
    const data = {
      center, status: "pending", testMode: !!ar.testMode, scheduleAt: sendAt.toISOString(),
      createdAt: Date.now(), createdBy: "server", recipients: [{ phone, name: s.name, message, subject }],
      auto: true, autoKey: core.autoReminderKey(center, wk), week: wk, studentId: s.id,
    };
    if (dryRun) {
      const existing = await ref.get();
      if (existing.exists) out.alreadyScheduled++;
      else out.created.push({ name: s.name, phone, scheduleAt: data.scheduleAt });
      continue;
    }
    try {
      await ref.create(data);
      out.created.push({ name: s.name, phone, scheduleAt: data.scheduleAt });
    } catch (e) {
      if (isAlreadyExists(e)) out.alreadyScheduled++;
      else throw e;
    }
  }
  return out;
}

// now: 지금 시각, targetDate: "YYYY-MM-DD" 로 수업 날짜를 직접 지정(시험용, 없으면 내일)
async function runReminders({ db, now = new Date(), targetDate = null, dryRun = false, onlyCenter = null }) {
  const classDate = targetDate ? parseYmd(targetDate) : core.addDays(core.startOfDay(now), 1);
  const refs = await db.collection("centers").listDocuments();
  const centers = refs.map(r => r.id).filter(c => !onlyCenter || c === onlyCenter).sort();
  const results = [];
  for (const center of centers) {
    let r;
    try {
      r = await runForCenter({ db, center, now, classDate, dryRun });
    } catch (e) {
      r = { center, classDate: core.fmt(classDate), error: String((e && e.message) || e) };
    }
    results.push(r);
    // 결제 매니저 설정 창에 마지막 실행 결과를 보여 주기 위한 기록 (시험 실행은 남기지 않음)
    if (!dryRun && !(r.note === "자동 예약 꺼짐")) {
      const summary = {
        lastRunAt: now.getTime(), classDate: r.classDate, day: r.day || "", note: r.note || "", error: r.error || "",
        created: (r.created || []).length, alreadyScheduled: r.alreadyScheduled || 0, paid: r.paid || 0,
        cancelled: r.cancelled || 0, noPhone: r.noPhone || 0,
      };
      try { await db.doc(`centers/${center}/data/config`).set({ autoReminderServer: summary }, { merge: true }); } catch (e) {}
    }
  }
  return { ok: results.every(r => !r.error), dryRun, now: now.toISOString(), classDate: core.fmt(classDate), results };
}

module.exports = { runReminders, runForCenter };
