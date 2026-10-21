// Character wallets (fictional coins 🪙). Agents arriving at the office start with an
// initial balance; earn more for completed tasks, and gain or lose bets with colleagues.
//
// Persisted in browser (localStorage) per agent: each browser maintains its own economy (bets are
// resolved in local simulation). Without localStorage (tests, incognito restrictions), held in memory only.
// Agents in visited world buildings (ids `world:`, shared/world/office-from-world.ts) use a separate
// key (WORLD_STORAGE_KEY), cleared upon leaving visit: visits never perturb local office economy.
import { tr } from '../../../../shared/i18n';
import { isWorldId } from '../../../../shared/world/office-from-world';

/** Initial balance for newly arrived agents. */
export const START_COINS: Readonly<Record<'main' | 'sub', number>> = { main: 100, sub: 30 };
/** Reward for completed task list item. */
export const TASK_REWARD = 10;
/** Subagent delivered result to calling agent (assigned task). */
export const DELIVERY_REWARD = 15;
/** Reward for fulfilled user request (turn completion). */
export const TURN_REWARD = 5;

const STORAGE_KEY = 'habblaud.wallets.v1';
/** Wallets for visited world building (ids `world:`). */
export const WORLD_STORAGE_KEY = 'habblaud:world-wallet';
const LEDGER_MAX = 12;
const PAID_MAX = 300;
/** Wallets for agents absent longer than this threshold are pruned. */
const FORGET_MS = 3 * 24 * 3_600_000;
const MAX_WALLETS = 400;

export interface LedgerEntry {
  at: number;
  delta: number;
  icon: string;
  text: string;
}

export interface WalletEntry {
  name: string;
  coins: number;
  /** Total earned working (initial balance, tasks, deliveries, requests). */
  earned: number;
  wins: number;
  losses: number;
  /** Head-to-head record per opponent (id): [wins, losses]. */
  vs: Record<string, [number, number]>;
  /** Already rewarded tasks ("id|title"). */
  paid: string[];
  /** Statement: most recent transactions first. */
  ledger: LedgerEntry[];
  createdAt: number;
  seenAt: number;
}

/** Minimal AgentInfo subset required by wallet. */
export interface WalletAgent {
  id: string;
  name: string;
  kind: 'main' | 'sub';
  tasks: readonly { id: string; title: string; status: string }[];
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

/** Economy partition: local office or visited world building. */
type Part = 'office' | 'world';
const PARTS: readonly Part[] = ['office', 'world'];
const KEYS: Readonly<Record<Part, string>> = { office: STORAGE_KEY, world: WORLD_STORAGE_KEY };
const partOf = (id: string): Part => (isWorldId(id) ? 'world' : 'office');

/**
 * Clears stored visit wallets from browser (upon leaving building). Call after destroying visit `Sim`:
 * it writes wallets when unmounted.
 */
export function clearWorldWallets(storage: StorageLike | null): void {
  if (!storage) return;
  try {
    if (storage.removeItem) storage.removeItem(WORLD_STORAGE_KEY);
    else storage.setItem(WORLD_STORAGE_KEY, '');
  } catch {
    // storage blocked: residual entries pruned after FORGET_MS
  }
}

/** Safe localStorage reference (incognito/restricted throws on access). */
export function browserStorage(): StorageLike | null {
  try {
    const s = (globalThis as { localStorage?: StorageLike }).localStorage;
    if (!s) return null;
    s.getItem(STORAGE_KEY);
    return s;
  } catch {
    return null;
  }
}

function taskKey(t: { id: string; title: string }): string {
  return `${t.id}|${t.title}`;
}

export class Wallets {
  private map = new Map<string, WalletEntry>();
  /** Dirty tracking per economy partition: each only rewrites its designated key. */
  private dirty: Record<Part, boolean> = { office: false, world: false };

  constructor(private readonly storage: StorageLike | null) {
    this.load();
  }

  get(id: string): WalletEntry | undefined {
    return this.map.get(id);
  }

  coins(id: string): number {
    return this.map.get(id)?.coins ?? 0;
  }

  /**
   * Ensures agent wallet exists. On first creation: initial balance and silently rewards tasks
   * already completed (work done before page was opened is credited).
   */
  ensure(a: WalletAgent, now: number): { entry: WalletEntry; created: boolean } {
    let w = this.map.get(a.id);
    if (w) {
      if (w.name !== a.name) w.name = a.name;
      if (now - w.seenAt > 60_000) {
        w.seenAt = now;
        this.touch(a.id);
      }
      return { entry: w, created: false };
    }
    const start = START_COINS[a.kind] ?? START_COINS.main;
    w = { name: a.name, coins: start, earned: start, wins: 0, losses: 0, vs: {}, paid: [], ledger: [], createdAt: now, seenAt: now };
    this.map.set(a.id, w);
    this.log(w, { at: now, delta: start, icon: '🏢', text: tr('Chegou ao escritório') });
    const done = a.tasks.filter((t) => t.status === 'completed');
    if (done.length) {
      for (const t of done) w.paid.push(taskKey(t));
      const v = done.length * TASK_REWARD;
      w.coins += v;
      w.earned += v;
      this.log(w, { at: now, delta: v, icon: '✅', text: done.length === 1 ? tr('1 tarefa já concluída') : tr('{0} tarefas já concluídas', [done.length]) });
    }
    this.touch(a.id);
    return { entry: w, created: true };
  }

