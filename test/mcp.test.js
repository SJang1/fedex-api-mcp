import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

function trackingResponseBody(trackingNumbers) {
  return `${JSON.stringify({
    transactionId: 'mock-transaction',
    output: {
      alerts: [{ code: 'VIRTUAL.RESPONSE' }],
      completeTrackResults: trackingNumbers.map((trackingNumber) => ({
        trackingNumber,
        trackResults: [{
          trackingNumberInfo: { trackingNumber },
          latestStatusDetail: { code: 'IT', statusByLocale: '운송 중', description: 'In transit' },
          scanEvents: [{ eventType: 'IT', eventDescription: 'In transit' }],
        }],
      })),
    },
  }, null, 2)}\n`;
}

const trackingErrorBody = '{ "errors": [{ "code": "MOCK.TRACK.ERROR", "message": "FedEx rejected the request." }] }\n';
const rateBody = '{ "output": { "rateReplyDetails": [{ "serviceType": "INTERNATIONAL_PRIORITY" }] } }\n';
const availabilityBody = '{ "output": { "packageOptions": [{ "serviceType": { "key": "INTERNATIONAL_PRIORITY" }, "packageType": { "key": "YOUR_PACKAGING" } }] } }\n';
const quoteErrorBody = 'FedEx unavailable\n';

function installFetchMock() {
  let requestNumber = 0;

  globalThis.fetch = async (url, { method, headers, body }) => {
    requestNumber += 1;
    assert.equal(url.origin, 'https://apis-sandbox.fedex.com');
    assert.equal(method, 'POST');

    if (requestNumber === 1) {
      assert.equal(url.pathname, '/oauth/token');
      assert.equal(headers['content-type'], 'application/x-www-form-urlencoded');
      assert.deepEqual(Object.fromEntries(body), {
        grant_type: 'client_credentials',
        client_id: 'mock-client-id',
        client_secret: 'mock-client-secret',
      });
      return Response.json({ access_token: 'mock-access-token', expires_in: 3600 });
    }

    assert.equal(headers.authorization, 'Bearer mock-access-token');
    assert.equal(headers['x-locale'], 'ko_KR');
    const payload = JSON.parse(body);

    if (url.pathname === '/rate/v1/rates/quotes') {
      assert.deepEqual(payload.rateRequestControlParameters, { returnTransitTimes: true });
      assert.equal(payload.accountNumber.value, '000123456');
      assert.equal(payload.requestedShipment.shipper.address.countryCode, 'KR');
      assert.ok(['2026-11-30', '2026-12-01'].includes(payload.requestedShipment.shipDateStamp));
      assert.equal(payload.requestedShipment.pickupType, 'DROPOFF_AT_FEDEX_LOCATION');
      assert.deepEqual(payload.requestedShipment.rateRequestType, ['LIST']);
      assert.deepEqual(payload.requestedShipment.customsClearanceDetail, { commodities: [{
        description: 'Cotton knit T-shirt',
        quantity: 1,
        countryOfManufacture: 'KR',
        customsValue: { amount: 25, currency: 'USD' },
      }] });
      return payload.requestedShipment.shipDateStamp === '2026-12-01'
        ? new Response(quoteErrorBody, { status: 503 })
        : new Response(rateBody, { headers: { 'content-type': 'application/json' } });
    }

    if (url.pathname === '/availability/v1/packageandserviceoptions') {
      assert.equal(payload.accountNumber.value, '000123456');
      assert.equal(payload.requestedShipment.recipients[0].address.postalCode, '94103');
      assert.equal(payload.requestedShipment.requestedPackageLineItems[0].physicalPackaging, 'YOUR_PACKAGING');
      assert.equal(Object.hasOwn(payload.requestedShipment, 'customsClearanceDetail'), false);
      return payload.requestedShipment.shipDateStamp === '2026-12-01'
        ? new Response(quoteErrorBody, { status: 503 })
        : new Response(availabilityBody, { headers: { 'content-type': 'application/json' } });
    }

    assert.equal(url.pathname, '/track/v1/trackingnumbers');
    const detailed = requestNumber === 3;
    const trackingNumbers = [
      ['000000001234', '000000000222'],
      ['000000000333'],
      ['000000000444'],
    ][requestNumber - 2];
    assert.ok(trackingNumbers);
    assert.deepEqual(payload, {
      includeDetailedScans: detailed,
      trackingInfo: trackingNumbers.map((trackingNumber) => ({ trackingNumberInfo: { trackingNumber } })),
    });

    return new Response(requestNumber === 4 ? trackingErrorBody : trackingResponseBody(trackingNumbers), {
      status: requestNumber === 4 ? 400 : 200,
      headers: { 'content-type': 'application/json', 'x-fedex-id': 'mock-response-id' },
    });
  };
}

const entry = fileURLToPath(new URL('../src/index.js', import.meta.url));
const preload = `import assert from 'node:assert/strict';
${trackingResponseBody.toString()}
const trackingErrorBody = ${JSON.stringify(trackingErrorBody)};
const rateBody = ${JSON.stringify(rateBody)};
const availabilityBody = ${JSON.stringify(availabilityBody)};
const quoteErrorBody = ${JSON.stringify(quoteErrorBody)};
(${installFetchMock.toString()})();`;
const mockModule = `data:text/javascript,${encodeURIComponent(preload)}`;

