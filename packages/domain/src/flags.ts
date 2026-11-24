export interface FlagRule {
  key: string;
  /** Global default when no allow-list or rollout applies. */
  enabled: boolean;
  /** 0–100. Applied per user, or per tenant when there is no user. */
  rolloutPercent: number;
  tenantIds: readonly string[];
  userIds: readonly string[];
}

export interface FlagSubject {
  tenantId?: string;
  userId?: string;
}

/** Stable bucket 0–99 for (flag, subject). FNV-1a 32-bit: fast, no crypto needed, same on server and device. */
export function flagBucket(key: string, subjectId: string): number {
  let hash = 0x811c9dc5;
  for (const char of `${key}:${subjectId}`) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % 100;
}

export function isFlagOn(flag: FlagRule, subject: FlagSubject): boolean {
  if (subject.userId && flag.userIds.includes(subject.userId)) return true;
  if (subject.tenantId && flag.tenantIds.includes(subject.tenantId)) return true;
  const subjectId = subject.userId ?? subject.tenantId;
  if (flag.rolloutPercent > 0 && subjectId)
    return flagBucket(flag.key, subjectId) < flag.rolloutPercent;
  return flag.enabled;
}
