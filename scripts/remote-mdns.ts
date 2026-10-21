// npm run remote:mdns — advertises <HABBLAUD_REMOTE_NAME>.local on local network (mDNS), pointing to this host's
// IP, allowing mobile devices to access https://<name>.local without memorizing IPs. The container cannot perform this
// (in Docker Desktop it sits outside host Wi-Fi network), so this runs on host — `npm run remote:setup` registers it
// as a background service (LaunchAgent on macOS, systemd user service on Linux).
//
// macOS: `dns-sd -P` (built-in). Linux: `avahi-publish -a -R` (avahi-utils package). Verifies IP every 20 s
// and re-advertises when it changes (network switch, DHCP renewal) or if the advertiser process exits.
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readEnvValue } from '../server/remote/envfile';
import { isValidName, primaryIp } from '../server/remote/tls';
import { tr } from '../shared/i18n';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHECK_MS = 20_000;

/** Comando que anuncia `host` -> `ip` (undefined = sistema sem suporte). */
export function mdnsCommand(platform: NodeJS.Platform, name: string, ip: string, port: number): { cmd: string; args: string[] } | undefined {
  const host = `${name}.local`;
  if (platform === 'darwin') return { cmd: 'dns-sd', args: ['-P', `Habblaud (${name})`, '_https._tcp', 'local', String(port), host, ip] };
  if (platform === 'linux') return { cmd: 'avahi-publish', args: ['-a', '-R', host, ip] };
  return undefined;
}

function readSettings(): { name?: string; port: number } {
  let env = '';
  try {
    env = readFileSync(join(ROOT, '.env'), 'utf8');
  } catch {
    // sem .env: sem nome
  }
  const name = (process.env.HABBLAUD_REMOTE_NAME ?? readEnvValue(env, 'HABBLAUD_REMOTE_NAME'))?.trim().toLowerCase();
  const port = Number.parseInt(process.env.HABBLAUD_REMOTE_PORT ?? readEnvValue(env, 'HABBLAUD_REMOTE_PORT') ?? '', 10);
  return { name, port: Number.isInteger(port) && port > 0 && port < 65536 ? port : 4748 };
}

function main(): void {
  const { name, port } = readSettings();
  if (!name || !isValidName(name)) {
    console.error(tr('[remote-mdns] sem HABBLAUD_REMOTE_NAME válido no .env: rode npm run remote:setup.'));
    process.exit(1);
  }
  let child: ChildProcess | undefined;
  let announced: string | undefined;
  let stopping = false;
  const tick = () => {
    const ip = primaryIp();
    if (!ip) {
      if (announced) console.log(tr('[remote-mdns] sem rede: anúncio suspenso.'));
      child?.kill();
      child = undefined;
      announced = undefined;
      return;
    }
    if (child && announced === ip) return;
    child?.kill();
    const c = mdnsCommand(process.platform, name, ip, port);
    if (!c) {
      console.error(tr('[remote-mdns] {0} sem suporte: use o IP ou um endereço no DNS do roteador.', [process.platform]));
      process.exit(1);
    }
    const proc = spawn(c.cmd, c.args, { stdio: ['ignore', 'ignore', 'pipe'] });
    proc.stderr?.on('data', (d: Buffer) => console.error(`[remote-mdns] ${c.cmd}: ${d.toString().trim()}`));
    proc.on('error', (err) => console.error(tr('[remote-mdns] não deu para rodar {0}: {1}', [c.cmd, err.message])));
    proc.on('exit', () => {
      if (child === proc) {
        child = undefined;
        announced = undefined;
      }
    });
    child = proc;
    announced = ip;
    console.log(tr('[remote-mdns] anunciando {0}.local -> {1}', [name, ip]));
  };
  tick();
  const timer = setInterval(tick, CHECK_MS);
  const stop = () => {
    if (stopping) return;
    stopping = true;
    clearInterval(timer);
    child?.kill();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
