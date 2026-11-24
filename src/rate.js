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

function summarizeTransit(commit, operational) {
  const date = commit?.dateDetail;
  const range = commit?.transitDays;
  // FedEx's schema and example use different field spellings for the expected date and maximum time.
  const transit = {
    deliveryDate: date?.dayFormat || date?.dayCxsFormat || operational?.deliveryDate || operational?.commitDate,
    daysInTransit: commit?.daysInTransit || operational?.transitTime || operational?.customTransitTime,
    description: range?.description,
    minimumTransitTime: range?.minimumTransitTime,
    maximumTransitTime: range?.maximumTransitTime || operational?.maximumTransitTime || operational?.MaximumTransitTime,
  };
  return Object.values(transit).some(Boolean) ? transit : undefined;
}

export function summarizeRates(output) {
  return (output.rateReplyDetails ?? []).map((detail) => ({
    serviceType: detail.serviceType || detail.serviceDescription?.serviceType,
    serviceName: detail.serviceName || detail.serviceDescription?.description,
    packagingType: detail.packagingType,
    transit: summarizeTransit(detail.commit, detail.operationalDetail),
    charges: (detail.ratedShipmentDetails ?? [])
      .filter((rate) => Number.isFinite(rate.totalNetCharge))
      .map((rate) => ({
        rateType: rate.rateType,
        amount: rate.totalNetCharge,
        currency: rate.shipmentRateDetail?.currency || rate.currency,
      })),
    messages: detail.customerMessages?.map(({ code, message }) => ({ code, message })),
  }));
}
