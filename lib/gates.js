// 「本对话启用/停用」的宿主实现。
//
// 平台事实（实测确认）：
//   ctx.tools.restrict({ deny }) 只对**调用者所在的 agent scope** 生效，
//   多次 restrict 会取交集（只能加严、不能放松），未知名字会抛错，
//   scope 内注册的工具（preset 自带）不受影响。
// 因此这里为每个活动会话持有一个 disposer：策略变化时先撤销旧的、再按新策略重新 restrict，
// 并在 agent/disposed 时撤销，避免泄漏到下一个复用同一 id 的 Agent。
import { mkdir, readdir, readFile, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { detectToolOwners } from './toolmap.js'

const POLICIES_DIR = 'sessions'
const OWNERS_TTL_MS = 60 * 1000
const SELF_MODULE = 'dsh-plugin-steward'

function safeFileId(sessionId) {
  return String(sessionId).replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 120)
}

/** mcp 工具名 `mcp__<server>__<tool>` → server；不是这种形状返回 null */
export function mcpServerOf(toolName) {
  if (typeof toolName !== 'string' || !toolName.startsWith('mcp__')) return null
  const rest = toolName.slice(5)
  const index = rest.indexOf('__')
  if (index <= 0) return null
  return rest.slice(0, index)
}

