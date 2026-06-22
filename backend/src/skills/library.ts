import type { PlatformSkill } from '../../../shared/protocol.ts'

// The platform Skills Library. These are the COMPLETE capabilities Terr offers out
// of the box. Each one declares its contract (shared/terr_skill_contract.md):
//   - `credentials`: what the user must configure when adding the skill, and
//   - `tools`:       the tool calls it exposes to the agent (the standard contract).
// The planner matches a user's goal against them; the matches are auto-added and the
// user fills any credentials in the skill's detail panel.
const obj = (properties: Record<string, unknown>) => ({ type: 'object', properties })

export const PLATFORM_SKILLS: PlatformSkill[] = [
  {
    id: 'gmail',
    name: 'Gmail',
    category: 'connector',
    description: "Read and act on the user's Gmail inbox (search, fetch recent messages).",
    keywords: ['gmail', 'email', 'inbox', 'mail', '邮箱', '邮件', '收件箱'],
    requiresSetup: true,
    credentials: [
      { key: 'email', label: 'Gmail address', placeholder: 'you@gmail.com' },
      { key: 'app_password', label: 'App Password (16 chars)', secret: true, placeholder: '16-char app password' },
    ],
    tools: [
      {
        name: 'gmail_connection_status',
        description: 'Check whether the Gmail credential exists and the IMAP connection can authenticate.',
        parameters: obj({}),
        builtin: 'gmail_connection_status',
      },
      {
        name: 'gmail_search',
        description: 'Fetch recent inbox messages with metadata and optional snippets for triage, summaries, and stats.',
        parameters: obj({
          query: { type: 'string' },
          from: { type: 'string' },
          subject: { type: 'string' },
          sinceDays: { type: 'number' },
          unread: { type: 'boolean' },
          flagged: { type: 'boolean' },
          includeSnippet: { type: 'boolean' },
          snippetBytes: { type: 'number' },
          limit: { type: 'number' },
        }),
        builtin: 'gmail_search',
      },
      {
        name: 'gmail_modify_message',
        description: 'After explicit user confirmation, modify Gmail messages via IMAP: archive, delete, move, mark read, or mark unread. Does not auto-unsubscribe.',
        parameters: obj({
          messageIds: { type: 'array', items: { type: 'string' } },
          operation: { type: 'string', enum: ['archive', 'delete', 'move', 'mark_read', 'mark_unread'] },
          mailbox: { type: 'string' },
          sourceMailbox: { type: 'string' },
        }),
        builtin: 'gmail_modify_message',
      },
    ],
  },
  {
    id: 'web_search',
    name: 'Web Search',
    category: 'tool',
    description: 'Search the live web and read result snippets.',
    keywords: ['search', 'web', 'google', 'lookup', 'find online', '搜索', '查找'],
    tools: [
      {
        name: 'web_search',
        description: 'Search the web and return result snippets.',
        parameters: obj({ query: { type: 'string' } }),
        builtin: 'web_search',
      },
    ],
  },
  {
    id: 'http_request',
    name: 'HTTP Request',
    category: 'connector',
    description: 'Call an external REST/HTTP API and use the JSON response.',
    keywords: ['api', 'http', 'rest', 'fetch', 'endpoint', '接口', '请求'],
    tools: [
      {
        name: 'http_request',
        description: 'Call an external HTTP API and return the response.',
        parameters: obj({ url: { type: 'string' }, method: { type: 'string' }, body: {} }),
        builtin: 'http_request',
      },
    ],
  },
  {
    id: 'text_generate',
    name: 'Text Generation',
    category: 'ai',
    description: 'Generate or rewrite text with the LLM (explanations, copy, ideas).',
    keywords: ['generate', 'write', 'explain', 'rewrite', 'compose', '生成', '解释', '写作'],
    tools: [
      {
        name: 'generate_text',
        description: 'Generate or rewrite text with the LLM.',
        parameters: obj({ prompt: { type: 'string' } }),
        builtin: 'text_generate',
      },
    ],
  },
  {
    id: 'classify',
    name: 'Classify & Tag',
    category: 'ai',
    description: 'Label or categorise text/items (sentiment, spam, topic, difficulty).',
    keywords: ['classify', 'label', 'categorize', 'tag', 'sort', '分类', '标注'],
    tools: [
      {
        name: 'classify',
        description: 'Label text into one of the given categories.',
        parameters: obj({ text: { type: 'string' }, labels: { type: 'array', items: { type: 'string' } } }),
        builtin: 'classify',
      },
    ],
  },
  {
    id: 'summarize',
    name: 'Summarize',
    category: 'ai',
    description: 'Condense long text into a short digest.',
    keywords: ['summarize', 'summary', 'digest', 'tldr', '总结', '摘要'],
    tools: [
      {
        name: 'summarize',
        description: 'Condense text into a short digest.',
        parameters: obj({ text: { type: 'string' } }),
        builtin: 'summarize',
      },
    ],
  },
  {
    id: 'image_generate',
    name: 'Image Generation',
    category: 'ai',
    description: 'Generate images from a text prompt.',
    keywords: ['image', 'picture', 'illustration', 'draw', 'art', '图片', '配图', '插画'],
    tools: [
      {
        name: 'generate_image',
        description: 'Generate an image from a prompt.',
        parameters: obj({ prompt: { type: 'string' } }),
        builtin: 'image_generate',
      },
    ],
  },
  {
    id: 'dataset_library',
    name: 'Dataset Library',
    category: 'data',
    description: 'Read a built-in or user-provided dataset (word lists, catalogs, FAQs).',
    keywords: ['dataset', 'library', 'word list', 'vocabulary', 'catalog', '词库', '数据集', '题库'],
    tools: [
      {
        name: 'query_dataset',
        description: "Query the app's dataset table. Use `where` for exact-match filters and `limit`.",
        parameters: obj({ where: {}, limit: { type: 'number' }, columns: { type: 'array', items: { type: 'string' } } }),
        builtin: 'query_dataset',
      },
    ],
  },
  {
    id: 'database',
    name: 'Database',
    category: 'data',
    description: 'A managed per-agent database with an agent-defined interface, record transformation, and CRUD/upsert operations.',
    keywords: ['database', 'db', 'store', 'records', 'save', 'persist', 'table', 'sql', 'crud', 'upsert', '存储', '数据库', '记录', '入库'],
    tools: [
      {
        name: 'define_database_interface',
        description: 'Define or update this agent database interface: tables, fields, primary keys, and notes. The agent should also document the interface in this skill README.',
        parameters: obj({
          tables: {
            type: 'array',
            items: obj({
              name: { type: 'string' },
              primaryKey: { type: 'string' },
              fields: {
                type: 'array',
                items: obj({ name: { type: 'string' }, type: { type: 'string', enum: ['text', 'number', 'boolean', 'json'] } }),
              },
              description: { type: 'string' },
            }),
          },
          readme: { type: 'string' },
        }),
        builtin: 'define_database_interface',
      },
      {
        name: 'transform_records',
        description: 'Transform raw records from another skill or API into rows matching the database interface. Optionally write the transformed rows to a table.',
        parameters: obj({
          sourceRows: { type: 'array', items: { type: 'object' } },
          targetTable: { type: 'string' },
          mapping: { type: 'object' },
          instruction: { type: 'string' },
          write: { type: 'boolean' },
        }),
        builtin: 'transform_records',
      },
      {
        name: 'create_records',
        description: 'Insert records into a database table, creating or extending the table schema if needed.',
        parameters: obj({ rows: { type: 'array', items: { type: 'object' } }, table: { type: 'string' } }),
        builtin: 'create_records',
      },
      {
        name: 'query_records',
        description: "Query one of the agent's database tables. Use `where` for exact-match filters and `limit`.",
        parameters: obj({ table: { type: 'string' }, where: {}, limit: { type: 'number' }, columns: { type: 'array', items: { type: 'string' } } }),
        builtin: 'query_records',
      },
      {
        name: 'update_records',
        description: 'Update records matching an exact filter. Requires a non-empty where filter.',
        parameters: obj({ table: { type: 'string' }, where: {}, patch: { type: 'object' } }),
        builtin: 'update_records',
      },
      {
        name: 'delete_records',
        description: 'Delete records matching an exact filter. Requires a non-empty where filter.',
        parameters: obj({ table: { type: 'string' }, where: {} }),
        builtin: 'delete_records',
      },
      {
        name: 'upsert_records',
        description: 'Insert or update records using one or more key fields as the unique identity.',
        parameters: obj({ table: { type: 'string' }, rows: { type: 'array', items: { type: 'object' } }, keys: { type: 'array', items: { type: 'string' } } }),
        builtin: 'upsert_records',
      },
    ],
  },
  {
    id: 'miniapp_data_source',
    name: 'Miniapp Data Source',
    category: 'data',
    description: 'Load persisted miniapp records from one or more app datastore tables so runtime actions can refresh UI state without rescanning external services.',
    keywords: ['miniapp data', 'dashboard data', 'data source', 'load data', 'hydrate state', '看板数据', '数据源', '刷新数据'],
    tools: [
      {
        name: 'load_miniapp_data',
        description: 'Read one or more datastore tables in a single call. Use this before patch_state when a miniapp needs to refresh its dashboard from persisted records.',
        parameters: obj({
          sources: {
            type: 'array',
            items: obj({
              table: { type: 'string' },
              alias: { type: 'string' },
              where: { type: 'object' },
              limit: { type: 'number' },
              columns: { type: 'array', items: { type: 'string' } },
            }),
          },
        }),
        builtin: 'load_miniapp_data',
      },
    ],
  },
  // NOTE: scheduling/cron triggers, inbound webhooks, and user notification/delivery
  // are deliberately NOT skills. They are runtime-level configuration (triggers +
  // output channels) configured on the runtime, not capabilities of the agent.
]

export function findPlatformSkill(id: string): PlatformSkill | undefined {
  return PLATFORM_SKILLS.find((s) => s.id === id)
}

/** Lightweight keyword match — a deterministic fallback for the LLM planner. */
export function matchPlatformSkill(text: string): PlatformSkill | undefined {
  const haystack = text.toLowerCase()
  return PLATFORM_SKILLS.find(
    (s) =>
      haystack.includes(s.id.replace(/_/g, ' ')) ||
      (s.keywords ?? []).some((k) => haystack.includes(k.toLowerCase())),
  )
}
