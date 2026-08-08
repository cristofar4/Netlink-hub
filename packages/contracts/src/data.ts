import { z } from 'zod';
import { PERMISSIONS, type Permission } from './permissions';

/**
 * The Data Pool.
 *
 * NetLink shares an internet data allowance that the owner already pays a
 * telecom, ISP or MVNO for. It does **not** create data, bypass carrier
 * billing, automate USSD tricks, or present mock usage as real usage. Every
 * real allocation goes through a licensed provider's own API; the Demo Provider
 * exists only so the product can be built and tested, and says so wherever it
 * appears.
 */

export const ALLOCATION_STATUSES = ['active', 'paused', 'expired', 'revoked'] as const;
export type AllocationStatus = (typeof ALLOCATION_STATUSES)[number];

/** Byte counts cross the wire as decimal strings — they exceed Number.MAX_SAFE_INTEGER. */
export const byteAmountSchema = z
  .string()
  .regex(/^\d{1,20}$/, 'Enter a whole number of bytes')
  .or(z.number().int().nonnegative().transform(String));

export const GIGABYTE = 1_000_000_000;

export type DataPoolSummary = {
  spaceId: string;
  provider: string;
  /** True for the development fixture. The UI must label it as a demo. */
  isDemo: boolean;
  accountRef: string;
  planName: string | null;
  balanceBytes: string;
  allocatedBytes: string;
  usedBytes: string;
  /** balance − allocated: what the owner can still hand out. */
  availableBytes: string;
  memberCount: number;
};

/** What a member sees about their own allocation, and nothing else. */
export type MyAllocation = {
  spaceId: string;
  spaceName: string;
  status: AllocationStatus;
  allocatedBytes: string;
  usedBytes: string;
  remainingBytes: string;
  dailyLimitBytes: string | null;
  usedTodayBytes: string;
  expiresAt: string;
  connected: boolean;
};

/** What the owner sees on the Member Access page for each member. */
export type MemberAccessRow = {
  memberId: string;
  userId: string;
  name: string;
  email: string;
  role: 'owner' | 'trusted_device' | 'invited_member';
  permissions: Permission[];
  suspended: boolean;
  expiresAt: string | null;
  connected: boolean;
  approvedDeviceName: string | null;
  allocation: {
    status: AllocationStatus;
    allocatedBytes: string;
    usedBytes: string;
    usedTodayBytes: string;
    remainingBytes: string;
    dailyLimitBytes: string | null;
    expiresAt: string;
  } | null;
};

// ---------------------------------------------------------------------------
// Invitations (NetLink Passes)
// ---------------------------------------------------------------------------

export const PASS_KINDS = ['data_only', 'custom'] as const;
export type PassKind = (typeof PASS_KINDS)[number];

export const createPassRequestSchema = z
  .object({
    /** Omit to generate a code or QR pass that anyone with the link can claim. */
    email: z.string().trim().toLowerCase().email().max(254).optional(),
    kind: z.enum(PASS_KINDS).default('data_only'),
    /** Only meaningful for a custom pass; a Data-Only pass ignores this. */
    permissions: z.array(z.enum(PERMISSIONS)).max(PERMISSIONS.length).default([]),
    totalBytes: byteAmountSchema.optional(),
    dailyBytes: byteAmountSchema.optional(),
    expiresAt: z.string().datetime(),
    allowResharing: z.boolean().default(false),
  })
  .superRefine((value, ctx) => {
    if (value.kind === 'data_only' && !value.totalBytes) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['totalBytes'],
        message: 'Set how much data this person may use',
      });
    }
    if (
      value.totalBytes &&
      value.dailyBytes &&
      BigInt(value.dailyBytes) > BigInt(value.totalBytes)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['dailyBytes'],
        message: 'The daily limit cannot be more than the total allocation',
      });
    }
    if (new Date(value.expiresAt).getTime() <= Date.now()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['expiresAt'],
        message: 'Choose an expiry date in the future',
      });
    }
  });
export type CreatePassRequest = z.infer<typeof createPassRequestSchema>;

export type PassSummary = {
  id: string;
  spaceId: string;
  spaceName: string;
  inviteeEmail: string | null;
  kind: PassKind;
  permissions: Permission[];
  status: 'pending' | 'claimed' | 'revoked' | 'expired';
  totalBytes: string | null;
  dailyBytes: string | null;
  allowResharing: boolean;
  expiresAt: string;
  createdAt: string;
  claimedAt: string | null;
  /** Returned once, at creation. Never stored or shown again. */
  claimToken?: string;
};

export const claimPassRequestSchema = z.object({
  token: z.string().min(20).max(512),
});
export type ClaimPassRequest = z.infer<typeof claimPassRequestSchema>;

