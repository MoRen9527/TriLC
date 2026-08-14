// ── Project Registry（注册点）──
// design-v2 §③ 落地（i3-1 拆解 §一，schema 先行冻结供 I4 并行）：
//
//   落点   = %LOCALAPPDATA%\trilc\project-registry.json（固定路径，不随
//            TRILC_DATA_DIR 覆盖——测试隔离读共享注册点只读无害，写入仅
//            daemon 单主体）。TRILC_PROJECT_REGISTRY env 仅供测试隔离
//            （r19 教训同款：生产无此 env 时恒为固定路径）。
//   写契约 = 真 tmp→rename 原子写 + 校验读回（init-chain.ts 同款，不复刻
//            init-state.ts 假原子写缺陷）。
//   读取   = 惰性清理：worktrees 逐项 existsSync(path) + gitdir 双校验，
//            无效项登记移除、不删磁盘 worktree（幽灵路径 = 物理资产保留，
//            重新打开可重新认领，design-v2 §六）。
//   主键   = worktrees 以「绝对路径 + gitdir」为主键；同键重复 = 幂等刷新，
//            键冲突（同路径异 gitdir / 异路径同 gitdir）= 拒绝（git 原生 +
//            注册点双重，i3-1 §一）。
//   缓存   = 内存态帧（daemon 热更新源：写后同请求内可见，无独立热更新端点）。
//
// 项目仓注册表（design-v2 §⑥）与注册点合并同文件：projects = project-key →
// { repoUrl, mainCheckoutPath, hasNpmFileDeps, defaultBranch, worktrees[] }。
// MVP 单项目 = daemon 内置预置表（TriMetaverse 常量）+ 文件承载运行态
// （mainCheckoutPath / worktrees 动态登记）；配置层 UI 与公司级默认清单
// （TriCompany 中央 registry 发布）归后续树（design-v2 §⑥ 预留结构不变）。

import { mkdir, readFile, writeFile, rename, access } from 'node:fs/promises';
import { resolve, dirname, normalize } from 'node:path';
import { existsSync } from 'node:fs';

// ── Types（schema 按 i3-1 §一冻结）──

export interface RegistryWorktreeEntry {
  /** worktree 绝对路径（主键之一）。 */
  path: string;
  /** gitdir 绝对路径（主键之二；git rev-parse --absolute-git-dir 实测值）。 */
  gitdir: string;
  branch: string;
  claimedAt: string;
}

export interface RegistryProjectEntry {
  repoUrl: string;
  /** 主检出绝对路径（动态登记；null = 尚未登记）。MVP 单主检出，多主检出归后续树。 */
  mainCheckoutPath: string | null;
  hasNpmFileDeps: boolean;
  defaultBranch: string;
  worktrees: RegistryWorktreeEntry[];
}

export interface ProjectRegistryFile {
  schemaVersion: 1;
  /** 焦点项目（design-v2 §2.7）：link/claim 成功即置 active；MVP 单项目无歧义。 */
  activeProjectKey: string | null;
  projects: Record<string, RegistryProjectEntry>;
}

// ── 内置预置表（MVP 单项目 = daemon 常量，i3-1 §一）──

export const BUILTIN_PROJECTS: Record<
  string,
  Pick<RegistryProjectEntry, 'repoUrl' | 'hasNpmFileDeps' | 'defaultBranch'>
> = {
  trimetaverse: {
    repoUrl: 'https://github.com/MoRen9527/TriMetaverse.git',
    hasNpmFileDeps: false,
    defaultBranch: 'dev',
  },
};

export function defaultRegistryFile(): ProjectRegistryFile {
  const projects: Record<string, RegistryProjectEntry> = {};
  for (const [key, preset] of Object.entries(BUILTIN_PROJECTS)) {
    projects[key] = { ...preset, mainCheckoutPath: null, worktrees: [] };
  }
  return { schemaVersion: 1, activeProjectKey: null, projects };
}

// ── 固定落点 ──

/** 固定路径：%LOCALAPPDATA%\trilc\project-registry.json（不随 TRILC_DATA_DIR 覆盖）。 */
export function defaultRegistryPath(): string {
  const localAppData = process.env.LOCALAPPDATA ?? process.env.HOME ?? process.env.TMPDIR ?? '/tmp';
  return resolve(localAppData, 'trilc', 'project-registry.json');
}

