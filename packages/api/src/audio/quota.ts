/**
 * The audio allowance (SIB2-140, ADR-0034 amendment decision 17): how many audio-seconds a user may have
 * transcribed in a period, as **configuration** and not code. It is a cap, not a price: how seconds become
 * money, and which user is on which paid plan, are decisions billing makes later (ADR-0039 decision 7).
 * Until then an operator names the allowance and the exceptions, and a "paid user" is one the operator has
 * listed with a higher or unlimited allowance.
 *
 *   - `freeSeconds`   what everyone gets per period. `null` means no cap at all (the local default: one
 *                     person on their own machine has nobody to be limited against).
 *   - `plans`         per-user overrides by owner id: a number of seconds, or `'unlimited'`.
 */
export interface AudioQuotaConfig {
  freeSeconds: number | null;
  plans?: Readonly<Record<string, number | 'unlimited'>>;
}

/** The cap that applies to this owner, in audio-seconds, or `null` when they have none. */
export function audioCapFor(config: AudioQuotaConfig, owner: string): number | null {
  const plan = config.plans?.[owner];
  if (plan === 'unlimited') return null;
  if (typeof plan === 'number') return plan;
  return config.freeSeconds;
}

/**
 * `usr_a=unlimited,usr_b=7200` into overrides. Strict, because a typo here silently decides who is limited:
 * an entry that is not `owner=unlimited` or `owner=<whole seconds>` is an error, not ignored.
 */
export function parseAudioPlans(text: string): Record<string, number | 'unlimited'> {
  const plans: Record<string, number | 'unlimited'> = {};
  for (const entry of text.split(',').map((part) => part.trim()).filter((part) => part !== '')) {
    const at = entry.lastIndexOf('=');
    const owner = at <= 0 ? '' : entry.slice(0, at).trim();
    const value = at <= 0 ? '' : entry.slice(at + 1).trim();
    if (owner === '' || (value !== 'unlimited' && !/^[0-9]+$/.test(value))) {
      throw new Error(`"${entry}" is not owner=unlimited or owner=<seconds>`);
    }
    plans[owner] = value === 'unlimited' ? 'unlimited' : Number(value);
  }
  return plans;
}
