// Ported from the frontend (src/utils/availability.ts). Pure functions, no I/O.
import type { Booking, BookingLine, Business, Service } from './types.js';
import { addDaysIso, nightsBetween, pricingMode } from './pricing.js';
import { occupiesInventory } from './lifecycle.js';
import { vehiclePlates } from './catalog.js';

type LineSource = Pick<Booking, 'lines' | 'serviceId' | 'serviceName' | 'units' | 'unitPriceRwf' | 'totalRwf'>;

export function bookingLines(booking: LineSource): BookingLine[] {
  if (booking.lines?.length) return booking.lines;
  if (!booking.serviceId) return [];
  return [{
    serviceId: booking.serviceId,
    serviceName: booking.serviceName ?? 'Service',
    units: booking.units ?? 1,
    unitPriceRwf: booking.unitPriceRwf ?? 0,
    lineTotalRwf: booking.totalRwf,
  }];
}

/** Checkout morning is free for stays. A single date occupies that day only. */
export function occupiedUntil(booking: Pick<Booking, 'date' | 'endDate' | 'nights'>, service?: Pick<Service, 'unit'>) {
  if (!booking.endDate) return addDaysIso(booking.date, 1);
  const stay = service ? pricingMode(service.unit) === 'stay' : nightsBetween(booking.date, booking.endDate) === (booking.nights ?? -1);
  return stay ? booking.endDate : addDaysIso(booking.endDate, 1);
}

const overlaps = (start: string, end: string, otherStart: string, otherEnd: string) => start < otherEnd && otherStart < end;

export type AvailabilityBooking = Pick<Booking, 'status' | 'date' | 'endDate' | 'nights'> & LineSource;

/** Units already held (any booking that has not been canceled, declined, expired or refunded) for this service between start (inclusive) and end (exclusive). */
export function reservedUnits(serviceId: string, bookings: AvailabilityBooking[], start: string, end: string, service?: Pick<Service, 'unit'>) {
  return bookings.reduce((sum, booking) => {
    if (!occupiesInventory(booking.status)) return sum;
    const line = bookingLines(booking).find((item) => item.serviceId === serviceId);
    if (!line) return sum;
    return overlaps(start, end, booking.date, occupiedUntil(booking, service)) ? sum + line.units : sum;
  }, 0);
}

/** Remaining units. Infinity when the offering has no fixed count. */
export function remaining(service: Pick<Service, 'id' | 'unit' | 'available'>, bookings: AvailabilityBooking[], start: string, end: string) {
  if (service.available == null) return Number.POSITIVE_INFINITY;
  return Math.max(0, service.available - reservedUnits(service.id, bookings, start, end, service));
}

/** The window a request occupies: stays free the checkout morning, other ranges include the last day. */
export function requestWindow(date: string, endDate: string | undefined, service: Pick<Service, 'unit'>) {
  if (!endDate) return { start: date, end: addDaysIso(date, 1) };
  return { start: date, end: pricingMode(service.unit) === 'stay' ? endDate : addDaysIso(endDate, 1) };
}

export function openToday(service: Service, bookings: AvailabilityBooking[], today: string) {
  return remaining(service, bookings, today, addDaysIso(today, 1)) > 0;
}

export const availableServices = (services: Service[], bookings: AvailabilityBooking[], today: string) =>
  services.filter((s) => openToday(s, bookings, today));

export const hasAvailability = (business: Pick<Business, 'services'>, bookings: AvailabilityBooking[], today: string) =>
  availableServices(business.services, bookings, today).length > 0;

/** Plates already assigned to overlapping bookings of this car type. */
export function reservedPlates(serviceId: string, bookings: AvailabilityBooking[], start: string, end: string, service?: Pick<Service, 'unit'>) {
  const taken: string[] = [];
  for (const booking of bookings) {
    if (!occupiesInventory(booking.status)) continue;
    const line = bookingLines(booking).find((item) => item.serviceId === serviceId);
    if (!line?.plateNumbers?.length) continue;
    if (overlaps(start, end, booking.date, occupiedUntil(booking, service))) taken.push(...line.plateNumbers);
  }
  return taken;
}

/** Next free registration plates for a vehicle hire. */
export function assignVehiclePlates(service: Service, count: number, bookings: AvailabilityBooking[], start: string, end: string) {
  const fleet = vehiclePlates(service);
  if (!fleet.length) return [];
  const taken = new Set(reservedPlates(service.id, bookings, start, end, service));
  const reserved = reservedUnits(service.id, bookings, start, end, service);
  const anonymous = Math.max(0, reserved - taken.size);
  const free = fleet.filter((plate) => !taken.has(plate));
  return free.slice(anonymous, anonymous + Math.max(0, count));
}