  /** Rewards unpaid completed tasks. Returns newly credited amount. */
  payTasks(a: WalletAgent, now: number): number {
    const w = this.map.get(a.id);
    if (!w) return 0;
    let total = 0;
    for (const t of a.tasks) {
      if (t.status !== 'completed') continue;
      const k = taskKey(t);
      if (w.paid.includes(k)) continue;
      w.paid.push(k);
      if (w.paid.length > PAID_MAX) w.paid.splice(0, w.paid.length - PAID_MAX);
      w.coins += TASK_REWARD;
      w.earned += TASK_REWARD;
      total += TASK_REWARD;
      this.log(w, { at: now, delta: TASK_REWARD, icon: '✅', text: tr('Tarefa concluída: {0}', [t.title]) });
    }
    if (total) this.touch(a.id);
    return total;
  }

  /** Work credit (fulfilled user request, subagent task delivery). */
  credit(id: string, amount: number, icon: string, text: string, now: number): number {
    const w = this.map.get(id);
    if (!w || amount <= 0) return 0;
    w.coins += amount;
    w.earned += amount;
    this.log(w, { at: now, delta: amount, icon, text });
    this.touch(id);
    return amount;
  }

  /**
   * Bet settlement: transfers up to `amount` from loser (non-negative floor) to winner.
   * Returns actual transferred amount.
   */
  transfer(fromId: string, toId: string, amount: number, icon: string, what: string, now: number): number {
    const from = this.map.get(fromId);
    const to = this.map.get(toId);
    if (!from || !to || fromId === toId) return 0;
    const v = Math.max(0, Math.min(Math.floor(amount), from.coins));
    if (!v) return 0;
    from.coins -= v;
    to.coins += v;
    this.log(from, { at: now, delta: -v, icon, text: tr('Perdeu {0} para {1}', [what, to.name]) });
    this.log(to, { at: now, delta: v, icon, text: tr('Ganhou {0} de {1}', [what, from.name]) });
    this.touch(fromId);
    this.touch(toId);
    return v;
  }

  /** Match/bet record update (also applies to zero-stake matches). */
  recordMatch(winnerId: string, loserId: string): void {
    const w = this.map.get(winnerId);
    const l = this.map.get(loserId);
    if (!w || !l) return;
    w.wins++;
    l.losses++;
    (w.vs[loserId] ??= [0, 0])[0]++;
    (l.vs[winnerId] ??= [0, 0])[1]++;
    this.touch(winnerId);
    this.touch(loserId);
  }

  /**
   * Flushes dirty wallets to browser storage (low-frequency cadence), partitioned per key: world visits
   * never overwrite office storage (even with stale snapshot), and vice versa.
   */
  save(now: number): void {
    for (const part of PARTS) {
      if (!this.dirty[part]) continue;
      this.dirty[part] = false;
      this.prune(now, part);
      if (!this.storage) continue;
      const wallets = Object.fromEntries([...this.map].filter(([id]) => partOf(id) === part));
      try {
        this.storage.setItem(KEYS[part], JSON.stringify({ v: 1, wallets }));
      } catch {
        // quota exceeded / storage blocked: continues in-memory only
      }
    }
  }

  /** Prunes wallets absent for days (and caps total entries per economy partition). */
  prune(now: number, only?: Part): void {
    for (const part of only ? [only] : PARTS) {
      const entries = [...this.map].filter(([id]) => partOf(id) === part);
      for (const [id, w] of entries) if (now - w.seenAt > FORGET_MS) this.map.delete(id);
      const left = entries.filter(([id]) => this.map.has(id));
      if (left.length <= MAX_WALLETS) continue;
      const old = left.sort((a, b) => a[1].seenAt - b[1].seenAt);
      for (const [id] of old.slice(0, left.length - MAX_WALLETS)) this.map.delete(id);
    }
  }

  private touch(id: string): void {
    this.dirty[partOf(id)] = true;
  }

  private log(w: WalletEntry, e: LedgerEntry): void {
    w.ledger.unshift(e);
    if (w.ledger.length > LEDGER_MAX) w.ledger.length = LEDGER_MAX;
  }

  private load(): void {
    for (const part of PARTS) this.loadPart(part);
  }

  private loadPart(part: Part): void {
    if (!this.storage) return;
    try {
      const raw = this.storage.getItem(KEYS[part]);
      if (!raw) return;
      const j = JSON.parse(raw) as { v?: number; wallets?: Record<string, Partial<WalletEntry>> };
      for (const [id, w] of Object.entries(j.wallets ?? {})) {
        if (partOf(id) !== part) continue; // each key scoped strictly to its economy
        if (!w || typeof w.coins !== 'number' || !Number.isFinite(w.coins)) continue;
        this.map.set(id, {
          name: typeof w.name === 'string' ? w.name : id,
          coins: Math.max(0, Math.floor(w.coins)),
          earned: typeof w.earned === 'number' ? w.earned : w.coins,
          wins: typeof w.wins === 'number' ? w.wins : 0,
          losses: typeof w.losses === 'number' ? w.losses : 0,
          vs: w.vs && typeof w.vs === 'object' ? w.vs : {},
          paid: Array.isArray(w.paid) ? w.paid.filter((p): p is string => typeof p === 'string') : [],
          ledger: Array.isArray(w.ledger) ? w.ledger.slice(0, LEDGER_MAX) : [],
          createdAt: typeof w.createdAt === 'number' ? w.createdAt : 0,
          seenAt: typeof w.seenAt === 'number' ? w.seenAt : 0,
        });
      }
    } catch {
      // unreadable: start fresh
    }
  }
}
