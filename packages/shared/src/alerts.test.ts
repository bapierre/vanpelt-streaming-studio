import { describe, expect, it } from 'vitest';
import { alertSize, defaultAlertsConfig, renderAlertText, type Alert } from './alerts';
import { validatePayload } from './events';

const alert = (over: Partial<Alert> = {}): Alert => ({
  id: 'twitch:abc',
  kind: 'sub',
  platform: 'twitch',
  user: { id: '1', name: 'Ada' },
  at: 1,
  ...over,
});

describe('alerts contract', () => {
  it('accepts every kind of alert', () => {
    expect(validatePayload('alert.event', alert()).ok).toBe(true);
    expect(validatePayload('alert.event', alert({ kind: 'tip', amount: 5, currency: 'USD', amountText: '$5.00' })).ok).toBe(true);
    expect(validatePayload('alert.event', alert({ kind: 'raid', count: 42 })).ok).toBe(true);
  });
  it('rejects a lowercase currency and platforms without alerts', () => {
    expect(validatePayload('alert.event', alert({ kind: 'tip', amount: 5, currency: 'usd' })).ok).toBe(false);
    expect(validatePayload('alert.event', alert({ platform: 'x' as never })).ok).toBe(false);
  });
  it('accepts the default config', () => {
    expect(validatePayload('alert.config', defaultAlertsConfig()).ok).toBe(true);
  });
  it('keeps durations and volume in range', () => {
    expect(validatePayload('alert.cmd.setKind', { kind: 'follow', durationMs: 500 }).ok).toBe(false);
    expect(validatePayload('alert.cmd.setKind', { kind: 'follow', volume: 2 }).ok).toBe(false);
    expect(validatePayload('alert.cmd.setKind', { kind: 'follow', enabled: false }).ok).toBe(true);
  });
  it('requires a currency on a tips goal', () => {
    const goal = { id: 'tips', label: 'Tips', metric: 'tips', scope: 'stream', target: 100, platforms: ['youtube'] };
    expect(validatePayload('goal.cmd.save', goal).ok).toBe(false);
    expect(validatePayload('goal.cmd.save', { ...goal, currency: 'EUR' }).ok).toBe(true);
    expect(validatePayload('goal.cmd.save', { ...goal, metric: 'followers' }).ok).toBe(true);
  });
  it('rejects a goal with no platform or a zero target', () => {
    const goal = { id: 'f', label: 'Followers', metric: 'followers', scope: 'total', target: 10, platforms: ['twitch'] };
    expect(validatePayload('goal.cmd.save', { ...goal, platforms: [] }).ok).toBe(false);
    expect(validatePayload('goal.cmd.save', { ...goal, target: 0 }).ok).toBe(false);
  });
});

describe('renderAlertText', () => {
  it('fills the placeholders', () => {
    expect(renderAlertText('{user} gifted {count} subs!', alert({ kind: 'giftsub', count: 1200 }))).toBe('Ada gifted 1,200 subs!');
    expect(renderAlertText('{user}: {months} months at tier {tier}', alert({ months: 7, tier: '2' }))).toBe('Ada: 7 months at tier 2');
  });
  it('uses the platform text for tips, or formats the currency', () => {
    expect(renderAlertText('{amount}', alert({ kind: 'tip', amount: 5, currency: 'USD', amountText: 'US$5' }))).toBe('US$5');
    expect(renderAlertText('{amount}', alert({ kind: 'tip', amount: 5, currency: 'USD' }))).toBe('$5.00');
    expect(renderAlertText('{amount} bits', alert({ kind: 'cheer', amount: 1000 }))).toBe('1,000 bits');
  });
  it('leaves unknown placeholders visible', () => {
    expect(renderAlertText('{usr} hi', alert())).toBe('{usr} hi');
  });
});

describe('alertSize', () => {
  it('measures the field each kind is filtered by', () => {
    expect(alertSize(alert({ kind: 'cheer', amount: 100 }))).toBe(100);
    expect(alertSize(alert({ kind: 'raid', count: 30 }))).toBe(30);
    expect(alertSize(alert({ kind: 'follow' }))).toBe(0);
  });
});
