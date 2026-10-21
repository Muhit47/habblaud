// Office dictation (microphone in "New agent"): browser records audio, submits via POST /api/dictation (base64
// JSON: edge guard enforces JSON across all POST requests), and polls GET /api/dictation/:id until transcription arrives.
// Transcribed via local Whisper (dictation/whisper.ts):
// - Node mode: local server process if whisper-cli, ffmpeg, and model are discovered;
// - Docker: host bridge (scripts/codex-bridge.ts) polls POST /api/host/dictation/poll and returns text via
//   POST /api/host/dictation/ack. Bridge polls strictly when Whisper is available ("available" = recent bridge heartbeat).
// Audio buffers reside strictly in memory and are discarded upon delivery; transcribed text persists until read (or 5 min).
import { randomUUID } from 'node:crypto';
import { tr } from '../../shared/i18n';
import { HostWait, pollWithWait } from '../host-wait';
import type { Transcriber } from './whisper';

/** Audio up to ~3 min (mobile devices record AAC/Opus, far less bandwidth per minute). */
export const AUDIO_MAX_BYTES = 12 * 1024 * 1024;
export const AUDIO_BODY_MAX = Math.ceil((AUDIO_MAX_BYTES * 4) / 3) + 16 * 1024;
export const HOST_PRESENCE_MS = 10_000;
const QUEUED_TIMEOUT_MS = 30_000;
const SENT_TIMEOUT_MS = 150_000;
const KEEP_MS = 5 * 60_000;
const MAX_OPEN = 4;
const TEXT_MAX = 20_000;
const ERROR_MAX = 300;

export type DictationStatus = 'queued' | 'sent' | 'done' | 'failed';

export interface DictationInfo {
  id: string;
  status: DictationStatus;
  text?: string;
  lang?: string;
  error?: string;
}

interface Entry {
  info: DictationInfo;
  audio: Buffer | null;
  type: string;
  at: number;
}

export interface DictationServiceOptions {
  /** Node mode with Whisper: transcribes locally. Omitted: queues for host bridge. */
  transcriber?: Transcriber;
  now?: () => number;
  newId?: () => string;
}

export type DictationSubmit = { dictation: DictationInfo } | { error: 'invalid' | 'unavailable' | 'too-many'; reason: string };

/** Validates body of POST /api/dictation: {type, data (base64)}. */
export function parseAudio(raw: unknown): { type: string; data: Buffer } | { error: string } {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const type = typeof r.type === 'string' && /^audio\/[\w.+-]+(;\s*codecs=[\w.,"' -]+)?$/i.test(r.type) ? r.type : '';
  if (!type) return { error: tr('formato de áudio desconhecido') };
  if (typeof r.data !== 'string' || !r.data || !/^[A-Za-z0-9+/]*={0,2}$/.test(r.data)) return { error: tr('áudio ilegível') };
  const data = Buffer.from(r.data, 'base64');
  if (data.length < 64) return { error: tr('gravação curta demais') };
  if (data.length > AUDIO_MAX_BYTES) return { error: tr('gravação longa demais (até uns 3 minutos)') };
  return { type, data };
}

export class DictationService {
  private readonly entries = new Map<string, Entry>();
  private readonly host: HostWait;
  private readonly now: () => number;

  constructor(private readonly opts: DictationServiceOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.host = new HostWait(HOST_PRESENCE_MS, this.now);
  }

  available(): boolean {
    return !!this.opts.transcriber || this.host.present();
  }

  submit(raw: unknown): DictationSubmit {
    this.prune();
    const audio = parseAudio(raw);
    if ('error' in audio) return { error: 'invalid', reason: audio.error };
    if (!this.available()) {
      return { error: 'unavailable', reason: tr('ditado indisponível: o Whisper não está instalado no computador ou o auxiliar (npm run codex:bridge) parou') };
    }
    let open = 0;
    for (const e of this.entries.values()) if (e.info.status === 'queued' || e.info.status === 'sent') open++;
    if (open >= MAX_OPEN) return { error: 'too-many', reason: tr('ditados demais esperando: aguarde o anterior') };
    const info: DictationInfo = { id: this.opts.newId?.() ?? randomUUID(), status: 'queued' };
    const entry: Entry = { info, audio: audio.data, type: audio.type, at: this.now() };
    this.entries.set(info.id, entry);
    if (this.opts.transcriber) void this.transcribeHere(entry, this.opts.transcriber);
    else this.host.wake();
    return { dictation: { ...info } };
  }

  get(id: string): DictationInfo | undefined {
    this.prune();
    const e = this.entries.get(id);
    return e && { ...e.info };
  }

  /** Bridge poll: registers presence and dequeues queued audio (base64), purged from memory. */
  poll(): Array<{ id: string; type: string; data: string }> {
    this.host.seen();
    this.prune();
    const out: Array<{ id: string; type: string; data: string }> = [];
    for (const e of this.entries.values()) {
      if (e.info.status !== 'queued' || !e.audio) continue;
      e.info.status = 'sent';
      e.at = this.now();
      out.push({ id: e.info.id, type: e.type, data: e.audio.toString('base64') });
      e.audio = null;
    }
    return out;
  }

  /** Long-poll (?wait=1): holds connection until audio arrives or timeout expires. */
  pollWait(ms: number, signal?: AbortSignal): Promise<Array<{ id: string; type: string; data: string }>> {
    return pollWithWait(this.host, () => this.poll(), ms, signal);
  }

  ack(raw: unknown): void {
    this.host.seen();
    const list = raw && typeof raw === 'object' && Array.isArray((raw as { results?: unknown }).results) ? (raw as { results: unknown[] }).results : [];
    for (const r of list) {
      const x = r && typeof r === 'object' ? (r as Record<string, unknown>) : {};
      const e = typeof x.id === 'string' ? this.entries.get(x.id) : undefined;
      if (!e || e.info.status !== 'sent') continue;
      if (x.ok === true && typeof x.text === 'string') this.finish(e, { text: x.text, lang: typeof x.lang === 'string' ? x.lang : '' });
      else this.fail(e, typeof x.error === 'string' && x.error ? x.error : tr('o auxiliar não transcreveu'));
    }
  }

  private async transcribeHere(e: Entry, transcribe: Transcriber): Promise<void> {
    const audio = e.audio;
    e.audio = null;
    e.info.status = 'sent';
    if (!audio) return this.fail(e, tr('áudio perdido'));
    try {
      this.finish(e, await transcribe(audio, e.type));
    } catch (err) {
      this.fail(e, (err as Error).message || tr('o Whisper falhou'));
    }
  }

  private finish(e: Entry, t: { text: string; lang: string }): void {
    e.info.status = 'done';
    e.info.text = t.text.slice(0, TEXT_MAX);
    e.info.lang = /^[a-z]{2,3}$/.test(t.lang) ? t.lang : undefined;
    e.at = this.now();
  }

  private fail(e: Entry, error: string): void {
    e.audio = null;
    e.info.status = 'failed';
    e.info.error = error.slice(0, ERROR_MAX);
    e.at = this.now();
  }

  private prune(): void {
    const now = this.now();
    for (const [id, e] of this.entries) {
      const age = now - e.at;
      if (e.info.status === 'queued' && age > QUEUED_TIMEOUT_MS) this.fail(e, tr('o auxiliar do computador não buscou o áudio'));
      else if (e.info.status === 'sent' && age > SENT_TIMEOUT_MS) this.fail(e, tr('a transcrição demorou demais'));
      else if ((e.info.status === 'done' || e.info.status === 'failed') && age > KEEP_MS) this.entries.delete(id);
    }
  }
}
