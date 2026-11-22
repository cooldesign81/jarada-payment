#!/usr/bin/env bash
# Google Cloud Shell(Jarada-checkin 프로젝트)에서 실행:
#   git clone https://github.com/cooldesign81/jarada-payment.git && bash jarada-payment/server/payment-reminder/deploy.sh
# 결제 안내 자동 예약 함수(payment-reminder)를 배포하고, 매일 오전 9시(한국 시간)에 부르는 작업
# (payment-reminder-daily)을 만들거나 고친 뒤, 실제로 예약하지 않는 시험 실행 결과를 보여 줌.
# 다시 실행해도 됨 — 코드를 고친 뒤에도 같은 명령으로 다시 배포.
set -euo pipefail

REGION="asia-northeast3"
FUNC="payment-reminder"
JOB="payment-reminder-daily"
SCHEDULE="${SCHEDULE:-0 9 * * *}"

cd "$(dirname "$0")"
PROJECT="$(gcloud config get-value project 2>/dev/null || true)"
if [ -z "$PROJECT" ]; then
  echo "프로젝트가 선택되지 않았어요. 먼저 실행: gcloud config set project <Jarada-checkin 프로젝트 ID>"
  exit 1
fi
echo "프로젝트: $PROJECT"

echo
echo "[1/4] 함수 배포 (몇 분 걸려요. API를 켜겠냐고 물으면 y)"
gcloud functions deploy "$FUNC" \
  --gen2 --region="$REGION" --runtime=nodejs20 --source=. \
  --entry-point=paymentReminder --trigger-http --no-allow-unauthenticated \
  --set-env-vars=TZ=Asia/Seoul --memory=256Mi --timeout=120s
URL="$(gcloud functions describe "$FUNC" --v2 --region="$REGION" --format='value(serviceConfig.uri)' 2>/dev/null || true)"
if [ -z "$URL" ]; then
  URL="$(gcloud run services describe "$FUNC" --region="$REGION" --format='value(status.url)')"
fi
if [ -z "$URL" ]; then echo "함수 주소를 찾지 못했어요. 배포 결과를 확인해 주세요."; exit 1; fi
echo "함수 주소: $URL"

echo
echo "[2/4] 매일 실행 작업이 함수를 부를 수 있게 권한 주기"
SA="$(gcloud scheduler jobs describe sms-relay-scheduler --location="$REGION" --format='value(httpTarget.oidcToken.serviceAccountEmail)' 2>/dev/null || true)"
if [ -z "$SA" ]; then
  PN="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')"
  SA="${PN}-compute@developer.gserviceaccount.com"
fi
echo "실행 계정: $SA"
gcloud functions add-invoker-policy-binding "$FUNC" --region="$REGION" --member="serviceAccount:$SA" >/dev/null

echo
echo "[3/4] 매일 실행 작업 ($SCHEDULE, 한국 시간)"
if gcloud scheduler jobs describe "$JOB" --location="$REGION" >/dev/null 2>&1; then MODE=update; else MODE=create; fi
gcloud scheduler jobs "$MODE" http "$JOB" \
  --location="$REGION" --schedule="$SCHEDULE" --time-zone="Asia/Seoul" \
  --uri="$URL" --http-method=POST \
  --oidc-service-account-email="$SA" --oidc-token-audience="$URL" \
  --attempt-deadline=120s >/dev/null
echo "작업 $JOB ${MODE} 완료"

echo
echo "[4/4] 시험 실행 — 내일 수업 학생 중 누구를 예약할지 보여 주기만 하고 실제로 예약하지는 않아요"
curl -sS -H "Authorization: Bearer $(gcloud auth print-identity-token)" "$URL?dryRun=1"
echo
echo
echo "끝났어요. 결제 매니저 ⚙ 설정의 '결제 안내 자동 예약'이 켜져 있는 원만 예약돼요."
