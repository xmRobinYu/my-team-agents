/**
 * P9d — execution isolation, the backend behind AC5.2.
 *
 * The contract this file implements was already declared and inert:
 * `RuntimeCapabilities.sandbox` had exactly one honest value for Pi (`"none"`)
 * because Pi's trust flag does not constrain tool access
 * (`runtime-core/src/adapter.ts`). A rule naming `bash` could therefore edit
 * anything the worker process could — including other projects and the SQLite
 * store. AC5.2 refused such rules outright, which was correct and incomplete: it
 * made a capability impossible rather than safe.
 *
 * This wraps the SAME argv the adapter already builds in a container, so Pi keeps
 * speaking JSONL over stdio and nothing above changes. What changes is what the
 * process can reach:
 *
 *   - only the run's workspace and persona dir are mounted, plus `models.json`
 *     read-only; the rest of the host filesystem does not exist in the namespace
 *   - root filesystem is read-only; the few writable paths are tmpfs
 *   - uid 1000, all capabilities dropped, `no-new-privileges`
 *   - pid/memory/cpu ceilings, so one runaway run cannot starve the host
 *   - mounts use the SAME absolute paths as the host, so `--session`,
 *     `--session-dir`, `--skill` and `--extension` keep working unrewritten
 *
 * Network is deliberately NOT `none` by default: the model endpoint is remote, so
 * an offline default would make every isolated run fail at the first token and the
 * "isolation" would then be measured only in its broken state.
 * `MTA_ISOLATION_NETWORK=none` is available for runs that genuinely need no egress;
 * architecture §9 records that egress is a policy knob, not a guarantee.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { handoffExtensionPath } from "./handoff-extension.js";

/** How long a probe may take before the answer is "unavailable", not "hanging". */
const PROBE_TIMEOUT_MS = 10_000;

export interface IsolationProbe {
  ok: boolean;
  /** `docker` when a daemon answered, `none` when isolation was never requested. */
  backend: "docker" | "none";
  /** Present when `ok` is false: what to tell an operator instead of guessing. */
  reason?: string;
  image?: string;
  daemonVersion?: string;
  /** True when a provider config will be visible inside the container. */
  modelsFileMounted?: boolean;
}

export interface IsolationLaunch {
  command: string;
  args: string[];
  containerName: string;
}

export interface IsolationWrapInput {
  args: string[];
  /** Working directory the runtime should start in (already resolved by the adapter). */
  cwd: string;
  workspacePath: string;
  agentDir?: string;
  runId: string;
}

/** What the adapter needs; kept narrow so a test can fake it without docker. */
export interface RunIsolation {
  readonly kind: "docker";
  readonly image: string;
  wrap(input: IsolationWrapInput): IsolationLaunch;
  /** Reap a hung container. Safe after a normal exit (`--rm` already removed it). */
  kill(runId: string): void;
}

export interface DockerIsolationOptions {
  image?: string;
  /** Docker binary. Defaults to PATH, then Docker Desktop's bundled CLI. */
  docker?: string;
  /** Hard ceilings, passed to docker verbatim so an operator can tune them. */
  memory?: string;
  cpus?: string;
  pidsLimit?: number;
  network?: string;
  /** Host path to Pi's provider config; mounted read-only when it exists. */
  modelsFile?: string;
  /** Absolute host path of the `handoff_to` extension, mounted read-only. */
  handoffExtension?: string;
  /** Test seam: replaces the real process spawn for `kill`. */
  exec?: (command: string, args: string[]) => void;
}

export const DEFAULT_ISOLATION_IMAGE = "mta-pi-sandbox:1";

/**
 * Docker Desktop installs its CLI outside PATH on macOS, and a worker started by an
 * IDE inherits an unhelpful PATH. Resolving explicitly turns "isolated runs fail
 * with ENOENT" into something that cannot happen silently.
 */
export function resolveDockerBin(env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = env.MTA_DOCKER_BIN?.trim();
  if (explicit) return existsSync(explicit) ? explicit : null;
  const onPath = spawnSync("docker", ["--version"], { timeout: PROBE_TIMEOUT_MS, stdio: "ignore" });
  if (!onPath.error && onPath.status === 0) return "docker";
  const desktop = "/Applications/Docker.app/Contents/Resources/bin/docker";
  return existsSync(desktop) ? desktop : null;
}

