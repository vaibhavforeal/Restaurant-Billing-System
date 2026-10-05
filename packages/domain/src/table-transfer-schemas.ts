import { z } from "zod";

export const OrderMove = z.object({
  clientRef: z.string().min(8).max(64),
  tableId: z.string().min(1),
}).strict();
export type OrderMoveInput = z.infer<typeof OrderMove>;

export const OrderMerge = z.object({
  clientRef: z.string().min(8).max(64),
  targetOrderId: z.string().min(1),
}).strict();
export type OrderMergeInput = z.infer<typeof OrderMerge>;
