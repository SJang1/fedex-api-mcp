import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFedExClient, readFedExConfig } from '../src/fedex.js';

const RATE_PATH = '/rate/v1/rates/quotes';
const AVAILABILITY_PATH = '/availability/v1/packageandserviceoptions';
const ACCOUNT_NUMBER = '000000123';
const config = readFedExConfig({
  FEDEX_CLIENT_ID: 'mock-client-id',
  FEDEX_CLIENT_SECRET: 'mock-client-secret',
  FEDEX_ACCOUNT_NUMBER: ACCOUNT_NUMBER,
  FEDEX_ENV: 'sandbox',
  FEDEX_LOCALE: 'ko_KR',
});

const input = {
  origin: { countryCode: 'KR', postalCode: '04524', city: 'Seoul' },
  destination: { countryCode: 'US', stateOrProvinceCode: 'NY', postalCode: '00123', residential: true },
  shipDate: '2026-11-25',
  pickupType: 'DROPOFF_AT_FEDEX_LOCATION',
  packagingType: 'YOUR_PACKAGING',
  rateRequestTypes: ['LIST'],
  packages: [
    { weight: { units: 'KG', value: 2.5 }, dimensions: { units: 'CM', length: 30, width: 20, height: 10 }, groupPackageCount: 2 },
    { weight: { units: 'LB', value: 1 } },
  ],
};

function tokenResponse() {
  return Response.json({ access_token: 'mock-quote-token', expires_in: 3600 });
}

const responseHeaders = { 'content-type': 'application/json', 'x-fedex-id': 'mock-response' };

function rateResponseBody() {
  return `${JSON.stringify({
    transactionId: 'rate-transaction',
    output: {
      alerts: [{ code: 'VIRTUAL.RESPONSE', alertType: 'NOTE', message: 'Virtual response' }],
      rateReplyDetails: [
        {
          serviceType: 'INTERNATIONAL_PRIORITY',
          serviceName: 'FedEx International Priority',
          packagingType: 'YOUR_PACKAGING',
          commit: { daysInTransit: 'TWO_DAYS', dateDetail: { dayCxsFormat: '2026-11-27T10:30:00' } },
          ratedShipmentDetails: [
            { rateType: 'ACCOUNT', totalNetCharge: 84.2, shipmentRateDetail: { currency: 'USD' } },
            { rateType: 'LIST', totalNetCharge: 97, currency: 'USD' },
          ],
        },
        { serviceType: 'INTERNATIONAL_FIRST', packagingType: 'FEDEX_BOX' },
        { serviceType: 'INTERNATIONAL_ECONOMY' },
        { serviceType: 'FEDEX_INTERNATIONAL_CONNECT_PLUS' },
      ],
    },
  }, null, 2)}\n`;
}

function availabilityResponseBody() {
  return `${JSON.stringify({
    transactionId: 'availability-transaction',
    output: {
      serviceOptions: [
        { key: 'INTERNATIONAL_PRIORITY', displayText: 'FedEx International Priority' },
        { key: 'INTERNATIONAL_FIRST', displayText: 'FedEx International First' },
        { key: 'INTERNATIONAL_ECONOMY', displayText: 'FedEx International Economy' },
      ],
      packageOptions: [
        {
          serviceType: { key: 'INTERNATIONAL_PRIORITY' },
          packageType: { key: 'YOUR_PACKAGING', displayText: 'Your Packaging' },
          rateTypes: ['ACCOUNT', 'LIST'],
        },
        {
          serviceType: { key: 'INTERNATIONAL_FIRST' },
          packageType: { key: 'YOUR_PACKAGING' },
        },
      ],
    },
  }, null, 2)}\n`;
}

