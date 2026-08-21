import { z } from "zod";

const reportSchema = z.object({
  id: z.string().min(1).max(128),
  lat: z.number().finite().min(-90).max(90),
  lng: z.number().finite().min(-180).max(180),
  locationName: z.string().min(1).max(200),
  wilaya: z.string().min(1).max(200),
  description: z.string().max(2000),
  severity: z.enum(["low", "medium", "high", "critical"]),
  status: z.enum(["pending", "verified", "rejected", "resolved"]),
  timestamp: z.string().datetime({ offset: true }),
  consensusCount: z.number().int().min(0).max(1_000_000),
  reporterType: z.enum(["citizen", "volunteer", "official"]).optional(),
}).passthrough();

export type ValidatedReport = z.infer<typeof reportSchema>;

export function validateReport(value: unknown): ValidatedReport | null {
  const parsed = reportSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function validateReports(values: unknown): ValidatedReport[] | null {
  if (!Array.isArray(values)) return null;
  const reports = values.map(validateReport);
  return reports.every((report): report is ValidatedReport => report !== null) ? reports : null;
}

export { reportSchema };
