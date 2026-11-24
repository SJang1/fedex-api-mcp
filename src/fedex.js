import { buildAvailabilityRequest, summarizeAvailability } from './availability.js';
import { buildRateRequest, summarizeRates } from './rate.js';

const API_URLS = {
  sandbox: 'https://apis-sandbox.fedex.com',
  production: 'https://apis.fedex.com',
};

const API_PRODUCTS = {
  tracking: 'Basic Integrated Visibility',
  rates: 'Rates and Transit Times',
  'service availability': 'Service Availability',
};

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

function httpError(operation, status, data) {
  if (status === 429) {
    return new FedExError('FedEx rate limit reached. Try again later.', status);
  }
  if (status >= 500) {
    return new FedExError(`FedEx ${operation} is temporarily unavailable (HTTP ${status}).`, status);
  }
  if (operation === 'authorization' && [400, 401, 403].includes(status)) {
    return new FedExError(`FedEx rejected the API credentials (HTTP ${status}). Check the key, secret, and FEDEX_ENV.`, status);
  }
  if (status === 401 || status === 403) {
    return new FedExError(`FedEx denied ${operation} access (HTTP ${status}). Check that ${API_PRODUCTS[operation]} is enabled for the project and environment.`, status);
  }

  const code = data?.errors?.[0]?.code;
  if (operation === 'rates' && status === 400 && code === 'RATE.CUSTOMCLEARANCEDETAIL.INVALID') {
    return new FedExError('FedEx requires valid customs details for this quote (HTTP 400, RATE.CUSTOMCLEARANCEDETAIL.INVALID). Provide customsClearanceDetail.commodities with the shipment contents. For eligible document-only shipments, also set documentShipment: true.', status);
  }
  const detail = typeof code === 'string' && /^[A-Z0-9_.-]{1,120}$/.test(code) ? `, ${code}` : '';
  return new FedExError(`FedEx ${operation} request failed (HTTP ${status}${detail}).`, status);
}

function location(address) {
  if (!address?.city && !address?.stateOrProvinceCode && !address?.countryCode) {
    return undefined;
  }
  return {
    city: address.city,
    stateOrProvinceCode: address.stateOrProvinceCode,
    countryCode: address.countryCode,
  };
}

function summarizeMatch(match, includeDetailedScans) {
  const trackingNumber = match.trackingNumberInfo?.trackingNumber;
  if (match.error) {
    return { trackingNumber, error: { code: match.error.code, message: match.error.message } };
  }

  const latest = match.latestStatusDetail;
  const dates = Array.isArray(match.dateAndTimes) ? match.dateAndTimes : [];
  const estimatedWindow = match.estimatedDeliveryTimeWindow?.window;

  return {
    trackingNumber,
    status: latest && {
      code: latest.code,
      description: latest.statusByLocale || latest.description,
    },
    location: location(latest?.scanLocation),
    estimatedDelivery: dates.find((date) => date?.type === 'ESTIMATED_DELIVERY')?.dateTime,
    estimatedDeliveryWindow: (estimatedWindow?.begins || estimatedWindow?.ends) ? {
      begins: estimatedWindow.begins,
      ends: estimatedWindow.ends,
    } : undefined,
    actualDelivery: dates.find((date) => date?.type === 'ACTUAL_DELIVERY')?.dateTime,
    scanEvents: includeDetailedScans ? (match.scanEvents ?? []).map((event) => ({
      date: event.date,
      eventType: event.eventType,
      description: event.eventDescription,
      location: location(event.scanLocation),
    })) : undefined,
  };
}

function summarizeTracking(data, config, trackingNumbers, includeDetailedScans) {
  const output = data?.output;
  const groups = output?.completeTrackResults ?? [];
  if (!output || typeof output !== 'object' || Array.isArray(output) || !Array.isArray(groups)) {
    throw new FedExError('FedEx returned an unexpected tracking response.');
  }

  return {
    environment: config.environment,
    ...responseDetails(data),
    requestedTrackingNumbers: trackingNumbers,
    shipments: groups.map((group) => ({
      trackingNumber: group.trackingNumber,
      matches: (group.trackResults ?? []).map((match) => summarizeMatch(match, includeDetailedScans)),
    })),
  };
}

