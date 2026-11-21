/**
 * Whether an engine and channel drifted: at least `threshold` of its prompts alarm on the same
 * day. Callers pass only prompts with a baseline, so a prompt that never varied neither counts
 * for nor dilutes the rule.
 */
export function regimeAlarm(alarms: readonly boolean[], threshold = 0.3): boolean {
  if (alarms.length === 0) return false;
  return alarms.filter(Boolean).length / alarms.length >= threshold;
}