export const updateAllocationRequestSchema = z
  .object({
    totalBytes: byteAmountSchema.optional(),
    dailyBytes: byteAmountSchema.nullable().optional(),
    expiresAt: z.string().datetime().optional(),
  })
  .refine(
    (value) =>
      value.totalBytes !== undefined ||
      value.dailyBytes !== undefined ||
      value.expiresAt !== undefined,
    { message: 'Change at least one thing' },
  );
export type UpdateAllocationRequest = z.infer<typeof updateAllocationRequestSchema>;

// ---------------------------------------------------------------------------
// Provider adapter
// ---------------------------------------------------------------------------

export type ProviderAccount = {
  accountRef: string;
  verified: boolean;
  displayName: string | null;
};

export type ProviderBalance = {
  /** Bytes remaining on the owner's own plan. */
  balanceBytes: string;
  /** When the provider's allowance next resets, if it does. */
  resetsAt: string | null;
};

export type ProviderPlan = {
  name: string;
  totalBytes: string;
  periodStart: string;
  periodEnd: string;
};

export type ProviderAllocation = {
  providerAllocationId: string;
  status: AllocationStatus;
  totalBytes: string;
  dailyBytes: string | null;
  expiresAt: string;
};

export type ProviderUsage = {
  usedBytes: string;
  usedTodayBytes: string;
  events: Array<{
    providerRef: string;
    bytes: string;
    sessionSeconds: number;
    occurredAt: string;
    deviceRef?: string;
  }>;
};

/**
 * What a telecom, ISP or MVNO adapter must implement.
 *
 * This is the whole boundary. A real MTN, Airtel, fibre ISP or MVNO adapter
 * satisfies these nine operations and drops in without the rest of NetLink
 * changing — which is the point of writing it down before there is a contract
 * to integrate against.
 */
export interface DataProviderAdapter {
  /** Machine name, e.g. "demo", "mtn-ng". Surfaced so the UI can label a demo. */
  readonly name: string;
  /** False for anything that does not move real bytes. */
  readonly isReal: boolean;

  verifyAccount(input: { accountRef: string }): Promise<ProviderAccount>;
  getBalance(input: { accountRef: string }): Promise<ProviderBalance>;
  getPlan(input: { accountRef: string }): Promise<ProviderPlan>;

  createAllocation(input: {
    accountRef: string;
    subscriberRef: string;
    totalBytes: string;
    dailyBytes: string | null;
    expiresAt: string;
  }): Promise<ProviderAllocation>;

  updateAllocation(input: {
    providerAllocationId: string;
    totalBytes?: string;
    dailyBytes?: string | null;
    expiresAt?: string;
  }): Promise<ProviderAllocation>;

  pauseAllocation(input: {
    providerAllocationId: string;
    paused: boolean;
  }): Promise<ProviderAllocation>;
  revokeAllocation(input: { providerAllocationId: string }): Promise<void>;

  getUsage(input: { providerAllocationId: string; since?: string }): Promise<ProviderUsage>;

  /**
   * Handles an inbound provider webhook.
   *
   * Returns the usage records it carried, already verified. An adapter that
   * cannot verify a payload must throw rather than return an empty result —
   * silently accepting unsigned usage would let anyone inflate a bill.
   */
  handleProviderWebhook(input: {
    signature: string | null;
    rawBody: string;
  }): Promise<Array<{ providerAllocationId: string; usage: ProviderUsage }>>;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** Human-readable bytes. Decimal units, because that is how data is sold. */
export function formatBytes(bytes: string | number | bigint): string {
  const value = typeof bytes === 'bigint' ? bytes : BigInt(bytes ?? 0);
  if (value < 1000n) return `${value} B`;

  const units = ['kB', 'MB', 'GB', 'TB', 'PB'];
  let scaled = Number(value);
  let unit = -1;
  while (scaled >= 1000 && unit < units.length - 1) {
    scaled /= 1000;
    unit += 1;
  }
  const decimals = scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2;
  return `${scaled.toFixed(decimals)} ${units[unit]}`;
}

/** Clamps a subtraction at zero — remaining data can never be negative. */
export function remainingBytes(total: string, used: string): string {
  const remaining = BigInt(total) - BigInt(used);
  return (remaining > 0n ? remaining : 0n).toString();
}

export function percentUsed(total: string, used: string): number {
  const totalValue = BigInt(total);
  if (totalValue === 0n) return 0;
  const percent = Number((BigInt(used) * 10000n) / totalValue) / 100;
  return Math.min(Math.max(percent, 0), 100);
}
