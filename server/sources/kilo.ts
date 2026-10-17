import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AgentSource } from './source';
import type { AgentStatus, SourceInfo } from '../../shared/types';
import type { Office } from '../model/office';
import type { AccountsService } from '../accounts/service';
import { log } from '../log';

/** 1 minute threshold: if no activity within 1 minute, agent transitions to idle */
const ACTIVE_THRESHOLD_MS = 60 * 1000;

export class KiloSource implements AgentSource {
  readonly provider = 'kilo' as const;
  private readonly baseDataDir: string;
  private readonly dbPath: string;
  private readonly locksDir: string;
  private db: DatabaseSync | null = null;
  private timer: NodeJS.Timeout | null = null;
  private activeSessions: Set<string> = new Set();

  constructor(private readonly deps: { office: Office; accounts?: AccountsService }) {
    this.baseDataDir = path.join(process.env.USERPROFILE || process.env.HOME || '', '.local', 'share', 'kilo');
    this.dbPath = path.join(this.baseDataDir, 'kilo.db');
    this.locksDir = path.join(process.env.USERPROFILE || process.env.HOME || '', '.local', 'state', 'kilo', 'locks');
  }

  async start(): Promise<void> {
    this.deps.office.beginBoot();
    try {
      this.initDb();
      this.registerAccount();
      this.poll();
      this.timer = setInterval(() => this.poll(), 2000);
    } catch (e) {
      log.error(`KiloSource: Failed to start: ${e}`);
    } finally {
      this.deps.office.endBoot();
    }
  }

  private registerAccount(): void {
    if (!this.deps.accounts) return;
    this.deps.accounts.setProviderAccounts('kilo', [
      {
        dir: this.baseDataDir,
        detected: {
          id: '.kilo',
          provider: 'kilo',
          short: 'K',
          name: 'Kilo',
          color: '#7c3aed',
          configDir: this.baseDataDir,
          plan: 'Kilo Gateway & Gemini',
        },
      },
    ]);
    this.updateUsage();
  }

