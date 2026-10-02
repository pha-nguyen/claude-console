import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { CODEX_PREDEFINED_MODELS, CodexProviderModels } from '@/modules/providers/list/codex/codex-models.provider.js';

const require = createRequire(import.meta.url);

const findCodexModel = (value: string) =>
  CODEX_PREDEFINED_MODELS.OPTIONS.find((option) => option.value === value);

test('lists GPT-6 Sol and GPT-6 Luna with the effort levels the Codex CLI accepts', () => {
  const sol = findCodexModel('gpt-6-sol');
  assert.equal(sol?.label, 'GPT-6 Sol');
  assert.equal(sol?.effort?.default, 'medium');
  assert.deepEqual(
    sol?.effort?.values.map((effort) => effort.value),
    ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  );

  const luna = findCodexModel('gpt-6-luna');
  assert.equal(luna?.label, 'GPT-6 Luna');
  assert.equal(luna?.effort?.default, 'medium');
  assert.deepEqual(
    luna?.effort?.values.map((effort) => effort.value),
    ['low', 'medium', 'high', 'xhigh', 'max'],
  );
});

test('bundles a Codex CLI new enough to know the GPT-6 Sol and Luna models', () => {
  // Codex only ships metadata for gpt-6-sol / gpt-6-luna from 0.155.0 on. An
  // older CLI still sends the request, but on fallback metadata: it warns
  // "Model metadata ... not found" and quietly drops `ultra` to `medium`.
  const { version } = require('@openai/codex/package.json') as { version: string };
  const [major, minor] = version.split('.').map(Number);
  assert.ok(major > 0 || minor >= 155, `bundled @openai/codex ${version} predates 0.155.0`);
});

test('Bedrock uses supported provider IDs, effort levels and the configured default', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-bedrock-models-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const configPath = path.join(directory, 'config.toml');
  await writeFile(configPath, 'model_provider = "amazon-bedrock"\nmodel = "openai.gpt-6-astra"\n');
  const adapter = new CodexProviderModels(configPath);
  const models = await adapter.getSupportedModels();

  assert.equal(models.DEFAULT, 'openai.gpt-6-astra');
  assert.deepEqual(models.OPTIONS.map((option) => option.value), [
    'openai.gpt-6-astra', 'openai.gpt-5.6-sol', 'openai.gpt-5.6-terra',
    'openai.gpt-5.6-luna', 'openai.gpt-5.5', 'openai.gpt-5.4',
  ]);
  assert.deepEqual(models.OPTIONS[0]?.aliases, ['gpt-6-astra']);
  assert.equal(models.OPTIONS.some((option) => option.effort?.values.some((effort) => effort.value === 'ultra')), false);
  assert.deepEqual(await adapter.getCurrentActiveModel(), { model: 'openai.gpt-6-astra' });
  assert.equal(CODEX_PREDEFINED_MODELS.OPTIONS[0]?.value, 'gpt-6-astra', 'the direct-provider catalog stays immutable');
});

test('Bedrock without a model uses its catalog default and normalizes a configured legacy ID', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-bedrock-default-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const configPath = path.join(directory, 'config.toml');
  const adapter = new CodexProviderModels(configPath);
  await writeFile(configPath, 'model_provider = "amazon-bedrock"\n');
  assert.equal((await adapter.getSupportedModels()).DEFAULT, 'openai.gpt-5.6-sol');
  await writeFile(configPath, 'model_provider = "amazon-bedrock"\nmodel = "gpt-5.6-terra"\n');
  assert.equal((await adapter.getSupportedModels()).DEFAULT, 'openai.gpt-5.6-terra');
  assert.deepEqual(await adapter.getCurrentActiveModel(), { model: 'openai.gpt-5.6-terra' });
});

test('the selected Codex profile overrides the root provider and model', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-bedrock-profile-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const configPath = path.join(directory, 'config.toml');
  await writeFile(configPath, 'model = "gpt-5.4"\nprofile = "work"\n[profiles.work]\nmodel_provider = "amazon-bedrock"\nmodel = "openai.gpt-5.6-luna"\n');
  assert.equal((await new CodexProviderModels(configPath).getSupportedModels()).DEFAULT, 'openai.gpt-5.6-luna');
});

test('an explicitly configured custom Bedrock deployment stays selectable', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-bedrock-custom-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const configPath = path.join(directory, 'config.toml');
  await writeFile(configPath, 'model_provider = "amazon-bedrock"\nmodel = "custom-deployment"\n');
  const models = await new CodexProviderModels(configPath).getSupportedModels();
  assert.equal(models.DEFAULT, 'custom-deployment');
  assert.equal(models.OPTIONS.at(-1)?.value, 'custom-deployment');
});

test('direct OpenAI, missing and malformed config retain the direct-provider catalog', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-direct-models-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const configPath = path.join(directory, 'config.toml');
  const adapter = new CodexProviderModels(configPath);
  assert.deepEqual(await adapter.getSupportedModels(), CODEX_PREDEFINED_MODELS);
  for (const contents of ['not valid TOML [', 'model_provider = "openai"\nmodel = "gpt-5.4"\n']) {
    await writeFile(configPath, contents);
    assert.deepEqual(await adapter.getSupportedModels(), CODEX_PREDEFINED_MODELS);
  }
});
