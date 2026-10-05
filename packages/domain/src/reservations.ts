import { z } from "zod";

export const ReservationFields = z.object({
  tableId: z.string().min(1),
  customerName: z.string().trim().min(1, "Enter the guest name").max(100),
  phone: z.string().trim().max(30).default("").refine((value) => !value || (/^[+\d ()-]+$/.test(value) && value.replace(/\D/g, "").length >= 7 && value.replace(/\D/g, "").length <= 15), "Enter a valid phone number or leave it blank"),
  partySize: z.number().int().min(1).max(99),
  startsLocal: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, "Choose a date and time"),
  durationMinutes: z.number().int().min(15).max(480).default(90),
  notes: z.string().trim().max(500).default(""),
});
export const ReservationCreate = ReservationFields.extend({ clientRef: z.string().uuid() });
export const ReservationUpdate = ReservationFields.extend({ version: z.number().int().positive() });
export const ReservationVersion = z.object({ version: z.number().int().positive() });
export const ReservationStatus = ReservationVersion.extend({ status: z.enum(["cancelled", "no_show"]) });
export type ReservationInput = z.infer<typeof ReservationFields>;
export interface Reservation {
  id: string; tableId: string; tableName: string; area: string | null;
  customerName: string; phone: string; partySize: number; startsAt: number; endsAt: number;
  startsLocal: string; durationMinutes: number; notes: string;
  status: "booked" | "seated" | "cancelled" | "no_show";
  orderId: string | null; orderStatus: string | null; version: number;
}
export interface ReservationList {
  reservations: Reservation[]; date: string; timezone: string; now: number; nowLocal: string;
}
