import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { EncryptionService } from '../common/crypto/encryption.service';
import {
  createProvider,
  DEFAULT_BASE_URL,
  type LlmProviderType,
} from '../ai/providers/provider.factory';
import type { AiProvider } from '../ai/ai-provider.interface';
import type {
  AddLlmModelsDto,
  CreateLlmConfigDto,
  ModelCapability,
  TestLlmConfigDto,
  UpdateLlmConfigDto,
  UpdateLlmModelDto,
} from './llm-config.dto';

const MODEL_SELECT = {
  id: true,
  configId: true,
  provider: true,
  modelId: true,
  displayName: true,
  capabilities: true,
  inputModalities: true,
  outputModalities: true,
  embeddingDimensions: true,
  maxInputTokens: true,
  isVerified: true,
  verifiedAt: true,
  isDefault: true,
  enabled: true,
  createdAt: true,
  updatedAt: true,
} as const;

const CONFIG_SELECT = {
  id: true,
  ownerId: true,
  name: true,
  provider: true,
  baseUrl: true,
  encryptedApiKey: true,
  status: true,
  lastError: true,
  createdAt: true,
  updatedAt: true,
  models: { select: MODEL_SELECT },
} as const;

type ConfigPayload = {
  encryptedApiKey: string | null;
} & Record<string, unknown>;

@Injectable()
export class LlmConfigService {
  private readonly logger = new Logger(LlmConfigService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
  ) {}

  // ===========================================================================
  // 配置增删改查
  // ===========================================================================

  async create(userId: string, dto: CreateLlmConfigDto) {
    if (dto.provider !== 'ollama' && !dto.apiKey) {
      throw new BadRequestException('云端模型提供商必须提供 API Key');
    }

    const baseUrl = this.resolveBaseUrl(dto.provider, dto.baseUrl);

    const data: Record<string, unknown> = {
      ownerId: userId,
      name: dto.name,
      provider: dto.provider,
      baseUrl,
      status: 'UNKNOWN',
    };
    if (dto.apiKey) {
      data.encryptedApiKey = this.encryption.encrypt(dto.apiKey);
    }

    const config = await this.prisma.llmProviderConfig.create({
      data: data as never,
      select: CONFIG_SELECT,
    });

    // 创建时顺带添加第一个模型
    if (dto.modelId) {
      await this.prisma.llmModel.create({
        data: {
          configId: config.id,
          provider: dto.provider,
          modelId: dto.modelId,
          displayName: dto.displayName || dto.modelId,
          capabilities: dto.capabilities ?? ['CHAT', 'STREAM'],
        },
      });
    }

    return this.toConfigView(
      await this.prisma.llmProviderConfig.findUniqueOrThrow({
        where: { id: config.id },
        select: CONFIG_SELECT,
      }),
    );
  }

  async findAll(userId: string) {
    const configs = await this.prisma.llmProviderConfig.findMany({
      where: { ownerId: userId },
      select: CONFIG_SELECT,
      orderBy: { createdAt: 'desc' },
    });
    return configs.map((c) => this.toConfigView(c));
  }

  async findOne(userId: string, id: string) {
    const config = await this.prisma.llmProviderConfig.findUnique({
      where: { id },
      select: CONFIG_SELECT,
    });
    if (!config) throw new NotFoundException('配置不存在');
    this.assertOwner(config, userId);
    return this.toConfigView(config);
  }

  async update(userId: string, id: string, dto: UpdateLlmConfigDto) {
    const existing = await this.prisma.llmProviderConfig.findUnique({
      where: { id },
      select: CONFIG_SELECT,
    });
    if (!existing) throw new NotFoundException('配置不存在');
    this.assertOwner(existing, userId);

    const data: Record<string, unknown> = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.baseUrl !== undefined) {
      data.baseUrl = this.resolveBaseUrl(
        existing.provider as LlmProviderType,
        dto.baseUrl,
      );
    }
    if (dto.apiKey !== undefined && dto.apiKey !== '') {
      data.encryptedApiKey = this.encryption.encrypt(dto.apiKey);
    }
    if (dto.disabled !== undefined) {
      data.status = dto.disabled ? 'DISABLED' : 'UNKNOWN';
    }

    await this.prisma.llmProviderConfig.update({
      where: { id },
      data,
      select: CONFIG_SELECT,
    });

    // 编辑配置时若填写了 modelId，只添加 / 更新这一个模型（不做全量拉取）
    if (dto.modelId?.trim()) {
      await this.upsertModel(id, existing.provider, dto.modelId.trim(), {
        displayName: dto.displayName || undefined,
        capabilities: dto.capabilities,
      });
    }

