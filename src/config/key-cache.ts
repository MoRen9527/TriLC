// ── TriLC Key Cache ──
// Fetches provider keys from TriModel configuration-plane API,
// persists them to disk (S3: 600 permissions in Phase 1),
// and refreshes every 15 minutes with stagger to avoid thundering herd.
//
// Phase 1: S3 security level (600 permissions on file).
// Code structure reserves KeyStorage abstraction for Phase 2 S2 (AES-256-GCM).

import { join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { hostname } from 'node:os';

// ── Types ──

export interface ProviderKey {
  api_key: string;
  base_url?: string;
}

export interface KeyCache {
  keys: Record<string, ProviderKey>;
  defaultModel: string;
  refreshIntervalS: number;
  fetchedAt: number;      // unix ms
  expiresAt: number;      // fetchedAt + 24h
}

// ── Storage abstraction (Phase 1: S3 file; Phase 2: S2 encrypted file) ──

export interface KeyStorage {
  read(): KeyCache | null;
  write(cache: KeyCache): void;
}

class FileKeyStorage implements KeyStorage {
  constructor(private readonly filePath: string) {}

  read(): KeyCache | null {
    try {
      if (!existsSync(this.filePath)) return null;
      const raw = readFileSync(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw) as KeyCache;
      // Validate shape
      if (!parsed.keys || !parsed.fetchedAt || !parsed.expiresAt) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  write(cache: KeyCache): void {
    try {
      // Ensure parent directory exists with 700
      const dir = this.filePath.substring(0, this.filePath.lastIndexOf('\\'));
      if (dir && !existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
        chmodSync(dir, 0o700);
      }
      writeFileSync(this.filePath, JSON.stringify(cache, null, 2), { mode: 0o600 });
      // chmod on Windows is a no-op for S_IRUSR|S_IWUSR, but it's a best-effort call
    } catch (err) {
      console.error('[trilc:keys] failed to write key cache:', err instanceof Error ? err.message : String(err));
    }
  }
}

// ── Constants ──

const KEY_CACHE_TTL_MS = 24 * 60 * 60 * 1000;    // 24 hours
const KEY_REFRESH_INTERVAL_S_DEFAULT = 15 * 60;    // 15 minutes (overridden by server's refresh_interval_s)
const API_TIMEOUT_MS = 5000;                       // 5 seconds
const STAGGER_MAX_MS = 60_000;                     // 0-60s random stagger at startup

// ── State ──

let _keyCache: KeyCache | null = null;
let _refreshTimer: ReturnType<typeof setTimeout> | null = null;
let _storage: KeyStorage | null = null;

// ── Key sanitisation for logs ──

function sanitizeKey(key: string): string {
  if (!key || key.length < 5) return '****';
  return key.substring(0, 5) + '****';
}

function sanitizeKeysForLog(cache: KeyCache): Record<string, { api_key: string; base_url?: string }> {
  const sanitized: Record<string, { api_key: string; base_url?: string }> = {};
  for (const [provider, info] of Object.entries(cache.keys)) {
    sanitized[provider] = { ...info, api_key: sanitizeKey(info.api_key) };
  }
  return sanitized;
}

// ── API fetch ──

async function fetchKeysFromApi(apiUrl: string, apiToken?: string): Promise<{ keys: Record<string, ProviderKey>; defaultModel: string; refreshIntervalS: number }> {
  const url = `${apiUrl}/v1/config/keys`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

  try {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (apiToken) {
      headers['authorization'] = `Bearer ${apiToken}`;
    }

    const res = await fetch(url, { signal: controller.signal, headers });

    if (!res.ok) {
      throw new Error(`TriModel API returned ${res.status}`);
    }

    const json = await res.json() as {
      keys: Record<string, ProviderKey>;
      default_model: string;
      refresh_interval_s: number;
    };

    return {
      keys: json.keys ?? {},
      defaultModel: json.default_model ?? 'deepseek-chat',
      refreshIntervalS: json.refresh_interval_s ?? KEY_REFRESH_INTERVAL_S_DEFAULT,
    };
  } finally {
    clearTimeout(timeout);
  }
}

// ── Public API ──

export function getKeyCache(): KeyCache | null {
  if (!_keyCache) return null;
  // Check expiry
  if (Date.now() > _keyCache.expiresAt) return null;
  return _keyCache;
}

export function getKeyCacheFilePath(dataDir: string): string {
  return join(dataDir, 'keys.json');
}

/**
 * Initialize the key cache.
 * 1. Read local cache from disk
 * 2. Try fetching from TriModel API (non-blocking at startup)
 * 3. Start periodic refresh timer with stagger
 */
export async function initKeyCache(apiUrl: string, dataDir: string, apiToken?: string): Promise<void> {
  const filePath = getKeyCacheFilePath(dataDir);
  _storage = new FileKeyStorage(filePath);

  // 1. Load cached keys from disk
  _keyCache = _storage.read();
  if (_keyCache) {
    console.log(`[trilc:keys] loaded cached keys (${Object.keys(_keyCache.keys).length} providers), expires ${new Date(_keyCache.expiresAt).toISOString()}`);
  }

  // 2. Async fetch from TriModel API
  try {
    const fresh = await fetchKeysFromApi(apiUrl, apiToken);
    _keyCache = {
      ...fresh,
      fetchedAt: Date.now(),
      expiresAt: Date.now() + KEY_CACHE_TTL_MS,
    };
    _storage.write(_keyCache);
    console.log(`[trilc:keys] fetched fresh keys (${Object.keys(fresh.keys).length} providers):`, sanitizeKeysForLog(_keyCache));
  } catch (err) {
    if (_keyCache) {
      console.warn(`[trilc:keys] fetch failed, using cached keys: ${err instanceof Error ? err.message : String(err)}`);
    } else {
      console.error(`[trilc:keys] no cached keys and fetch failed — chat disabled: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 3. Start refresh timer with stagger
  if (_keyCache) {
    startRefreshTimer(apiUrl, _keyCache.refreshIntervalS, apiToken);
  }
}

function startRefreshTimer(apiUrl: string, intervalS: number, apiToken?: string): void {
  if (_refreshTimer) return;

  const intervalMs = intervalS * 1000;
  const staggerMs = Math.floor(Math.random() * STAGGER_MAX_MS);

  console.log(`[trilc:keys] refresh timer: every ${intervalS}s (first in ${Math.round(staggerMs / 1000)}s stagger)`);

  _refreshTimer = setTimeout(() => {
    // First refresh after stagger
    doRefresh(apiUrl, apiToken).catch(() => {});

    // Then set up regular interval
    _refreshTimer = setInterval(() => {
      doRefresh(apiUrl, apiToken).catch(() => {});
    }, intervalMs);
  }, staggerMs);
}

async function doRefresh(apiUrl: string, apiToken?: string): Promise<void> {
  try {
    const fresh = await fetchKeysFromApi(apiUrl, apiToken);
    _keyCache = {
      ...fresh,
      fetchedAt: Date.now(),
      expiresAt: Date.now() + KEY_CACHE_TTL_MS,
    };
    _storage?.write(_keyCache);
    console.log(`[trilc:keys] refreshed keys:`, sanitizeKeysForLog(_keyCache));
  } catch (err) {
    console.warn(`[trilc:keys] refresh failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function stopKeyCache(): void {
  if (_refreshTimer) {
    clearInterval(_refreshTimer);
    clearTimeout(_refreshTimer);
    _refreshTimer = null;
  }
  _keyCache = null;
  _storage = null;
}
