import { afterEach, describe, expect, it } from 'vitest';
import { createClient } from '@sibei/cli';

/** A bearer token is not sent over plain http to another machine unless the person opts in (SEC, low). */

afterEach(() => {
  delete process.env.SBSCORE_ALLOW_INSECURE_TOKEN;
});

describe('where a token may travel', () => {
  it('refuses plain http to a non-loopback host', () => {
    expect(() => createClient('http://scores.example.com', { token: 'sbs_x' })).toThrow(/refusing to send a token/);
    expect(() => createClient('http://10.0.0.5:4321', { token: 'sbs_x' })).toThrow(/plain http/);
  });

  it('allows https, loopback, and an explicit opt-in', () => {
    expect(() => createClient('https://scores.example.com', { token: 'sbs_x' })).not.toThrow();
    expect(() => createClient('http://127.0.0.1:4321', { token: 'sbs_x' })).not.toThrow();
    expect(() => createClient('http://localhost:4321', { token: 'sbs_x' })).not.toThrow();
    expect(() => createClient('http://[::1]:4321', { token: 'sbs_x' })).not.toThrow();
    process.env.SBSCORE_ALLOW_INSECURE_TOKEN = '1';
    expect(() => createClient('http://scores.example.com', { token: 'sbs_x' })).not.toThrow();
  });

  it('does not mind a tokenless client, which is how a local install runs', () => {
    expect(() => createClient('http://scores.example.com')).not.toThrow();
  });
});
