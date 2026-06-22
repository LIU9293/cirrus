# Gmail Digest Agent Run Gaps

Date: 2026-06-22

## Goal

Create and run a Gmail Digest agent that can:

- Connect to the user's Gmail account.
- Analyze inbox data for digest/triage use cases.
- Persist emails, analysis snapshots, and agent operations to the app database.
- Expose repeatable verification so the platform can prove the capability is actually connected.

## Current Evidence

Miniapp under test: `app-l99jrh-2cfn` (`Gmail CleanBoard`).

Active runtime tools:

- `gmail_connection_status`
- `gmail_search`
- `define_database_table`
- `query_database`
- `write_rows`
- `inbox_triage`

Miniapp surface:

- The app now declares a `run_gmail_digest` manifest action.
- The app has a built dashboard surface with a `Run Gmail digest` control.
- The verifier calls the manifest action, not only the lower-level tool.

Verification command:

```bash
cd backend
npm run verify:gmail-digest -- app-l99jrh-2cfn
```

What passes in the current sandbox:

- Database schema creation works through `define_database_table`.
- Database append/query works through `write_rows` and `query_database`.
- `inbox_triage` records failed Gmail scan operations in `agent_operations`.
- `run_gmail_digest` updates miniapp state with `status`, `lastScan`, `error`, and visible operation entries.
- The verifier reports datastore tables and samples without exposing secrets.

Current external blocker:

- Gmail IMAP cannot be reached from this execution sandbox: `getaddrinfo ENOTFOUND imap.gmail.com`.
- This prevents proving live Gmail authentication and live inbox fetch from this sandbox.

## Platform Gaps Found

1. Credential health must be first-class.
   - The creator should see a Gmail connection check separate from business tool execution.
   - The platform needs to distinguish missing credential, DNS/network failure, auth failure, and empty inbox.

2. Persistence planning must be explicit.
   - Digest/analytics/history use cases need `database` automatically, even when the primary data source is Gmail.
   - The planner now adds `database` for scan/history/analytics/persistence goals.

3. DB skill needs schema ownership, not just row append.
   - Agents need a way to declare/update table schemas before writing.
   - The database skill now exposes `define_database_table`, `write_rows`, and `query_database`.

4. Operations need durable logging, including failures.
   - A failed Gmail scan is still an agent operation and should be queryable.
   - `inbox_triage` now writes failed scan rows to `agent_operations`.

5. Gmail search must return enough content for analysis.
   - Envelope-only fetch is not enough for digest and unsubscribe classification.
   - `gmail_search` now supports structured filters and optional snippets.

6. Runtime verification should be scriptable.
   - The platform needs a one-command check that exercises runtime tools and DB persistence.
   - `npm run verify:gmail-digest -- <appId>` now checks Gmail connection, calls the app manifest action, and reports DB tables.

7. Network reachability belongs in platform diagnostics.
   - The sandbox may not be able to reach external providers even when credentials are valid.
   - This should appear as a connection diagnostics state, not as a generic skill failure.

8. Agent actions sometimes need deterministic orchestration.
   - For critical workflow buttons such as `run_gmail_digest`, relying on an LLM to decide to call the right tool creates avoidable variance.
   - The runtime now has a deterministic action path for this action that calls `inbox_triage`, patches state, and preserves DB logging.
