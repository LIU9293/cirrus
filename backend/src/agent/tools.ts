import type { OpenAI } from 'openai'

// Tool schemas exposed to the Cirrus Developer Agent.
export const developerTools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'set_manifest',
      description:
        'Declare or replace the miniapp manifest: id, name, description, the state model (fields + initial values), and the actions (mutate_state or agent). Call this before writing files.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'kebab-case id' },
          name: { type: 'string' },
          description: { type: 'string' },
          stateModel: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              description: { type: 'string' },
              fields: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    name: { type: 'string' },
                    type: { type: 'string', enum: ['string', 'number', 'boolean', 'object', 'array'] },
                    description: { type: 'string' },
                  },
                  required: ['name', 'type'],
                },
              },
              initial: { type: 'object', description: 'Initial JSON value of the state model', additionalProperties: true },
            },
            required: ['id', 'fields', 'initial'],
          },
          actions: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                kind: { type: 'string', enum: ['mutate_state', 'agent'] },
                description: { type: 'string' },
                agentInstruction: { type: 'string', description: 'Required for kind:agent — what the runtime agent should do.' },
                payloadExample: { type: 'object', additionalProperties: true },
              },
              required: ['id', 'kind', 'description'],
            },
          },
        },
        required: ['id', 'name', 'description', 'stateModel', 'actions'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_files',
      description:
        'Write miniapp source files. Paths are rooted at the runtime src dir; the entry must be app/App.tsx with a default-exported React component. Overwrites existing files at the same path.',
      parameters: {
        type: 'object',
        properties: {
          files: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                path: { type: 'string', description: 'e.g. app/App.tsx or app/TodoItem.tsx' },
                content: { type: 'string' },
              },
              required: ['path', 'content'],
            },
          },
        },
        required: ['files'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_files',
      description: 'Read back the current miniapp source files (paths + content).',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'build',
      description:
        'Build the miniapp into a single self-contained HTML file. Returns success, or the build error log so you can fix the source and build again.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'finish',
      description: 'Finish the task. Provide a short summary of what you built for the user.',
      parameters: {
        type: 'object',
        properties: { summary: { type: 'string' } },
        required: ['summary'],
      },
    },
  },
]
