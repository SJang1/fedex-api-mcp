export function buildRateRequest(input, accountNumber) {
  return {
    accountNumber: { value: accountNumber },
    rateRequestControlParameters: { returnTransitTimes: true },
    requestedShipment: {
      shipper: { address: input.origin },
      recipient: { address: input.destination },
      pickupType: input.pickupType,
      packagingType: input.packagingType,
      shipDateStamp: input.shipDate,
      rateRequestType: input.rateRequestTypes,
      requestedPackageLineItems: input.packages,
      serviceType: input.serviceType,
      documentShipment: input.documentShipment,
      customsClearanceDetail: input.customsClearanceDetail,
    },
  };
}
