import { describe, it, expect, beforeEach } from "vitest";

const ERR_NOT_AUTHORIZED = 200;
const ERR_INVALID_PROPERTY = 201;
const ERR_INVALID_DATES = 202;
const ERR_INVALID_COST = 203;
const ERR_INVALID_STATUS = 204;
const ERR_BOOKING_NOT_FOUND = 206;
const ERR_PROPERTY_NOT_AVAILABLE = 207;
const ERR_HOST_NOT_VERIFIED = 208;
const ERR_ESCROW_FAIL = 209;
const ERR_INVALID_DEPOSIT = 215;
const ERR_INVALID_REVIEW_RATING = 219;
const ERR_INVALID_REVIEW_COMMENT = 220;

interface Booking {
  propertyId: number;
  host: string;
  guest: string;
  startDate: number;
  endDate: number;
  totalCost: number;
  deposit: number;
  status: string;
  escrowId: number;
  timestamp: number;
  cancellationFee: number;
  reviewRating: number | null;
  reviewComment: string | null;
}

interface BookingUpdate {
  updateStatus: string;
  updateTimestamp: number;
  updater: string;
}

interface Result<T> {
  ok: boolean;
  value: T;
}

interface Property {
  owner: string;
}

interface Identity {
  verified: boolean;
}

class MockPropertyRegistry {
  properties: Map<number, Property> = new Map();

  getProperty(id: number): Result<Property> {
    const prop = this.properties.get(id);
    return prop ? { ok: true, value: prop } : { ok: false, value: null as unknown as Property };
  }
}

class MockIdentityRegistry {
  identities: Map<string, Identity> = new Map();

  getIdentity(principal: string): Result<Identity> {
    const id = this.identities.get(principal);
    return id ? { ok: true, value: id } : { ok: false, value: null as unknown as Identity };
  }
}

class MockEscrow {
  escrows: Map<number, { guest: string; host: string; amount: number; deposit: number }> = new Map();
  nextId: number = 1;

  createEscrow(guest: string, host: string, amount: number, deposit: number): Result<number> {
    const id = this.nextId++;
    this.escrows.set(id, { guest, host, amount, deposit });
    return { ok: true, value: id };
  }

  confirmEscrow(id: number): Result<boolean> {
    return this.escrows.has(id) ? { ok: true, value: true } : { ok: false, value: false };
  }

  cancelEscrow(id: number, fee: number): Result<boolean> {
    return this.escrows.has(id) ? { ok: true, value: true } : { ok: false, value: false };
  }

  releaseEscrow(id: number, fee: number): Result<boolean> {
    return this.escrows.has(id) ? { ok: true, value: true } : { ok: false, value: false };
  }
}

class MockReviewSystem {
  addReview(bookingId: number, rating: number, comment: string): Result<boolean> {
    return { ok: true, value: true };
  }
}

class BookingManagerMock {
  state: {
    nextBookingId: number;
    maxBookings: number;
    platformFeeRate: number;
    cancellationFeeRate: number;
    bookings: Map<number, Booking>;
    bookingsByProperty: Map<number, number[]>;
    bookingUpdates: Map<number, BookingUpdate>;
  } = {
    nextBookingId: 1,
    maxBookings: 10000,
    platformFeeRate: 5,
    cancellationFeeRate: 10,
    bookings: new Map(),
    bookingsByProperty: new Map(),
    bookingUpdates: new Map(),
  };
  blockHeight: number = 100;
  caller: string = "ST1GUEST";
  propertyRegistry: MockPropertyRegistry = new MockPropertyRegistry();
  identityRegistry: MockIdentityRegistry = new MockIdentityRegistry();
  escrow: MockEscrow = new MockEscrow();
  reviewSystem: MockReviewSystem = new MockReviewSystem();

  reset() {
    this.state = {
      nextBookingId: 1,
      maxBookings: 10000,
      platformFeeRate: 5,
      cancellationFeeRate: 10,
      bookings: new Map(),
      bookingsByProperty: new Map(),
      bookingUpdates: new Map(),
    };
    this.blockHeight = 100;
    this.caller = "ST1GUEST";
    this.propertyRegistry = new MockPropertyRegistry();
    this.identityRegistry = new MockIdentityRegistry();
    this.escrow = new MockEscrow();
    this.reviewSystem = new MockReviewSystem();
  }

  isPropertyAvailable(propertyId: number, start: number, end: number): boolean {
    const bookings = this.state.bookingsByProperty.get(propertyId) || [];
    return bookings.every(id => {
      const b = this.state.bookings.get(id);
      if (!b || b.status === "cancelled") return true;
      return start >= b.endDate || end <= b.startDate;
    });
  }