// ── ProjectRegistry ──

export class ProjectRegistry {
  private registryPath: string;
  private cache: ProjectRegistryFile | null = null;

  constructor(opts?: { registryPath?: string }) {
    // TRILC_PROJECT_REGISTRY 仅测试隔离用；生产无此 env → 恒固定路径。
    this.registryPath = opts?.registryPath ?? process.env.TRILC_PROJECT_REGISTRY ?? defaultRegistryPath();
  }

  get path(): string {
    return this.registryPath;
  }

  /**
   * 读取（含惰性清理）+ 内存态缓存。ENOENT（首次启动正常缺失）= 默认帧
   * （预置表 + 空运行态），不产噪音日志；JSON 解析错 = console.error + 默认帧
   * （daemon 不因注册点损坏崩溃）。
   */
  async load(): Promise<ProjectRegistryFile> {
    if (this.cache) return this.cache;
    let raw: string;
    try {
      await access(this.registryPath);
      raw = await readFile(this.registryPath, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error(`[trilc:project] registry load access failed: ${(err as Error).message}`);
      }
      this.cache = defaultRegistryFile();
      return this.cache;
    }
    let parsed: Partial<ProjectRegistryFile>;
    try {
      parsed = JSON.parse(raw) as Partial<ProjectRegistryFile>;
    } catch (err) {
      console.error(`[trilc:project] registry parse failed — default frame: ${(err as Error).message}`);
      this.cache = defaultRegistryFile();
      return this.cache;
    }
    // 帧补齐：预置表默认 + 文件承载运行态（i3-1 §一）。repoUrl 恒以预置为准
    // （白名单完整性——注册点文件不可改白名单 URL）；hasNpmFileDeps / defaultBranch
    // 以预置为默认、文件显式值时覆盖（现场纠偏安全阀，如 INCIDENT 类仓临时上锁）；
    // mainCheckoutPath / worktrees 为动态登记。
    const projects: Record<string, RegistryProjectEntry> = {};
    for (const key of Object.keys(BUILTIN_PROJECTS)) {
      const preset = BUILTIN_PROJECTS[key];
      const dynamic = parsed.projects?.[key];
      projects[key] = {
        repoUrl: preset.repoUrl,
        hasNpmFileDeps:
          typeof dynamic?.hasNpmFileDeps === 'boolean' ? dynamic.hasNpmFileDeps : preset.hasNpmFileDeps,
        defaultBranch:
          typeof dynamic?.defaultBranch === 'string' ? dynamic.defaultBranch : preset.defaultBranch,
        mainCheckoutPath: typeof dynamic?.mainCheckoutPath === 'string' ? dynamic.mainCheckoutPath : null,
        worktrees: Array.isArray(dynamic?.worktrees)
          ? (dynamic.worktrees as RegistryWorktreeEntry[])
          : [],
      };
    }
    this.cache = {
      schemaVersion: 1,
      activeProjectKey: typeof parsed.activeProjectKey === 'string' ? parsed.activeProjectKey : null,
      projects,
    };
    // 惰性清理：幽灵路径只登记移除，不删磁盘（design-v2 §六）
    const cleaned = await this.lazyCleanup(this.cache);
    if (cleaned) {
      try {
        await this.persist(this.cache);
      } catch (err) {
        // 清理持久失败不阻塞读取（内存态已清理；下次读重试）
        console.error(`[trilc:project] lazy cleanup persist failed: ${(err as Error).message}`);
      }
    }
    return this.cache;
  }

  /** 内存态帧快照（daemon 热更新读源；需先 load）。 */
  getSnapshot(): ProjectRegistryFile {
    if (!this.cache) throw new Error('ProjectRegistry not loaded — call load() first');
    return JSON.parse(JSON.stringify(this.cache)) as ProjectRegistryFile;
  }