function responseDetails(data) {
  const alerts = [data.output.alerts, data.alerts].filter(Array.isArray).flat().filter(Boolean);
  return {
    virtualResponse: alerts.some((alert) => alert.code === 'VIRTUAL.RESPONSE'),
    alerts: alerts.length ? alerts.map(({ code, alertType, message }) => ({ code, alertType, message })) : undefined,
    transactionId: data.transactionId,
  };
}

function addAvailabilityToQuotes(quotes, services, requestedPackagingType) {
  const servicesByType = new Map(services.map((service) => [service.serviceType, service]));
  for (const quote of quotes) {
    if (!quote.serviceType) continue;

    const service = servicesByType.get(quote.serviceType);
    const packagingType = quote.packagingType ?? requestedPackagingType;
    quote.availability = { serviceListed: Boolean(service) };
    if (service?.packagingOptions.length && packagingType) {
      quote.availability.packagingListed = service.packagingOptions.some((option) => option.packagingType === packagingType);
    }
  }
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
      const data = await response.json().catch(() => undefined);
      if (!response.ok) {
        throw httpError(operation, response.status, data);
      }
      if (!data) {
        throw new FedExError(`FedEx returned an invalid ${operation} response.`);
      }
      return data;
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
    const data = await post('/oauth/token', 'authorization', {
      'content-type': 'application/x-www-form-urlencoded',
    }, new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: config.clientId,
      client_secret: config.clientSecret,
    }));

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
    try {
      return await post(path, operation, {
        'content-type': 'application/json',
        authorization: `Bearer ${token.value}`,
        'x-locale': config.locale,
      }, body);
    } catch (error) {
      if (error.status === 401 && tokenCache.token === token) {
        tokenCache.token = undefined;
      }
      throw error;
    }
  }

  async function requestJson(path, operation, payload) {
    const body = JSON.stringify(payload);
    const token = await getToken();
    try {
      return await sendAuthenticated(path, operation, body, token);
    } catch (error) {
      if (error.status !== 401) throw error;
      return sendAuthenticated(path, operation, body, await getToken());
    }
  }

  async function quotePart(path, operation, payload, summarize) {
    try {
      const data = await requestJson(path, operation, payload);
      const output = data.output;
      if (!output || typeof output !== 'object' || Array.isArray(output)) {
        throw new FedExError(`FedEx returned an unexpected ${operation} response.`);
      }
      return { ...responseDetails(data), ...summarize(output) };
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
      const data = await requestJson('/track/v1/trackingnumbers', 'tracking', {
        trackingInfo: trackingNumbers.map((trackingNumber) => ({ trackingNumberInfo: { trackingNumber } })),
        includeDetailedScans,
      });
      return summarizeTracking(data, config, trackingNumbers, includeDetailedScans);
    },

    async quote(input) {
      if (!/^\d{9}$/.test(config.accountNumber ?? '')) {
        throw new FedExError('Set FEDEX_ACCOUNT_NUMBER to the 9-digit shipping account linked to this FedEx project.');
      }

      const [rates, serviceAvailability] = await Promise.all([
        quotePart('/rate/v1/rates/quotes', 'rates', buildRateRequest(input, config.accountNumber),
          (output) => ({ quotes: summarizeRates(output) })),
        quotePart('/availability/v1/packageandserviceoptions', 'service availability',
          buildAvailabilityRequest(input, config.accountNumber), (output) => ({ services: summarizeAvailability(output) })),
      ]);

      if (rates.quotes && serviceAvailability.services) {
        addAvailabilityToQuotes(rates.quotes, serviceAvailability.services, input.packagingType);
      }
      return { environment: config.environment, rates, serviceAvailability };
    },
  };
}
