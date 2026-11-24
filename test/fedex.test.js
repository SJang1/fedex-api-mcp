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

test('successful batches retain shipment dates, delivery location, and individual FedEx errors', async () => {
  const trackingNumbers = ['000001', '000002'];
  const estimatedDelivery = '2026-11-25T14:30:00+09:00';
  const actualDelivery = '2026-11-25T12:30:00+09:00';
  const fedexError = { code: 'TRACKING.DATA.NOTFOUND', message: 'No tracking information found.' };
  const client = createFedExClient(config, async (url) => {
    if (url.pathname === '/oauth/token') {
      return Response.json({ access_token: 'mock-token', expires_in: 3600 });
    }

    return Response.json({
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
    });
  });

  const result = await client.track(trackingNumbers, false);
  const [delivered, notFound] = result.shipments;
  assert.equal(result.virtualResponse, false);
  assert.equal(delivered.matches[0].location.city, 'Seoul');
  assert.equal(delivered.matches[0].location.streetLines, undefined);
  assert.equal(delivered.matches[0].estimatedDelivery, estimatedDelivery);
  assert.equal(delivered.matches[0].actualDelivery, actualDelivery);
  assert.equal(notFound.trackingNumber, trackingNumbers[1]);
  assert.deepEqual(notFound.matches[0].error, fedexError);
});

test('a tracking response with only an alert preserves the FedEx message', async () => {
  const alert = { code: 'TRACKING.DATA.NOTFOUND', message: 'No tracking information found.', alertType: 'NOTE' };
  const client = createFedExClient(config, async (url) => Response.json(
    url.pathname === '/oauth/token'
      ? { access_token: 'mock-token', expires_in: 3600 }
      : { output: { alerts: [alert] } },
  ));

  const result = await client.track(['000001'], false);
  assert.deepEqual(result.shipments, []);
  assert.deepEqual(result.alerts, [alert]);
});
