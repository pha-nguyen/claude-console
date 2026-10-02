import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import { resetUserPreferences, writeUserPreference } from '@/shared/userSettings';
import type { ProjectSession, ProviderModelsDefinition } from '@/shared/types';

/**
 * The four per-provider default models used to be four useState slots with four
 * copy-pasted reconciliation effects and a four-branch setter. They are now one
 * Record with one loop. These tests pin the behaviour that has to survive that:
 * each provider keeps its own model, under its own storage key, and choosing a
 * model persists it.
 */

const okJson = (data: unknown) => Promise.resolve({
  ok: true,
  json: async () => data,
});

const { modelsResponse, sessionModelResponse } = vi.hoisted(() => ({
  modelsResponse: vi.fn(),
  sessionModelResponse: vi.fn(),
}));

vi.mock('@/shared/api', () => ({
  api: {
    // The preference store PATCHes through api.user; it is stubbed rather than
    // exercised here, which keeps these tests about the model record.
    user: {
      preferences: () => okJson({ success: true, preferences: {} }),
      savePreferences: () => okJson({ success: true, preferences: {} }),
    },
    providers: {
      models: (provider: string) => modelsResponse(provider),
      capabilities: () => okJson({ success: true, data: null }),
      sessionActiveModel: () => sessionModelResponse(),
      setSessionActiveModel: () => okJson({ success: true, data: null }),
      setSessionActiveEffort: () => okJson({ success: true, data: null }),
      createModel: () => okJson({ success: true, data: null }),
      updateModel: () => okJson({ success: true, data: null }),
      removeModel: () => okJson({ success: true, data: null }),
    },
  },
}));

const renderProviderState = async (selectedSession: ProjectSession | null = null) => {
  const { useChatProviderState } = await import(
    '@/modules/chat/hooks/useChatProviderState'
  );
  return renderHook(() =>
    useChatProviderState({ selectedSession, selectedProject: null }),
  );
};

beforeEach(() => {
  localStorage.clear();
  // The preference store is a module-level singleton, so its in-memory copy
  // outlives localStorage.clear() and would leak one test's writes into the next.
  resetUserPreferences();
  modelsResponse.mockReset().mockImplementation(() => okJson({ success: true, data: null }));
  sessionModelResponse.mockReset().mockImplementation(() => okJson({ success: true, data: null }));
});

afterEach(() => {
  vi.resetModules();
});

test('each provider gets its own model from its own storage key', async () => {
  localStorage.setItem('claude-model', 'claude-stored');
  localStorage.setItem('cursor-model', 'cursor-stored');
  localStorage.setItem('codex-model', 'codex-stored');
  localStorage.setItem('opencode-model', 'opencode-stored');

  const { result } = await renderProviderState();

  await waitFor(() => {
    assert.equal(result.current.providerModels.claude, 'claude-stored');
  });
  assert.equal(result.current.providerModels.cursor, 'cursor-stored');
  assert.equal(result.current.providerModels.codex, 'codex-stored');
  assert.equal(result.current.providerModels.opencode, 'opencode-stored');
});

test('a provider with no stored model falls back to its own default, not another provider’s', async () => {
  const { result } = await renderProviderState();

  await waitFor(() => {
    assert.ok(result.current.providerModels.claude);
  });

  const models = result.current.providerModels;
  assert.equal(
    new Set(Object.values(models)).size,
    Object.keys(models).length,
    'each provider must have a distinct default model',
  );
});

test('choosing a model persists it under that provider’s key only', async () => {
  const { result } = await renderProviderState();
  await waitFor(() => {
    assert.equal(result.current.providerModelsLoading, false);
  });
  const claudeBefore = result.current.providerModels.claude;

  act(() => {
    result.current.setStoredProviderModel('codex', 'codex-chosen');
  });

  assert.equal(result.current.providerModels.codex, 'codex-chosen');
  assert.equal(localStorage.getItem('codex-model'), 'codex-chosen');
  assert.equal(
    result.current.providerModels.claude,
    claudeBefore,
    'setting one provider must not disturb another',
  );
  assert.equal(localStorage.getItem('claude-model'), null);
});