  /**
   * 登记 worktree（主键去重：绝对路径 + gitdir）。
   * - 同键重复 = 幂等刷新（branch/claimedAt 更新；认领绝不重复 add 的登记面）；
   * - 键冲突（同路径异 gitdir / 异路径同 gitdir）= 拒绝；
   * - 成功即置 activeProjectKey = projectKey（焦点项目，MVP 单项目无歧义）。
   */
  async registerWorktree(
    projectKey: string,
    entry: { path: string; gitdir: string; branch: string; claimedAt?: string },
  ): Promise<ProjectRegistryFile> {
    const frame = await this.load();
    const project = frame.projects[projectKey];
    if (!project) throw new Error(`unknown project key: ${projectKey}`);
    const absPath = normalize(entry.path);
    const absGitdir = normalize(entry.gitdir);
    const claimedAt = entry.claimedAt ?? new Date().toISOString();
    const existing = project.worktrees.find(
      (wt) => normalize(wt.path) === absPath || normalize(wt.gitdir) === absGitdir,
    );
    if (existing && !(normalize(existing.path) === absPath && normalize(existing.gitdir) === absGitdir)) {
      throw new Error(
        `worktree primary-key conflict: path or gitdir already registered (path=${existing.path})`,
      );
    }
    if (existing) {
      existing.branch = entry.branch;
      existing.claimedAt = claimedAt;
    } else {
      project.worktrees.push({ path: absPath, gitdir: absGitdir, branch: entry.branch, claimedAt });
    }
    frame.activeProjectKey = projectKey;
    await this.persist(frame);
    return frame;
  }

  /** 登记移除（回滚 + git worktree list 交叉验证的幽灵项移除；不删磁盘）。 */
  async unregisterWorktree(projectKey: string, path: string): Promise<ProjectRegistryFile> {
    const frame = await this.load();
    const project = frame.projects[projectKey];
    if (!project) throw new Error(`unknown project key: ${projectKey}`);
    const absPath = normalize(path);
    const before = project.worktrees.length;
    project.worktrees = project.worktrees.filter((wt) => normalize(wt.path) !== absPath);
    if (project.worktrees.length === before) return frame; // 无变化不写盘
    await this.persist(frame);
    return frame;
  }

  /** 登记主检出（仅首次登记；多主检出归后续树）。 */
  async setMainCheckout(projectKey: string, mainCheckoutPath: string): Promise<ProjectRegistryFile> {
    const frame = await this.load();
    const project = frame.projects[projectKey];
    if (!project) throw new Error(`unknown project key: ${projectKey}`);
    if (!project.mainCheckoutPath) {
      project.mainCheckoutPath = normalize(mainCheckoutPath);
      await this.persist(frame);
    }
    return frame;
  }

  /** 按 worktree 路径查登记项（无则 null）。 */
  findWorktree(projectKey: string, path: string): RegistryWorktreeEntry | null {
    if (!this.cache) throw new Error('ProjectRegistry not loaded — call load() first');
    const project = this.cache.projects[projectKey];
    if (!project) return null;
    const absPath = normalize(path);
    return project.worktrees.find((wt) => normalize(wt.path) === absPath) ?? null;
  }

  /** 惰性清理：无效项（路径或 gitdir 不可见）登记移除；返回是否有变化。 */
  private async lazyCleanup(frame: ProjectRegistryFile): Promise<boolean> {
    let dirty = false;
    for (const project of Object.values(frame.projects)) {
      const valid: RegistryWorktreeEntry[] = [];
      for (const wt of project.worktrees) {
        const pathOk = existsSync(wt.path);
        const gitdirOk = existsSync(wt.gitdir);
        if (pathOk && gitdirOk) {
          valid.push(wt);
        } else {
          dirty = true;
          console.log(
            `[trilc:project] registry lazy cleanup: dropped ghost entry ${wt.path}（磁盘资产保留，可重新认领）`,
          );
        }
      }
      project.worktrees = valid;
    }
    return dirty;
  }

  /** 真 tmp→rename 原子写 + 校验读回（写坏即抛，不静默吞）。 */
  private async persist(frame: ProjectRegistryFile): Promise<void> {
    await mkdir(dirname(this.registryPath), { recursive: true });
    const tmp = `${this.registryPath}.tmp`;
    await writeFile(tmp, JSON.stringify(frame, null, 2), 'utf-8');
    await rename(tmp, this.registryPath);
    const readBack = JSON.parse(await readFile(this.registryPath, 'utf-8')) as ProjectRegistryFile;
    if (
      readBack.schemaVersion !== frame.schemaVersion ||
      readBack.activeProjectKey !== frame.activeProjectKey
    ) {
      throw new Error('project-registry persist verification failed: read-back mismatch');
    }
    this.cache = frame;
  }
}