  private updateUsage(): void {
    if (!this.deps.accounts) return;
    const now = Date.now();
    const oneDayAgo = now - 24 * 3600 * 1000;
    const sevenDaysAgo = now - 7 * 86400 * 1000;

    let dayTokens = 0, dayIn = 0, dayOut = 0;
    let weekTokens = 0, weekIn = 0, weekOut = 0;
    let totalTokens = 0, totalIn = 0, totalOut = 0;

    if (this.db) {
      try {
        const rows = this.db.prepare("SELECT time_created, data FROM message WHERE data LIKE '%tokens%'").all() as {
          time_created: number;
          data: string;
        }[];

        for (const r of rows) {
          try {
            const d = JSON.parse(r.data);
            if (d.tokens) {
              const input = (d.tokens.input || 0) + (d.tokens.cache?.read || 0);
              const output = (d.tokens.output || 0) + (d.tokens.reasoning || 0);
              const total = d.tokens.total || (input + output);
              const time = r.time_created || d.time?.created || 0;

              totalTokens += total;
              totalIn += input;
              totalOut += output;
              if (time >= sevenDaysAgo) {
                weekTokens += total;
                weekIn += input;
                weekOut += output;
              }
              if (time >= oneDayAgo) {
                dayTokens += total;
                dayIn += input;
                dayOut += output;
              }
            }
          } catch {}
        }
      } catch (e) {
        log.error(`KiloSource: Failed to query token usage: ${e}`);
      }
    }

    this.deps.accounts.setUsage('.kilo', {
      source: 'kilo',
      fetchedAt: now,
      dailyTokens: {
        tokens: dayTokens,
        tokensIn: dayIn,
        tokensOut: dayOut,
      },
      weeklyTokens: {
        tokens: weekTokens,
        tokensIn: weekIn,
        tokensOut: weekOut,
      },
      totalTokens: {
        tokens: totalTokens,
        tokensIn: totalIn,
        tokensOut: totalOut,
      },
    });
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.db) this.db.close();
  }

  sources(): SourceInfo[] {
    return [
      {
        provider: this.provider,
        label: 'Kilo Department',
        path: this.baseDataDir,
        sessions: this.activeSessions.size,
        ok: true,
      },
    ];
  }

  transcriptPathOf(_agentId: string): string | undefined {
    return undefined;
  }

  private initDb(): void {
    if (fs.existsSync(this.dbPath)) {
      try {
        this.db = new DatabaseSync(this.dbPath, { readOnly: true });
      } catch (e) {
        log.error(`KiloSource: Error opening SQLite DB: ${e}`);
      }
    }
  }

  private formatModelName(rawModel: string | undefined): string {
    if (!rawModel) return 'Kilo Default';
    try {
      if (rawModel.startsWith('{')) {
        const parsed = JSON.parse(rawModel);
        if (parsed.id === 'kilo-auto/free') {
          return 'Auto Free (Kilo Gateway)';
        }
        if (parsed.id === 'openrouter/free') {
          return 'OpenRouter Free Models Router (Kilo Gateway)';
        }
        if (parsed.id === 'gemini-3.1-flash-lite') {
          return 'Gemini 3.1 Flash Lite';
        }
        if (parsed.id) {
          const name = parsed.id.replace(/-/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase());
          return parsed.providerID === 'kilo' ? `${name} (Kilo Gateway)` : name;
        }
      }
    } catch {}
    if (rawModel.startsWith('gemini/')) {
      return `Gemini: ${rawModel.replace('gemini/', '')}`;
    }
    return rawModel;
  }

  private handleSession(s: any, status: AgentStatus, currentLive: Set<string>): void {
    const agentId = `kilo-${s.id}`;
    currentLive.add(s.id);

    const rawDir = (s.directory || '').replace(/\\/g, '/');
    const isPinned = rawDir.toLowerCase().includes('kilo desktop/chats') || !rawDir;
    const cwd = isPinned
      ? path.join(process.env.USERPROFILE || process.env.HOME || '', 'Pinned Conversations').replace(/\\/g, '/')
      : rawDir;
    const projectName = isPinned
      ? 'Pinned'
      : (cwd.split('/').filter(Boolean).pop() || 'Project');
    const title = s.title || projectName;
    const modelName = this.formatModelName(s.model);

    if (!this.activeSessions.has(s.id)) {
      this.activeSessions.add(s.id);

      this.deps.office.addMain({
        id: agentId,
        name: `[Kilo] ${projectName}: ${title}`,
        provider: this.provider,
        account: '.kilo',
        sessionId: s.id,
        cwd: 'Kilo Office',
        role: modelName,
        startedAt: s.time_created || Date.now(),
        status,
      });

      this.deps.office.applyTranscript(agentId, {
        title: `${title} (${modelName})`,
        model: modelName,
        tasks: [],
        stats: {
          toolCalls: 0,
          tokensIn: s.tokens_input || 0,
          tokensOut: s.tokens_output || 0,
          subagents: 0,
        },
      });
    } else {
      this.deps.office.setStatus(agentId, status);
    }

    this.syncParts(agentId, s.id, status === 'working');
  }

  private poll(): void {
    if (!this.db) this.initDb();
    if (!this.db) return;

    try {
      const sessions = this.db.prepare(
        "SELECT id, directory, title, cost, tokens_input, tokens_output, agent, model, time_created, time_updated FROM session ORDER BY time_updated DESC LIMIT 10"
      ).all() as any[];

      const now = Date.now();
      const currentLive = new Set<string>();

      for (const s of sessions) {
        const lockExists = fs.existsSync(path.join(this.locksDir, `${s.id}.lock`));
        const isWorking = lockExists || (now - s.time_updated <= ACTIVE_THRESHOLD_MS);

        this.handleSession(s, isWorking ? 'working' : 'idle', currentLive);
      }

      // Automatically remove any project no longer in currentLive
      for (const id of this.activeSessions) {
        if (!currentLive.has(id)) {
          this.activeSessions.delete(id);
          this.deps.office.closeMain(`kilo-${id}`);
        }
      }

      this.updateUsage();
    } catch (e) {
      log.error(`KiloSource: Poll error: ${e}`);
    }
  }

  private syncParts(agentId: string, sessionId: string, isWorking: boolean): void {
    if (!this.db) return;
    try {
      const parts = this.db.prepare(
        "SELECT id, data, time_created, time_updated FROM part WHERE session_id = ? ORDER BY time_updated DESC LIMIT 5"
      ).all(sessionId) as any[];

      for (const p of parts) {
        const data = JSON.parse(p.data);
        
        if (data.type === 'tool' || data.tool_name || data.action) {
          const toolName = data.tool || data.tool_name || 'Tool';
          const summary = data.state?.title || data.title || data.summary || 'Executing tool';
          this.deps.office.addActivity(agentId, {
            id: `kilo-${p.id}`,
            kind: toolName === 'bash' ? 'run' : 'edit',
            icon: toolName === 'bash' ? '💻' : '✏️',
            tool: toolName === 'bash' ? 'Bash' : toolName,
            text: summary,
            at: p.time_updated,
          }, isWorking);
        }
      }
    } catch (e) {
      // ignore
    }
  }
}
