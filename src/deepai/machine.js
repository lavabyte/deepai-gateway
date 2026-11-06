/**
 * The machine identity DeepAI's server reads from Code-lane requests.
 *
 * Taken from the DeepAI Code app itself (`src/deepai/machineId.ts`, read out of
 * `app.asar` in the 0.3.18 build), because the header is not documented anywhere else:
 *
 *     const DEEPAI_MACHINE_HEADER = "X-DeepAI-Code-Machine";
 *     function hashMachineId(raw) { return sha256(raw).digest("hex"); }
 *
 * The app's own comment says what it is for:
 *
 *   "Daily Theos are granted once per machine: the server reads this header and withholds
 *    the grant from a build that omits it. The value is a digest of an identifier that
 *    survives reinstalling the app and the OS: IOPlatformUUID on macOS, the SMBIOS UUID on
 *    Windows (MachineGuid when the firmware ships a placeholder). The raw identifier never
 *    leaves the machine. When no identifier is readable the header is omitted and the
 *    server, told apart from an older build by the lane version, answers metered calls with
 *    machine_required."
 *
 * So a gateway that omits it is a build the server will not grant Theos to. The raw
 * identifier is hashed here and never sent, exactly as the app does.
 *
 * The gateway is one machine for every account it serves, which is what it is: the header
 * names the host, not the account. `DEEPAI_MACHINE_ID` overrides it for a deployment whose
 * host identifier is not stable (a container, a machine re-imaged often), because a value
 * that changes makes the server see a new machine every time.
 *
 * @module deepai-gateway/deepai/machine
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

/** The header name, as the app spells it. */
export const MACHINE_HEADER = 'X-DeepAI-Code-Machine';

/** Firmware placeholders that are not a machine: the app carries the same list. */
const PLACEHOLDERS = new Set([
  '00000000-0000-0000-0000-000000000000',
  'ffffffff-ffff-ffff-ffff-ffffffffffff',
  '03000200-0400-0500-0006-000700080009',
]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Run a command and return its output, or nothing when it cannot be run. */
function run(file, args) {
  try {
    return execFileSync(file, args, { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return '';
  }
}

/** Read a file and return its trimmed contents, or nothing. */
function read(file) {
  try {
    return readFileSync(file, 'utf8').trim();
  } catch {
    return '';
  }
}

/**
 * A stable identifier for this host, or '' when none can be read.
 *
 * @returns {string}
 */
function detect() {
  if (process.platform === 'darwin') {
    // The app's own command and pattern: the platform expert device's IOPlatformUUID.
    const match = /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(run('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice']));
    return match?.[1] ?? '';
  }
  if (process.platform === 'win32') {
    const smbios = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
      .exec(run('powershell', ['-NoProfile', '-NonInteractive', '-Command', '(Get-CimInstance Win32_ComputerSystemProduct).UUID']));
    if (smbios !== null && !PLACEHOLDERS.has(smbios[0].toLowerCase())) return smbios[0];
    const guid = /MachineGuid\s+REG_SZ\s+(\S+)/.exec(run('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid']));
    return guid?.[1] ?? '';
  }
  /*
   * Linux, which the app does not cover because it does not ship for it. The DMI product
   * UUID is the firmware identifier and the closest equivalent to what the app reads on the
   * other two platforms; `/etc/machine-id` is the fallback, and it is what survives an OS
   * reinstall rather than a firmware change.
   */
  const dmi = read('/sys/class/dmi/id/product_uuid').toLowerCase();
  if (UUID.test(dmi) && !PLACEHOLDERS.has(dmi)) return dmi;
  return read('/etc/machine-id');
}

/*
 * Only the detection is remembered. The override is read on every call, because it comes
 * from the environment and a cached answer would ignore it for the life of the process -
 * which is also what makes it testable.
 */
let detected;

/** The digest of this host's identifier, computed at most once. */
function detectedId() {
  if (detected === undefined) {
    const raw = detect();
    detected = raw === '' ? '' : createHash('sha256').update(raw).digest('hex');
  }
  return detected;
}

/**
 * The value for the machine header.
 *
 * @param {NodeJS.ProcessEnv} [env] - read for the override; `process.env` by default.
 * @returns {string} a hex digest, or '' when this host has no identifier to hash.
 */
export function machineId(env = process.env) {
  const override = typeof env.DEEPAI_MACHINE_ID === 'string' ? env.DEEPAI_MACHINE_ID.trim() : '';
  // Sent as given rather than hashed: an operator who sets this is naming the machine this
  // gateway stands in for, which may be one the server already knows.
  return override === '' ? detectedId() : override;
}

/**
 * The machine header, for spreading into a request's headers.
 *
 * Empty when this host has no identifier, which is what the app does too: the header is
 * omitted rather than sent blank, and the server answers `machine_required` to say so.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Record<string, string>}
 */
export function machineHeaders(env = process.env) {
  const id = machineId(env);
  return id === '' ? {} : { [MACHINE_HEADER]: id };
}