  createBooking(propertyId: number, startDate: number, endDate: number, totalCost: number, deposit: number): Result<number> {
    if (startDate <= this.blockHeight || endDate <= startDate) return { ok: false, value: ERR_INVALID_DATES };
    if (totalCost <= 0) return { ok: false, value: ERR_INVALID_COST };
    if (deposit < 0 || deposit > totalCost) return { ok: false, value: ERR_INVALID_DEPOSIT };
    const propRes = this.propertyRegistry.getProperty(propertyId);
    if (!propRes.ok) return { ok: false, value: ERR_INVALID_PROPERTY };
    const host = propRes.value.owner;
    const idRes = this.identityRegistry.getIdentity(host);
    if (!idRes.ok || !idRes.value.verified) return { ok: false, value: ERR_HOST_NOT_VERIFIED };
    if (!this.isPropertyAvailable(propertyId, startDate, endDate)) return { ok: false, value: ERR_PROPERTY_NOT_AVAILABLE };
    const escRes = this.escrow.createEscrow(this.caller, host, totalCost, deposit);
    if (!escRes.ok) return { ok: false, value: ERR_ESCROW_FAIL };
    const bookingId = this.state.nextBookingId;
    const cancellationFee = Math.floor(totalCost * this.state.cancellationFeeRate / 100);
    this.state.bookings.set(bookingId, {
      propertyId,
      host,
      guest: this.caller,
      startDate,
      endDate,
      totalCost,
      deposit,
      status: "pending",
      escrowId: escRes.value,
      timestamp: this.blockHeight,
      cancellationFee,
      reviewRating: null,
      reviewComment: null
    });
    const propBookings = this.state.bookingsByProperty.get(propertyId) || [];
    propBookings.push(bookingId);
    this.state.bookingsByProperty.set(propertyId, propBookings);
    this.state.nextBookingId++;
    return { ok: true, value: bookingId };
  }

  confirmBooking(bookingId: number): Result<boolean> {
    const booking = this.state.bookings.get(bookingId);
    if (!booking) return { ok: false, value: ERR_BOOKING_NOT_FOUND };
    if (this.caller !== booking.host) return { ok: false, value: ERR_NOT_AUTHORIZED };
    if (booking.status !== "pending") return { ok: false, value: ERR_INVALID_STATUS };
    const escRes = this.escrow.confirmEscrow(booking.escrowId);
    if (!escRes.ok) return { ok: false, value: false };
    this.state.bookings.set(bookingId, { ...booking, status: "confirmed", timestamp: this.blockHeight });
    this.state.bookingUpdates.set(bookingId, { updateStatus: "confirmed", updateTimestamp: this.blockHeight, updater: this.caller });
    return { ok: true, value: true };
  }

  cancelBooking(bookingId: number): Result<boolean> {
    const booking = this.state.bookings.get(bookingId);
    if (!booking) return { ok: false, value: ERR_BOOKING_NOT_FOUND };
    if (this.caller !== booking.guest && this.caller !== booking.host) return { ok: false, value: ERR_NOT_AUTHORIZED };
    if (booking.status !== "pending" && booking.status !== "confirmed") return { ok: false, value: ERR_INVALID_STATUS };
    const fee = this.blockHeight < booking.startDate ? booking.cancellationFee : Math.floor(booking.totalCost / 2);
    const escRes = this.escrow.cancelEscrow(booking.escrowId, fee);
    if (!escRes.ok) return { ok: false, value: false };
    this.state.bookings.set(bookingId, { ...booking, status: "cancelled", timestamp: this.blockHeight });
    this.state.bookingUpdates.set(bookingId, { updateStatus: "cancelled", updateTimestamp: this.blockHeight, updater: this.caller });
    return { ok: true, value: true };
  }

  completeBooking(bookingId: number): Result<boolean> {
    const booking = this.state.bookings.get(bookingId);
    if (!booking) return { ok: false, value: ERR_BOOKING_NOT_FOUND };
    if (this.caller !== booking.guest) return { ok: false, value: ERR_NOT_AUTHORIZED };
    if (booking.status !== "confirmed") return { ok: false, value: ERR_INVALID_STATUS };
    if (this.blockHeight < booking.endDate) return { ok: false, value: ERR_INVALID_DATES };
    const fee = Math.floor(booking.totalCost * this.state.platformFeeRate / 100);
    const escRes = this.escrow.releaseEscrow(booking.escrowId, fee);
    if (!escRes.ok) return { ok: false, value: false };
    this.state.bookings.set(bookingId, { ...booking, status: "completed", timestamp: this.blockHeight });
    this.state.bookingUpdates.set(bookingId, { updateStatus: "completed", updateTimestamp: this.blockHeight, updater: this.caller });
    return { ok: true, value: true };
  }

  addReview(bookingId: number, rating: number, comment: string): Result<boolean> {
    const booking = this.state.bookings.get(bookingId);
    if (!booking) return { ok: false, value: ERR_BOOKING_NOT_FOUND };
    if (this.caller !== booking.guest) return { ok: false, value: ERR_NOT_AUTHORIZED };
    if (booking.status !== "completed") return { ok: false, value: ERR_INVALID_STATUS };
    if (rating < 1 || rating > 5) return { ok: false, value: ERR_INVALID_REVIEW_RATING };
    if (comment.length > 500) return { ok: false, value: ERR_INVALID_REVIEW_COMMENT };
    this.state.bookings.set(bookingId, { ...booking, reviewRating: rating, reviewComment: comment });
    const revRes = this.reviewSystem.addReview(bookingId, rating, comment);
    if (!revRes.ok) return { ok: false, value: false };
    return { ok: true, value: true };
  }

