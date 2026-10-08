/**
 * REST client.
 *
 * Thin on purpose. The token lives in memory plus sessionStorage (not
 * localStorage): a Mini App session should not outlive the browsing session,
 * and the server can revoke it independently anyway.
 */

import type { ApiResponse } from '@cb/shared';

const TOKEN_KEY = 'cb.token';

let token: string | null = null;

export function setToken(value: string | null): void {
  token = value;
  try {
    if (value) sessionStorage.setItem(TOKEN_KEY, value);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    // Private mode / storage disabled — the in-memory copy still works.
  }
}

export function getToken(): string | null {
  if (token) return token;
  try {
    token = sessionStorage.getItem(TOKEN_KEY);
  } catch {
    token = null;
  }
  return token;
}

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';

  const current = getToken();
  if (current) headers.Authorization = `Bearer ${current}`;

  let response: Response;
  try {
    response = await fetch(path, {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal ?? AbortSignal.timeout(20_000),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new ApiError('TIMEOUT', 'The server took too long to respond.', 0);
    }
    throw new ApiError('NETWORK', 'Connection failed. Check your internet and try again.', 0);
  }

  let payload: ApiResponse<T>;
  try {
    payload = (await response.json()) as ApiResponse<T>;
  } catch {
    throw new ApiError('BAD_RESPONSE', 'The server sent an unreadable response.', response.status);
  }

  if (!payload.ok) {
    if (response.status === 401) setToken(null);
    throw new ApiError(payload.error.code, payload.error.message, response.status, payload.error.details);
  }

  return payload.data;
}

export const api = {
  get: <T>(path: string, signal?: AbortSignal) => request<T>(path, { signal }),
  post: <T>(path: string, body?: unknown) => request<T>(path, { method: 'POST', body }),
  put: <T>(path: string, body?: unknown) => request<T>(path, { method: 'PUT', body }),
};

/** Idempotency key for any request that must not be applied twice. */
export function requestKey(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
