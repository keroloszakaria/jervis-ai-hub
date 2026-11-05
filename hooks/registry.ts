// ProviderRegistry: every provider the hub knows, how it authenticates and
// what the integration (not the model) can do.
import type { AuthMethod, Kind, Task } from '../types'

export type ProviderEntry = {
  id: string
  label: string
  kind: Kind
  auth: AuthMethod
  /** OpenCode's provider id, the prefix of its model ids, and models.dev's key */
  ocProvider?: string
  envVar?: string
  keyUrl?: string
  hint: string
  /** integration capabilities */
  canWrite: boolean
  /** the Jervis Relay delegate skill that drives this CLI, if it works with the installed CLI */
  relaySkill?: string
  /** whether the CLI reports token usage per request */
  reportsUsage: boolean
  /** subscription usage is counted against a plan, not billed per request */
  billing: 'subscription' | 'api' | 'free'
}

export const PROVIDERS: ProviderEntry[] = [
  {
    id: 'chatgpt',
    label: 'ChatGPT (Codex)',
    kind: 'codex',
    auth: 'subscription',
    hint: 'Your ChatGPT plan, signed in through the official Codex CLI',
    canWrite: true,
    relaySkill: 'codex-delegate',
    reportsUsage: true,
    billing: 'subscription',
  },
  {
    id: 'antigravity',
    label: 'Antigravity',
    kind: 'agy',
    auth: 'subscription',
    hint: 'Your Google Antigravity account, through the official agy CLI',
    canWrite: true,
    relaySkill: 'agy-delegate',
    reportsUsage: true,
    billing: 'subscription',
  },
  {
    id: 'opencode-free',
    label: 'OpenCode Zen (free)',
    kind: 'opencode-free',
    auth: 'free',
    ocProvider: 'opencode',
    hint: 'Free models served by OpenCode, no key needed',
    canWrite: true,
    reportsUsage: false,
    billing: 'free',
  },
  ...(
    [
      ['deepseek', 'DeepSeek', 'deepseek', 'DEEPSEEK_API_KEY', 'https://platform.deepseek.com/api_keys'],
      ['openrouter', 'OpenRouter', 'openrouter', 'OPENROUTER_API_KEY', 'https://openrouter.ai/keys'],
      ['gemini', 'Google Gemini API', 'google', 'GOOGLE_GENERATIVE_AI_API_KEY', 'https://aistudio.google.com/apikey'],
      ['xai', 'xAI Grok', 'xai', 'XAI_API_KEY', 'https://console.x.ai'],
      ['mistral', 'Mistral', 'mistral', 'MISTRAL_API_KEY', 'https://console.mistral.ai/api-keys'],
      ['groq', 'Groq', 'groq', 'GROQ_API_KEY', 'https://console.groq.com/keys'],
      ['kimi', 'Moonshot Kimi', 'moonshotai', 'MOONSHOT_API_KEY', 'https://platform.moonshot.ai/console/api-keys'],
      ['qwen', 'Alibaba Qwen', 'alibaba', 'DASHSCOPE_API_KEY', 'https://dashscope.console.aliyun.com/apiKey'],
      ['glm', 'Zhipu GLM', 'zhipuai', 'ZHIPU_API_KEY', 'https://open.bigmodel.cn/usercenter/apikeys'],
      ['cerebras', 'Cerebras', 'cerebras', 'CEREBRAS_API_KEY', 'https://cloud.cerebras.ai'],
      ['fireworks', 'Fireworks', 'fireworks-ai', 'FIREWORKS_API_KEY', 'https://fireworks.ai/account/api-keys'],
      ['perplexity', 'Perplexity', 'perplexity-agent', 'PERPLEXITY_API_KEY', 'https://www.perplexity.ai/settings/api'],
      ['minimax', 'MiniMax', 'minimax', 'MINIMAX_API_KEY', 'https://platform.minimax.io/docs/guides/quickstart'],
      ['minimax-plan', 'MiniMax Token Plan', 'minimax-coding-plan', 'MINIMAX_API_KEY', 'https://platform.minimax.io/docs/token-plan/intro'],
      ['anthropic', 'Anthropic API', 'anthropic', 'ANTHROPIC_API_KEY', 'https://console.anthropic.com/settings/keys'],
      ['openai', 'OpenAI API', 'openai', 'OPENAI_API_KEY', 'https://platform.openai.com/api-keys'],
      ['zai', 'Z.AI', 'zai', 'ZHIPU_API_KEY', 'https://docs.z.ai/guides/overview/pricing'],
      ['zai-plan', 'Z.AI Coding Plan', 'zai-coding-plan', 'ZHIPU_API_KEY', 'https://docs.z.ai/devpack/overview'],
      ['kimi-code', 'Kimi For Coding', 'kimi-code-plan-global', 'KIMI_API_KEY', 'https://www.kimi.ai/code/docs/en/kimi-code/models.html'],
      ['qwen-code', 'Alibaba Coding Plan', 'alibaba-coding-plan', 'ALIBABA_CODING_PLAN_API_KEY', 'https://www.alibabacloud.com/help/en/model-studio/coding-plan'],
      ['together', 'Together AI', 'togetherai', 'TOGETHER_API_KEY', 'https://docs.together.ai/docs/serverless-models'],
      ['deepinfra', 'Deep Infra', 'deepinfra', 'DEEPINFRA_API_KEY', 'https://deepinfra.com/models'],
      ['nvidia', 'NVIDIA NIM', 'nvidia', 'NVIDIA_API_KEY', 'https://build.nvidia.com'],
      ['huggingface', 'Hugging Face', 'huggingface', 'HF_TOKEN', 'https://huggingface.co/settings/tokens'],
      ['cohere', 'Cohere', 'cohere', 'COHERE_API_KEY', 'https://dashboard.cohere.com/api-keys'],
      ['sambanova', 'SambaNova', 'sambanova', 'SAMBANOVA_API_KEY', 'https://docs.sambanova.ai/cloud/docs/get-started/supported-models'],
      ['novita', 'Novita AI', 'novita-ai', 'NOVITA_API_KEY', 'https://novita.ai/docs/guides/introduction'],
      ['siliconflow', 'SiliconFlow', 'siliconflow', 'SILICONFLOW_API_KEY', 'https://cloud.siliconflow.com/models'],
      ['xiaomi', 'Xiaomi MiMo', 'xiaomi', 'XIAOMI_API_KEY', 'https://platform.xiaomimimo.com/#/docs'],
      ['stepfun', 'StepFun', 'stepfun-ai', 'STEPFUN_API_KEY', 'https://platform.stepfun.ai/docs/en/overview/concept'],
      ['venice', 'Venice AI', 'venice', 'VENICE_API_KEY', 'https://docs.venice.ai'],
      ['nebius', 'Nebius', 'nebius', 'NEBIUS_API_KEY', 'https://docs.tokenfactory.nebius.com/'],
      ['ollama-cloud', 'Ollama Cloud', 'ollama-cloud', 'OLLAMA_API_KEY', 'https://docs.ollama.com/cloud'],
      ['vercel', 'Vercel AI Gateway', 'vercel', 'AI_GATEWAY_API_KEY', 'https://vercel.com/docs/ai-gateway'],
      ['ai21', 'AI21 Labs', 'ai21', 'AI21_API_KEY', 'https://docs.ai21.com/docs/jamba-foundation-models'],
      ['upstage', 'Upstage', 'upstage', 'UPSTAGE_API_KEY', 'https://developers.upstage.ai/docs/apis/chat'],
      ['inception', 'Inception Labs', 'inception', 'INCEPTION_API_KEY', 'https://docs.inceptionlabs.ai/get-started/models'],
    ] as const
  ).map(
    ([id, label, ocProvider, envVar, keyUrl]): ProviderEntry => ({
      id,
      label,
      kind: 'opencode-key',
      auth: 'api-key',
      ocProvider,
      envVar,
      keyUrl,
      hint: `API key, used through OpenCode (${envVar})`,
      canWrite: true,
      reportsUsage: false,
      billing: 'api',
    }),
  ),
]

export const provider = (id: string): ProviderEntry | undefined => PROVIDERS.find(p => p.id === id)

export const AUTH_LABEL: Record<AuthMethod, string> = {
  subscription: 'Subscription sign-in',
  'api-key': 'API key',
  free: 'Local or free',
}

export const TASKS: { id: Task; label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'code', label: 'Coding' },
  { id: 'review', label: 'Code review' },
  { id: 'reasoning', label: 'Hard reasoning' },
  { id: 'fast', label: 'Fast answers' },
  { id: 'vision', label: 'Images' },
]
