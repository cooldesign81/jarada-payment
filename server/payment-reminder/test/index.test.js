"use strict";
// 함수 진입점: 쿼리(dryRun·date·center)를 읽어 runReminders 에 넘기는지 (Firestore 없이 runReminders 를 바꿔치기)
const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const calls = [];
const reminderPath = require.resolve(path.join(__dirname, "../reminder.js"));
require.cache[reminderPath] = { id: reminderPath, filename: reminderPath, loaded: true,
  exports: { runReminders: async args => { calls.push(args); return { ok: true, classDate: args.targetDate || "x", results: [] }; } } };
require("../index.js");
const { getFunction } = require("@google-cloud/functions-framework/testing");

test("시험 실행 주소를 부르면 dryRun·date·center 를 넘김", async () => {
  const fn = getFunction("paymentReminder");
  let status = 0, body = null;
  const res = { status(s) { status = s; return this; }, json(b) { body = b; return this; } };
  await fn({ query: { dryRun: "1", date: "2026-11-24", center: "서초반포원" } }, res);
  assert.strictEqual(status, 200);
  assert.strictEqual(body.ok, true);
  assert.strictEqual(calls[0].dryRun, true); assert.strictEqual(calls[0].targetDate, "2026-11-24"); assert.strictEqual(calls[0].onlyCenter, "서초반포원");
  assert.strictEqual(process.env.TZ, "Asia/Seoul");
  await fn({ query: {} }, res);
  assert.strictEqual(calls[1].dryRun, false); assert.strictEqual(calls[1].targetDate, null);
});