/** Container names must be [a-zA-Z0-9][a-zA-Z0-9_.-]*; run ids are uuids with prefixes. */
export function containerNameFor(runId: string): string {
  const safe = runId.replace(/[^a-zA-Z0-9_.-]/g, "-").replace(/^[-.]+/, "").slice(0, 48);
  return `mta-${safe === "" ? "run" : safe}`;
}

/**
 * A probe is a MEASUREMENT, not a config read: `MTA_ISOLATION=docker` with a dead
 * daemon must report `ok: false`, because that is the state where a writable-tool
 * rule would otherwise be accepted and then run unisolated.
 */
export function probeDockerIsolation(options: DockerIsolationOptions = {}): IsolationProbe {
  const image = options.image ?? DEFAULT_ISOLATION_IMAGE;
  const docker = options.docker ?? resolveDockerBin();
  if (!docker) {
    return { ok: false, backend: "docker", image,
      reason: "找不到 docker 可执行文件（PATH 与 Docker Desktop 默认路径都没有）" };
  }
  const version = spawnSync(docker, ["version", "--format", "{{.Server.Version}}"],
    { timeout: PROBE_TIMEOUT_MS, encoding: "utf8" });
  if (version.error || version.status !== 0) {
    const detail = (version.stderr ?? "").trim().split("\n")[0] ?? "";
    return { ok: false, backend: "docker", image, reason:
      `docker daemon 不可达${detail === "" ? "" : `：${detail}`}` };
  }
  const inspected = spawnSync(docker, ["image", "inspect", image, "--format", "{{.Id}}"],
    { timeout: PROBE_TIMEOUT_MS, encoding: "utf8" });
  if (inspected.error || inspected.status !== 0) {
    return { ok: false, backend: "docker", image,
      daemonVersion: version.stdout.trim(),
      reason: `镜像 ${image} 不存在（构建命令见 docs/architecture.md §6.8）` };
  }
  const modelsFile = options.modelsFile ?? join(homedir(), ".pi", "agent", "models.json");
  return { ok: true, backend: "docker", image,
    daemonVersion: version.stdout.trim(), modelsFileMounted: existsSync(modelsFile) };
}

export class DockerIsolation implements RunIsolation {
  readonly kind = "docker" as const;
  readonly image: string;
  private readonly docker: string;
  private readonly limits: Required<Pick<DockerIsolationOptions, "memory" | "cpus" | "pidsLimit" | "network">>;
  private readonly modelsFile: string;
  private readonly handoffExtension?: string;
  private readonly exec: (command: string, args: string[]) => void;

  constructor(options: DockerIsolationOptions = {}) {
    const docker = options.docker ?? resolveDockerBin();
    if (!docker) {
      throw new Error("DockerIsolation: 找不到 docker 可执行文件；"
        + "先设 MTA_DOCKER_BIN，或确认 Docker Desktop 已安装");
    }
    this.docker = docker;
    this.image = options.image ?? DEFAULT_ISOLATION_IMAGE;
    this.modelsFile = options.modelsFile ?? join(homedir(), ".pi", "agent", "models.json");
    this.limits = {
      memory: options.memory ?? "2g",
      cpus: options.cpus ?? "2",
      pidsLimit: options.pidsLimit ?? 512,
      network: options.network ?? "bridge",
    };
    if (options.handoffExtension !== undefined) this.handoffExtension = options.handoffExtension;
    this.exec = options.exec ?? ((command, args) => {
      // Fire-and-forget: reaping must never throw into a run that has already ended.
      spawnSync(command, args, { timeout: PROBE_TIMEOUT_MS, stdio: "ignore" });
    });
  }

