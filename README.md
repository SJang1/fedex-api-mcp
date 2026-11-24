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

응답의 `environment`와 `virtualResponse`는 조회 환경과 가상화 여부를 나타냅니다. `transactionId`와 `alerts`는 FedEx가 제공할 때 포함됩니다. `requestedTrackingNumbers`는 요청 번호를 담고, `shipments`는 FedEx가 반환한 `trackingNumber`별 조회 결과(`matches`)를 담습니다. 각 결과는 배송 상태, 위치, 배송 예정 및 완료 시각, 상세 스캔 또는 조회 오류를 포함할 수 있습니다. 가상 응답의 배송 번호는 샘플 데이터에 따라 요청 번호와 다를 수 있습니다.

위 번호 `613746411451`은 FedEx 샌드박스의 배송 완료 샘플입니다. 다른 시나리오는 **JSON API Collection**에서 **Track by Tracking Numbers** 샘플을 선택해 테스트할 수 있습니다. `virtualResponse: true`는 FedEx 응답에 `VIRTUAL.RESPONSE`가 있다는 뜻입니다. 가상 시나리오에 해당하지 않는 요청은 샌드박스 테스트 인스턴스로 전달될 수 있습니다. [FedEx Track JSON 컬렉션](https://developer.fedex.com/wirc/jsonapi-collections/api_groups/Track/TrackAPI_collection.json) · [FedEx 샌드박스 가상화 가이드](https://developer.fedex.com/api/en-us/guides/sandboxvirtualization.html) · [FedEx 가상화 안내](https://developer.fedex.com/api/en-us/announcements/July_2023-Virtualization_Announcement.html)

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

`rates.quotes`에는 서비스별 예상 운임(`charges`)과 예상 배송일·소요 시간(`transit`)이 담깁니다. 각 운임에는 FedEx가 제공한 요금 유형(`rateType`), 금액(`amount`), 통화(`currency`)가 포함됩니다. 입력한 통관 정보는 견적 요청에 사용됩니다. [FedEx 운임 및 배송 소요 시간 API](https://developer.fedex.com/api/en-us/catalog/rate/v1/docs.html)

`serviceAvailability.services`에는 해당 경로의 서비스와 포장 옵션이 담깁니다. 두 API가 성공하면 서비스 코드가 있는 견적의 `availability.serviceListed`가 가용성 목록에서 해당 서비스의 조회 여부를 표시합니다. 해당 서비스의 포장 옵션도 반환되면 `availability.packagingListed`에서 포장 유형의 조회 여부를 확인할 수 있습니다. `false`는 FedEx가 반환한 목록에 해당 항목이 없다는 뜻입니다. [FedEx 서비스 가용성 API](https://developer.fedex.com/api/en-us/catalog/service-availability/v1/docs.html)

각 API 응답의 `virtualResponse`로 가상화 여부를 확인할 수 있으며, FedEx가 제공한 `transactionId`와 `alerts`도 전달됩니다. 한 API가 실패하면 해당 응답의 `error`와 성공한 응답을 함께 반환합니다.

로컬 모의 응답으로 동작을 검증하려면 `npm test`를 실행합니다.
