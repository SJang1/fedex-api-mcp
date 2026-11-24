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

function rateResponse() {
  return Response.json({
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
  });
}

function availabilityResponse() {
  return Response.json({
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
  });
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
  rates.resolve(rateResponse());
  availability.resolve(availabilityResponse());
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

  assert.equal(quote.environment, 'sandbox');
  assert.equal(quote.rates.transactionId, 'rate-transaction');
  assert.equal(quote.rates.virtualResponse, true);
  assert.equal(quote.serviceAvailability.transactionId, 'availability-transaction');
  assert.equal(quote.serviceAvailability.virtualResponse, false);
  assert.deepEqual(quote.serviceAvailability.services[0].packagingOptions, [
    { packagingType: 'YOUR_PACKAGING', packagingName: 'Your Packaging', rateTypes: ['ACCOUNT', 'LIST'] },
  ]);

  const [priority, first, economy, unlisted] = quote.rates.quotes;
  assert.equal(priority.transit.daysInTransit, 'TWO_DAYS');
  assert.equal(priority.transit.deliveryDate, '2026-11-27T10:30:00');
  assert.deepEqual(priority.charges, [
    { rateType: 'ACCOUNT', amount: 84.2, currency: 'USD' },
    { rateType: 'LIST', amount: 97, currency: 'USD' },
  ]);
  assert.deepEqual(priority.availability, { serviceListed: true, packagingListed: true });
  assert.deepEqual(first.availability, { serviceListed: true, packagingListed: false });
  assert.deepEqual(economy.availability, { serviceListed: true });
  assert.deepEqual(unlisted.availability, { serviceListed: false });
});

test('a failed availability request leaves the rates usable', async () => {
  const client = createFedExClient(config, async (url) => {
    switch (url.pathname) {
      case '/oauth/token': return tokenResponse();
      case RATE_PATH: return rateResponse();
      case AVAILABILITY_PATH: return Response.json({}, { status: 403 });
    }
    assert.fail(`Unexpected request: ${url.pathname}`);
  });

  const quote = await client.quote(input);
  assert.equal(quote.rates.quotes[0].charges[0].amount, 84.2);
  assert.equal(quote.rates.quotes[0].availability, undefined);
  assert.equal(quote.serviceAvailability.error.httpStatus, 403);
  assert.match(quote.serviceAvailability.error.message, /Service Availability/);
});

test('a failed rates request leaves the available services usable', async () => {
  const client = createFedExClient(config, async (url) => {
    switch (url.pathname) {
      case '/oauth/token': return tokenResponse();
      case RATE_PATH: return Response.json({}, { status: 503 });
      case AVAILABILITY_PATH: return availabilityResponse();
    }
    assert.fail(`Unexpected request: ${url.pathname}`);
  });

  const quote = await client.quote(input);
  assert.equal(quote.rates.error.httpStatus, 503);
  assert.equal(quote.serviceAvailability.services[0].serviceType, 'INTERNATIONAL_PRIORITY');
});
