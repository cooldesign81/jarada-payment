"use strict";
// Cloud Run 함수 진입점: Cloud Scheduler(payment-reminder-daily)가 매일 오전 9시(한국 시간)에 부름.
// 시험: ?dryRun=1 이면 실제로 예약하지 않고 무엇을 예약할지만 돌려줌. ?date=YYYY-MM-DD 로 수업 날짜 지정, ?center=원 이름
process.env.TZ = "Asia/Seoul";
const functions = require("@google-cloud/functions-framework");
const admin = require("firebase-admin");
const { runReminders } = require("./reminder");

if (!admin.apps.length) admin.initializeApp();

functions.http("paymentReminder", async (req, res) => {
  const q = req.query || {};
  const dryRun = q.dryRun === "1" || q.dryRun === "true";
  const targetDate = /^\d{4}-\d{2}-\d{2}$/.test(String(q.date || "")) ? String(q.date) : null;
  const onlyCenter = q.center ? String(q.center) : null;
  try {
    const result = await runReminders({ db: admin.firestore(), now: new Date(), targetDate, dryRun, onlyCenter });
    console.log(JSON.stringify({ severity: "INFO", message: "payment-reminder", dryRun, classDate: result.classDate,
      results: result.results.map(r => ({ center: r.center, created: (r.created || []).length, already: r.alreadyScheduled, paid: r.paid, note: r.note, error: r.error })) }));
    res.status(result.ok ? 200 : 500).json(result);
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: String((e && e.message) || e) });
  }
});
