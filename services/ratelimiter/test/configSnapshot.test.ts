/**
 * Config snapshot parsing + key handling — the fallback path's only source
 * of client limits, so malformed data must degrade safely, never crash.
 */
import { parseConfigHash, clientIdFromKey } from '../src/limiter/configSnapshot';

describe('parseConfigHash', () => {
  it('parses a well-formed config hash', () => {
    expect(
      parseConfigHash({ limit: '100', windowSeconds: '60', onOutage: 'closed' }),
    ).toEqual({ limit: 100, windowSeconds: 60, onOutage: 'closed' });
  });

  it('defaults missing/unknown outage policy to fail-open (the PRD default)', () => {
    expect(parseConfigHash({ limit: '100', windowSeconds: '60' })?.onOutage).toBe('open');
    expect(
      parseConfigHash({ limit: '100', windowSeconds: '60', onOutage: 'weird' })?.onOutage,
    ).toBe('open');
  });

  it.each([
    [{}],
    [{ limit: 'abc', windowSeconds: '60' }],
    [{ limit: '0', windowSeconds: '60' }],
    [{ limit: '-5', windowSeconds: '60' }],
    [{ limit: '100', windowSeconds: '0' }],
    [{ limit: '100' }],
  ])('rejects malformed hash %j', (hash) => {
    expect(parseConfigHash(hash as Record<string, string>)).toBeNull();
  });
});

describe('clientIdFromKey', () => {
  it('strips the prefix and the cluster hash-tag braces', () => {
    expect(clientIdFromKey('ratelimit:config:{client-a}')).toBe('client-a');
  });

  it('tolerates keys without braces (defensive)', () => {
    expect(clientIdFromKey('ratelimit:config:client-a')).toBe('client-a');
  });
});
