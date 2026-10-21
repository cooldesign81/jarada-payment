/**
 * 자라다 결제 매니저 → 구글 시트 매출 기록 수신 스크립트
 *
 * 이 파일 내용을 구글 시트의 [확장 프로그램 > Apps Script]에 붙여넣고 웹앱으로 배포하면,
 * 결제 매니저가 이번 주 결제 완료 행을 보낼 때마다 "매출기록" 탭에 추가/갱신/삭제됩니다.
 * 설정 순서는 같은 폴더의 README.md를 참고하세요.
 *
 * 스크립트 속성 (프로젝트 설정 > 스크립트 속성)
 *   TOKEN          : 결제 매니저 ⚙ 설정의 "비밀 토큰"과 같은 값. 비워 두면 토큰 검사를 하지 않음.
 *   CENTERS        : (선택) 이 시트에 기록을 허용할 원 이름. 쉼표로 여러 개 (예: 서초반포원).
 *                    비워 두면 모든 원을 받음 — 대표 계정 시트는 비워 두고, 원별 시트는 자기 원만 적어 두면
 *                    설정 실수로 다른 원의 기록이 섞이는 것을 막을 수 있음.
 *   SPREADSHEET_ID : (선택) 시트에 붙어 있지 않은 독립 스크립트일 때만 기록할 시트 ID.
 */

var LEDGER_SHEET = "매출기록";
var DAILY_SHEET = "일별합계";
var LEDGER_HEADERS = ["기록키", "원", "주차", "구분", "분류", "체크일", "요일", "이름", "나이", "교사", "수업시간", "금액", "결제방법", "메모", "다음텀", "마지막갱신"];
var DAILY_HEADERS = ["날짜", "원", "결제 건수", "합계", "카드", "이체", "제로페이", "현금", "갱신시각"];
var PAY_METHODS = ["카드", "이체", "제로페이", "현금"];
var TZ = "Asia/Seoul";

// 브라우저에서 URL을 직접 열었을 때 동작 확인용
function doGet() {
  return jsonOut({ ok: true, message: "자라다 매출 기록 웹앱이 동작 중이에요." });
}

// 결제 매니저가 보내는 요청 처리 (본문은 text/plain 으로 온 JSON 문자열)
function doPost(e) {
  var body;
  try {
    body = JSON.parse((e && e.postData && e.postData.contents) || "{}");
  } catch (err) {
    return jsonOut({ ok: false, error: "JSON 파싱 실패" });
  }

  var props = PropertiesService.getScriptProperties();
  var expected = (props.getProperty("TOKEN") || "").trim();
  if (expected && String(body.token || "").trim() !== expected) {
    return jsonOut({ ok: false, error: "토큰이 일치하지 않아요" });
  }

  // 허용 원 목록이 정해져 있으면 다른 원의 기록은 거절 (원별 시트에 다른 원 데이터가 섞이는 실수 방지)
  var allowed = (props.getProperty("CENTERS") || "").split(",")
    .map(function (c) { return c.trim(); })
    .filter(function (c) { return c; });
  var center = String(body.center || "").trim();
  if (allowed.length && center && allowed.indexOf(center) === -1) {
    return jsonOut({ ok: false, error: "이 시트는 " + allowed.join(", ") + " 전용이에요 (요청한 원: " + center + ")" });
  }

  if (body.action === "ping") {
    return jsonOut({ ok: true, sheet: getSpreadsheet().getName(), centers: allowed });
  }
  if (body.action !== "sync") {
    return jsonOut({ ok: false, error: "알 수 없는 요청: " + body.action });
  }
  if (!body.center || !body.week || !Array.isArray(body.rows)) {
    return jsonOut({ ok: false, error: "center / week / rows 가 필요해요" });
  }

  // 여러 직원이 동시에 체크해도 시트가 꼬이지 않게 한 번에 하나씩 처리
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);
  } catch (err) {
    return jsonOut({ ok: false, error: "다른 기록이 처리 중이에요. 잠시 후 다시 시도해 주세요." });
  }
  try {
    var result = syncWeek(body);
    result.ok = true;
    return jsonOut(result);
  } catch (err) {
    return jsonOut({ ok: false, error: String((err && err.message) || err) });
  } finally {
    lock.releaseLock();
  }
}

/**
 * 한 원의 한 주(원 + 주차) 결제 완료 행을 통째로 받아 시트와 맞춤
 *  - 기록키가 이미 있으면 그 행을 갱신
 *  - 없으면 맨 아래에 추가
 *  - 삭제는 두 경우만:
 *      (1) unpaidKeys 에 든 기록키 — 앱 화면에 보이는데 결제 체크가 안 된 사람
 *      (2) fullSyncKinds 에 든 구분(기타·상자)인데 이번에 안 온 기록키 — ✕로 지운 결제자
 *    → 토요일에 엑셀(명단)을 갈아 끼워 화면에서 사라진 학생의 결제 행은 그대로 남음
 *  - 다른 원이나 지난 주의 행은 건드리지 않음
 *  - (예전 앱 호환) unpaidKeys / fullSyncKinds 둘 다 없으면 이번에 안 온 기록키를 모두 삭제
 */
