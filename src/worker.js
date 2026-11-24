import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
  createMcpHandler,
  readRequestBody,
} from '@modelcontextprotocol/server';
import { createFedExClient, FedExError, readFedExConfig } from './fedex.js';
import { createServer } from './server.js';

const handlers = new WeakMap();
const sitesProtocolVersion = '2026-07-28';
const sitesMethods = new Set(['server/discover', 'tools/list', 'tools/call']);
const landingPage = `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>fedex_api</title>
</head>
<body>
  <main>
    <h1>fedex_api</h1>
    <p>Dots에서 <code>@fedex_api</code>를 선택해 FedEx 배송을 추적하거나 운임, 배송 소요 시간과 서비스 가용성을 조회하세요.</p>
  </main>
</body>
</html>`;

function createHandler(env) {
  const tokenCache = {};

  return createMcpHandler(() => {
    let fedex;
    function getFedExClient() {
      let config;
      try {
        config = readFedExConfig(env);
      } catch (error) {
        throw new FedExError(error.message);
      }
      // Keep ongoing fetches local to one Worker request and reuse completed tokens.
      fedex ??= createFedExClient(config, globalThis.fetch, tokenCache);
      return fedex;
    }

    return createServer({
      track: (...args) => getFedExClient().track(...args),
      quote: (...args) => getFedExClient().quote(...args),
    });
  });
}

async function serveMcp(request, handler) {
  const headers = new Headers(request.headers);
  if (request.method !== 'POST' || headers.has('MCP-Protocol-Version') || headers.has('Mcp-Method')
    || headers.get('accept')?.includes('text/event-stream')) {
    return handler.fetch(request);
  }

  const { tooLarge, text } = await readRequestBody(request);
  if (tooLarge) return new Response('Request body too large', { status: 413 });

  let message;
  try {
    message = JSON.parse(text);
  } catch {
    return Response.json({
      jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' },
    }, { status: 400 });
  }

  const { method, params } = message ?? {};
  if (sitesMethods.has(method) && !Object.hasOwn(params?._meta ?? {}, PROTOCOL_VERSION_META_KEY)) {
    // Sites also sends bare JSON-RPC. Supply the envelope the HTTP SDK expects.
    headers.set('Accept', 'application/json');
    headers.set('Content-Type', 'application/json');
    headers.set('MCP-Protocol-Version', sitesProtocolVersion);
    headers.set('Mcp-Method', method);
    if (method === 'tools/call' && /^[A-Za-z0-9_.-]{1,128}$/.test(params?.name ?? '')) {
      headers.set('Mcp-Name', params.name);
    }
    message.params = {
      ...params,
      _meta: {
        ...params?._meta,
        [PROTOCOL_VERSION_META_KEY]: sitesProtocolVersion,
        [CLIENT_CAPABILITIES_META_KEY]: {},
        [CLIENT_INFO_META_KEY]: { name: 'sites', version: '1.0.0' },
      },
    };
  }

  return handler.fetch(new Request(request.url, {
    method: request.method, headers, signal: request.signal,
  }), { parsedBody: message });
}

export default {
  fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === '/' && (request.method === 'GET' || request.method === 'HEAD')) {
      return new Response(request.method === 'HEAD' ? null : landingPage, {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }
    if (pathname !== '/mcp') {
      return new Response('Not found', { status: 404 });
    }

    // Sites authenticates the caller and enforces the private Site's access policy before dispatch.
    let handler = handlers.get(env);
    if (!handler) {
      handler = createHandler(env);
      handlers.set(env, handler);
    }
    return serveMcp(request, handler);
  },
};
