# 결제 안내 문자 서버 자동 예약 (payment-reminder)

매일 **오전 9시(한국 시간)** 에 Google Cloud에서 혼자 돌면서, **다음 날 수업이 있는 학생 중 결제 안 한 학생**에게
**오늘 저녁 7시**(결제 매니저 설정의 "보내는 시각") 안내 문자를 문자 대기열(`smsQueue`)에 예약합니다.
실제 발송은 지금처럼 `sms-relay-scheduler`가 1분마다 대기열을 보고 처리합니다.

결제 매니저를 아무도 열지 않는 날(월요일 저녁에 보내는 화요일 수업 문자 등)에도 빠지지 않게 하려는 것입니다.

## 동작 규칙

- 원마다 결제 매니저 ⚙ 설정의 **결제 안내 자동 예약이 켜져 있고**, 문자 발송 설정(알리고 계정)이 있을 때만 예약합니다.
- 이미 **결제 체크된 학생은 예약하지 않고**, 대기 중인 예약이 있으면 취소합니다.
- 오전 9시 이후에 결제 체크하면 결제 매니저 화면이 그 예약을 바로 취소합니다(지금과 같음).
- 연락처가 없는 학생, 보낼 시각이 이미 지난 경우는 예약하지 않습니다.
- 예약 문서 이름이 결제 매니저 화면과 같아서(`auto|원|주차|학생`), 서버와 화면이 같은 학생을 예약해도 한 건만 남습니다.
- 문자 제목·내용·테스트 모드는 결제 매니저 설정의 값을 그대로 씁니다. 테스트 모드면 실제로 보내지 않습니다.
- 실행할 때마다 결과를 원 설정에 남겨서, 결제 매니저 ⚙ 설정의 자동 예약 칸 아래에 "서버 자동 예약: 11-24 09:00 실행 · …"으로 보입니다.

## 설치 (한 번만, 약 5분)

1. [Google Cloud 콘솔](https://console.cloud.google.com/)에서 프로젝트가 **Jarada-checkin**인지 확인합니다.
2. 오른쪽 위 **Cloud Shell 활성화**(`>_` 모양) 버튼을 누릅니다.
3. 아래 두 줄을 붙여 넣고 Enter. 중간에 API를 켜겠냐고 물으면 `y`.

```bash
git clone https://github.com/cooldesign81/jarada-payment.git
bash jarada-payment/server/payment-reminder/deploy.sh
```

스크립트가 하는 일:

1. `payment-reminder` 함수를 `asia-northeast3`에 배포 (로그인 없이는 부를 수 없게)
2. `sms-relay-scheduler`가 쓰는 실행 계정에 이 함수를 부를 권한 부여
3. 매일 09:00(Asia/Seoul)에 함수를 부르는 `payment-reminder-daily` 작업 생성
4. **시험 실행**: 내일 수업 학생 중 누구를 예약할지 결과만 보여 줌 (실제로 예약하지 않음)

마지막에 이런 결과가 나오면 성공입니다 (`created`가 예약될 학생, `note`가 건너뛴 이유).

```json
{"ok":true,"dryRun":true,"classDate":"2026-11-25","results":[{"center":"서초반포원","created":[{"name":"…","scheduleAt":"…"}],"note":""}, …]}
```

## 확인과 시험

- **Cloud Scheduler** 화면에 `payment-reminder-daily`가 생기고, 매일 9시에 "Success"가 찍히면 정상입니다. **Force run**으로 바로 돌려 볼 수도 있습니다(이때는 실제로 예약됨).
- 결제 매니저 **문자 대기열**에서 "자동" 표시가 붙은 예약을 확인합니다.
- 날짜를 지정한 시험 실행 (실제로 예약하지 않음):

```bash
URL=$(gcloud functions describe payment-reminder --v2 --region=asia-northeast3 --format='value(serviceConfig.uri)')
curl -sS -H "Authorization: Bearer $(gcloud auth print-identity-token)" "$URL?dryRun=1&date=2026-11-25"
```

`center=서초반포원`을 붙이면 한 원만 봅니다.

## 코드를 고친 뒤에는

Cloud Shell에서 최신 코드를 받아 같은 스크립트를 다시 실행하면 됩니다.

```bash
cd ~/jarada-payment && git pull && bash server/payment-reminder/deploy.sh
```

실행 시각을 바꾸려면 `SCHEDULE="0 8 * * *" bash server/payment-reminder/deploy.sh` 처럼 앞에 붙입니다.
결제 매니저 설정의 "보내는 시각"은 이 실행 시각보다 뒤여야 합니다.

## 문제가 생기면

| 증상 | 확인할 것 |
|---|---|
| `is not a supported runtime` | 스크립트가 지원하는 Node.js를 스스로 고릅니다. 그래도 나면 `gcloud functions runtimes list --region=asia-northeast3`로 목록을 보고 `RUNTIME=nodejs24 bash server/payment-reminder/deploy.sh` 처럼 지정 |
| 배포 중 `Permission denied` / API 사용 안 함 | 프로젝트 소유자 계정인지, 물어보는 API를 `y`로 켰는지 |
| 시험 실행이 `403 Forbidden` | Cloud Shell 로그인 계정이 프로젝트 소유자인지. 잠시 뒤 다시 시도 |
| 결과의 `note`가 "자동 예약 꺼짐" | 결제 매니저 ⚙ 설정에서 그 원의 자동 예약을 켰는지 |
| `note`가 "문자 발송 설정 없음" | 그 원의 알리고 계정(API Key·User ID·발신번호)이 저장됐는지 |
| `error`에 `PERMISSION_DENIED` (Firestore) | 함수 실행 계정(기본 Compute 계정)에 Cloud Datastore 사용자 역할이 있는지 |
| 매일 실행 작업이 실패 | Cloud Scheduler 작업의 실행 계정이 함수를 부를 권한이 있는지 (스크립트를 다시 실행하면 다시 줌) |

## 파일

- `core.js` — 명단·원비·다음 텀·문자 내용 계산 (결제 매니저 `index.html`과 같은 규칙. 규칙을 바꾸면 둘 다 바꿔야 함)
- `reminder.js` — 다음 날 수업 학생 예약
- `index.js` — Cloud Run 함수 진입점 (`?dryRun=1`, `?date=YYYY-MM-DD`, `?center=원`)
- `deploy.sh` — Cloud Shell 배포 스크립트
- `test/` — `npm test` (서버와 화면의 계산이 같은지, 예약 규칙)
