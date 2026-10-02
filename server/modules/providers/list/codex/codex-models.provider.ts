import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import TOML from '@iarna/toml';

import type { IProviderModels } from '@/shared/interfaces.js';
import type {
  ProviderCurrentActiveModel,
  ProviderModelsDefinition,
} from '@/shared/types.js';
import {
  buildDefaultProviderCurrentActiveModel,
  readObjectRecord,
  readOptionalString,
} from '@/shared/utils.js';

/** Curated Codex catalog shipped as immutable CloudCLI defaults. */
export const CODEX_PREDEFINED_MODELS: ProviderModelsDefinition = {
  OPTIONS: [
    {
      value: 'gpt-6-astra',
      label: 'GPT-6 Astra',
      description: 'Our most capable model for complex, demanding work.',
      effort: {
        default: 'low',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
          { value: 'ultra' },
        ],
      },
    },
    {
      value: 'gpt-6-sol',
      label: 'GPT-6 Sol',
      description: 'Workhorse model for coding and everyday work.',
      effort: {
        default: 'medium',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
          { value: 'ultra' },
        ],
      },
    },
    {
      value: 'gpt-6-luna',
      label: 'GPT-6 Luna',
      description: 'Fast and affordable model for easier tasks.',
      effort: {
        default: 'medium',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
        ],
      },
    },
    {
      value: 'gpt-5.6-sol',
      label: 'GPT-5.6 Sol',
      description: 'Latest frontier agentic coding model.',
      effort: {
        default: 'low',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
          { value: 'ultra' },
        ],
      },
    },
    {
      value: 'gpt-5.6-terra',
      label: 'GPT-5.6 Terra',
      description: 'Balanced agentic coding model for everyday work.',
      effort: {
        default: 'medium',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
          { value: 'ultra' },
        ],
      },
    },
    {
      value: 'gpt-5.6-luna',
      label: 'GPT-5.6 Luna',
      description: 'Fast and affordable agentic coding model.',
      effort: {
        default: 'medium',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
        ],
      },
    },
    {
      value: 'gpt-5.5',
      label: 'GPT-5.5',
      description: 'Frontier model for complex coding, research, and real-world work.',
      effort: {
        default: 'medium',
        values: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }, { value: 'xhigh' }],
      },
    },
    {
      value: 'gpt-5.4',
      label: 'GPT-5.4',
      description: 'Strong model for everyday coding.',
      effort: {
        default: 'medium',
        values: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }, { value: 'xhigh' }],
      },
    },
    {
      value: 'gpt-5.4-mini',
      label: 'GPT-5.4 Mini',
      description: 'Small, fast, and cost-efficient model for simpler coding tasks.',
      effort: {
        default: 'medium',
        values: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }, { value: 'xhigh' }],
      },
    },
  ],
  DEFAULT: 'gpt-5.6-sol',
};

// The bundled Codex CLI's amazon-bedrock model/list catalog. Bedrock does not
// expose every model in the direct OpenAI catalog or the Ultra effort tier.
const BEDROCK_CODEX_MODELS = new Set([
  'gpt-6-astra',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'gpt-5.5',
  'gpt-5.4',
]);

/** Provider registry model adapter for Codex predefined models and active config. */
export class CodexProviderModels implements IProviderModels {
  constructor(
    private readonly configPath = path.join(
      process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
      'config.toml',
    ),
  ) {}

  private async readConfiguration(): Promise<{ model?: string; modelProvider?: string }> {
    try {
      const parsed = readObjectRecord(TOML.parse(await readFile(this.configPath, 'utf8')));
      const profiles = readObjectRecord(parsed?.profiles);
      const profileName = readOptionalString(parsed?.profile);
      const profile = profileName ? readObjectRecord(profiles?.[profileName]) : null;
      return {
        model: readOptionalString(profile?.model) || readOptionalString(parsed?.model),
        modelProvider: readOptionalString(profile?.model_provider) || readOptionalString(parsed?.model_provider),
      };
    } catch {
      return {};
    }
  }

  async getSupportedModels(): Promise<ProviderModelsDefinition> {
    const configuration = await this.readConfiguration();
    if (configuration.modelProvider !== 'amazon-bedrock') {
      return CODEX_PREDEFINED_MODELS;
    }

    const options = CODEX_PREDEFINED_MODELS.OPTIONS
      .filter((option) => BEDROCK_CODEX_MODELS.has(option.value))
      .map((option) => ({
        ...option,
        value: `openai.${option.value}`,
        aliases: [option.value],
        effort: option.effort ? {
          ...option.effort,
          values: option.effort.values.filter((effort) => effort.value !== 'ultra'),
        } : undefined,
      }));
    const configuredOption = options.find((option) =>
      option.value === configuration.model || option.aliases.includes(configuration.model ?? ''));
    const defaultModel = configuredOption?.value
      || configuration.model
      || `openai.${CODEX_PREDEFINED_MODELS.DEFAULT}`;

    // Explicitly configured deployment IDs (including custom inference
    // profiles) must remain selectable even when they are not curated here.
    if (!options.some((option) => option.value === defaultModel)) {
      options.push({
        value: defaultModel,
        label: defaultModel,
        description: 'Configured Codex model',
        aliases: [],
        effort: undefined,
      });
    }

    return { OPTIONS: options, DEFAULT: defaultModel };
  }

  async getCurrentActiveModel(): Promise<ProviderCurrentActiveModel> {
    const configuration = await this.readConfiguration();
    const catalog = await this.getSupportedModels();
    const model = configuration.model;
    if (!model) return buildDefaultProviderCurrentActiveModel(catalog);

    const option = catalog.OPTIONS.find((entry) => entry.value === model || entry.aliases?.includes(model));
    return { model: option?.value ?? model };
  }
}
