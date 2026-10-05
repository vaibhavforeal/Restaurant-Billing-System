import { z } from "zod";

export const ServiceSubmission = z.object({
  clientRef: z.string().uuid(),
  receiptToken: z.string().regex(/^[a-f0-9]{64}$/),
  kind: z.enum(["waiter", "bill"]),
}).strict();
export type ServiceSubmission = z.infer<typeof ServiceSubmission>;
export interface ServiceReceipt {
  id: string;
  kind: "waiter" | "bill";
  status: "pending" | "resolved" | "expired";
  tableName: string;
  createdAt: number;
  expiresAt: number;
  resolvedAt: number | null;
}
export interface ServiceRequest extends ServiceReceipt {
  tableId: string;
  resolvedByName: string | null;
}
