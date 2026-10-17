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

export class AntigravitySource implements AgentSource {
  readonly provider = 'antigravity' as const;
  private readonly baseDir: string;
  private readonly presenceDir: string;
  private readonly brainDir: string;
  private watcher: fs.FSWatcher | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private sessionWatchers: Map<string, fs.FSWatcher> = new Map();
  private activeSessions: Set<string> = new Set();
  private transcriptCache = new Map<string, { mtimeMs: number; size: number; entries: { time: number; input: number; output: number }[] }>();

  constructor(private readonly deps: { office: Office; accounts?: AccountsService }) {
    this.baseDir = path.join(process.env.USERPROFILE || process.env.HOME || '', '.gemini', 'antigravity');
    this.presenceDir = path.join(this.baseDir, 'presence');
    this.brainDir = path.join(this.baseDir, 'brain');
  }

  async start(): Promise<void> {
    this.deps.office.beginBoot();
    try {
      this.registerAccount();
      if (!fs.existsSync(this.presenceDir)) {
        fs.mkdirSync(this.presenceDir, { recursive: true });
      }

      this.syncActiveSessions();
      this.pollTimer = setInterval(() => this.syncActiveSessions(), 3000);

      this.watcher = fs.watch(this.presenceDir, () => {
        this.syncActiveSessions();
      });
    } finally {
      this.deps.office.endBoot();
    }
  }

