import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { applyKeyCacheToEnvironment, type KeyCache } from '../src/config/key-cache.js';

describe('applyKeyCacheToEnvironment', () => {
  it('maps cached providers to the TriModel environment contract', () => {
    const cache: KeyCache = {
      keys: {
        deepseek: { api_key: 'deepseek-key', base_url: 'https://deepseek.example/v1' },
        anthropic: { api_key: 'anthropic-key', base_url: 'https://anthropic.example' },
        openai: { api_key: 'openai-key', base_url: 'https://openai.example/v1' },
        trimetaverse: { api_key: 'tmv-key', base_url: 'https://tmv.example/v1' },
      },
      defaultModel: 'deepseek-chat',
      refreshIntervalS: 900,
      fetchedAt: 1,
      expiresAt: 2,
    };
    const env: NodeJS.ProcessEnv = {};

    applyKeyCacheToEnvironment(cache, env);

    assert.deepEqual(env, {
      DEEPSEEK_API_KEY: 'deepseek-key',
      DEEPSEEK_BASE_URL: 'https://deepseek.example/v1',
      ANTHROPIC_API_KEY: 'anthropic-key',
      ANTHROPIC_BASE_URL: 'https://anthropic.example',
      OPENAI_API_KEY: 'openai-key',
      OPENAI_BASE_URL: 'https://openai.example/v1',
      TRIMODEL_TRIMETAVERSE_API_KEY: 'tmv-key',
      TRIMODEL_TRISTACISS_BASE_URL: 'https://tmv.example/v1',
      TRIMODEL_DEFAULT_MODEL: 'deepseek-chat',
    });
  });
});