  /**
   * Pure: builds argv only. `--rm` plus a deterministic `--name` means a crashed
   * worker leaves at most one container behind, and its name is derivable from the
   * attempt id instead of discoverable only by listing.
   */
  wrap(input: IsolationWrapInput): IsolationLaunch {
    const name = containerNameFor(input.runId);
    const args = [
      "run", "--rm", "-i", "--init",
      "--name", name,
      "--label", "mta.isolation=1",
      "--label", `mta.run=${name}`,
      // Privilege: nothing retained, nothing gained by execing a setuid binary.
      "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges",
      "--pids-limit", String(this.limits.pidsLimit),
      "--memory", this.limits.memory,
      "--memory-swap", this.limits.memory,
      "--cpus", this.limits.cpus,
      // Writable paths are exactly the mounts and the tmpfs below.
      "--read-only",
      "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,size=64m,mode=1777",
      "--tmpfs", "/home/node/.cache:rw,size=64m,mode=1777",
      // Pi writes sessions, auth cache and its own state under $HOME/.pi/agent.
      // This MUST be the tmpfs mountpoint itself: when the pi parent dir is left to
      // docker (it creates a file-mount target as root 0755), uid 1000 cannot
      // `mkdir sessions` there and every run dies with EACCES. Measured, not
      // assumed — the first version mounted the parent and failed exactly so.
      // mode=1777 is what makes it writable by the non-root user.
      "--tmpfs", "/home/node/.pi/agent:rw,nosuid,nodev,size=128m,mode=1777",
      "--user", "1000:1000",
      "--env", "HOME=/home/node",
      "--network", this.limits.network,
      "--workdir", input.cwd,
      // Same-path mounts: the adapter's argv (--session/-dir, --skill, --extension,
      // cwd) stays byte-identical because nothing has to be translated.
      "--volume", `${input.workspacePath}:${input.workspacePath}:rw`,
    ];
    if (input.agentDir && input.agentDir !== input.workspacePath) {
      args.push("--volume", `${input.agentDir}:${input.agentDir}:rw`);
    }
    if (existsSync(this.modelsFile)) {
      args.push("--volume", `${this.modelsFile}:/home/node/.pi/agent/models.json:ro`);
    }
    if (this.handoffExtension && existsSync(this.handoffExtension)) {
      args.push("--volume", `${this.handoffExtension}:${this.handoffExtension}:ro`);
    }
    args.push(this.image, "pi", ...input.args);
    return { command: this.docker, args, containerName: name };
  }

  kill(runId: string): void {
    this.exec(this.docker, ["kill", containerNameFor(runId)]);
  }
}

export interface IsolationSetup {
  /** null when the deployment never asked for isolation. */
  isolation: RunIsolation | null;
  probe: IsolationProbe;
  /**
   * The registration gate for AC5.2. `allowed` is true only when isolation was
   * requested AND measured working — never when it is merely configured.
   */
  writableTools: { allowed: boolean; reason?: string };
}

export function isolationFromEnv(env: NodeJS.ProcessEnv = process.env): IsolationSetup {
  const requested = (env.MTA_ISOLATION ?? "").trim();
  if (requested === "") {
    return {
      isolation: null,
      probe: { ok: false, backend: "none", reason: "MTA_ISOLATION 未设置：执行未隔离" },
      writableTools: { allowed: false, reason: "未启用执行隔离（MTA_ISOLATION 未设置）" },
    };
  }
  if (requested !== "docker") {
    const reason = `MTA_ISOLATION=${requested} 不是已知后端（只支持 docker）`;
    return { isolation: null, probe: { ok: false, backend: "none", reason },
      writableTools: { allowed: false, reason } };
  }
  const options: DockerIsolationOptions = {
    ...(env.MTA_ISOLATION_IMAGE ? { image: env.MTA_ISOLATION_IMAGE } : {}),
    ...(env.MTA_ISOLATION_MEMORY ? { memory: env.MTA_ISOLATION_MEMORY } : {}),
    ...(env.MTA_ISOLATION_CPUS ? { cpus: env.MTA_ISOLATION_CPUS } : {}),
    ...(env.MTA_ISOLATION_PIDS ? { pidsLimit: Number(env.MTA_ISOLATION_PIDS) } : {}),
    ...(env.MTA_ISOLATION_NETWORK ? { network: env.MTA_ISOLATION_NETWORK } : {}),
    ...(env.MTA_ISOLATION_MODELS_FILE ? { modelsFile: env.MTA_ISOLATION_MODELS_FILE } : {}),
  };
  const probe = probeDockerIsolation(options);
  if (!probe.ok) {
    return { isolation: null, probe,
      writableTools: { allowed: false, reason: probe.reason ?? "隔离后端不可用" } };
  }
  return {
    isolation: new DockerIsolation({
      // D1's extension is a host file the container cannot see otherwise. Same
      // path inside, so `--extension` needs no translation; a missing file is the
      // same hard error it is without isolation.
      handoffExtension: handoffExtensionPath(),
      ...options,
    }),
    probe,
    writableTools: { allowed: true },
  };
}
