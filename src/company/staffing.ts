// ── 候选岗位发布 / 员工上岗（FADE-004 执行体，daemon 单执行体）──
// 协议依据：TriMetaverse/docs/execution/clone-dispatch-protocol.md（岗位-员工分离：
// md 岗位说明 = JD；上岗 = JD 进入在岗名册；分身 spawn 是另一层 HC 流程）。
// 链路：settings 勾选（或开业装配发布候选）→ onboard 登记（runId/pending-cho）→
// CHO 审批（decide）→ 名册写入（CompanyInitState.employees）+ 审计 json → 终态。

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export interface StaffingDeps {
  dataDir: string;
  companyState: { load(): Promise<any>; save(next: any): Promise<any> };
  chain: { getState(): string };
  getRoleCatalog: () => any;
  publish: (event: any) => void;
}

interface StaffingRequest {
  requestId: string;
  runId: string;
  roleId: string;
  displayName: string;
  employeeName?: string; // CEO 勾选时输入的员工名（审批通过后写入名册）
  requester: string;
  requestedAt: string;
  status: 'pending-cho' | 'approved' | 'rejected';
  decidedAt?: string;
  approver?: string;
  approverRole?: string;
  note?: string;
}

const RID = () => `staffing_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

async function loadRequests(dataDir: string): Promise<StaffingRequest[]> {
  try {
    const raw = await readFile(resolve(dataDir, 'staffing', 'requests.json'), 'utf-8');
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

async function saveRequests(dataDir: string, list: StaffingRequest[]): Promise<void> {
  const dir = resolve(dataDir, 'staffing');
  await mkdir(dir, { recursive: true });
  await writeFile(resolve(dir, 'requests.json'), JSON.stringify(list, null, 2), 'utf-8');
}

/** GET roster：13 岗 JD 全集 + 在岗（开业选定/后补上岗）+ 待审。 */
export async function getStaffingRoster(deps: StaffingDeps) {
  const catalog = deps.getRoleCatalog();
  const company = await deps.companyState.load();
  const requests = await loadRequests(deps.dataDir);
  const active = new Map<string, any>((company.employees ?? []).map((e: any) => [e.role, e]));
  const pending = new Map<string, StaffingRequest>(
    requests.filter((r) => r.status === 'pending-cho').map((r) => [r.roleId, r]),
  );
  const roles: any[] = catalog?.roles ?? [];
  const roster = roles.map((r: any) => {
    const emp = active.get(r.roleId);
    const req = pending.get(r.roleId);
    return {
      roleId: r.roleId,
      displayName: r.displayName ?? r.roleName ?? r.roleId, // 岗位中文名（roster displayName，JD 层）
      role: r.roleName ?? r.role ?? r.roleId,
      description: r.oneLinePositioning ?? r.description ?? '',
      // CEO 2026-08-18：个人名是开业/上岗时赋予的实例属性——未在岗一律 null（呈现「无名字」），
      // 不从 TriCompany roster 默认名带出（岗位=固定资产，名字=流动资产，见 clone-dispatch §1.2）。
      employeeName: emp?.name ?? null,
      instanceName: r.instanceName ?? null, // 起名默认建议（JD 登记层遗留参考）
      status: emp ? 'active' : req ? 'pending-cho' : 'candidate',
      onboardedAt: company.onboardedAt ?? null,
      requestId: req?.requestId ?? null,
    };
  });
  return {
    chainState: deps.chain.getState(),
    companyState: company.state,
    roster,
    counts: {
      total: roster.length,
      active: roster.filter((x) => x.status === 'active').length,
      pending: roster.filter((x) => x.status === 'pending-cho').length,
    },
  };
}

/** POST onboard：开业后勾选候选 → 登记 pending-cho 请求（CHO 审批门）。 */
export async function requestOnboarding(deps: StaffingDeps, roleId: string, requester: string, employeeName?: string) {
  const chainState = deps.chain.getState();
  if (chainState !== 'ready' && chainState !== 'confirm' && chainState !== 'sync') {
    return { status: 409, error: 'chain_state_gate', message: `链态 ${chainState} 不可上岗（开业完成后才允许增员）` };
  }
  const catalog = deps.getRoleCatalog();
  if (!catalog) return { status: 503, error: 'role_catalog_unavailable', message: '员工名册未加载' };
  const role = (catalog.roles ?? []).find((r: any) => r.roleId === roleId);
  if (!role) return { status: 404, error: 'role_not_found', message: `候选岗位不存在: ${roleId}` };
  const company = await deps.companyState.load();
  if ((company.employees ?? []).some((e: any) => e.role === roleId)) {
    return { status: 409, error: 'already_active', message: `${roleId} 已在岗` };
  }
  const requests = await loadRequests(deps.dataDir);
  if (requests.some((r) => r.roleId === roleId && r.status === 'pending-cho')) {
    return { status: 409, error: 'already_pending', message: `${roleId} 已有待审请求` };
  }
  const req: StaffingRequest = {
    requestId: RID(),
    runId: RID(),
    roleId,
    displayName: role.displayName ?? roleId,
    requester: requester || 'ceo-panel',
    employeeName: (employeeName ?? '').trim() || undefined,
    requestedAt: new Date().toISOString(),
    status: 'pending-cho',
  };
  requests.push(req);
  await saveRequests(deps.dataDir, requests);
  deps.publish({ type: 'init:staffing-request', roleId, requestId: req.requestId, displayName: req.displayName });
  return { status: 202, ok: true, requestId: req.requestId, runId: req.runId, statusText: 'pending-cho' };
}

/** POST decide：CHO 审批（approved → 名册写入 + 审计；rejected → 终态记录）。 */
export async function decideOnboarding(
  deps: StaffingDeps,
  requestId: string,
  decision: 'approved' | 'rejected',
  approver: string,
  note?: string,
) {
  const requests = await loadRequests(deps.dataDir);
  const req = requests.find((r) => r.requestId === requestId && r.status === 'pending-cho');
  if (!req) return { status: 404, error: 'request_not_found', message: `待审请求不存在: ${requestId}` };
  const CHO_ALLOWED = ['cho', 'chief-human-resources-officer', 'ceo', 'panel-cho'];
  if (!CHO_ALLOWED.includes((approver || '').toLowerCase())) {
    return { status: 403, error: 'cho_gate', message: `审批人必须是 CHO（收到: ${approver}）` };
  }
  req.status = decision;
  req.decidedAt = new Date().toISOString();
  req.approver = approver;
  req.approverRole = 'ChiefHumanResourcesOfficer';
  req.note = note ?? '';
  await saveRequests(deps.dataDir, requests);

  if (decision === 'approved') {
    const company = await deps.companyState.load();
    const employees = [...(company.employees ?? [])];
    if (!employees.some((e: any) => e.role === req.roleId)) {
      employees.push({ role: req.roleId, name: req.employeeName || req.displayName });
    }
    await deps.companyState.save({ ...company, employees });
    // 审计 json（对齐 CHO-clone-staffing 形态）
    const audit = {
      requestType: 'STAFFING_ONBOARDING_APPROVAL',
      approver: req.approver,
      approverRole: req.approverRole,
      decision: 'APPROVED',
      employee: { roleId: req.roleId, displayName: req.displayName },
      requester: req.requester,
      runId: req.runId,
      note: req.note,
      conditions: ['岗位 JD 单一真源（TriCompany 合同）；分身 spawn 走 clone-dispatch 协议另批'],
      auditAt: req.decidedAt,
    };
    const dir = resolve(deps.dataDir, 'staffing');
    await mkdir(dir, { recursive: true });
    await writeFile(resolve(dir, `CHO-staffing-${req.requestId}.json`), JSON.stringify(audit, null, 2), 'utf-8');
    deps.publish({ type: 'init:staffing-approved', roleId: req.roleId, requestId, displayName: req.displayName });
  } else {
    deps.publish({ type: 'init:staffing-rejected', roleId: req.roleId, requestId });
  }
  return { status: 200, ok: true, decision, requestId, runId: req.runId };
}