test('setting the same model twice keeps the record identity stable', async () => {
  const { result } = await renderProviderState();
  await waitFor(() => {
    assert.ok(result.current.providerModels.claude);
  });

  act(() => {
    result.current.setStoredProviderModel('claude', 'pinned');
  });
  const afterFirst = result.current.providerModels;

  act(() => {
    result.current.setStoredProviderModel('claude', 'pinned');
  });

  assert.equal(
    result.current.providerModels,
    afterFirst,
    'a no-op write must not allocate a new record and wake consumers',
  );
});

test('the active provider’s model is what currentProviderModel reports', async () => {
  // The provider selection is a stored preference; the per-provider model is
  // still a plain localStorage key.
  writeUserPreference('selectedProvider', 'cursor');
  localStorage.setItem('cursor-model', 'cursor-active');

  const { result } = await renderProviderState();

  await waitFor(() => {
    assert.equal(result.current.provider, 'cursor');
  });
  assert.equal(result.current.currentProviderModel, 'cursor-active');
});

const BEDROCK_MODELS: ProviderModelsDefinition = {
  OPTIONS: [
    {
      value: 'openai.gpt-6-astra',
      label: 'GPT-6 Astra',
      aliases: ['gpt-6-astra'],
      effort: { default: 'low', values: [{ value: 'low' }, { value: 'high' }, { value: 'max' }] },
    },
    { value: 'openai.gpt-5.4', label: 'GPT-5.4', aliases: ['gpt-5.4'] },
  ],
  DEFAULT: 'openai.gpt-6-astra',
};

const useBedrockCatalog = () => {
  writeUserPreference('selectedProvider', 'codex');
  modelsResponse.mockImplementation((provider: string) => okJson({
    success: true,
    data: provider === 'codex' ? { models: BEDROCK_MODELS } : null,
  }));
};

test('a fresh Codex session takes its default from the deployment catalog', async () => {
  useBedrockCatalog();
  const { result } = await renderProviderState();
  await waitFor(() => assert.equal(result.current.currentProviderModel, 'openai.gpt-6-astra'));
  assert.equal(localStorage.getItem('codex-model'), 'openai.gpt-6-astra');
});

test('Codex sends no guessed direct-provider model while the catalog is loading', async () => {
  writeUserPreference('selectedProvider', 'codex');
  modelsResponse.mockImplementation(() => new Promise(() => {}));
  const { result } = await renderProviderState();
  assert.equal(result.current.currentProviderModel, '');
  assert.equal(localStorage.getItem('codex-model'), null);
});

test('saved legacy IDs migrate to the same model instead of switching to the deployment default', async () => {
  useBedrockCatalog();
  localStorage.setItem('codex-model', 'gpt-5.4');
  const { result } = await renderProviderState();
  await waitFor(() => assert.equal(result.current.currentProviderModel, 'openai.gpt-5.4'));
  assert.equal(localStorage.getItem('codex-model'), 'openai.gpt-5.4');
});

test('a session with a legacy ID displays and sends the canonical model and its supported efforts', async () => {
  useBedrockCatalog();
  localStorage.setItem('codex-effort', 'ultra');
  sessionModelResponse.mockImplementation(() => okJson({
    success: true,
    data: { model: 'gpt-6-astra', source: 'session' },
  }));
  const { result } = await renderProviderState({ id: 'legacy-session', __provider: 'codex' });
  await waitFor(() => assert.equal(result.current.currentProviderModel, 'openai.gpt-6-astra'));
  assert.deepEqual(result.current.currentProviderEffortOptions.map((effort) => effort.value), ['low', 'high', 'max']);
  assert.equal(result.current.currentProviderEffort, 'default');
});
