import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import worker from '../src/worker.js';

const endpoint = new URL('https://fedex.example/mcp');

test('Sites can discover FedEx tools before runtime credentials are configured', async () => {
  const env = {};
  async function call(method, params) {
    const response = await worker.fetch(new Request(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    }), env);
    assert.equal(response.status, 200);
    return (await response.json()).result;
  }

  const discovery = await call('server/discover');
  assert.ok(discovery.supportedVersions.includes('2026-07-28'));
  assert.deepEqual(discovery.capabilities.tools, { listChanged: true });
  const { tools } = await call('tools/list');
  assert.deepEqual(tools.map(({ name }) => name).sort(), ['fedex_quote', 'fedex_track']);

  const result = await call('tools/call', {
    name: 'fedex_track', arguments: { trackingNumbers: ['000000000001'] },
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /FEDEX_CLIENT_ID and FEDEX_CLIENT_SECRET/);
});

test('Worker serves modern MCP with configured bindings and reuses a completed OAuth token', async (t) => {
  const env = {
    FEDEX_ENV: 'sandbox',
    FEDEX_CLIENT_ID: 'mock-client-id',
    FEDEX_CLIENT_SECRET: 'mock-client-secret',
  };
  let tokenRequests = 0;
  t.mock.method(globalThis, 'fetch', async (url, { body, headers }) => {
    assert.equal(url.origin, 'https://apis-sandbox.fedex.com');
    if (url.pathname === '/oauth/token') {
      tokenRequests += 1;
      assert.equal(body.get('client_id'), env.FEDEX_CLIENT_ID);
      assert.equal(body.get('client_secret'), env.FEDEX_CLIENT_SECRET);
      return Response.json({ access_token: 'mock-token', expires_in: 3600 });
    }
    assert.equal(url.pathname, '/track/v1/trackingnumbers');
    assert.equal(headers.authorization, 'Bearer mock-token');
    return Response.json({ output: { completeTrackResults: [] } });
  });

  const client = new Client({ name: 'fedex-worker-test', version: '1.0.0' }, {
    versionNegotiation: { mode: { pin: '2026-07-28' } },
  });
  t.after(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(endpoint, {
    fetch: (url, init) => worker.fetch(new Request(url, init), env),
  }));
  assert.equal(client.getProtocolEra(), 'modern');

  for (const trackingNumber of ['000000000001', '000000000002']) {
    const result = await client.callTool({
      name: 'fedex_track', arguments: { trackingNumbers: [trackingNumber] },
    });
    assert.equal(Boolean(result.isError), false);
    assert.equal(result.structuredContent.environment, 'sandbox');
    assert.deepEqual(result.structuredContent.requestedTrackingNumbers, [trackingNumber]);
  }
  assert.equal(tokenRequests, 1);
});
