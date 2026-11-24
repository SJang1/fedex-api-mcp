import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFedExClient, readFedExConfig } from '../src/fedex.js';

const config = readFedExConfig({
  FEDEX_CLIENT_ID: 'mock-client-id',
  FEDEX_CLIENT_SECRET: 'mock-client-secret',
  FEDEX_ENV: 'sandbox',
});

test('FedEx uses production by default and sandbox when explicitly selected', () => {
  const credentials = {
    FEDEX_CLIENT_ID: config.clientId,
    FEDEX_CLIENT_SECRET: config.clientSecret,
  };
  assert.equal(readFedExConfig(credentials).environment, 'production');
  assert.equal(readFedExConfig({ ...credentials, FEDEX_ENV: ' ' }).environment, 'production');
  assert.equal(readFedExConfig({ ...credentials, FEDEX_ENV: 'sandbox' }).environment, 'sandbox');
});

test('FedEx authentication rejects a redirect without forwarding credentials', async () => {
  const requests = [];
  const client = createFedExClient(config, async (url, { redirect }) => {
    requests.push({ path: url.pathname, redirect });
    return new Response(null, {
      status: 307,
      headers: { location: 'https://example.invalid/oauth/token' },
    });
  });

  await assert.rejects(client.track(['000001'], false), { status: 307 });
  assert.deepEqual(requests, [{ path: '/oauth/token', redirect: 'manual' }]);
});

test('concurrent requests share the refreshed token after a FedEx 401', async () => {
  let tokenRequests = 0;
  const trackingTokens = [];
  const client = createFedExClient(config, async (url, { headers }) => {
    if (url.pathname === '/oauth/token') {
      tokenRequests += 1;
      return Response.json({ access_token: `token-${tokenRequests}`, expires_in: 3600 });
    }

    trackingTokens.push(headers.authorization);
    if (headers.authorization === 'Bearer token-1') {
      return new Response('Unauthorized', { status: 401 });
    }
    return Response.json({ output: { completeTrackResults: [] } });
  });

  await Promise.all([client.track(['000001'], false), client.track(['000002'], false)]);
  assert.equal(tokenRequests, 2);
  assert.deepEqual(trackingTokens, ['Bearer token-1', 'Bearer token-1', 'Bearer token-2', 'Bearer token-2']);
});

test('tracking preserves the original response body and returns safe response headers', async () => {
  const trackingNumbers = ['000001', '000002'];
  const estimatedDelivery = '2026-11-25T14:30:00+09:00';
  const actualDelivery = '2026-11-25T12:30:00+09:00';
  const fedexError = { code: 'TRACKING.DATA.NOTFOUND', message: 'No tracking information found.' };
  const body = `${JSON.stringify({
    output: {
      completeTrackResults: [
        {
          trackingNumber: trackingNumbers[0],
          trackResults: [{
            trackingNumberInfo: { trackingNumber: trackingNumbers[0] },
            latestStatusDetail: {
              code: 'DL',
              description: 'Delivered',
              scanLocation: { city: 'Seoul', countryCode: 'KR', streetLines: ['Example address'] },
            },
            dateAndTimes: [
              { type: 'ESTIMATED_DELIVERY', dateTime: estimatedDelivery },
              { type: 'ACTUAL_DELIVERY', dateTime: actualDelivery },
            ],
          }],
        },
        { trackingNumber: trackingNumbers[1], trackResults: [{ error: fedexError }] },
      ],
    },
  }, null, 2)}\r\n`;
  const client = createFedExClient(config, async (url) => url.pathname === '/oauth/token'
    ? Response.json({ access_token: 'mock-token', expires_in: 3600 })
    : new Response(body, { headers: {
      'Content-Type': 'application/json',
      'X-FedEx-ID': 'mock-request-id',
      Authorization: 'Bearer mock-response-token',
      'Proxy-Authorization': 'Basic bW9jaw==',
      'Set-Cookie': 'mock-session=secret',
    } }));

  assert.deepEqual(await client.track(trackingNumbers, false), {
    status: 200,
    headers: { 'content-type': 'application/json', 'x-fedex-id': 'mock-request-id' },
    body,
  });
});

test('tracking returns the final HTTP 401 body after one token refresh', async () => {
  const body = '{ "output": { "alerts": [{ "code": "MOCK.TRACK.ERROR", "message": "Access denied." }] } }\n';
  const trackingTokens = [];
  let tokenRequests = 0;
  const client = createFedExClient(config, async (url, { headers }) => {
    if (url.pathname === '/oauth/token') {
      tokenRequests += 1;
      return Response.json({ access_token: `token-${tokenRequests}`, expires_in: 3600 });
    }
    trackingTokens.push(headers.authorization);
    return new Response(tokenRequests === 1 ? 'Initial access denied' : body, {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  });

  assert.deepEqual(await client.track(['000001'], false), {
    status: 401,
    headers: { 'content-type': 'application/json' },
    body,
  });
  assert.deepEqual(trackingTokens, ['Bearer token-1', 'Bearer token-2']);
});