  getBooking(bookingId: number): Booking | null {
    return this.state.bookings.get(bookingId) || null;
  }

  getBookingCount(): Result<number> {
    return { ok: true, value: this.state.nextBookingId };
  }
}

describe("BookingManager", () => {
  let contract: BookingManagerMock;

  beforeEach(() => {
    contract = new BookingManagerMock();
    contract.reset();
  });

  it("creates a booking successfully", () => {
    contract.propertyRegistry.properties.set(1, { owner: "ST1HOST" });
    contract.identityRegistry.identities.set("ST1HOST", { verified: true });
    const result = contract.createBooking(1, 110, 120, 1000, 200);
    expect(result.ok).toBe(true);
    expect(result.value).toBe(1);
    const booking = contract.getBooking(1);
    expect(booking?.propertyId).toBe(1);
    expect(booking?.host).toBe("ST1HOST");
    expect(booking?.guest).toBe("ST1GUEST");
    expect(booking?.startDate).toBe(110);
    expect(booking?.endDate).toBe(120);
    expect(booking?.totalCost).toBe(1000);
    expect(booking?.deposit).toBe(200);
    expect(booking?.status).toBe("pending");
    expect(booking?.cancellationFee).toBe(100);
  });

  it("rejects invalid dates", () => {
    const result = contract.createBooking(1, 90, 120, 1000, 200);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_INVALID_DATES);
  });

  it("rejects unverified host", () => {
    contract.propertyRegistry.properties.set(1, { owner: "ST1HOST" });
    contract.identityRegistry.identities.set("ST1HOST", { verified: false });
    const result = contract.createBooking(1, 110, 120, 1000, 200);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_HOST_NOT_VERIFIED);
  });

  it("confirms a booking successfully", () => {
    contract.propertyRegistry.properties.set(1, { owner: "ST1HOST" });
    contract.identityRegistry.identities.set("ST1HOST", { verified: true });
    contract.createBooking(1, 110, 120, 1000, 200);
    contract.caller = "ST1HOST";
    const result = contract.confirmBooking(1);
    expect(result.ok).toBe(true);
    const booking = contract.getBooking(1);
    expect(booking?.status).toBe("confirmed");
  });

  it("cancels a booking successfully", () => {
    contract.propertyRegistry.properties.set(1, { owner: "ST1HOST" });
    contract.identityRegistry.identities.set("ST1HOST", { verified: true });
    contract.createBooking(1, 110, 120, 1000, 200);
    const result = contract.cancelBooking(1);
    expect(result.ok).toBe(true);
    const booking = contract.getBooking(1);
    expect(booking?.status).toBe("cancelled");
  });

  it("completes a booking successfully", () => {
    contract.propertyRegistry.properties.set(1, { owner: "ST1HOST" });
    contract.identityRegistry.identities.set("ST1HOST", { verified: true });
    contract.createBooking(1, 110, 120, 1000, 200);
    contract.caller = "ST1HOST";
    contract.confirmBooking(1);
    contract.caller = "ST1GUEST";
    contract.blockHeight = 125;
    const result = contract.completeBooking(1);
    expect(result.ok).toBe(true);
    const booking = contract.getBooking(1);
    expect(booking?.status).toBe("completed");
  });

  it("adds a review successfully", () => {
    contract.propertyRegistry.properties.set(1, { owner: "ST1HOST" });
    contract.identityRegistry.identities.set("ST1HOST", { verified: true });
    contract.createBooking(1, 110, 120, 1000, 200);
    contract.caller = "ST1HOST";
    contract.confirmBooking(1);
    contract.caller = "ST1GUEST";
    contract.blockHeight = 125;
    contract.completeBooking(1);
    const result = contract.addReview(1, 4, "Great stay!");
    expect(result.ok).toBe(true);
    const booking = contract.getBooking(1);
    expect(booking?.reviewRating).toBe(4);
    expect(booking?.reviewComment).toBe("Great stay!");
  });

  it("rejects invalid review rating", () => {
    contract.propertyRegistry.properties.set(1, { owner: "ST1HOST" });
    contract.identityRegistry.identities.set("ST1HOST", { verified: true });
    contract.createBooking(1, 110, 120, 1000, 200);
    contract.caller = "ST1HOST";
    contract.confirmBooking(1);
    contract.caller = "ST1GUEST";
    contract.blockHeight = 125;
    contract.completeBooking(1);
    const result = contract.addReview(1, 6, "Invalid");
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_INVALID_REVIEW_RATING);
  });

  it("returns correct booking count", () => {
    contract.propertyRegistry.properties.set(1, { owner: "ST1HOST" });
    contract.identityRegistry.identities.set("ST1HOST", { verified: true });
    contract.createBooking(1, 110, 120, 1000, 200);
    contract.createBooking(1, 130, 140, 1500, 300);
    const result = contract.getBookingCount();
    expect(result.ok).toBe(true);
    expect(result.value).toBe(3);
  });
});