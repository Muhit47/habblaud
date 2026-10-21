// Codex hook events (the "live" stream for Codex source): hook script pipes event stdin to
// POST /api/codex/events, forwarded here. Implemented by Codex source (sources/codex/source.ts).

export interface CodexLive {
  /**
   * Applies Codex hook event (from hook stdin: `hook_event_name`, `session_id`, `agent_id`, `cwd`,
   * `tool_name`, `tool_use_id`, `tool_input`, `transcript_path`...) to office. `account` = sending Codex account
   * (account id or CODEX_HOME; if absent, inferred from `transcript_path` or thread). Returns
   * false for unknown events or sessions not matching any Codex account.
   */
  applyHookEvent(account: string | undefined, input: Record<string, unknown>): boolean;
}