    return this.toConfigView(
      await this.prisma.llmProviderConfig.findUniqueOrThrow({
        where: { id },
        select: CONFIG_SELECT,
      }),
    );
  }

  async remove(userId: string, id: string) {
    const existing = await this.prisma.llmProviderConfig.findUnique({
      where: { id },
      select: { id: true, ownerId: true },
    });
    if (!existing) throw new NotFoundException('配置不存在');
    if (existing.ownerId !== userId) {
      throw new ForbiddenException('无权删除该配置');
    }
    await this.prisma.llmProviderConfig.delete({ where: { id } });
    return { id, deleted: true };
  }

  // ===========================================================================
  // 连接测试
  // ===========================================================================

  /** 保存前的预测试（不落库）：直接用表单数据构造 Provider 并拉取模型列表 */
  async testBeforeSave(dto: TestLlmConfigDto) {
    if (dto.provider !== 'ollama' && !dto.apiKey) {
      throw new BadRequestException('云端模型提供商必须提供 API Key');
    }
    if (dto.provider === 'openai-compatible' && !dto.baseUrl) {
      throw new BadRequestException('openai-compatible 必须提供 baseUrl');
    }

    const baseUrl = this.resolveBaseUrl(dto.provider, dto.baseUrl);
    const provider = createProvider({
      provider: dto.provider,
      baseUrl,
      apiKey: dto.apiKey || null,
    });

    try {
      const models = (await provider.listModels?.()) ?? [];
      return { ok: true, models };
    } catch (err) {
      return {
        ok: false,
        models: [] as string[],
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /** 对已保存配置进行连接测试，并回写 status / lastError */
  async testSaved(userId: string, id: string) {
    const config = await this.prisma.llmProviderConfig.findUnique({
      where: { id },
      select: CONFIG_SELECT,
    });
    if (!config) throw new NotFoundException('配置不存在');
    this.assertOwner(config, userId);

    const provider = this.buildProviderFromConfig(config);

    let models: string[] = [];
    let ok = true;
    let error: string | null = null;
    try {
      models = (await provider.listModels?.()) ?? [];
    } catch (err) {
      ok = false;
      error = err instanceof Error ? err.message : String(err);
    }

    await this.prisma.llmProviderConfig.update({
      where: { id },
      data: {
        status: ok ? 'CONNECTED' : 'ERROR',
        lastError: error,
      },
    });

    return { ok, models, status: ok ? 'CONNECTED' : 'ERROR', error };
  }

  /** 拉取模型列表并落地到 LlmModel 表（幂等 upsert），返回该配置下全部模型 */
  async fetchModels(userId: string, id: string) {
    const config = await this.prisma.llmProviderConfig.findUnique({
      where: { id },
      select: CONFIG_SELECT,
    });
    if (!config) throw new NotFoundException('配置不存在');
    this.assertOwner(config, userId);

    const provider = this.buildProviderFromConfig(config);
    let remoteModels: string[] = [];
    try {
      remoteModels = (await provider.listModels?.()) ?? [];
    } catch (err) {
      await this.prisma.llmProviderConfig.update({
        where: { id },
        data: {
          status: 'ERROR',
          lastError: err instanceof Error ? err.message : String(err),
        },
      });
      throw new BadRequestException(
        `获取模型列表失败：${err instanceof Error ? err.message : err}`,
      );
    }

    for (const modelId of remoteModels) {
      await this.upsertModel(id, config.provider, modelId);
    }

    await this.prisma.llmProviderConfig.update({
      where: { id },
      data: { status: 'CONNECTED', lastError: null },
    });

    return this.listConfigModels(id);
  }

  /**
   * 只拉取远端模型列表（**不落地**），供前端弹窗勾选后按需添加。
   * 返回远端模型 id 列表 + 已存在的模型 id（前端用于标记「已添加」）。
   */
  async listRemoteModels(userId: string, id: string) {
    const config = await this.prisma.llmProviderConfig.findUnique({
      where: { id },
      select: CONFIG_SELECT,
    });
    if (!config) throw new NotFoundException('配置不存在');
    this.assertOwner(config, userId);

    const provider = this.buildProviderFromConfig(config);
    let remoteModels: string[] = [];
    try {
      remoteModels = (await provider.listModels?.()) ?? [];
    } catch (err) {
      await this.prisma.llmProviderConfig.update({
        where: { id },
        data: {
          status: 'ERROR',
          lastError: err instanceof Error ? err.message : String(err),
        },
      });
      throw new BadRequestException(
        `获取模型列表失败：${err instanceof Error ? err.message : err}`,
      );
    }

    await this.prisma.llmProviderConfig.update({
      where: { id },
      data: { status: 'CONNECTED', lastError: null },
    });

    const existing = await this.prisma.llmModel.findMany({
      where: { configId: id },
      select: { modelId: true },
    });

    return {
      models: remoteModels,
      existing: existing.map((m) => m.modelId),
    };
  }

  /** 只添加用户指定的模型（幂等 upsert），返回该配置下全部模型 */
  async addModels(userId: string, id: string, dto: AddLlmModelsDto) {
    const config = await this.prisma.llmProviderConfig.findUnique({
      where: { id },
      select: CONFIG_SELECT,
    });
    if (!config) throw new NotFoundException('配置不存在');
    this.assertOwner(config, userId);

    const modelIds = [
      ...new Set(
        (dto.modelIds ?? [])
          .map((m) => (typeof m === 'string' ? m.trim() : ''))
          .filter(Boolean),
      ),
    ];
    if (modelIds.length === 0) {
      throw new BadRequestException('请至少选择一个模型');
    }

    for (const modelId of modelIds) {
      await this.upsertModel(id, config.provider, modelId, {
        capabilities: dto.capabilities,
        displayName: modelIds.length === 1 ? dto.displayName : undefined,
      });
    }

    return this.listConfigModels(id);
  }

  /** 删除单个模型（不影响配置本身） */
  async removeModel(userId: string, modelId: string) {
    const model = await this.prisma.llmModel.findUnique({
      where: { id: modelId },
      select: { id: true, configId: true, isDefault: true },
    });
    if (!model) throw new NotFoundException('模型不存在');
    await this.assertModelOwner(model.configId, userId);

    await this.prisma.llmModel.delete({ where: { id: modelId } });
    return { id: modelId, deleted: true, wasDefault: model.isDefault };
  }

  // ===========================================================================
  // 模型（LlmModel）管理
  // ===========================================================================

  /**
   * 列出当前用户全部启用模型（供聊天 / 工作流 / 知识库选择器使用）。
   * @param capability 可选：按能力过滤（如 'EMBEDDING' 仅返回向量模型，'CHAT' 仅返回对话模型）
   */
  async listModels(userId: string, capability?: ModelCapability) {
    return this.prisma.llmModel.findMany({
      where: {
        config: { ownerId: userId },
        enabled: true,
        ...(capability ? { capabilities: { has: capability } } : {}),
      },
      select: MODEL_SELECT,
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    });
  }

  // ===========================================================================
  // 运行时解析（供 Agent / 工作流 / 知识库向量化按用户所选模型动态调用）
  // ===========================================================================

  /**
   * 根据 LlmModel.id 解析出可直接调用的 AiProvider（自动解密父配置的 API Key）。
   * 调用方拿到 provider 后即可 chat / streamChat / chatWithTools / embedding。
   */
  async resolveModelRuntime(modelId: string): Promise<{
    provider: AiProvider;
    modelId: string;
    providerType: LlmProviderType;
    /** 模型能力；供调用方判断是否走流式（未包含 STREAM 则应使用非流式 chat） */
    capabilities: ModelCapability[];
  }> {
    const model = await this.prisma.llmModel.findUniqueOrThrow({
      where: { id: modelId },
      select: {
        id: true,
        modelId: true,
        capabilities: true,
        config: {
          select: { provider: true, baseUrl: true, encryptedApiKey: true },
        },
      },
    });

    const plainKey = model.config.encryptedApiKey
      ? this.encryption.decrypt(model.config.encryptedApiKey)
      : null;
    const providerType = model.config.provider as LlmProviderType;
    const provider = createProvider({
      provider: providerType,
      baseUrl: model.config.baseUrl ?? null,
      apiKey: plainKey,
    });

    return {
      provider,
      modelId: model.modelId,
      providerType,
      capabilities: (model.capabilities ?? []) as ModelCapability[],
    };
  }

  /**
   * 便捷方法：有 llmModelId 时返回解析后的 provider，否则返回 null。
   * 调用方在拿到 null 时应回退到默认的全局 Ollama Provider（保持旧行为不变）。
   */
  async resolveChatProvider(
    llmModelId?: string | null,
  ): Promise<AiProvider | null> {
    if (!llmModelId) return null;
    return (await this.resolveModelRuntime(llmModelId)).provider;
  }

  /**
   * 取模型的真实标识（如 "deepseek-ai/DeepSeek-V4-Flash"）。
   * 用于把 Agent.model / 工作流节点等「模型名」字段同步为真实值，
   * 而不是只依赖 llmModelId。查不到时返回 null（调用方自行回退）。
   */
  async getModelName(llmModelId: string): Promise<string | null> {
    const model = await this.prisma.llmModel.findUnique({
      where: { id: llmModelId },
      select: { modelId: true },
    });
    return model?.modelId ?? null;
  }

  /**
   * 取当前用户拥有的全部模型 id（含未启用）。
   * 用途：校验「模型是否属于该用户」——平台助理生成工作流 / Agent 时，
   * 模型可能传入一个不存在的 llmModelId，需要据此拒绝。
   */
  async listOwnedModelIds(userId: string): Promise<string[]> {
    const models = await this.prisma.llmModel.findMany({
      where: { config: { ownerId: userId } },
      select: { id: true },
    });
    return models.map((m) => m.id);
  }

  /**
   * 取当前用户的「默认对话模型」。
   * 用途：系统内置的平台助理不绑定固定模型（一份 Agent 记录服务所有用户），
   * 因此运行时按用户各自的默认对话模型解析；找不到则调用方回退全局 Ollama。
   */
  async resolveUserDefaultChatModel(userId: string): Promise<{
    llmModelId: string;
    modelName: string;
    provider: AiProvider;
    capabilities: ModelCapability[];
  } | null> {
    const model = await this.prisma.llmModel.findFirst({
      where: {
        config: { ownerId: userId },
        enabled: true,
        capabilities: { has: 'CHAT' },
      },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
      select: { id: true, modelId: true },
    });
    if (!model) return null;

    try {
      const runtime = await this.resolveModelRuntime(model.id);
      return {
        llmModelId: model.id,
        modelName: model.modelId,
        provider: runtime.provider,
        capabilities: runtime.capabilities,
      };
    } catch {
      return null;
    }
  }

  async updateModel(userId: string, modelId: string, dto: UpdateLlmModelDto) {
    const model = await this.prisma.llmModel.findUnique({
      where: { id: modelId },
      select: { id: true, configId: true },
    });
    if (!model) throw new NotFoundException('模型不存在');
    await this.assertModelOwner(model.configId, userId);

    return this.prisma.llmModel.update({
      where: { id: modelId },
      data: {
        ...(dto.displayName !== undefined
          ? { displayName: dto.displayName }
          : {}),
        ...(dto.capabilities !== undefined
          ? { capabilities: dto.capabilities }
          : {}),
        ...(dto.enabled !== undefined ? { enabled: dto.enabled } : {}),
        ...(dto.inputModalities !== undefined
          ? { inputModalities: dto.inputModalities }
          : {}),
        ...(dto.outputModalities !== undefined
          ? { outputModalities: dto.outputModalities }
          : {}),
        ...(dto.embeddingDimensions !== undefined
          ? { embeddingDimensions: dto.embeddingDimensions }
          : {}),
        ...(dto.maxInputTokens !== undefined
          ? { maxInputTokens: dto.maxInputTokens }
          : {}),
      },
      select: MODEL_SELECT,
    });
  }

  /**
   * 实测模型能力 —— 不靠模型名猜。
   *
   * - 含 EMBEDDING：跑一次真实 embedding，把**实际输出维度**写回 embeddingDimensions；
   * - 其它：跑一次极短 chat，确认可调用；
   * - 成功则 isVerified = true / verifiedAt = now()。
   */
  async verifyModel(userId: string, modelId: string) {
    const model = await this.prisma.llmModel.findUnique({
      where: { id: modelId },
      select: { id: true, configId: true, modelId: true, capabilities: true },
    });
    if (!model) throw new NotFoundException('模型不存在');
    await this.assertModelOwner(model.configId, userId);

    const { provider } = await this.resolveModelRuntime(modelId);
    const started = Date.now();

    try {
      if (model.capabilities.includes('EMBEDDING')) {
        const res = await provider.embedding(['维度校验'], {
          model: model.modelId,
        });
        const dim = res.embeddings?.[0]?.length ?? 0;
        if (!dim) {
          throw new Error('未返回任何向量，无法确定输出维度');
        }
        await this.prisma.llmModel.update({
          where: { id: modelId },
          data: {
            embeddingDimensions: dim,
            isVerified: true,
            verifiedAt: new Date(),
          },
        });
        return {
          ok: true,
          dimensions: dim,
          latencyMs: Date.now() - started,
          checked: ['embedding'],
        };
      }

      await provider.complete('ping', {
        model: model.modelId,
        maxTokens: 16,
      });
      await this.prisma.llmModel.update({
        where: { id: modelId },
        data: { isVerified: true, verifiedAt: new Date() },
      });
      return {
        ok: true,
        dimensions: null,
        latencyMs: Date.now() - started,
        checked: ['chat'],
      };
    } catch (err) {
      await this.prisma.llmModel.update({
        where: { id: modelId },
        data: { isVerified: false },
      });
      return {
        ok: false,
        dimensions: null,
        latencyMs: Date.now() - started,
        checked: model.capabilities.includes('EMBEDDING')
          ? ['embedding']
          : ['chat'],
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /** 设置某模型为用户的默认模型（同一 owner 仅一个默认） */
  async setDefaultModel(userId: string, modelId: string) {
    const model = await this.prisma.llmModel.findUnique({
      where: { id: modelId },
      select: { id: true, configId: true },
    });
    if (!model) throw new NotFoundException('模型不存在');
    await this.assertModelOwner(model.configId, userId);

    await this.prisma.$transaction([
      this.prisma.llmModel.updateMany({
        where: { config: { ownerId: userId }, isDefault: true },
        data: { isDefault: false },
      }),
      this.prisma.llmModel.update({
        where: { id: modelId },
        data: { isDefault: true },
      }),
    ]);

    return this.prisma.llmModel.findUnique({
      where: { id: modelId },
      select: MODEL_SELECT,
    });
  }

  // ===========================================================================
  // 内部工具
  // ===========================================================================

  /** 幂等写入单条模型记录；已存在时只补 provider / 可选字段，不覆盖用户改过的显示名 */
  private async upsertModel(
    configId: string,
    provider: unknown,
    modelId: string,
    opts?: { displayName?: string; capabilities?: ModelCapability[] },
  ) {
    return this.prisma.llmModel.upsert({
      where: { configId_modelId: { configId, modelId } },
      create: {
        configId,
        provider: provider as string,
        modelId,
        displayName: opts?.displayName || modelId,
        capabilities: opts?.capabilities ?? ['CHAT', 'STREAM'],
      },
      update: {
        provider: provider as string,
        ...(opts?.displayName ? { displayName: opts.displayName } : {}),
        ...(opts?.capabilities ? { capabilities: opts.capabilities } : {}),
      },
    });
  }

  /** 某配置下的全部模型 */
  private listConfigModels(configId: string) {
    return this.prisma.llmModel.findMany({
      where: { configId },
      select: MODEL_SELECT,
      orderBy: { createdAt: 'asc' },
    });
  }

  private resolveBaseUrl(
    provider: LlmProviderType,
    baseUrl?: string,
  ): string | null {
    if (baseUrl) return baseUrl;
    // openai / deepseek 都有默认地址（与 createProvider 的合并分支保持一致）
    if (provider === 'openai' || provider === 'deepseek') {
      return DEFAULT_BASE_URL[provider];
    }
    if (provider === 'openai-compatible') {
      throw new BadRequestException('openai-compatible 必须提供 baseUrl');
    }
    return null; // ollama：运行时取默认本地地址
  }

  private buildProviderFromConfig(config: ConfigPayload) {
    const plainKey = config.encryptedApiKey
      ? this.encryption.decrypt(config.encryptedApiKey)
      : null;
    return createProvider({
      provider: config.provider as LlmProviderType,
      baseUrl: (config.baseUrl as string) ?? null,
      apiKey: plainKey,
    });
  }

  private assertOwner(config: { ownerId: string }, userId: string) {
    if (config.ownerId !== userId) {
      throw new ForbiddenException('无权访问该配置');
    }
  }

  private async assertModelOwner(configId: string, userId: string) {
    const config = await this.prisma.llmProviderConfig.findUnique({
      where: { id: configId },
      select: { ownerId: true },
    });
    if (!config) throw new NotFoundException('配置不存在');
    if (config.ownerId !== userId) {
      throw new ForbiddenException('无权访问该模型');
    }
  }

  /** 脱敏：剥离 encryptedApiKey，补充 apiKeyMasked / hasApiKey */
  private toConfigView(config: ConfigPayload) {
    const { encryptedApiKey, ...rest } = config;
    const plain = encryptedApiKey
      ? this.encryption.decrypt(encryptedApiKey)
      : null;
    return {
      ...rest,
      apiKeyMasked: this.encryption.maskApiKey(plain),
      hasApiKey: !!encryptedApiKey,
    };
  }
}
