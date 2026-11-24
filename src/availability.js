export function buildAvailabilityRequest(input, accountNumber) {
  return {
    accountNumber: { value: accountNumber },
    requestedShipment: {
      shipper: { address: input.origin },
      recipients: [{ address: input.destination }],
      shipDateStamp: input.shipDate,
      pickupType: input.pickupType,
      requestedPackageLineItems: input.packages.map(({ weight, dimensions, groupPackageCount }) => ({
        physicalPackaging: input.packagingType,
        groupPackageCount,
        weight,
        dimensions,
      })),
    },
  };
}

export function summarizeAvailability(output) {
  const services = new Map();

  for (const { key, displayText } of output.serviceOptions ?? []) {
    if (key) {
      services.set(key, { serviceType: key, serviceName: displayText, packagingOptions: [] });
    }
  }

  for (const { serviceType, packageType, rateTypes } of output.packageOptions ?? []) {
    const key = serviceType?.key;
    if (!key) continue;

    const service = services.get(key) ?? {
      serviceType: key,
      serviceName: serviceType.displayText,
      packagingOptions: [],
    };
    if (packageType?.key) {
      service.packagingOptions.push({
        packagingType: packageType.key,
        packagingName: packageType.displayText,
        rateTypes,
      });
    }
    services.set(key, service);
  }

  return [...services.values()];
}
