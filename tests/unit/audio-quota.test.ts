import { describe, expect, it } from 'vitest';
import { audioCapFor, parseAudioPlans } from '@sibei/api';

/** The audio allowance as configuration (SIB2-140): who gets what, with no code involved. */
describe('the audio allowance', () => {
  const config = { freeSeconds: 1800, plans: { usr_paid: 'unlimited', usr_more: 7200 } as const };

  it('gives everyone the free allowance, and a listed user their own', () => {
    expect(audioCapFor(config, 'usr_anyone')).toBe(1800);
    expect(audioCapFor(config, 'usr_more')).toBe(7200);
    expect(audioCapFor(config, 'usr_paid')).toBeNull();
  });

  it('has no cap at all when none is configured, which is the local default', () => {
    expect(audioCapFor({ freeSeconds: null }, 'local')).toBeNull();
  });

  it('reads the plans text strictly, because a typo decides who is limited', () => {
    expect(parseAudioPlans('usr_a=unlimited, usr_b=7200')).toEqual({ usr_a: 'unlimited', usr_b: 7200 });
    expect(parseAudioPlans('')).toEqual({});
    for (const bad of ['usr_a', 'usr_a=lots', '=5', 'usr_a=-1', 'usr_a=1.5']) {
      expect(() => parseAudioPlans(bad), bad).toThrow(/owner=unlimited or owner=<seconds>/);
    }
  });
});