export function createSessionGates(options) {
  const { ctx, consoleDir } = options
  /** @type {Map<string, { disposers: unknown[], deny: string[], appliedAt: string|null, error: string|null }>} */
  const live = new Map()
  let ownersCache = null
  let ownersAt = 0

  const serviceOf = name => {
    try {
      return ctx.get(name)
    } catch {
      return undefined
    }
  }

  async function toolsService() {
    return serviceOf('tools')
  }

  async function agentsService() {
    return serviceOf('agents')
  }

  async function liveToolNames() {
    const tools = await toolsService()
    if (tools === undefined || typeof tools.schemas !== 'function') return []
    try {
      const schemas = tools.schemas()
      return (Array.isArray(schemas) ? schemas : []).map(schema => schema?.name).filter(name => typeof name === 'string')
    } catch {
      return []
    }
  }

  async function policiesDir() {
    const dir = join(await consoleDir(), POLICIES_DIR)
    await mkdir(dir, { recursive: true })
    return dir
  }

  function policyPath(dir, sessionId) {
    return join(dir, `${safeFileId(sessionId)}.json`)
  }

  async function readPolicy(sessionId) {
    const dir = await policiesDir()
    try {
      const raw = JSON.parse(await readFile(policyPath(dir, sessionId), 'utf8'))
      return {
        disabled: Array.isArray(raw?.disabled) ? raw.disabled.filter(value => typeof value === 'string') : [],
        disabledMcp: Array.isArray(raw?.disabledMcp) ? raw.disabledMcp.filter(value => typeof value === 'string') : [],
        updatedAt: typeof raw?.updatedAt === 'string' ? raw.updatedAt : null,
      }
    } catch {
      return { disabled: [], disabledMcp: [], updatedAt: null }
    }
  }

  async function writePolicy(sessionId, policy) {
    const dir = await policiesDir()
    await writeFile(policyPath(dir, sessionId), `${JSON.stringify(policy, null, 2)}\n`, 'utf8')
  }

  async function listPolicyFiles() {
    const dir = await policiesDir()
    try {
      return (await readdir(dir)).filter(name => name.endsWith('.json'))
    } catch {
      return []
    }
  }

  /** 工具归属（带 60s 缓存）；参数来自 index.js 的目录扫描结果 */
  async function ensureOwners(catalog) {
    const now = Date.now()
    if (ownersCache !== null && now - ownersAt < OWNERS_TTL_MS) return ownersCache
    const names = await liveToolNames()
    const official = []
    const packages = []
    for (const row of catalog?.rows ?? []) {
      const patchId = typeof row?.patchId === 'string' ? row.patchId : ''
      if (patchId.startsWith('tool-')) official.push(...officialToolNames(row, names))
    }
    for (const bundle of catalog?.installedBundles ?? []) {
      const name = bundle?.name
      if (typeof name !== 'string' || name.length === 0) continue
      if (name.startsWith('@deepseek-ai/')) continue // 官方包不进第三方归属
      if (name === SELF_MODULE) continue // 自己不是"插件"，别把内建工具认领走
      packages.push(name)
    }
    // 归属判定只看"可能属于插件"的工具：MCP 工具按 server 分组，内建工具排除
    const candidates = names.filter(name => mcpServerOf(name) === null && !isBuiltinTool(name))
    ownersCache = await detectToolOwners({
      profileDir: await options.profileDir(),
      packageNames: packages,
      liveNames: candidates,
      officialNames: [...officialToolSet.always, ...official],
    })
    ownersAt = now
    return ownersCache
  }

  /**
   * 官方工具行（patchId = tool-fs / tool-bash …）对应的工具名。
   * 平台没有把「行 → 工具名」直接暴露出来，这里用行名与工具名做保守匹配：
   * 只把「行名后缀能解释」的工具算作官方，其余仍参与第三方探测。
   */
  function officialToolNames(row, names) {
    const patchId = typeof row?.patchId === 'string' ? row.patchId.slice(5) : ''
    if (patchId.length === 0) return []
    const hyphens = patchId.replace(/-/g, '_')
    const first = patchId.split('-')[0]
    const matched = names.filter(name => name === hyphens || name === first || name.startsWith(`${first}_`))
    return matched
  }

  const officialToolSet = {
    // 兜底：无论启发式是否命中，这些名字永远算内建，避免第三方插件「认领」它们
    always: new Set([
      'read', 'write', 'edit', 'grep', 'glob', 'pwsh', 'bash', 'job_output', 'job_list', 'job_kill',
      'web_search', 'web_fetch', 'skill', 'todo_write', 'working_directory', 'subagent', 'subagent_fork',
      'send_message', 'interrupt_agent', 'wait_agent', 'list_agents', 'spawn_teammate', 'team_task_create',
      'team_task_get', 'team_task_list', 'team_task_update', 'workflow', 'read_image', 'cordis_inspect_list',
      'cordis_inspect_query', 'load_workspace_dependencies', 'create_goal', 'get_goal', 'update_goal',
      'schedule_create', 'schedule_delete', 'schedule_list', 'schedule_update', 'present', 'ask_user_question',
      'list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource', 'list_versions',
    ]),
  }

  function isBuiltinTool(toolName) {
    return officialToolSet.always.has(toolName)
  }

  function isOfficialTool(toolName) {
    return officialToolSet.always.has(toolName)
  }

  /** 撤销某会话上的限制 */
  function revoke(sessionId) {
    const entry = live.get(String(sessionId))
    if (entry === undefined) return false
    for (const disposer of entry.disposers) {
      try {
        if (typeof disposer === 'function') disposer()
      } catch {
        // 撤销失败不影响后续重建
      }
    }
    live.delete(String(sessionId))
    return true
  }

  function revokeAll() {
    for (const id of [...live.keys()]) revoke(id)
  }

  /** 把策略落到某个活动会话上；返回实际拦截的工具名 */
  async function apply(sessionId, catalog) {
    const id = String(sessionId)
    revoke(id)
    const agents = await agentsService()
    const agent = agents !== undefined && typeof agents.get === 'function' ? agents.get(id) : undefined
    const agentCtx = agent?.ctx
    if (agentCtx === undefined || agentCtx?.tools === undefined) {
      live.set(id, { disposers: [], deny: [], appliedAt: null, error: '会话当前不在运行中（下次进入对话时自动生效）' })
      return { applied: false, denied: [], error: '会话当前不在运行中（下次进入对话时自动生效）' }
    }
    const policy = await readPolicy(id)
    if (policy.disabled.length === 0 && policy.disabledMcp.length === 0) {
      live.set(id, { disposers: [], deny: [], appliedAt: new Date().toISOString(), error: null })
      return { applied: true, denied: [], error: null }
    }
    const owners = await ensureOwners(catalog)
    const names = new Set(await liveToolNames())
    const deny = new Set()
    for (const pkg of policy.disabled) {
      for (const tool of owners.packageToTools[pkg] ?? []) {
        if (names.has(tool) && !isOfficialTool(tool)) deny.add(tool)
      }
    }
    for (const server of policy.disabledMcp) {
      for (const tool of names) {
        if (mcpServerOf(tool) === server) deny.add(tool)
      }
    }
    if (deny.size === 0) {
      live.set(id, { disposers: [], deny: [], appliedAt: new Date().toISOString(), error: null })
      return { applied: true, denied: [], error: null }
    }
    try {
      const disposer = agentCtx.tools.restrict({ deny: [...deny] })
      live.set(id, {
        disposers: [disposer],
        deny: [...deny],
        appliedAt: new Date().toISOString(),
        error: null,
      })
      return { applied: true, denied: [...deny], error: null }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      live.set(id, { disposers: [], deny: [...deny], appliedAt: null, error: message })
      return { applied: false, denied: [...deny], error: message }
    }
  }

  /** 对当前所有活动会话重新应用（启动、目录变化、策略变化时调用） */
  async function applyAll(catalog) {
    const agents = await agentsService()
    if (agents === undefined || typeof agents.list !== 'function') return []
    const results = []
    for (const agent of agents.list()) {
      const id = agent?.id
      if (typeof id !== 'string') continue
      results.push({ sessionId: id, ...(await apply(id, catalog)) })
    }
    return results
  }

  /** 给 UI 用：某会话可切换的「组」= 有工具的插件 + MCP 服务器 */
  async function describe(sessionId, catalog) {
    const owners = await ensureOwners(catalog)
    const names = await liveToolNames()
    const policy = await readPolicy(sessionId)
    const disabled = new Set(policy.disabled)
    const disabledMcp = new Set(policy.disabledMcp)

    const labelOf = new Map()
    for (const bundle of catalog?.bundles ?? []) {
      const name = bundle?.name
      if (typeof name === 'string') labelOf.set(name, bundle?.meta?.title ?? bundle?.description ?? name)
    }

    const groups = []
    for (const [pkg, tools] of Object.entries(owners.packageToTools)) {
      const visible = tools.filter(tool => names.includes(tool))
      if (visible.length === 0) continue
      groups.push({
        kind: 'plugin',
        id: `pkg:${pkg}`,
        packageName: pkg,
        label: labelOf.get(pkg) ?? pkg,
        tools: visible,
        disabled: disabled.has(pkg),
        inferred: true,
      })
    }
    groups.sort((a, b) => b.tools.length - a.tools.length || a.label.localeCompare(b.label))

    const byServer = new Map()
    for (const tool of names) {
      const server = mcpServerOf(tool)
      if (server === null) continue
      if (!byServer.has(server)) byServer.set(server, [])
      byServer.get(server).push(tool)
    }
    const mcp = [...byServer.entries()].map(([server, tools]) => ({
      kind: 'mcp',
      id: `mcp:${server}`,
      server,
      label: `MCP · ${server}`,
      tools: tools.sort(),
      disabled: disabledMcp.has(server),
    }))

    const entry = live.get(String(sessionId))
    const agents = await agentsService()
    const agent = agents !== undefined && typeof agents.get === 'function' ? agents.get(String(sessionId)) : undefined
    return {
      sessionId: String(sessionId),
      live: agent !== undefined,
      policy,
      groups,
      mcp,
      stats: {
        visibleTools: names.length,
        ownedTools: names.filter(name => owners.toolToPackage[name] !== undefined).length,
        denied: entry?.deny ?? [],
        appliedAt: entry?.appliedAt ?? null,
        error: entry?.error ?? null,
      },
      owners: {
        scannedAt: owners.scannedAt,
        scannedPackages: owners.scannedPackages,
        ambiguous: owners.ambiguous,
      },
    }
  }

  async function setPolicy(sessionId, next, catalog) {
    const policy = {
      disabled: [...new Set((next?.disabled ?? []).filter(value => typeof value === 'string'))].sort(),
      disabledMcp: [...new Set((next?.disabledMcp ?? []).filter(value => typeof value === 'string'))].sort(),
      updatedAt: new Date().toISOString(),
    }
    await writePolicy(sessionId, policy)
    const applied = await apply(sessionId, catalog)
    return { policy, applied }
  }

  async function forget(sessionId) {
    revoke(sessionId)
    const dir = await policiesDir()
    await rm(policyPath(dir, sessionId), { force: true })
    return true
  }

  return {
    apply,
    applyAll,
    revoke,
    revokeAll,
    describe,
    setPolicy,
    readPolicy,
    forget,
    listPolicyFiles,
    ensureOwners,
    liveToolNames,
  }
}
