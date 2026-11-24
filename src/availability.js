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
