import * as logs from "aws-cdk-lib/aws-logs";

/** CloudWatch Logs only accepts these retention periods (days). */
const ALLOWED = Object.values(logs.RetentionDays).filter((v): v is number => typeof v === "number" && v > 0 && v !== logs.RetentionDays.INFINITE);

/** The context value as a RetentionDays, or an error naming the allowed values. */
export function logRetention(days: number): logs.RetentionDays {
  if (!ALLOWED.includes(days)) {
    throw new Error(`logRetentionDays must be one of ${ALLOWED.sort((a, b) => a - b).join(", ")}`);
  }
  return days as logs.RetentionDays;
}
