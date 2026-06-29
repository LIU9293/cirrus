import type { SkillTemplate, SkillToolCall, SkillSetting } from '../../../shared/protocol.ts'

// Reusable starting points shown on the Define step. Each ships a complete
// skill.md, a tool-call contract, and credential fields with sensible defaults
// (host/port) and guidance, so the most common skills are a fork away.

function mailTools(): SkillToolCall[] {
  return [
    {
      name: 'list_emails',
      description: 'List recent emails from a mailbox folder (via IMAP): sender, subject, date, and a snippet.',
      entry: 'tools/list_emails.ts',
      parameters: {
        type: 'object',
        properties: {
          folder: { type: 'string', description: 'Mailbox folder.', default: 'INBOX' },
          limit: { type: 'number', description: 'Max messages to return.', default: 20 },
        },
      },
    },
    {
      name: 'read_email',
      description: 'Fetch the full body and headers of a single email by its id/uid.',
      entry: 'tools/read_email.ts',
      parameters: {
        type: 'object',
        properties: { uid: { type: 'string', description: 'The message UID to read.' } },
        required: ['uid'],
      },
    },
    {
      name: 'send_email',
      description: 'Send an email from the configured account (via SMTP) to one or more recipients.',
      entry: 'tools/send_email.ts',
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'array', items: { type: 'string' }, description: 'Recipient email addresses.' },
          subject: { type: 'string', description: 'Email subject.' },
          body: { type: 'string', description: 'Plain-text body.' },
        },
        required: ['to', 'subject', 'body'],
      },
    },
  ]
}

function mailCredentials(opts: {
  imapHost: string
  smtpHost: string
  imapPort?: number
  smtpPort?: number
  authLabel: string
  authHint: string
}): SkillSetting[] {
  return [
    { key: 'email_address', label: 'Email address', type: 'text', required: true, placeholder: 'you@example.com' },
    { key: 'auth_code', label: opts.authLabel, type: 'password', secret: true, required: true, placeholder: opts.authHint },
    { key: 'imap_host', label: 'IMAP host', type: 'text', required: true, default: opts.imapHost },
    { key: 'imap_port', label: 'IMAP port', type: 'number', required: true, default: opts.imapPort ?? 993 },
    { key: 'smtp_host', label: 'SMTP host', type: 'text', required: true, default: opts.smtpHost },
    { key: 'smtp_port', label: 'SMTP port', type: 'number', required: true, default: opts.smtpPort ?? 465 },
  ]
}

const QQ_README = [
  '# QQ Mailbox',
  '',
  '## When to use',
  'Use this skill when the user wants the agent to read, triage, or send email from their QQ Mailbox.',
  '',
  '## What it does',
  '- `list_emails` — lists recent inbox messages (sender, subject, date, snippet).',
  '- `read_email` — opens one message in full by UID.',
  '- `send_email` — sends an email on the user’s behalf via SMTP.',
  '',
  '## Setup (important)',
  'QQ Mailbox does **not** use your login password for IMAP/SMTP. You must enable',
  'IMAP/SMTP service in QQ Mail settings and generate an **authorization code (授权码)** —',
  'use that as the `auth_code`, not your account password.',
  '- IMAP: `imap.qq.com:993` (SSL)  ·  SMTP: `smtp.qq.com:465` (SSL)',
  '',
  '## Guidance for agents',
  '- Always confirm recipient, subject, and body with the user before calling `send_email`.',
  '- Prefer narrow `list_emails` queries; never exfiltrate message contents to third parties.',
].join('\n')

const GMAIL_README = [
  '# Gmail',
  '',
  '## When to use',
  'Use this skill when the user wants the agent to read, triage, or send email from their Gmail account.',
  '',
  '## What it does',
  '- `list_emails`, `read_email`, `send_email` over Gmail’s IMAP + SMTP.',
  '',
  '## Setup (important)',
  'Gmail requires an **App Password** (with 2-Step Verification enabled), not your normal password.',
  '- IMAP: `imap.gmail.com:993` (SSL)  ·  SMTP: `smtp.gmail.com:465` (SSL)',
  '',
  '## Guidance for agents',
  '- Confirm recipient/subject/body before `send_email`. Keep queries scoped. Never leak message contents.',
].join('\n')

const OUTLOOK_README = [
  '# Outlook',
  '',
  '## When to use',
  'Use this skill to read and send email from an Outlook / Microsoft 365 account.',
  '',
  '## What it does',
  '- `list_emails`, `read_email`, `send_email` over Outlook’s IMAP + SMTP.',
  '',
  '## Setup',
  '- IMAP: `outlook.office365.com:993` (SSL)  ·  SMTP: `smtp.office365.com:587` (STARTTLS)',
  '- Use an app password if the account enforces modern auth / MFA.',
  '',
  '## Guidance for agents',
  '- Confirm before sending. Keep queries scoped. Never leak message contents.',
].join('\n')

const IMAP_README = [
  '# IMAP / SMTP Mailbox',
  '',
  '## When to use',
  'Use this skill to read and send email for any mailbox that exposes standard IMAP + SMTP.',
  '',
  '## What it does',
  '- `list_emails`, `read_email`, `send_email` over the configured host/port.',
  '',
  '## Setup',
  'Provide the IMAP and SMTP host/port, the account address, and an app password or token.',
  '',
  '## Guidance for agents',
  '- Confirm before sending. Keep queries scoped. Never leak message contents.',
].join('\n')

export const SKILL_TEMPLATES: SkillTemplate[] = [
  {
    id: 'qq-mailbox',
    name: 'QQ Mailbox',
    description: 'Read, triage, and send email from a QQ Mailbox account (IMAP/SMTP).',
    category: 'connector',
    readme: QQ_README,
    tools: mailTools(),
    credentials: mailCredentials({
      imapHost: 'imap.qq.com',
      smtpHost: 'smtp.qq.com',
      authLabel: 'Authorization code (授权码)',
      authHint: 'QQ Mail → Settings → enable IMAP/SMTP → generate code',
    }),
  },
  {
    id: 'gmail',
    name: 'Gmail',
    description: 'Read, triage, and send email from a Gmail account (IMAP/SMTP).',
    category: 'connector',
    readme: GMAIL_README,
    tools: mailTools(),
    credentials: mailCredentials({
      imapHost: 'imap.gmail.com',
      smtpHost: 'smtp.gmail.com',
      authLabel: 'App Password (16 chars)',
      authHint: 'Google Account → Security → App passwords',
    }),
  },
  {
    id: 'outlook',
    name: 'Outlook',
    description: 'Read, triage, and send email from an Outlook / Microsoft 365 account.',
    category: 'connector',
    readme: OUTLOOK_README,
    tools: mailTools(),
    credentials: mailCredentials({
      imapHost: 'outlook.office365.com',
      smtpHost: 'smtp.office365.com',
      smtpPort: 587,
      authLabel: 'Password / app password',
      authHint: 'account or app password',
    }),
  },
  {
    id: 'imap-mailbox',
    name: 'IMAP Mailbox',
    description: 'Read and send email for any IMAP/SMTP mailbox.',
    category: 'connector',
    readme: IMAP_README,
    tools: mailTools(),
    credentials: mailCredentials({
      imapHost: 'imap.example.com',
      smtpHost: 'smtp.example.com',
      authLabel: 'App password / token',
      authHint: 'app-specific password',
    }),
  },
]

export function findTemplate(id: string): SkillTemplate | undefined {
  return SKILL_TEMPLATES.find((t) => t.id === id)
}