test('rates and availability start in parallel using one token and the same shipment', async (t) => {
  const requests = new Map();
  const rates = Promise.withResolvers();
  const availability = Promise.withResolvers();
  const bothRequestsStarted = Promise.withResolvers();
  const startupDeadline = setTimeout(() => {
    bothRequestsStarted.reject(new Error('Expected both FedEx requests before either mock response was released.'));
  }, 3000);
  t.after(() => clearTimeout(startupDeadline));
  let tokenRequests = 0;

  const client = createFedExClient(config, async (url, options) => {
    if (url.pathname === '/oauth/token') {
      tokenRequests += 1;
      return tokenResponse();
    }
    requests.set(url.pathname, { url, ...options });
    if (requests.has(RATE_PATH) && requests.has(AVAILABILITY_PATH)) {
      bothRequestsStarted.resolve();
    }
    return url.pathname === RATE_PATH ? rates.promise : availability.promise;
  });

  const quotePromise = client.quote(input);
  await bothRequestsStarted.promise;
  clearTimeout(startupDeadline);
  const rateBody = rateResponseBody();
  const availabilityBody = availabilityResponseBody();
  rates.resolve(new Response(rateBody, { headers: responseHeaders }));
  availability.resolve(new Response(availabilityBody, { headers: responseHeaders }));
  const quote = await quotePromise;

  assert.equal(tokenRequests, 1);
  for (const { url, method, headers } of requests.values()) {
    assert.equal(url.origin, 'https://apis-sandbox.fedex.com');
    assert.equal(method, 'POST');
    assert.equal(headers.authorization, 'Bearer mock-quote-token');
    assert.equal(headers['x-locale'], 'ko_KR');
  }
  assert.deepEqual(JSON.parse(requests.get(RATE_PATH).body), {
    accountNumber: { value: ACCOUNT_NUMBER },
    rateRequestControlParameters: { returnTransitTimes: true },
    requestedShipment: {
      shipper: { address: input.origin },
      recipient: { address: input.destination },
      pickupType: input.pickupType,
      packagingType: input.packagingType,
      shipDateStamp: input.shipDate,
      rateRequestType: input.rateRequestTypes,
      requestedPackageLineItems: input.packages,
    },
  });
  assert.deepEqual(JSON.parse(requests.get(AVAILABILITY_PATH).body), {
    accountNumber: { value: ACCOUNT_NUMBER },
    requestedShipment: {
      shipper: { address: input.origin },
      recipients: [{ address: input.destination }],
      shipDateStamp: input.shipDate,
      pickupType: input.pickupType,
      requestedPackageLineItems: input.packages.map((item) => ({ physicalPackaging: input.packagingType, ...item })),
    },
  });

  assert.deepEqual(quote, {
    rates: { status: 200, headers: responseHeaders, body: rateBody },
    serviceAvailability: { status: 200, headers: responseHeaders, body: availabilityBody },
  });
});

test('an availability HTTP error and a successful rate response both retain their original bodies', async () => {
  const rateBody = rateResponseBody();
  const availabilityBody = '{ "errors": [{ "code": "MOCK.AVAILABILITY.DENIED" }] }\n';
  const client = createFedExClient(config, async (url) => {
    switch (url.pathname) {
      case '/oauth/token': return tokenResponse();
      case RATE_PATH: return new Response(rateBody, { headers: responseHeaders });
      case AVAILABILITY_PATH: return new Response(availabilityBody, { status: 403, headers: responseHeaders });
    }
    assert.fail(`Unexpected request: ${url.pathname}`);
  });

  const quote = await client.quote(input);
  assert.deepEqual(quote, {
    rates: { status: 200, headers: responseHeaders, body: rateBody },
    serviceAvailability: { status: 403, headers: responseHeaders, body: availabilityBody },
  });
});

test('a rates transport failure leaves the original availability response usable', async () => {
  const availabilityBody = availabilityResponseBody();
  const client = createFedExClient(config, async (url) => {
    switch (url.pathname) {
      case '/oauth/token': return tokenResponse();
      case RATE_PATH: throw new TypeError('Mock transport failure');
      case AVAILABILITY_PATH: return new Response(availabilityBody, { headers: responseHeaders });
    }
    assert.fail(`Unexpected request: ${url.pathname}`);
  });

  const quote = await client.quote(input);
  assert.match(quote.rates.error.message, /Unable to reach FedEx for rates/);
  assert.deepEqual(quote.serviceAvailability, { status: 200, headers: responseHeaders, body: availabilityBody });
});
