import { z } from 'zod';

/**
 * Files and printers.
 *
 * Only folders the owner explicitly approved are reachable. NetLink never
 * exposes a whole drive, and file contents never pass through — or rest on —
 * the control plane. Transfers are brokered here and move directly between the
 * owner's own devices.
 */

export type FileEntry = {
  name: string;
  /** Relative to the approved folder, always with forward slashes. */
  path: string;
  isDir: boolean;
  sizeBytes: number;
  modifiedAt: string;
};

export type ApprovedFolder = {
  resourceId: string;
  agentId: string;
  agentName: string;
  name: string;
  /** Shown so an owner can see which folder they approved. */
  target: string;
  readOnly: boolean;
  agentOnline: boolean;
};

export const browseRequestSchema = z.object({
  resourceId: z.string().uuid(),
  path: z.string().max(1024).default(''),
});
export type BrowseRequest = z.infer<typeof browseRequestSchema>;

export const approveFolderRequestSchema = z.object({
  agentId: z.string().uuid(),
  name: z.string().trim().min(1).max(120),
  path: z.string().trim().min(1).max(400),
  readOnly: z.boolean().default(false),
});
export type ApproveFolderRequest = z.infer<typeof approveFolderRequestSchema>;

// ---------------------------------------------------------------------------
// Transfers
// ---------------------------------------------------------------------------

export const TRANSFER_DIRECTIONS = ['download', 'upload'] as const;
export type TransferDirection = (typeof TRANSFER_DIRECTIONS)[number];

export const TRANSFER_STATES = ['pending', 'active', 'completed', 'failed', 'cancelled'] as const;
export type TransferState = (typeof TRANSFER_STATES)[number];

/**
 * A brokered transfer.
 *
 * The control plane authorises it, records that it happened, and hands both
 * ends a ticket. The bytes themselves go directly between the devices — the
 * server never holds them, which is why a server compromise cannot leak files.
 */
export type Transfer = {
  id: string;
  spaceId: string;
  resourceId: string;
  agentId: string;
  direction: TransferDirection;
  path: string;
  state: TransferState;
  sizeBytes: string | null;
  transferredBytes: string;
  /** SHA-256, filled in once the agent has hashed the file. */
  checksum: string | null;
  createdAt: string;
  completedAt: string | null;
  detail: string | null;
};

export const startTransferRequestSchema = z.object({
  resourceId: z.string().uuid(),
  direction: z.enum(TRANSFER_DIRECTIONS),
  path: z.string().trim().min(1).max(1024),
  /** For an upload, so the far end can show real progress. */
  sizeBytes: z
    .string()
    .regex(/^\d{1,20}$/)
    .optional(),
  /** Where a resumed transfer left off. */
  offsetBytes: z
    .string()
    .regex(/^\d{1,20}$/)
    .default('0'),
});
export type StartTransferRequest = z.infer<typeof startTransferRequestSchema>;

export const transferProgressSchema = z.object({
  transferId: z.string().uuid(),
  transferredBytes: z.string().regex(/^\d{1,20}$/),
  state: z.enum(TRANSFER_STATES),
  checksum: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
  detail: z.string().max(500).optional(),
});
export type TransferProgress = z.infer<typeof transferProgressSchema>;

export const fileOperationSchema = z.object({
  resourceId: z.string().uuid(),
  operation: z.enum(['mkdir', 'rename', 'delete']),
  path: z.string().trim().min(1).max(1024),
  /** Destination, for a rename. */
  toPath: z.string().trim().max(1024).optional(),
  /**
   * Deleting is destructive and irreversible, so the client has to say so
   * explicitly rather than the server inferring intent from the verb alone.
   */
  confirmed: z.boolean().default(false),
});
export type FileOperation = z.infer<typeof fileOperationSchema>;

// ---------------------------------------------------------------------------
// Printing
// ---------------------------------------------------------------------------

export const PAPER_SIZES = ['A4', 'A5', 'Letter', 'Legal'] as const;
export type PaperSize = (typeof PAPER_SIZES)[number];

export const PRINT_JOB_STATES = ['queued', 'sent', 'printing', 'completed', 'failed'] as const;
export type PrintJobState = (typeof PRINT_JOB_STATES)[number];

export type SharedPrinter = {
  resourceId: string;
  agentId: string;
  agentName: string;
  name: string;
  /** ready, offline, error or unknown, as the agent reported it. */
  status: string;
  isDefault: boolean;
  agentOnline: boolean;
};

export const printJobRequestSchema = z.object({
  resourceId: z.string().uuid(),
  /** The PDF, base64. Bounded so a print job cannot be used as a file upload. */
  documentBase64: z.string().min(1).max(40_000_000),
  documentName: z.string().trim().min(1).max(200),
  copies: z.number().int().min(1).max(50).default(1),
  colour: z.boolean().default(true),
  paperSize: z.enum(PAPER_SIZES).default('A4'),
});
export type PrintJobRequest = z.infer<typeof printJobRequestSchema>;

export type PrintJob = {
  id: string;
  spaceId: string;
  printerName: string;
  documentName: string;
  copies: number;
  colour: boolean;
  paperSize: PaperSize;
  state: PrintJobState;
  createdAt: string;
  completedAt: string | null;
  detail: string | null;
};

export const printJobResultSchema = z.object({
  deviceId: z.string().uuid(),
  jobId: z.string().uuid(),
  state: z.enum(PRINT_JOB_STATES),
  detail: z.string().max(500).optional(),
});
export type PrintJobResult = z.infer<typeof printJobResultSchema>;

/** Only PDFs are accepted, checked by magic bytes rather than by file name. */
export function looksLikePdf(base64: string): boolean {
  // "%PDF" is "JVBERi" once base64-encoded from offset zero.
  return base64.startsWith('JVBERi');
}