function syncWeek(body) {
  var sheet = getOrCreateSheet(LEDGER_SHEET, LEDGER_HEADERS);
  var center = String(body.center);
  var week = String(body.week);
  var now = Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd HH:mm:ss");

  var data = sheet.getDataRange().getValues();
  var existing = {};   // 기록키 -> 시트 행 번호
  var weekRows = [];   // 이 원·주차에 속한 행들
  for (var i = 1; i < data.length; i++) {
    var k = String(data[i][0] || "");
    if (!k) continue;
    existing[k] = i + 1;
    if (String(data[i][1]) === center && String(data[i][2]) === week) {
      weekRows.push({ row: i + 1, key: k, kind: String(data[i][3] || "") });
    }
  }

  var legacy = body.unpaidKeys === undefined && body.fullSyncKinds === undefined;
  var unpaid = {};
  (Array.isArray(body.unpaidKeys) ? body.unpaidKeys : []).forEach(function (k) {
    if (k) unpaid[center + "|" + week + "|" + String(k)] = true;
  });
  var fullKinds = {};
  (Array.isArray(body.fullSyncKinds) ? body.fullSyncKinds : []).forEach(function (k) { fullKinds[String(k)] = true; });

  var incoming = {};
  var appends = [];
  var upserted = 0;
  body.rows.forEach(function (r) {
    if (!r || !r.key) return;
    var fullKey = center + "|" + week + "|" + String(r.key);
    incoming[fullKey] = true;
    var values = rowValues(fullKey, center, week, r, now);
    if (existing[fullKey]) {
      sheet.getRange(existing[fullKey], 1, 1, LEDGER_HEADERS.length).setValues([values]);
    } else {
      appends.push(values);
    }
    upserted++;
  });

  // 결제가 취소된 행 삭제 — 행 번호가 밀리지 않게 아래에서 위로
  var toDelete = weekRows
    .filter(function (w) {
      if (incoming[w.key]) return false;
      if (legacy) return true;
      return !!(unpaid[w.key] || fullKinds[w.kind]);
    })
    .map(function (w) { return w.row; })
    .sort(function (a, b) { return b - a; });
  toDelete.forEach(function (row) { sheet.deleteRow(row); });

  if (appends.length) {
    sheet.getRange(sheet.getLastRow() + 1, 1, appends.length, LEDGER_HEADERS.length).setValues(appends);
  }

  return { upserted: upserted, deleted: toDelete.length, total: Math.max(sheet.getLastRow() - 1, 0) };
}

function rowValues(fullKey, center, week, r, now) {
  return [
    fullKey, center, week,
    str(r.kind), str(r.category),
    str(r.paidDate), str(r.day), str(r.name), str(r.age), str(r.teacher), str(r.time),
    Number(r.amount) || 0,
    str(r.method), str(r.memo), str(r.nextTerm),
    now,
  ];
}

function str(v) {
  return v === null || v === undefined ? "" : String(v);
}

/**
 * "매출기록" 탭을 날짜·원별로 집계해 "일별합계" 탭을 다시 만듦
 *  - 시간 기반 트리거로 매일 밤 실행하거나, 시트 메뉴 [자라다 결제 > 일별합계 다시 만들기]로 수동 실행
 *  - 매번 전체를 다시 계산하므로 여러 번 실행해도 결과가 같음
 */
function rebuildDailySummary() {
  var ledger = getOrCreateSheet(LEDGER_SHEET, LEDGER_HEADERS);
  var daily = getOrCreateSheet(DAILY_SHEET, DAILY_HEADERS);
  var data = ledger.getDataRange().getValues();
  var idx = {};
  LEDGER_HEADERS.forEach(function (h, i) { idx[h] = i; });

  var groups = {};
  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    var date = normDate(row[idx["체크일"]]);
    var center = String(row[idx["원"]] || "");
    if (!date || !center) continue;
    var gk = date + "|" + center;
    var g = groups[gk] || (groups[gk] = { date: date, center: center, count: 0, total: 0, by: {} });
    var amt = Number(row[idx["금액"]]) || 0;
    var m = String(row[idx["결제방법"]] || "카드");
    g.count++;
    g.total += amt;
    g.by[m] = (g.by[m] || 0) + amt;
  }

  var now = Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd HH:mm:ss");
  var out = Object.keys(groups).map(function (k) { return groups[k]; })
    .sort(function (a, b) {
      if (a.date !== b.date) return a.date < b.date ? 1 : -1; // 최근 날짜가 위로
      return a.center < b.center ? -1 : a.center > b.center ? 1 : 0;
    })
    .map(function (g) {
      return [g.date, g.center, g.count, g.total]
        .concat(PAY_METHODS.map(function (m) { return g.by[m] || 0; }))
        .concat([now]);
    });

  if (daily.getLastRow() > 1) {
    daily.getRange(2, 1, daily.getLastRow() - 1, DAILY_HEADERS.length).clearContent();
  }
  if (out.length) {
    daily.getRange(2, 1, out.length, DAILY_HEADERS.length).setValues(out);
  }
  return out.length;
}

function normDate(v) {
  if (v instanceof Date) return Utilities.formatDate(v, TZ, "yyyy-MM-dd");
  var s = String(v || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : "";
}

function getSpreadsheet() {
  var id = (PropertiesService.getScriptProperties().getProperty("SPREADSHEET_ID") || "").trim();
  return id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
}

function getOrCreateSheet(name, headers) {
  var ss = getSpreadsheet();
  var sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight("bold");
    sheet.setFrozenRows(1);
    // 기록키·주차·체크일처럼 날짜로 오해될 수 있는 글자가 자동 변환되지 않게 텍스트 서식 지정
    var textCols = name === LEDGER_SHEET ? [1, 2, 3, 6] : [1];
    textCols.forEach(function (c) {
      sheet.getRange(1, c, sheet.getMaxRows(), 1).setNumberFormat("@");
    });
  }
  return sheet;
}

// 시트를 열면 메뉴 추가
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("자라다 결제")
    .addItem("일별합계 다시 만들기", "rebuildDailySummary")
    .addToUi();
}

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