  private registerAccount(): void {
    if (!this.deps.accounts) return;
    this.deps.accounts.setProviderAccounts('antigravity', [
      {
        dir: this.baseDir,
        detected: {
          id: '.antigravity',
          provider: 'antigravity',
          short: 'AG',
          name: 'Antigravity',
          color: '#2563eb',
          configDir: this.baseDir,
          plan: 'Gemini',
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

    try {
      const brainDir = path.join(this.baseDir, 'brain');
      if (fs.existsSync(brainDir)) {
        const dirs = fs.readdirSync(brainDir);
        for (const d of dirs) {
          const logPath = path.join(brainDir, d, '.system_generated', 'logs', 'transcript.jsonl');
          if (!fs.existsSync(logPath)) continue;
          try {
            const stat = fs.statSync(logPath);
            let cached = this.transcriptCache.get(logPath);
            if (!cached || cached.mtimeMs !== stat.mtimeMs || cached.size !== stat.size) {
              const lines = fs.readFileSync(logPath, 'utf8').split('\n');
              const entries: { time: number; input: number; output: number }[] = [];
              for (const line of lines) {
                if (!line.trim() || !line.includes('PLANNER_RESPONSE')) continue;
                try {
                  const o = JSON.parse(line);
                  if (o.type === 'PLANNER_RESPONSE') {
                    const time = o.created_at ? new Date(o.created_at).getTime() : 0;
                    const input = (o.input_tokens || 0) + (o.cache_read_tokens || 0);
                    const output = o.output_tokens || 0;
                    entries.push({ time, input, output });
                  }
                } catch {}
              }
              cached = { mtimeMs: stat.mtimeMs, size: stat.size, entries };
              this.transcriptCache.set(logPath, cached);
            }

            for (const e of cached.entries) {
              const total = e.input + e.output;
              totalTokens += total;
              totalIn += e.input;
              totalOut += e.output;
              if (e.time >= sevenDaysAgo) {
                weekTokens += total;
                weekIn += e.input;
                weekOut += e.output;
              }
              if (e.time >= oneDayAgo) {
                dayTokens += total;
                dayIn += e.input;
                dayOut += e.output;
              }
            }
          } catch {}
        }
      }
    } catch (e) {
      log.error(`AntigravitySource: Failed to compute token usage: ${e}`);
    }

    this.deps.accounts.setUsage('.antigravity', {
      source: 'antigravity',
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
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.watcher) this.watcher.close();
    for (const watcher of this.sessionWatchers.values()) watcher.close();
    this.sessionWatchers.clear();
    this.activeSessions.clear();
  }

  sources(): SourceInfo[] {
    return [
      {
        provider: this.provider,
        label: 'Antigravity Department',
        path: this.baseDir,
        sessions: this.activeSessions.size,
        ok: true,
      },
    ];
  }

  transcriptPathOf(agentId: string): string | undefined {
    if (agentId.startsWith('antigravity-')) {
      const sessionId = agentId.replace('antigravity-', '');
      return path.join(this.brainDir, sessionId, '.system_generated', 'logs', 'transcript.jsonl');
    }
    return undefined;
  }

  private syncActiveSessions(): void {
    try {
      const currentLive = new Set<string>();

      if (fs.existsSync(this.presenceDir)) {
        const files = fs.readdirSync(this.presenceDir);

        for (const file of files) {
          if (!file.endsWith('.lock')) continue;
          const sessionId = file.replace('.lock', '');
          const meta = this.getConversationMeta(sessionId);

          // Working if recent activity in last 3 min, otherwise idle (goes to restroom, lounge, kitchen, reception)
          const isWorking = Date.now() - meta.lastActivityTime <= ACTIVE_THRESHOLD_MS;
          currentLive.add(sessionId);
          this.registerOrUpdateSession(sessionId, meta, isWorking ? 'working' : 'idle');
        }
      }

      // If no active locked session, ensure the most recent conversation stays present in 'idle' mode
      // so the character can hang out in the lounge, kitchen, restroom, and reception!
      if (currentLive.size === 0) {
        try {
          const dbPath = path.join(this.baseDir, 'conversation_summaries.db');
          if (fs.existsSync(dbPath)) {
            const db = new DatabaseSync(dbPath, { readOnly: true });
            const row = db.prepare(
              "SELECT conversation_id, title, workspace_uris, last_modified_time FROM conversation_summaries ORDER BY last_modified_time DESC LIMIT 1"
            ).get() as any;
            db.close();

            if (row && row.conversation_id) {
              const sessionId = row.conversation_id;
              const meta = this.getConversationMeta(sessionId);
              currentLive.add(sessionId);
              this.registerOrUpdateSession(sessionId, meta, 'idle');
            }
          }
        } catch {}
      }

      // Automatically remove any project no longer in currentLive
      for (const sessionId of this.activeSessions) {
        if (!currentLive.has(sessionId)) {
          this.unregisterSession(sessionId);
        }
      }

      this.updateUsage();
    } catch (e) {
      log.error(`AntigravitySource: sync error: ${e}`);
    }
  }

  private getConversationMeta(sessionId: string): { cwd: string; title: string; projectName: string; model: string; lastActivityTime: number } {
    const transcriptPath = this.transcriptPathOf(`antigravity-${sessionId}`)!;
    let lastActivityTime = 0;
    let detectedModel = 'Gemini 3.8 Flash';

    if (fs.existsSync(transcriptPath)) {
      try {
        const stats = fs.statSync(transcriptPath);
        lastActivityTime = stats.mtimeMs;

        // Try extracting exact model from transcript
        const sample = fs.readFileSync(transcriptPath, 'utf8').slice(0, 4000);
        const match = sample.match(/Model Selection.*?to\s+([A-Za-z0-9.\s()-]+?)(?:\.|\n|<)/i);
        if (match && match[1]) {
          detectedModel = match[1].trim();
        }
      } catch {}
    }

    try {
      const dbPath = path.join(this.baseDir, 'conversation_summaries.db');
      if (fs.existsSync(dbPath)) {
        const db = new DatabaseSync(dbPath, { readOnly: true });
        const row = db.prepare(
          "SELECT title, workspace_uris, last_modified_time FROM conversation_summaries WHERE conversation_id = ?"
        ).get(sessionId) as any;
        db.close();

        if (row) {
          let cwd = '';
          let projectName = '';

          if (row.workspace_uris) {
            try {
              const uris = JSON.parse(row.workspace_uris);
              if (Array.isArray(uris) && uris[0]) {
                const clean = uris[0].replace(/^file:\/\/\/?/, '');
                cwd = decodeURIComponent(clean).replace(/\\/g, '/');
                projectName = cwd.split('/').filter(Boolean).pop() || '';
              }
            } catch {}
          }

          if (!cwd) {
            cwd = path.join(process.env.USERPROFILE || process.env.HOME || '', 'Antigravity Conversations').replace(/\\/g, '/');
            projectName = 'Conversations';
          }

          return {
            cwd,
            title: row.title || projectName,
            projectName: projectName || 'Antigravity',
            model: detectedModel,
            lastActivityTime: Math.max(lastActivityTime, row.last_modified_time ? new Date(row.last_modified_time).getTime() : 0)
          };
        }
      }
    } catch (e) {
      // fallback
    }

    return {
      cwd: path.join(process.env.USERPROFILE || process.env.HOME || '', 'Antigravity Conversations').replace(/\\/g, '/'),
      title: 'Antigravity Session',
      projectName: 'Conversations',
      model: detectedModel,
      lastActivityTime
    };
  }

  private registerOrUpdateSession(
    sessionId: string,
    meta: { cwd: string; title: string; projectName: string; model: string },
    status: AgentStatus = 'working',
  ): void {
    const agentId = `antigravity-${sessionId}`;
    const transcriptPath = this.transcriptPathOf(agentId)!;

    if (!this.activeSessions.has(sessionId)) {
      this.activeSessions.add(sessionId);

      this.deps.office.addMain({
        id: agentId,
        name: `[Antigravity] ${meta.projectName}: ${meta.title}`,
        provider: this.provider,
        account: '.antigravity',
        sessionId: sessionId,
        cwd: 'Antigravity Office',
        role: meta.model,
        startedAt: Date.now(),
        status,
      });

      this.deps.office.applyTranscript(agentId, {
        title: `${meta.title} (${meta.model})`,
        model: meta.model,
        tasks: [],
        stats: { toolCalls: 0, tokensIn: 0, tokensOut: 0, subagents: 0 },
      });

      this.watchTranscript(sessionId, transcriptPath);
    } else {
      this.deps.office.setStatus(agentId, status);
    }
  }

  private unregisterSession(sessionId: string): void {
    this.activeSessions.delete(sessionId);
    this.deps.office.closeMain(`antigravity-${sessionId}`);
    const watcher = this.sessionWatchers.get(sessionId);
    if (watcher) watcher.close();
    this.sessionWatchers.delete(sessionId);
  }

  private watchTranscript(sessionId: string, transcriptPath: string): void {
    if (fs.existsSync(transcriptPath) && !this.sessionWatchers.has(sessionId)) {
      this.parseTranscript(sessionId, transcriptPath);
      this.sessionWatchers.set(sessionId, fs.watch(transcriptPath, () => {
        this.parseTranscript(sessionId, transcriptPath);
      }));
    }
  }

  private parseTranscript(sessionId: string, transcriptPath: string): void {
    try {
      const content = fs.readFileSync(transcriptPath, 'utf8');
      const lines = content.trim().split('\n');
      const agentId = `antigravity-${sessionId}`;
      
      for (const line of lines.slice(-20)) { // only parse latest lines
        try {
          const entry = JSON.parse(line);
          if (entry.tool_calls) {
            for (const call of entry.tool_calls) {
              const activity = this.mapToolCall(call, sessionId, entry);
              this.deps.office.addActivity(agentId, activity, true);
              this.deps.office.setStatus(agentId, 'working');
            }
          }
        } catch (e) {
          // ignore
        }
      }
    } catch (e) {
      log.error(`Failed to read transcript for ${sessionId}: ${e}`);
    }
  }

  private mapToolCall(call: any, sessionId: string, entry: any): any {
    const name = call.name;
    const args = call.args || {};
    const at = Date.now();
    const callId = `ag-${sessionId}-${entry.step_index ?? Date.now()}-${call.name}`;
    const clean = (val: string | undefined) => val?.replace(/^["']|["']$/g, '');

    switch (name) {
      case 'view_file':
        return { id: callId, kind: 'read', icon: '📄', tool: 'View', text: clean(args.toolSummary) || clean(args.toolAction) || 'Viewing file', at };
      case 'replace_file_content':
      case 'write_to_file':
        return { id: callId, kind: 'edit', icon: '✏️', tool: 'Edit', text: clean(args.toolSummary) || clean(args.toolAction) || 'Editing file', at };
      case 'run_command':
        return { id: callId, kind: 'run', icon: '💻', tool: 'Bash', text: clean(args.toolSummary) || clean(args.toolAction) || 'Running command', at };
      case 'search_web':
        return { id: callId, kind: 'search', icon: '🔍', tool: 'Web', text: clean(args.toolSummary) || 'Web search', at };
      default:
        return { id: callId, kind: 'edit', icon: '⚡', tool: name, text: clean(args.toolSummary) || name, at };
    }
  }
}