for (const [era, mode] of [['legacy', 'legacy'], ['modern', { pin: '2026-07-28' }]]) {
  test(`FedEx tools over ${era} MCP stdio`, { timeout: 10_000 }, async (t) => {
    const client = new Client({ name: 'fedex-tracking-test', version: '1.0.0' }, {
      versionNegotiation: { mode },
    });
    t.after(() => client.close());

    await client.connect(new StdioClientTransport({
      command: process.execPath,
      args: ['--import', mockModule, entry],
      env: {
        FEDEX_CLIENT_ID: 'mock-client-id',
        FEDEX_CLIENT_SECRET: 'mock-client-secret',
        FEDEX_ACCOUNT_NUMBER: era === 'modern' ? '000123456' : '',
        FEDEX_ENV: 'sandbox',
        FEDEX_LOCALE: 'ko_KR',
      },
    }));
    assert.equal(client.getProtocolEra(), era);

    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(({ name }) => name).sort(), ['fedex_quote', 'fedex_track']);
    const trackingTool = tools.find(({ name }) => name === 'fedex_track');
    const quoteTool = tools.find(({ name }) => name === 'fedex_quote');
    assert.equal(trackingTool.annotations.readOnlyHint, true);
    assert.equal(trackingTool.inputSchema.properties.trackingNumbers.maxItems, 30);
    assert.equal(quoteTool.annotations.readOnlyHint, true);

    const callTool = (args) => client.callTool({ name: 'fedex_track', arguments: args });
    const invalid = await callTool({ trackingNumbers: ['   '] });
    assert.equal(invalid.isError, true);
    assert.match(invalid.content[0].text, /Input validation error/);

    const tracked = await callTool({ trackingNumbers: ['  000000001234  ', '000000000222'] });
    const headers = { 'content-type': 'application/json', 'x-fedex-id': 'mock-response-id' };
    const body = trackingResponseBody(['000000001234', '000000000222']);
    assert.equal(Boolean(tracked.isError), false, tracked.content[0]?.text);
    assert.equal(tracked.content[0].text, body);
    assert.deepEqual(JSON.parse(tracked.content[1].text), { status: 200, headers });
    assert.deepEqual(tracked.structuredContent, { status: 200, headers, body });

    const detailed = await callTool({ trackingNumbers: ['000000000333'], includeDetailedScans: true });
    assert.equal(Boolean(detailed.isError), false, detailed.content[0]?.text);
    assert.equal(detailed.content[0].text, trackingResponseBody(['000000000333']));

    const rejected = await callTool({ trackingNumbers: ['000000000444'] });
    assert.equal(rejected.isError, true);
    assert.equal(rejected.content[0].text, trackingErrorBody);
    assert.deepEqual(JSON.parse(rejected.content[1].text), { status: 400, headers });
    assert.deepEqual(rejected.structuredContent, { status: 400, headers, body: trackingErrorBody });

    const shipment = {
      origin: { countryCode: ' kr ', postalCode: '04524' },
      destination: { countryCode: 'US', stateOrProvinceCode: 'CA', postalCode: '94103' },
      shipDate: '2026-11-30',
      packages: [{ weight: { value: 2, units: 'KG' } }],
      customsClearanceDetail: { commodities: [{
        description: 'Cotton knit T-shirt',
        quantity: 1,
        countryOfManufacture: 'kr',
        customsValue: { amount: 25, currency: 'usd' },
      }] },
    };
    const quote = (arguments_) => client.callTool({ name: 'fedex_quote', arguments: arguments_ });
    const invalidQuote = await quote({ ...shipment, shipDate: '2026-02-29' });
    assert.equal(invalidQuote.isError, true);
    assert.match(invalidQuote.content[0].text, /Input validation error/);

    const quoted = await quote(shipment);
    if (era === 'legacy') {
      assert.equal(quoted.isError, true);
      assert.match(quoted.content[0].text, /FEDEX_ACCOUNT_NUMBER/);
    } else {
      assert.equal(Boolean(quoted.isError), false, quoted.content[0]?.text);
      const jsonHeaders = { 'content-type': 'application/json' };
      assert.deepEqual(quoted.structuredContent, {
        rates: { status: 200, headers: jsonHeaders, body: rateBody },
        serviceAvailability: { status: 200, headers: jsonHeaders, body: availabilityBody },
      });
      assert.deepEqual(JSON.parse(quoted.content[0].text), { operation: 'rates', status: 200, headers: jsonHeaders });
      assert.equal(quoted.content[1].text, rateBody);
      assert.deepEqual(JSON.parse(quoted.content[2].text), { operation: 'serviceAvailability', status: 200, headers: jsonHeaders });
      assert.equal(quoted.content[3].text, availabilityBody);

      const unavailable = await quote({ ...shipment, shipDate: '2026-12-01' });
      assert.equal(unavailable.isError, true);
      assert.equal(unavailable.structuredContent.rates.status, 503);
      assert.equal(unavailable.structuredContent.serviceAvailability.status, 503);
      assert.equal(unavailable.content[1].text, quoteErrorBody);
      assert.equal(unavailable.content[3].text, quoteErrorBody);
    }
  });
}
