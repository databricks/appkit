import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ServicePrincipalTokenProvider, OboTokenExtractor } from '../../src/plugin/auth';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('ServicePrincipalTokenProvider', () => {
  let provider: ServicePrincipalTokenProvider;

  beforeEach(() => {
    vi.stubEnv('DATABRICKS_CLIENT_ID', 'test-client-id');
    vi.stubEnv('DATABRICKS_CLIENT_SECRET', 'test-client-secret');
    provider = new ServicePrincipalTokenProvider('test-host.databricks.com');
    mockFetch.mockReset();
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('fetches token from OIDC endpoint', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ access_token: 'token-abc', expires_in: 3600 }),
    });

    const token = await provider.getToken();

    expect(token).toBe('token-abc');
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('https://test-host.databricks.com/oidc/v1/token');
    expect(opts.method).toBe('POST');
    expect(opts.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    const body = new URLSearchParams(opts.body);
    expect(body.get('grant_type')).toBe('client_credentials');
    expect(body.get('client_id')).toBe('test-client-id');
    expect(body.get('client_secret')).toBe('test-client-secret');
    expect(body.get('scope')).toBe('all-apis');
  });

  it('returns cached token on subsequent calls within expiry', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ access_token: 'token-abc', expires_in: 3600 }),
    });

    await provider.getToken();
    await provider.getToken();

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('refreshes token when within 2-minute expiry buffer', async () => {
    vi.useFakeTimers();

    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ access_token: 'token-1', expires_in: 3600 }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ access_token: 'token-2', expires_in: 3600 }),
      });

    const token1 = await provider.getToken();
    expect(token1).toBe('token-1');

    // Advance to within 2 minutes of expiry (3600s - 120s = 3480s)
    vi.advanceTimersByTime(3481 * 1000);

    const token2 = await provider.getToken();
    expect(token2).toBe('token-2');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});

describe('OboTokenExtractor', () => {
  it('extracts token from x-forwarded-access-token header', () => {
    const req = {
      headers: { 'x-forwarded-access-token': 'user-token-xyz' },
    } as any;

    const token = OboTokenExtractor.extractFromRequest(req);
    expect(token).toBe('user-token-xyz');
  });

  it('throws UNAUTHORIZED when header is missing', () => {
    const req = { headers: {} } as any;

    expect(() => OboTokenExtractor.extractFromRequest(req)).toThrow();
    try {
      OboTokenExtractor.extractFromRequest(req);
    } catch (err: any) {
      expect(err.code).toBe('UNAUTHORIZED');
      expect(err.statusCode).toBe(401);
    }
  });

  it('throws UNAUTHORIZED when header is empty string', () => {
    const req = {
      headers: { 'x-forwarded-access-token': '' },
    } as any;

    expect(() => OboTokenExtractor.extractFromRequest(req)).toThrow();
  });
});
