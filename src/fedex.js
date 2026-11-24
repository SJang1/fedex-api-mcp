import { buildAvailabilityRequest } from './availability.js';
import { buildRateRequest } from './rate.js';

const API_URLS = {
  sandbox: 'https://apis-sandbox.fedex.com',
  production: 'https://apis.fedex.com',
};

const SENSITIVE_RESPONSE_HEADERS = new Set(['authorization', 'proxy-authorization', 'set-cookie']);

export function readFedExConfig(env = process.env) {
  const environment = env.FEDEX_ENV?.trim() || 'production';
  const clientId = env.FEDEX_CLIENT_ID?.trim();
  const clientSecret = env.FEDEX_CLIENT_SECRET?.trim();
  const accountNumber = env.FEDEX_ACCOUNT_NUMBER?.trim();
  const locale = env.FEDEX_LOCALE?.trim() || 'en_US';

  if (!Object.hasOwn(API_URLS, environment)) {
    throw new Error('FEDEX_ENV must be sandbox or production.');
  }
  if (!clientId || !clientSecret) {
    throw new Error('Set the FEDEX_CLIENT_ID and FEDEX_CLIENT_SECRET environment variables.');
  }
  if (!/^[a-z]{2}_[A-Z]{2}$/.test(locale)) {
    throw new Error('FEDEX_LOCALE must use the language_COUNTRY format, such as en_US.');
  }

  return { environment, clientId, clientSecret, accountNumber, locale };
}

export class FedExError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'FedExError';
    this.status = status;
  }
}

function authorizationHttpError(status, data) {
  if (status === 429) {
    return new FedExError('FedEx rate limit reached. Try again later.', status);
  }
  if (status >= 500) {
    return new FedExError(`FedEx authorization is temporarily unavailable (HTTP ${status}).`, status);
  }
  if ([400, 401, 403].includes(status)) {
    return new FedExError(`FedEx rejected the API credentials (HTTP ${status}). Check the key, secret, and FEDEX_ENV.`, status);
  }

  const code = data?.errors?.[0]?.code;
  const detail = typeof code === 'string' && /^[A-Z0-9_.-]{1,120}$/.test(code) ? `, ${code}` : '';
  return new FedExError(`FedEx authorization request failed (HTTP ${status}${detail}).`, status);
}

function readAuthorizationResponse({ response, body }) {
  let data;
  try {
    data = JSON.parse(body);
  } catch {
    data = undefined;
  }
  if (!response.ok) {
    throw authorizationHttpError(response.status, data);
  }
  if (!data) {
    throw new FedExError('FedEx returned an invalid authorization response.');
  }
  return data;
}

function originalResponse({ response, body }) {
  const headers = Object.fromEntries(
    [...response.headers].filter(([name]) => !SENSITIVE_RESPONSE_HEADERS.has(name)),
  );
  return { status: response.status, headers, body };
}

export function createFedExClient(config, fetchImpl = globalThis.fetch, tokenCache = {}) {
  const baseUrl = API_URLS[config.environment];
  let pendingToken;

  async function post(path, operation, headers, body) {
    const signal = AbortSignal.timeout(15_000);
    try {
      const response = await fetchImpl(new URL(path, baseUrl), {
        method: 'POST',
        headers: { accept: 'application/json', ...headers },
        body,
        signal,
        // Workers support manual redirects, which keeps credentials on the original URL.
        redirect: 'manual',
      });
      return { response, body: await response.text() };
    } catch (error) {
      if (signal.aborted) {
        throw new FedExError(`FedEx ${operation} request timed out. Try again later.`);
      }
      if (error instanceof FedExError) {
        throw error;
      }
      throw new FedExError(`Unable to reach FedEx for ${operation}. Check the network and try again.`);
    }
  }

  async function requestToken() {
    const requestedAt = Date.now();
    const result = await post('/oauth/token', 'authorization', {
      'content-type': 'application/x-www-form-urlencoded',
    }, new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: config.clientId,
      client_secret: config.clientSecret,
    }));
    const data = readAuthorizationResponse(result);

    const lifetime = Number(data.expires_in) * 1_000;
    if (typeof data.access_token !== 'string' || !data.access_token.trim() || !Number.isFinite(lifetime) || lifetime <= 0) {
      throw new FedExError('FedEx returned an invalid access token response.');
    }
    return {
      value: data.access_token,
      refreshAt: requestedAt + lifetime - Math.min(60_000, lifetime / 10),
    };
  }

  async function getToken() {
    if (tokenCache.token?.refreshAt > Date.now()) {
      return tokenCache.token;
    }
    pendingToken ??= requestToken()
      .then((token) => {
        tokenCache.token = token;
        return token;
      })
      .finally(() => {
        pendingToken = undefined;
      });
    return pendingToken;
  }

  async function sendAuthenticated(path, operation, body, token) {
    const result = await post(path, operation, {
      'content-type': 'application/json',
      authorization: `Bearer ${token.value}`,
      'x-locale': config.locale,
    }, body);
    if (result.response.status === 401 && tokenCache.token === token) {
      tokenCache.token = undefined;
    }
    return result;
  }

  async function requestAuthenticated(path, operation, payload) {
    const body = JSON.stringify(payload);
    const token = await getToken();
    const result = await sendAuthenticated(path, operation, body, token);
    if (result.response.status === 401) {
      return sendAuthenticated(path, operation, body, await getToken());
    }
    return result;
  }

  async function quotePart(path, operation, payload) {
    try {
      return originalResponse(await requestAuthenticated(path, operation, payload));
    } catch (error) {
      return {
        error: error instanceof FedExError
          ? { message: error.message, httpStatus: error.status }
          : { message: `Unable to process the FedEx ${operation} response.` },
      };
    }
  }

  return {
    async track(trackingNumbers, includeDetailedScans) {
      const result = await requestAuthenticated('/track/v1/trackingnumbers', 'tracking', {
        trackingInfo: trackingNumbers.map((trackingNumber) => ({ trackingNumberInfo: { trackingNumber } })),
        includeDetailedScans,
      });
      return originalResponse(result);
    },

    async quote(input) {
      if (!/^\d{9}$/.test(config.accountNumber ?? '')) {
        throw new FedExError('Set FEDEX_ACCOUNT_NUMBER to the 9-digit shipping account linked to this FedEx project.');
      }

      const [rates, serviceAvailability] = await Promise.all([
        quotePart('/rate/v1/rates/quotes', 'rates', buildRateRequest(input, config.accountNumber)),
        quotePart('/availability/v1/packageandserviceoptions', 'service availability',
          buildAvailabilityRequest(input, config.accountNumber)),
      ]);

      return { rates, serviceAvailability };
    },
  };
}
