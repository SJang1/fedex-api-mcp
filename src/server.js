import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { FedExError } from './fedex.js';

const addressSchema = z.object({
  countryCode: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/).describe('Two-letter country code, e.g. KR.'),
  postalCode: z.string().trim().min(1).max(10).optional(),
  city: z.string().trim().min(1).optional(),
  stateOrProvinceCode: z.string().trim().min(1).optional().describe('State or province code where required, e.g. CA.'),
  residential: z.boolean().optional(),
});

const dimension = z.int().min(1).max(999);
const weightSchema = z.object({ value: z.number().positive(), units: z.enum(['KG', 'LB']) });
const packageSchema = z.object({
  weight: weightSchema,
  dimensions: z.object({
    length: dimension,
    width: dimension,
    height: dimension,
    units: z.enum(['CM', 'IN']),
  }).optional(),
  groupPackageCount: z.int().min(1).max(100).optional().describe('Number of identical packages. Defaults to one.'),
});

const customsValueSchema = z.object({
  amount: z.number().nonnegative(),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/),
});
const commoditySchema = z.object({
  description: z.string().trim().min(1).max(450),
  quantity: z.int().positive(),
  customsValue: customsValueSchema,
  countryOfManufacture: addressSchema.shape.countryCode.optional(),
  quantityUnits: z.string().trim().min(1).optional(),
  weight: weightSchema.optional(),
  unitPrice: customsValueSchema.optional(),
  numberOfPieces: z.int().positive().optional(),
  harmonizedCode: z.string().trim().min(1).optional(),
});

function failedResponse({ status, error }) {
  return Boolean(error) || status < 200 || status >= 300;
}

function quotePartContent(operation, { status, headers, body, error }) {
  if (error) {
    return [{ type: 'text', text: JSON.stringify({ operation, error }) }];
  }
  return [
    { type: 'text', text: JSON.stringify({ operation, status, headers }) },
    { type: 'text', text: body },
  ];
}

function toolError(error, fallback) {
  return {
    isError: true,
    content: [{ type: 'text', text: error instanceof FedExError ? error.message : fallback }],
  };
}

export function createServer(fedex) {
  const server = new McpServer({ name: 'fedex-tracking-mcp', version: '0.1.0' });

  server.registerTool('fedex_track', {
    title: 'Track FedEx shipments',
    description: 'Look up up to 30 FedEx tracking numbers. Returns the original FedEx response body and the HTTP status and headers. Sandbox results may be simulated.',
    inputSchema: z.object({
      trackingNumbers: z.array(z.string().trim().min(1)).min(1).max(30)
        .describe('FedEx tracking numbers as strings. Preserve leading zeros.'),
      includeDetailedScans: z.boolean().default(false).describe('Include shipment scan history.'),
    }),
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async ({ trackingNumbers, includeDetailedScans }) => {
    try {
      const result = await fedex.track(trackingNumbers, includeDetailedScans);
      const { status, headers, body } = result;
      return {
        ...(failedResponse(result) ? { isError: true } : {}),
        structuredContent: result,
        content: [
          { type: 'text', text: body },
          { type: 'text', text: JSON.stringify({ status, headers }) },
        ],
      };
    } catch (error) {
      return toolError(error, 'Unable to process the FedEx tracking response.');
    }
  });

  server.registerTool('fedex_quote', {
    title: 'Compare FedEx rates, transit times, and service availability',
    description: 'Get FedEx rate and transit estimates and service and packaging availability for the same route and ship date. Returns the original response body, HTTP status, and headers for each API. Sandbox results may be simulated.',
    inputSchema: z.object({
      origin: addressSchema,
      destination: addressSchema,
      shipDate: z.iso.date().describe('Planned date to hand the shipment to FedEx, in the origin’s local time (YYYY-MM-DD).'),
      packages: z.array(packageSchema).min(1).max(100).refine(
        (packages) => packages.reduce((total, parcel) => total + (parcel.groupPackageCount ?? 1), 0) <= 100,
        { message: 'A shipment can contain up to 100 packages.' },
      ),
      packagingType: z.string().trim().regex(/^[A-Z0-9_]+$/).default('YOUR_PACKAGING')
        .describe('FedEx packaging code for the shipment.'),
      pickupType: z.enum(['DROPOFF_AT_FEDEX_LOCATION', 'CONTACT_FEDEX_TO_SCHEDULE', 'USE_SCHEDULED_PICKUP'])
        .default('DROPOFF_AT_FEDEX_LOCATION'),
      rateRequestTypes: z.array(z.enum(['ACCOUNT', 'LIST'])).min(1).max(2).default(['LIST'])
        .describe('LIST includes any account rates FedEx supplies. Use ACCOUNT for account rates only.'),
      serviceType: z.string().trim().regex(/^[A-Z0-9_]+$/).optional()
        .describe('Optional FedEx service code to limit rate quotes. Availability still lists services for the route.'),
      documentShipment: z.boolean().optional().describe('Set true for an eligible document-only shipment.'),
      customsClearanceDetail: z.object({
        commodities: z.array(commoditySchema).min(1).max(999),
        dutiesPayment: z.object({ paymentType: z.literal('SENDER') }).optional(),
      }).optional().describe('Customs information for rate quotes on goods shipments when required by FedEx.'),
    }),
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async (input) => {
    try {
      const result = await fedex.quote(input);
      const { rates, serviceAvailability } = result;
      return {
        ...(failedResponse(rates) && failedResponse(serviceAvailability) ? { isError: true } : {}),
        structuredContent: result,
        content: [
          ...quotePartContent('rates', rates),
          ...quotePartContent('serviceAvailability', serviceAvailability),
        ],
      };
    } catch (error) {
      return toolError(error, 'Unable to process the FedEx quote.');
    }
  });

  return server;
}
