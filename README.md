# FedEx Tracking MCP

FedEx 운송장 추적, 예상 운임과 배송 소요 시간, 서비스 가용성을 조회하는 로컬 MCP 서버입니다. Node.js 22.16 이상과 npm이 필요합니다. MCP 클라이언트와는 표준 입출력(`stdio`)으로 통신합니다.

## 설치와 환경 설정

프로젝트 디렉터리에서 실행합니다.

```sh
npm ci
```

FedEx Developer Portal에서 사용할 API 제품이 포함된 프로젝트의 키를 확인합니다. 운송장 추적에는 **Basic Integrated Visibility**가 필요합니다. 운임과 서비스 가용성 조회에는 **Rates and Transit Times API**, **Service Availability API**, 같은 프로젝트에 연결된 9자리 배송 계정 번호가 필요합니다. [FedEx API 인증 문서](https://developer.fedex.com/api/en-us/catalog/authorization/docs.html)

서버 프로세스에 다음 환경 변수를 전달합니다.

| 환경 변수 | 값 |
| --- | --- |
| `FEDEX_CLIENT_ID` | FedEx 프로젝트 API Key |
| `FEDEX_CLIENT_SECRET` | FedEx 프로젝트 Secret Key |
| `FEDEX_ACCOUNT_NUMBER` | 9자리 배송 계정 번호. 운송장 추적만 사용하는 경우 생략할 수 있습니다. |
| `FEDEX_ENV` | 기본값 `production`. 테스트는 `sandbox`를 지정합니다. |
| `FEDEX_LOCALE` | 기본값 `en_US`. FedEx API에 한국어 로케일을 요청하려면 `ko_KR`. |

`FEDEX_ENV`를 생략하거나 비워 두면 운영 환경을 사용합니다. FedEx 포털에서 필요한 API 제품의 운영 사용을 활성화하고, 운영 키와 배송 계정 번호를 사용합니다. 샌드박스 테스트에는 `FEDEX_ENV=sandbox`를 지정하고 테스트 키와 테스트 배송 계정 번호를 사용합니다. 샌드박스 주소는 `https://apis-sandbox.fedex.com`입니다. [FedEx 운영 전환 안내](https://developer.fedex.com/api/en-us/get-started/shipper.html)

## Dots에서 사용

Sites에 배포한 비공개 `fedex_api` 플러그인을 연결합니다. Dot 프로필의 **Customize → Plugins**에서 연결 상태를 확인하고, 대화에서 `@fedex_api`를 선택합니다.

호스팅 환경은 Sites의 환경 변수 설정에서 관리합니다. `FEDEX_CLIENT_ID`, `FEDEX_CLIENT_SECRET`, `FEDEX_ACCOUNT_NUMBER`는 비밀 변수로 추가합니다. 로컬과 동일한 환경이나 언어를 사용하려면 `FEDEX_ENV`와 `FEDEX_LOCALE`도 설정합니다. Sites가 인증과 접근 권한을 적용한 뒤 MCP 요청을 `/mcp`로 전달합니다.

로컬에서 배포용 Worker를 빌드하려면 `npm ci`와 `npm run site:build`를 실행합니다. Worker와 로컬 MCP는 같은 도구 정의를 사용합니다.

## macOS에서 Codex 로컬 플러그인으로 설치

프로젝트 루트의 `.env`에 위 환경 변수를 설정합니다. 플러그인은 실행할 때 이 파일을 읽습니다. `.env`는 빌드 산출물과 플러그인 설치본 외부에 보관됩니다.

```sh
npm ci
npm run plugin:build
codex plugin marketplace add "$(pwd)/dist/codex-marketplace"
codex plugin add fedex-api-mcp@fedex-local
```

새 Codex 채팅에서 **fedex_api** 플러그인을 선택하면 `fedex_track`과 `fedex_quote`를 사용할 수 있습니다. 기존에 같은 MCP를 직접 등록했다면 플러그인 설치를 확인한 뒤 Codex 설정의 `[mcp_servers.fedex]`에서 `enabled = false`로 설정해 중복 로드를 방지할 수 있습니다.

로컬 빌드는 빌드할 때 사용한 Node.js 경로와 이 프로젝트의 `.env` 경로를 사용합니다. 저장소를 옮기거나 Node.js 경로가 바뀌면 새 위치에서 빌드하고 플러그인을 다시 설치합니다. 이 설치 방식은 Codex 데스크톱과 CLI에서 지원됩니다.

## MCP 클라이언트에 등록

클라이언트가 `mcpServers` 형식의 구성을 지원한다면 다음 항목을 추가합니다. `command`에는 `command -v node`의 결과를, `args`에는 서버 진입점의 절대 경로를 입력합니다. `env`에 실제 환경 변수 값을 설정합니다.

```json
{
  "mcpServers": {
    "fedex": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/fedex-api-mcp/src/index.js"],
      "env": {
        "FEDEX_CLIENT_ID": "your_production_api_key",
        "FEDEX_CLIENT_SECRET": "your_production_secret_key",
        "FEDEX_ACCOUNT_NUMBER": "your_9_digit_production_account_number",
        "FEDEX_LOCALE": "en_US"
      }
    }
  }
}
```

MCP 클라이언트에서 샌드박스를 사용하려면 `env`에 `"FEDEX_ENV": "sandbox"`를 추가하고 API 키와 배송 계정 번호를 테스트 값으로 설정합니다.

터미널에서 직접 실행하려면 셸에서 필요한 환경 변수를 `export`한 뒤, 프로젝트 디렉터리에서 `npm start`를 실행합니다. 서버는 MCP 클라이언트의 요청을 표준 입력에서 기다립니다.

## 운송장 조회

`fedex_track`에 `trackingNumbers`로 운송장 번호 문자열을 1개부터 30개까지 전달합니다. 상세 스캔이 필요하면 `includeDetailedScans`를 `true`로 설정합니다. 기본값은 `false`입니다. [FedEx 배송 조회 API 문서](https://developer.fedex.com/api/en-us/catalog/track/v1/docs.html)

```json
{
  "trackingNumbers": ["613746411451"],
  "includeDetailedScans": true
}
```

첫 번째 MCP 텍스트 블록과 `structuredContent.body`에는 FedEx 조회 API의 응답 본문을 Fetch가 읽은 텍스트 그대로 담습니다. 두 번째 텍스트 블록과 `structuredContent`에서 HTTP 상태 코드(`status`)와 응답 헤더(`headers`)를 확인할 수 있습니다. 헤더 이름과 중복 헤더 값에는 Fetch의 정규화가 적용되며 `authorization`, `proxy-authorization`, `set-cookie`는 제외됩니다. FedEx 조회 API가 오류 상태 코드를 반환할 때도 본문과 헤더를 제공하고 MCP 결과를 오류로 표시합니다.

위 번호 `613746411451`은 FedEx 샌드박스의 배송 완료 샘플입니다. 다른 시나리오는 **JSON API Collection**에서 **Track by Tracking Numbers** 샘플을 선택해 테스트할 수 있습니다. FedEx 본문의 `alerts` 또는 `output.alerts`에 `VIRTUAL.RESPONSE` 코드가 있으면 가상 응답입니다. 샘플 응답의 운송장 번호는 요청 번호와 다를 수 있습니다. 가상 시나리오에 해당하지 않는 요청은 샌드박스 테스트 인스턴스로 전달될 수 있습니다. [FedEx Track JSON 컬렉션](https://developer.fedex.com/wirc/jsonapi-collections/api_groups/Track/TrackAPI_collection.json) · [FedEx 샌드박스 가상화 가이드](https://developer.fedex.com/api/en-us/guides/sandboxvirtualization.html) · [FedEx 가상화 안내](https://developer.fedex.com/api/en-us/announcements/July_2023-Virtualization_Announcement.html)

## 운임·배송 소요 시간·서비스 가용성 조회

`fedex_quote`는 같은 출발지, 도착지, 발송일로 두 FedEx API를 동시에 호출합니다. `shipDate`에는 출발지 현지 날짜 기준으로 FedEx에 화물을 인계할 예정일을 `YYYY-MM-DD` 형식으로 입력합니다. [FedEx 운임 및 배송 소요 시간 API](https://developer.fedex.com/api/en-us/catalog/rate/v1/docs.html) · [FedEx 서비스 가용성 API](https://developer.fedex.com/api/en-us/catalog/service-availability/v1/docs.html)

- `origin`과 `destination`에는 `countryCode`가 필요합니다. `postalCode`, `city`, `stateOrProvinceCode`, `residential`은 해당 주소와 FedEx 서비스에 맞춰 입력합니다.
- `packages`의 각 항목에는 `weight`(`KG` 또는 `LB`)가 필요합니다. `dimensions`(`CM` 또는 `IN`)와 동일한 포장물 수량인 `groupPackageCount`도 전달할 수 있습니다.
- `packagingType`의 기본값은 `YOUR_PACKAGING`이고, `pickupType`의 기본값은 `DROPOFF_AT_FEDEX_LOCATION`입니다. `rateRequestTypes`의 기본값인 `["LIST"]`는 표준 요금과 적용 가능한 계정 요금을 요청합니다. 계정 요금만 요청하려면 `["ACCOUNT"]`를 사용합니다. `serviceType`을 지정하면 해당 서비스의 운임을 요청합니다. [FedEx 운임 및 배송 소요 시간 API](https://developer.fedex.com/api/en-us/catalog/rate/v1/docs.html)

### 국제 견적의 통관 정보

`customsClearanceDetail.commodities`에 품목을 1개부터 999개까지 입력할 수 있습니다. 품목마다 `description`(품목 설명), `quantity`(수량), `customsValue.amount`(신고가액), `customsValue.currency`(통화 코드)가 필요합니다. FedEx 요구 사항에 따라 제조국(`countryOfManufacture`), 수량 단위(`quantityUnits`), 품목 총중량(`weight`), 단가(`unitPrice`), 개수(`numberOfPieces`), HS 코드(`harmonizedCode`)를 추가합니다. 관세 납부자가 발송인인 경우 `customsClearanceDetail.dutiesPayment.paymentType`을 `SENDER`로 지정할 수 있습니다. [FedEx 운임 API 요청 스키마](https://developer.fedex.com/wirc/json/api_groups/Rate/RateQuotes-Resource.json)

아래는 서울에서 샌프란시스코로 보내는 물품 견적 예시입니다. 날짜와 통관 정보는 실제 발송 조건에 맞춰 입력합니다.

```json
{
  "origin": { "countryCode": "KR", "postalCode": "04524", "city": "Seoul" },
  "destination": { "countryCode": "US", "postalCode": "94103", "city": "San Francisco", "stateOrProvinceCode": "CA", "residential": false },
  "shipDate": "2026-11-30",
  "packages": [
    {
      "weight": { "value": 0.5, "units": "KG" },
      "dimensions": { "length": 30, "width": 20, "height": 5, "units": "CM" }
    }
  ],
  "customsClearanceDetail": {
    "commodities": [
      {
        "description": "Cotton knit T-shirt",
        "countryOfManufacture": "KR",
        "quantity": 1,
        "quantityUnits": "PCS",
        "weight": { "value": 0.3, "units": "KG" },
        "customsValue": { "amount": 25, "currency": "USD" }
      }
    ]
  }
}
```

서류 전용 배송에는 `documentShipment: true`를 지정합니다. 위 경로의 샌드박스 확인에서는 서류 설명, 수량, 신고가액이 담긴 `commodities`도 필요했습니다. 아래는 상업적 가치가 없는 종이 서류를 가정한 예시입니다. 실제 견적에는 해당 서류의 신고가액을 입력합니다.

```json
{
  "origin": { "countryCode": "KR", "postalCode": "04524", "city": "Seoul" },
  "destination": { "countryCode": "US", "postalCode": "94103", "city": "San Francisco", "stateOrProvinceCode": "CA", "residential": false },
  "shipDate": "2026-11-30",
  "packages": [{ "weight": { "value": 0.3, "units": "KG" } }],
  "documentShipment": true,
  "customsClearanceDetail": {
    "commodities": [
      {
        "description": "Paper business correspondence",
        "countryOfManufacture": "KR",
        "quantity": 1,
        "quantityUnits": "PCS",
        "weight": { "value": 0.3, "units": "KG" },
        "customsValue": { "amount": 0, "currency": "USD" }
      }
    ]
  }
}
```

### 응답

`structuredContent.rates`에는 운임·배송 소요 시간 API 응답이, `structuredContent.serviceAvailability`에는 서비스 가용성 API 응답이 담깁니다. 각 응답의 `body`는 Fetch가 읽은 원문 텍스트입니다. `status`는 HTTP 상태 코드이며 `headers`에는 운송장 조회와 같은 규칙이 적용됩니다. `transactionId`와 `alerts` 등은 FedEx 본문의 원래 위치에서 확인할 수 있습니다.

MCP 텍스트 블록에는 각 API의 `operation`과 HTTP 상태·헤더를 담은 JSON 블록 뒤에 응답 원문 블록이 이어집니다. 정상 응답과 HTTP 오류 응답 모두 이 형식으로 전달합니다. API에 연결하지 못하면 해당 항목에 `error`가 담깁니다. 두 API 호출이 모두 실패하면 MCP 결과를 오류로 표시합니다.

로컬 모의 응답으로 동작을 검증하려면 `npm test`를 실행합니다.
