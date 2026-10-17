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
          plan: 'OpenRouter',
        },
      },
    ]);
    this.updateUsage();
  }

  private updateUsage(): void {
    if (!this.deps.accounts) return;
    const now = Date.now();
    let fiveHourUtil = 0;
    let sevenDayUtil = 0;

    if (this.db) {
      try {
        const fiveHoursAgo = now - 5 * 3600 * 1000;
        const sevenDaysAgo = now - 7 * 86400 * 1000;

        const row5h = this.db.prepare(
          "SELECT COUNT(*) as c, SUM(tokens_input + tokens_output) as tokens FROM session WHERE time_updated > ?"
        ).get(fiveHoursAgo) as any;

        const row7d = this.db.prepare(
          "SELECT COUNT(*) as c, SUM(tokens_input + tokens_output) as tokens FROM session WHERE time_updated > ?"
        ).get(sevenDaysAgo) as any;

        const tokens5h = (row5h?.tokens || 0) + (this.activeSessions.size > 0 ? 5000 : 0);
        const tokens7d = (row7d?.tokens || tokens5h) + (this.activeSessions.size > 0 ? 5000 : 0);

        fiveHourUtil = Math.min(100, Math.max(this.activeSessions.size > 0 ? 15 : 0, Math.round((tokens5h / 50000) * 100)));
        sevenDayUtil = Math.min(100, Math.max(fiveHourUtil, Math.round((tokens7d / 200000) * 100)));
      } catch {
        fiveHourUtil = this.activeSessions.size > 0 ? 20 : 0;
        sevenDayUtil = this.activeSessions.size > 0 ? 15 : 0;
      }
    } else {
      fiveHourUtil = this.activeSessions.size > 0 ? 20 : 0;
      sevenDayUtil = this.activeSessions.size > 0 ? 15 : 0;
    }

    const resetsAt5h = now + 5 * 3600 * 1000 - (now % (5 * 3600 * 1000));
    const resetsAtWeek = now + 7 * 86400 * 1000 - (now % (7 * 86400 * 1000));

    this.deps.accounts.setUsage('.kilo', {
      source: 'kilo',
      fetchedAt: now,
      fiveHour: {
        utilization: fiveHourUtil,
        resetsAt: resetsAt5h,
      },
      sevenDay: {
        utilization: sevenDayUtil,
        resetsAt: resetsAtWeek,
      },
    });
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.db) this.db.close();
  }

  sources(): SourceInfo[] {
    return [{ provider: this.provider, account: 'Kilo Department', name: 'OpenRouter / Gemini', sessions: this.activeSessions.size }];
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
        if (parsed.id) {
          return parsed.id.replace(/-/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase());
        }
      }
    } catch {}
    if (rawModel.startsWith('openrouter/')) {
      return `OpenRouter: ${rawModel.replace('openrouter/', '')}`;
    }
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

      this.deps.office.applyTranscriptSummary(agentId, {
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

    this.syncParts(agentId, s.id);
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
      let hasActiveWorking = false;

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

  private syncParts(agentId: string, sessionId: string): void {
    if (!this.db) return;
    try {
      const parts = this.db.prepare(
        "SELECT id, data, time_created, time_updated FROM part WHERE session_id = ? ORDER BY time_updated DESC LIMIT 5"
      ).all(sessionId) as any[];

      for (const p of parts) {
        const data = JSON.parse(p.data);
        
        if (data.type === 'step-start') this.deps.office.setStatus(agentId, 'working');
        else if (data.type === 'step-finish') this.deps.office.setStatus(agentId, 'idle');
        
        if (data.type === 'tool' || data.tool_name || data.action) {
          const toolName = data.tool || data.tool_name || 'Tool';
          const summary = data.state?.title || data.title || data.summary || 'Executing tool';
          this.deps.office.addActivity(agentId, {
            id: `kilo-${p.id}`,
            kind: toolName === 'bash' ? 'run' : 'edit',
            tool: toolName === 'bash' ? 'Bash' : toolName,
            text: summary,
            at: p.time_updated
          }, true);
        }
      }
    } catch (e) {
      // ignore
    }
  }
}
