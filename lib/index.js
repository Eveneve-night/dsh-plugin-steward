/**
 * 插件管家 · 宿主半
 *
 * 职责：
 *  1. 汇总"本机所有插件"的目录（bundle 级 + loader 行级），补齐标题/描述/版本/状态；
 *  2. 提供全局启停（bundle 用 setBundleEnabled，行用 setPluginEnabled）；
 *  3. 自动发现：定时扫描，把"新出现的插件"记成待认领，供 UI 打「新」徽章；
 *  4. 与能力面板类插件共存：只检测、只给跳转，不抢它们的 UI。
 *
 * 约定：宿主插件入口是 `export function apply(ctx)`；HTTP 路由挂在 webServer 上，
 * 客户端同源 fetch(`/plugin-console/api/...`)。不引第三方依赖，纯 node 内置模块。
 */
import { mkdir, readFile, writeFile, access } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createSessionGates } from './gates.js'
import { describePlugin } from './describe.js'

export const name = 'plugin-console'
export const inject = ['pluginManager', 'webServer']

const ROUTE_BASE = '/plugin-console/api'
const SCAN_INTERVAL_MS = 5 * 60 * 1000
const SELF_MODULE = 'dsh-plugin-steward'
const STATE_VERSION = 1

/** 能力面板类插件：我们只做"检测 + 跳转"，绝不重复实现它们的界面。 */
const PEER_PANELS = [
  { match: /(^|\/)dsh-capability-panel$/i, title: '能力面板', note: '技能的按会话开关、真实上下文状态由它显示' },
  { match: /(^|\/)dsh-capability-composer$/i, title: '能力编排器', note: '工具/技能/提示段的可见面收窄由它负责' },
  { match: /(^|\/)@super_camel\/dsh-plugin-panel$/i, title: '插件面板', note: '技能与 MCP 的会话级入口由它提供' },
]

/* ------------------------------------------------------------------ 状态存储 */

let cachedProfileDir

async function exists(target) {
  try {
    await access(target)
    return true
  } catch {
    return false
  }
}

/**
 * 找到当前 profile 目录。
 * 桌面版宿主进程并不设置 DSH_PROFILE_DIR，所以按可靠性依次尝试：
 *   1. 环境变量 DSH_PROFILE_DIR（CLI / 测试环境）
 *   2. 从 process.cwd() 向上找带 cordis.yml / cordis.patch.yml 的目录（桌面版 cwd 就是 profile 目录）
 *   3. 默认位置 ~/.dsh/profiles/<DSH_PROFILE|desktop>
 */
/**
 * profile 里实际被组装进来的 bundle 名单（package.json 的 dsh.profile.bundles）。
 * 用来分辨"这个 bundle 是否真的属于当前 profile"——app 安装目录里的可选包也会列出自己的行，
 * 但那些行的 entryId 常和基础包重名，不能只靠 entryId 判归属。
 */
let cachedProfileBundles
async function readProfileBundleNames() {
  if (cachedProfileBundles !== undefined) return cachedProfileBundles
  const profileDir = await resolveProfileDir()
  if (profileDir === null) {
    cachedProfileBundles = null
    return null
  }
  try {
    const raw = await readFile(path.join(profileDir, 'package.json'), 'utf8')
    const manifest = JSON.parse(raw)
    const list = manifest?.dsh?.profile?.bundles
    cachedProfileBundles = new Set(Array.isArray(list) ? list.map(item => String(item)) : [])
    return cachedProfileBundles
  } catch {
    cachedProfileBundles = null
    return null
  }
}

async function resolveProfileDir() {
  if (cachedProfileDir !== undefined) return cachedProfileDir

  const candidates = []
  if (typeof process.env.DSH_PROFILE_DIR === 'string' && process.env.DSH_PROFILE_DIR.length > 0) {
    candidates.push(process.env.DSH_PROFILE_DIR)
  }
  let dir = process.cwd()
  for (let depth = 0; depth < 6; depth += 1) {
    candidates.push(dir)
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  candidates.push(path.join(os.homedir(), '.dsh', 'profiles', process.env.DSH_PROFILE ?? 'desktop'))

  for (const candidate of candidates) {
    if (await exists(path.join(candidate, 'cordis.patch.yml')) || await exists(path.join(candidate, 'cordis.yml'))) {
      cachedProfileDir = candidate
      return candidate
    }
  }
  cachedProfileDir = null
  return null
}

async function stateFile() {
  const profileDir = await resolveProfileDir()
  if (profileDir === null) return null
  return path.join(profileDir, '.plugin-console', 'state.json')
}

/** 插件管家的数据目录（profile 下的 .plugin-console/）。 */
async function consoleDir() {
  const profileDir = await resolveProfileDir()
  if (profileDir === null) throw new Error('找不到 profile 目录')
  return path.join(profileDir, '.plugin-console')
}

function emptyState() {
  return {
    version: STATE_VERSION,
    knownBundles: [],
    knownRows: [],
    pendingBundles: [],
    pendingRows: [],
    lastScanAt: null,
    settings: { autoAck: false, aiTags: true },
  }
}

async function readState() {
  const file = await stateFile()
  if (file === null) return emptyState()
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'))
    if (parsed === null || typeof parsed !== 'object') return emptyState()
    return {
      ...emptyState(),
      ...parsed,
      knownBundles: Array.isArray(parsed.knownBundles) ? parsed.knownBundles : [],
      knownRows: Array.isArray(parsed.knownRows) ? parsed.knownRows : [],
      pendingBundles: Array.isArray(parsed.pendingBundles) ? parsed.pendingBundles : [],
      pendingRows: Array.isArray(parsed.pendingRows) ? parsed.pendingRows : [],
      settings: {
        autoAck: parsed?.settings?.autoAck === true,
        aiTags: parsed?.settings?.aiTags !== false,
      },
    }
  } catch {
    return emptyState()
  }
}

async function writeState(state) {
  const file = await stateFile()
  if (file === null) return
  try {
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  } catch {
    /* 写不进去不影响使用，只是"新插件"标记会重复出现 */
  }
}

/* -------------------------------------------------------------- 目录数据整理 */

function plainText(value) {
  if (typeof value === 'string') return value
  if (value === null || typeof value !== 'object') return null
  // LocalizedText = string | { en, zh, ... }
  for (const key of ['zh', 'zh-CN', 'zh-Hans', 'en']) {
    if (typeof value[key] === 'string' && value[key].length > 0) return value[key]
  }
  for (const candidate of Object.values(value)) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate
  }
  return null
}

/** 一个 loader 行（= 插件在组合中的一次实例化）。 */
function rowView(row) {
  const meta = row?.meta ?? {}
  const moduleName = String(row?.moduleName ?? row?.entryId ?? '')
  return {
    id: String(row?.entryId ?? row?.id ?? moduleName),
    patchId: row?.patchId ?? null,
    moduleName,
    title: plainText(meta.title) ?? moduleName,
    description: plainText(meta.description),
    icon: plainText(meta.icon),
    enabled: row?.enabled === true,
    phase: row?.fiberPhase ?? null,
    readOnlyReason: row?.readOnlyReason ?? null,
    toggleable: row?.readOnlyReason == null,
  }
}

/** 一个 bundle（= 用户通常所说的"一个插件"）。 */
function bundleView(bundle) {
  const meta = bundle?.meta ?? {}
  return {
    name: String(bundle?.name ?? ''),
    version: bundle?.version ?? null,
    title: plainText(meta.title) ?? String(bundle?.name ?? ''),
    description: plainText(meta.description) ?? bundle?.description ?? null,
    icon: plainText(meta.icon),
    official: bundle?.official === true,
    installed: bundle?.installed === true,
    enabled: bundle?.enabled === true,
    optional: bundle?.optional === true,
    removable: bundle?.removable === true,
    availability: bundle?.availability ?? null,
    readOnlyReason: bundle?.readOnlyReason ?? null,
    rowCount: Array.isArray(bundle?.rows) ? bundle.rows.length : 0,
    rows: Array.isArray(bundle?.rows) ? bundle.rows.map(rowView) : [],
  }
}

/** 内核常开：官方 bundle 且不可移除，或行上没有 patch 输入口。 */
function isAlwaysOn(bundle) {
  return bundle.official === true && bundle.removable !== true
}

/*
 * 描述兜底：很多插件没在 package.json 里写 description，列表里就只剩个包名。
 * 这时读它自己的 README / 源码 / 客户端注入点，让 describe.js 生成一句话（≤90 字）。
 * 作者自己写的描述永远优先；只有缺失时才补，并标上来源供用户判断可信度。
 */
const describeCache = new Map()
const DESCRIBE_TTL_MS = 10 * 60 * 1000

async function fillDescriptions(bundles) {
  const missing = bundles.filter(bundle =>
    bundle.installed === true
    && (bundle.description == null || String(bundle.description).trim().length === 0))
  if (missing.length === 0) return

  const profileDir = await resolveProfileDir()
  if (profileDir === null) return
  const now = Date.now()

  await Promise.all(missing.map(async (bundle) => {
    const cached = describeCache.get(bundle.name)
    let info
    if (cached !== undefined && now - cached.at < DESCRIBE_TTL_MS) {
      info = cached.info
    } else {
      try {
        info = await describePlugin({ profileDir, packageName: bundle.name })
      } catch {
        info = null
      }
      describeCache.set(bundle.name, { at: now, info })
    }
    if (info !== null && typeof info?.text === 'string' && info.text.length > 0) {
      bundle.description = info.text
      bundle.descriptionSource = info.source ?? null
      bundle.badges = Array.isArray(info.badges) ? info.badges : []
      bundle.slots = Array.isArray(info.slots) ? info.slots : []
    }
  }))
}

async function readCatalog(ctx) {
  const pm = ctx.get('pluginManager')
  if (pm === undefined) throw new Error('pluginManager 服务不可用')

  const [rawBundles, rawRows] = await Promise.all([pm.listBundles(), pm.listPlugins()])

  const bundles = (Array.isArray(rawBundles) ? rawBundles : []).map(bundleView)
  const rows = (Array.isArray(rawRows) ? rawRows : []).map(rowView)

  // 缺描述的插件：读它自己的 README/源码补一句话（作者写的描述优先）
  await fillDescriptions(bundles)

  // 已经记下来的 AI 中文标签（读不到就当没有，绝不因此让目录接口失败）
  try {
    const remembered = await readTags()
    for (const bundle of bundles) {
      const tag = remembered.entries[bundle.name]
      if (tag !== undefined && tag !== null) bundle.aiTag = tag
    }
  } catch {
    /* tags.json 坏掉不影响目录 */
  }

  // 行的归属：bundle.rows[].entryId 能对上的就归属该 bundle，否则算独立行。
  // profile 里真正组装进来的 bundle 优先认领（app 安装目录里的可选包会声明重名的 entryId）。
  const profileBundleNames = await readProfileBundleNames()
  const inProfile = bundle => profileBundleNames !== null && profileBundleNames.has(bundle.name)
  const ownerOrder = [...bundles].sort((a, b) => Number(inProfile(a)) - Number(inProfile(b)))
  const rowOwner = new Map()
  for (const bundle of ownerOrder) {
    for (const row of bundle.rows) {
      if (row.id) rowOwner.set(row.id, bundle.name)
    }
  }
  const bundleByName = new Map(bundles.map(bundle => [bundle.name, bundle]))
  for (const row of rows) {
    row.bundle = rowOwner.get(row.id) ?? null
    const owner = row.bundle === null ? undefined : bundleByName.get(row.bundle)
    // 装进 DSH 本体的模块（availability = installation）一律算"始终开启"，不给开关
    row.alwaysOn = owner !== undefined && (owner.availability === 'installation' || isAlwaysOn(owner))
  }

  const installedBundles = bundles.filter(b => b.installed)
  // 内核（始终开启）单独分区：既装在本体里（availability = installation）、又真的被当前 profile 组装进来的包。
  // 官方可选插件（experimental-* 等）即使在本体目录里，只要没进 profile 名单就不算内核。
  const kernel = bundles
    .filter(bundle => bundle.availability === 'installation' && inProfile(bundle))
    .map(bundle => {
      const rowIds = bundle.rows.map(row => row.id).filter(Boolean)
      return { bundle, rowIds }
    })
    .map(entry => ({
      name: entry.bundle.name,
      title: entry.bundle.title,
      version: entry.bundle.version,
      description: entry.bundle.description,
      descriptionSource: entry.bundle.descriptionSource ?? null,
      rowCount: entry.rowIds.length,
      rowIds: entry.rowIds,
    }))
  const peers = []
  for (const peer of PEER_PANELS) {
    const hit = installedBundles.find(b => peer.match.test(b.name)) ?? rows.find(r => peer.match.test(r.moduleName))
    if (hit !== undefined) peers.push({ title: peer.title, note: peer.note, packageName: hit.name ?? hit.moduleName })
  }

  return {
    bundles,
    rows,
    installedBundles,
    kernel,
    peers,
    profileBundles: profileBundleNames === null ? null : [...profileBundleNames],
  }
}

/** 诊断用：客户端半是否已被 web 启动图收录（面板按钮不出现时先看这里）。 */
function describeClientHalf(ctx) {
  const modules = ctx.get('clientModules')
  if (modules === undefined) return { available: false }
  try {
    const graph = modules.graph()
    const entry = (graph?.entries ?? []).find(item => item.id === SELF_MODULE)
    return {
      available: true,
      listed: entry !== undefined,
      entry: entry ?? null,
      path: modules.clientPath?.(SELF_MODULE) ?? null,
    }
  } catch (error) {
    return { available: true, error: error instanceof Error ? error.message : String(error) }
  }
}

/* ------------------------------------------------- 配置表单（自省 schemastery） */
/*
 * 平台的插件 Config 是 schemastery Schema：一个可调用对象，带 `.dict`（对象字段）、
 * `.meta`（default / description / required / volatile / min / max）和 `.toString()`
 * 的类型文本。不引入 schemastery 依赖，直接按这些信息生成表单描述：
 *   - dict 存在      → 逐个字段
 *   - "a" | "b"      → 下拉枚举
 *   - number/string/boolean → 对应控件
 *   - 其他（含数组、嵌套对象、联合） → JSON 文本域
 * 校验与持久化仍交给平台的 configEditor.edit()，我们不自己校验。
 */

const MAX_FIELDS = 240

function schemaText(schema) {
  try {
    return String(schema)
  } catch {
    return ''
  }
}

function schemaDict(schema) {
  try {
    const dict = schema?.dict
    if (dict === null || typeof dict !== 'object') return null
    const entries = dict instanceof Map ? Array.from(dict.entries()) : Object.entries(dict)
    return entries.length > 0 ? entries : null
  } catch {
    return null
  }
}

function jsonSafe(value) {
  if (value === undefined) return null
  try {
    const text = JSON.stringify(value)
    return text === undefined ? null : JSON.parse(text)
  } catch {
    return null
  }
}

function leafFromText(text) {
  if (text === 'string') return { kind: 'string' }
  if (text === 'number' || text === 'integer') return { kind: 'number' }
  if (text === 'boolean') return { kind: 'boolean' }
  if (text.endsWith('[]')) return { kind: 'json', typeText: text }
  const parts = text.split('|').map(part => part.trim()).filter(part => part.length > 0)
  if (parts.length > 1) {
    const literals = parts.map(part => /^"([^"]*)"$/.exec(part) ?? /^'([^']*)'$/.exec(part))
    if (literals.every(Boolean)) return { kind: 'enum', options: literals.map(match => match[1]) }
  }
  return { kind: 'json', typeText: text }
}

function describeField(key, schema) {
  const meta = (schema !== null && typeof schema === 'object' ? schema.meta : null) ?? {}
  const text = schemaText(schema)
  const shape = schemaDict(schema) === null ? leafFromText(text) : { kind: 'json', typeText: text }
  return {
    path: key,
    kind: shape.kind,
    options: shape.options ?? null,
    typeText: shape.typeText ?? text,
    description: typeof meta.description === 'string' ? meta.description : null,
    required: meta.required === true,
    volatile: meta.volatile === true,
    default: jsonSafe(meta.default),
    min: typeof meta.min === 'number' ? meta.min : null,
    max: typeof meta.max === 'number' ? meta.max : null,
  }
}

function describeConfig(config) {
  const fields = []
  const dict = schemaDict(config)
  if (dict === null) return fields
  for (const [key, child] of dict) {
    if (fields.length >= MAX_FIELDS) break
    fields.push(describeField(key, child))
  }
  return fields
}

/** 找 loader 入口 + 它的 Config + 当前显式配置。 */
function findConfigTarget(ctx, id) {
  const editor = ctx.get('configEditor')
  if (editor === undefined) return { error: 'configEditor 服务不可用' }
  const configuration = editor.configuration()
  const item = configuration.find(candidate => (candidate.entry?.id ?? '') === id)
  if (item === undefined) return { error: `找不到配置入口：${id}` }
  const entry = item.entry
  const namespace = entry?.moduleNamespace ?? {}
  const Config = namespace?.Config ?? namespace?.default?.Config
  return {
    editor,
    entry,
    Config,
    name: entry?.options?.name ?? entry?.name ?? null,
    patchId: entry?.options?.id ?? entry?.patchId ?? null,
    explicit: item.override ?? {},
    inherited: item.inherited ?? {},
    fields: Config === undefined ? [] : describeConfig(Config),
  }
}

/* --------------------------------------------------------------- 自动发现扫描 */

async function scan(ctx, options = {}) {
  const { bundles, rows } = await readCatalog(ctx)
  const state = await readState()

  const currentBundles = bundles.filter(b => b.installed).map(b => b.name)
  const currentRows = rows.map(r => r.id)

  const knownBundles = new Set(state.knownBundles)
  const knownRows = new Set(state.knownRows)
  const firstRun = state.knownBundles.length === 0 && state.knownRows.length === 0

  // 首次运行不制造 30 条"新插件"噪音：直接把当前状态记为已知
  const newBundles = firstRun ? [] : currentBundles.filter(n => !knownBundles.has(n))
  const newRows = firstRun ? [] : currentRows.filter(n => !knownRows.has(n))

  // 用户在设置页打开「自动纳入管理」后：新插件直接视为已知，不再要求点确认
  const autoAck = state.settings?.autoAck === true
  const autoAckedBundles = autoAck ? newBundles : []
  const autoAckedRows = autoAck ? newRows : []

  const next = {
    ...state,
    knownBundles: currentBundles,
    knownRows: currentRows,
    pendingBundles: autoAck ? [] : newBundles,
    pendingRows: autoAck ? [] : newRows,
    lastScanAt: new Date().toISOString(),
    firstScanAt: state.firstScanAt ?? new Date().toISOString(),
  }
  if (options.persist !== false) await writeState(next)

  const titleOf = (name) => bundles.find(b => b.name === name)?.title ?? name
  const titleOfRow = (id) => rows.find(r => r.id === id)?.title ?? id

  return {
    scannedAt: next.lastScanAt,
    firstRun,
    autoAck,
    newBundles: (autoAck ? [] : newBundles).map(n => ({ name: n, title: titleOf(n) })),
    newRows: (autoAck ? [] : newRows).map(n => ({ id: n, title: titleOfRow(n) })),
    autoAcked: [
      ...autoAckedBundles.map(n => ({ kind: 'bundle', name: n, title: titleOf(n) })),
      ...autoAckedRows.map(n => ({ kind: 'row', id: n, title: titleOfRow(n) })),
    ],
    knownCounts: { bundles: currentBundles.length, rows: currentRows.length },
  }
}

/* ------------------------------------------------------------------- HTTP 工具 */

function sendJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(`${JSON.stringify(body)}\n`)
}

async function readJson(req, limit = 64 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > limit) throw new Error('请求体过大')
    chunks.push(buffer)
  }
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/* --------------------------------------------------------------- AI 中文标签 */
/*
 * 可选能力（用户可在设置页关掉）：让模型读插件自己的信息——README、package.json、
 * 客户端注入点——给出一句中文标签：
 *     { label: "≤10 字名称", summary: "≤40 字一句话", tags: ["关键词", ...] }
 * 结果记在 <profile>/.plugin-console/tags.json，只有内容变了或用户点「重新生成」才重算，
 * 所以它是"记忆"的：刷新页面、重启 DSH 都还在。
 *
 * 模型调用走 host 的 `llm` 服务 + `agentDefaultModel` 的当前选择；两者都不可用时
 * 退化成"读 README 提炼"，并如实标注 source，不假装是模型给的。
 */

const MAX_MATERIAL_CHARS = 6000
const TAGS_CACHE_TTL_MS = 5 * 1000

let tagsCache = null
let tagsCacheAt = 0
let tagsModelSeen = null

async function tagsPath() {
  return path.join(await consoleDir(), 'tags.json')
}

function emptyTags() {
  return { version: 1, entries: {}, model: null }
}

async function readTags() {
  const now = Date.now()
  if (tagsCache !== null && now - tagsCacheAt < TAGS_CACHE_TTL_MS) return tagsCache
  let data = emptyTags()
  try {
    const parsed = JSON.parse(await readFile(await tagsPath(), 'utf8'))
    if (parsed !== null && typeof parsed === 'object' && parsed.entries !== null && typeof parsed.entries === 'object') {
      data = {
        version: 1,
        entries: { ...parsed.entries },
        model: typeof parsed.model === 'string' ? parsed.model : null,
      }
    }
  } catch {
    data = emptyTags()
  }
  tagsCache = data
  tagsCacheAt = now
  return data
}

async function writeTags(data) {
  const file = await tagsPath()
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
  tagsCache = data
  tagsCacheAt = Date.now()
}

async function readTextSafe(file, limit) {
  try {
    const text = await readFile(file, 'utf8')
    return text.slice(0, limit)
  } catch {
    return null
  }
}

const ZH_USAGE_HEADING = /^#{1,4}\s*(用法|使用说明|使用方法|怎么用|如何使用|使用方式|快速开始|快速上手|开始使用|入门)/im
const EN_USAGE_HEADING = /^#{1,4}\s*(usage|how to use|getting started|quick start|basic usage)/im

/** 把一段 README 里的 markdown 噪音去掉，只留能读的句子。 */
function cleanReadmeText(raw) {
  return raw
    .replace(/```[\s\S]*?```/g, '\n')
    .replace(/~~~[\s\S]*?~~~/g, '\n')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/<img[^>]*>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * 从 README 里摘一段「怎么用」：先找中文小标题，再找英文小标题，取紧随其后的几行。
 * 找不到就返回 null（不猜）。
 */
function extractUsageSection(cleaned) {
  for (const pattern of [ZH_USAGE_HEADING, EN_USAGE_HEADING]) {
    const match = pattern.exec(cleaned)
    if (match === null) continue
    const after = cleaned.slice(match.index + match[0].length)
    const lines = after
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length >= 4 && !/^#{1,6}\s/.test(line) && !line.startsWith('|') && !/^[-=_]{3,}$/.test(line))
      .map((line) => line.replace(/^[-*+]\s+/, '').replace(/^\d+[.)]\s+/, '').replace(/^>\s*/, ''))
      .filter((line) => line.length >= 4)
      .slice(0, 6)
    if (lines.length === 0) continue
    const joined = lines.join(' · ')
    if (joined.length < 12) continue
    return joined.length > 400 ? `${joined.slice(0, 400)}…` : joined
  }
  return null
}

const README_CANDIDATES = ['README.md', 'readme.md', 'README.en.md', 'readme.en.md', 'README.txt', 'readme.txt', 'README_EN.md']

/** 按候选名依次试，返回第一份非空文本（很多插件只发 README.en.md）。 */
async function readFirstText(dir, names, limit) {
  for (const name of names) {
    const text = await readTextSafe(path.join(dir, name), limit)
    if (text !== null && text.trim().length > 0) return text
  }
  return null
}

/** 只为了拿「怎么用」这一段。 */
async function readmeUsage(packageName) {
  const profileDir = await resolveProfileDir()
  if (profileDir === null) return null
  const dir = path.join(profileDir, 'node_modules', ...String(packageName).split('/'))
  const raw = await readFirstText(dir, README_CANDIDATES, 80 * 1024)
  if (raw === null) return null
  return extractUsageSection(cleanReadmeText(raw))
}

/** 把插件自己的信息收成一段给模型看的素材（尽量短、尽量真）。 */
async function gatherMaterial(packageName) {
  const profileDir = await resolveProfileDir()
  if (profileDir === null) return null
  const dir = path.join(profileDir, 'node_modules', ...String(packageName).split('/'))
  if (!(await exists(dir))) return null

  const material = []
  const rawPkg = await readTextSafe(path.join(dir, 'package.json'), 40 * 1024)
  if (rawPkg !== null) {
    try {
      const pkg = JSON.parse(rawPkg)
      const manifest = pkg?.dsh ?? {}
      material.push([
        '## package.json',
        `name: ${pkg?.name ?? packageName}`,
        `version: ${pkg?.version ?? '?'}`,
        `description: ${pkg?.description ?? '(无)'}`,
        Array.isArray(pkg?.keywords) && pkg.keywords.length > 0 ? `keywords: ${pkg.keywords.join(', ')}` : null,
        manifest?.bundle != null ? `dsh.bundle: yes` : null,
        manifest?.client != null ? `dsh.client.platform: ${manifest.client.platform ?? '?'}` : null,
        Array.isArray(pkg?.dependencies) ? `dependencies: ${pkg.dependencies.join?.(', ') ?? pkg.dependencies}` : null,
      ].filter((line) => line !== null).join('\n'))
    } catch {
      /* 坏 JSON 就跳过 */
    }
  }

  const readmeRaw = await readFirstText(dir, README_CANDIDATES, 60 * 1024)
  if (readmeRaw !== null && readmeRaw.trim().length > 0) {
    const cleaned = cleanReadmeText(readmeRaw)
    // 前 1800 字通常是英文标题区；如果中文很少，再从全文里抽中文段落补上（很多插件 README 是双语的）
    let excerpt = cleaned.slice(0, 1800)
    const hanCount = (excerpt.match(/\p{Script=Han}/gu) ?? []).length
    if (hanCount < 40) {
      const chineseLines = cleaned
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => (line.match(/\p{Script=Han}/gu) ?? []).length >= 6)
        .slice(0, 40)
        .join('\n')
      if (chineseLines.length > 0) excerpt = `${excerpt}\n\n## README 中文片段\n${chineseLines.slice(0, 1200)}`
    }
    material.push(`## README 摘录\n${excerpt}`)
    const usageSnippet = extractUsageSection(cleaned)
    if (usageSnippet !== null) material.push(`## README 用法片段（照着这段总结 usage）\n${usageSnippet}`)
  }

  const client = await readTextSafe(path.join(dir, 'lib', 'client.js'), 400 * 1024)
    ?? await readTextSafe(path.join(dir, 'dist', 'client.js'), 400 * 1024)
  if (client !== null) {
    const slots = new Set()
    const slotRe = /slots\.register\(\s*\{\s*name:\s*'([^']+)'/g
    let match
    while ((match = slotRe.exec(client)) !== null) slots.add(match[1])
    const labels = new Set()
    const labelRe = /label:\s*\(\)\s*=>\s*'([^']{2,40})'/g
    while ((match = labelRe.exec(client)) !== null) labels.add(match[1])
    if (slots.size > 0) material.push(`## 客户端注入点\n${[...slots].join(', ')}`)
    if (labels.size > 0) material.push(`## 界面文案\n${[...labels].slice(0, 8).join(' / ')}`)
  }

  const joined = material.join('\n\n')
  if (joined.trim().length === 0) return null
  return joined.slice(0, MAX_MATERIAL_CHARS)
}

/** 从各种可能的流式分片里取文本（不同适配器给的形状不一样）。 */
function chunkText(chunk) {
  if (typeof chunk === 'string') return chunk
  if (chunk === null || typeof chunk !== 'object') return ''
  if (typeof chunk.text === 'string') return chunk.text
  if (typeof chunk.delta === 'string') return chunk.delta
  if (chunk.delta !== null && typeof chunk.delta === 'object' && typeof chunk.delta.text === 'string') return chunk.delta.text
  if (typeof chunk.textDelta === 'string') return chunk.textDelta
  if (typeof chunk.content === 'string') return chunk.content
  if (Array.isArray(chunk.content)) {
    return chunk.content.map((block) => (typeof block === 'string' ? block : typeof block?.text === 'string' ? block.text : '')).join('')
  }
  return ''
}

const HAS_CHINESE = /\p{Script=Han}/u

/** 标签清洗：去掉引号/书名号/省略号，超长按字符截断（不切断代理对）。 */
function sanitizeLabel(label) {
  let out = String(label ?? '').trim()
  out = out.replace(/^[「『“‘"'（(【\[]+/, '').replace(/[」』”’"'）)】\]]+$/, '')
  out = out.replace(/(\.{2,}|…+)$/, '').trim()
  const chars = [...out]
  if (chars.length > 14) out = chars.slice(0, 14).join('').trim()
  return out
}

function parseTagText(text) {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  let parsed = null
  try {
    parsed = JSON.parse(text.slice(start, end + 1))
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object') return null
  const label = sanitizeLabel(parsed.label)
  const summary = typeof parsed.summary === 'string' ? parsed.summary.trim().slice(0, 160) : ''
  const usage = typeof parsed.usage === 'string'
    ? parsed.usage.replace(/\s+/g, ' ').trim().slice(0, 200)
    : ''
  const tags = Array.isArray(parsed.tags)
    ? parsed.tags.filter((item) => typeof item === 'string').map((item) => item.trim()).filter(Boolean).slice(0, 6)
    : []
  if (label.length === 0 && summary.length === 0) return null
  // 标签必须是中文：模型偶尔会把 README 的英文标题当 label 抄回来
  if (!HAS_CHINESE.test(label) && !HAS_CHINESE.test(summary)) return null
  return { label, summary, usage, tags }
}

const TAG_PROMPT = (packageName, material) => [
  '你是 DSH（DeepSeek Harness）插件目录的编辑。下面是一个插件的真实信息。',
  '请只根据这些信息，为它在中文界面上写一个短标签。',
  '',
  '输出要求：',
  '- 只输出一行 JSON，不要 markdown 代码围栏，不要解释。',
  '- 形状：{"label":"不超过 10 个汉字的中文名称","summary":"不超过 40 个字的中文说明它做什么","usage":"不超过 60 个字的中文使用说明","tags":["2 到 4 个中文关键词"]}',
  '- label 是名词短语（例如「余额挂件」「回合回溯」），不是营销口号，不要带引号或书名号。',
  '- label 必须指「这个插件多出来的那个功能」，读起来像界面上的功能名；不能是评价词或泛词（禁止「官方级」「专业版」「增强版」「好用」「插件」「工具」「功能」「扩展」这类）。',
  '- 拿不准就用它最核心的那个名词（例如「记忆检索」「上下文压缩」），不要照抄英文标题，也不要把包名直译。',
  '- summary 只写它真实做的事；材料里没有的能力一律不要写，宁短勿编。',
  '- usage 写「怎么用」：入口在界面哪里、要不要打开某个面板/设置、有没有命令或快捷键。',
  '- usage 只写材料里能看出来的操作（有「README 用法片段」就照着总结）；看不出来就写一句最保守的，例如「装上后它的面板会自己出现」，不要编命令。',
  '- 不要复述插件名，不要在 summary/usage 里用「本插件」开头。',
  '',
  `插件包名：${packageName}`,
  '',
  '=== 插件信息开始 ===',
  material,
  '=== 插件信息结束 ===',
].join('\n')

/** 调当前默认模型；不依赖具体 provider，只要求宿主注入了 llm + agentDefaultModel。 */
async function askModel(ctx, packageName, material, previousText = null) {
  const llm = ctx.get('llm')
  if (llm === undefined) throw new Error('宿主没有可用的模型服务（llm）')
  const selection = ctx.get('agentDefaultModel')?.currentSelection?.()
  const provider = typeof selection?.provider === 'string' ? selection.provider : null
  const model = typeof selection?.model === 'string' ? selection.model : null
  if (provider === null || model === null) throw new Error('还没有默认模型：先在模型设置里选一个')

  const prompt = TAG_PROMPT(packageName, material)
  const messages = typeof previousText === 'string' && previousText.length > 0
    ? [
      { role: 'user', content: prompt },
      { role: 'assistant', content: previousText.slice(0, 400) },
      { role: 'user', content: '上一次输出不是要求的 JSON。请重新回答，只输出一行合法 JSON，不要任何其它文字、不要代码围栏。label 必须是中文名词短语（≤10 个汉字）。' },
    ]
    : [{ role: 'user', content: prompt }]

  const attempts = [
    () => llm.stream({ provider, model, messages }),
    () => llm.stream({ provider, model, messages: [{ role: 'user', content: messages.map(m => ({ type: 'text', text: typeof m.content === 'string' ? m.content : '' })) }] }),
  ]

  let lastError = null
  for (const attempt of attempts) {
    try {
      let text = ''
      for await (const chunk of attempt()) text += chunkText(chunk)
      if (text.trim().length > 0) {
        tagsModelSeen = `${provider}/${model}`
        return { text: text.trim(), model: tagsModelSeen }
      }
    } catch (error) {
      lastError = error
    }
  }
  throw lastError ?? new Error('模型没有返回任何内容')
}

/** 没有模型时的兜底：读插件信息提炼，标注 source 让用户知道不是模型给的。 */
async function fallbackTag(packageName) {
  const profileDir = await resolveProfileDir()
  if (profileDir === null) return null
  const info = await describePlugin({ profileDir, packageName }).catch(() => null)
  const text = typeof info?.text === 'string' ? info.text.trim() : ''
  if (text.length === 0) return null
  const stripped = text.replace(/^[（(][^）)]*[）)]/, '').replace(/\([^)]*\)/g, ' ').replace(/（[^）]*）/g, ' ')
  const chinese = stripped.match(/\p{Script=Han}(?:[\p{Script=Han}0-9A-Za-z·、]{0,13})/u)
  const label = (chinese !== null ? chinese[0] : stripped
    .split(/[，。；：、,.;:]/)[0]
    .replace(/^(提供|支持|用于|可以|能够)/, '')
    .trim()
    .slice(0, 14)) ?? ''
  return {
    label: sanitizeLabel(label),
    summary: text.slice(0, 80),
    usage: (await readmeUsage(packageName)) ?? '',
    tags: [],
    source: 'rule',
    at: Date.now(),
    model: null,
  }
}

/** 生成并记住一个插件的中文标签。 */
async function generateTag(ctx, packageName, options = {}) {
  const material = await gatherMaterial(packageName)
  if (material === null) {
    // 源码不在本机（最常见的原因：link 依赖指向的目录被删了，例如应用更新把安装目录清空）
    const fallback = await fallbackTag(packageName)
    if (fallback === null) {
      const error = new Error('读不到这个插件的源码：它可能是 link 依赖，而指向的目录已经不在了。重装这个插件后再试')
      error.status = 404
      throw error
    }
    const data0 = await readTags()
    data0.entries[packageName] = fallback
    await writeTags(data0)
    return fallback
  }

  let entry = null
  let previousText = null
  try {
    // 最多问两次：第一次结果不是合法 JSON（或标签不是中文）时，带上上一次输出让它改
    for (let round = 0; round < 2 && entry === null; round += 1) {
      const result = await askModel(ctx, packageName, material, previousText)
      previousText = result.text
      const parsed = parseTagText(result.text)
      if (parsed !== null) entry = { ...parsed, source: 'ai', model: result.model, at: Date.now() }
    }
  } catch (error) {
    if (options.allowFallback === false) throw error
  }
  if (entry === null) entry = await fallbackTag(packageName)
  if (entry === null) throw new Error('生成失败：模型没给出可解析的 JSON，README 里也没有可提炼的信息')

  const data = await readTags()
  data.entries[packageName] = entry
  if (entry.model != null) data.model = entry.model
  await writeTags(data)
  return entry
}

/** 老条目没记 usage：启动时补一次（只读 README，不调模型，幂等）。 */
async function backfillUsage() {
  const data = await readTags()
  let changed = false
  for (const [packageName, entry] of Object.entries(data.entries ?? {})) {
    if (entry === null || typeof entry !== 'object') continue
    if (typeof entry.usage === 'string' && entry.usage.length > 0) continue
    const usage = await readmeUsage(packageName)
    if (usage === null || usage.length === 0) continue
    data.entries[packageName] = { ...entry, usage }
    changed = true
  }
  if (changed) await writeTags(data)
  return changed
}

/* ------------------------------------------------------------------ 插件本体 */

export function apply(ctx) {
  let lastScan = null
  const runScan = async (options) => {
    try {
      lastScan = await scan(ctx, options)
      return lastScan
    } catch (error) {
      lastScan = { error: error instanceof Error ? error.message : String(error) }
      return lastScan
    }
  }

  // 启动即扫一次（仅记录，不打扰）；之后每 5 分钟静默复查，发现新插件就记成待认领
  ctx.effect(() => {
    void runScan()
    const timer = setInterval(() => { void runScan() }, SCAN_INTERVAL_MS)
    if (typeof timer.unref === 'function') timer.unref()
    return () => clearInterval(timer)
  }, 'plugin-console: 自动发现扫描')

  // 已经记住的中文标签如果还没有「使用说明」，启动时从 README 补一次（不调模型）
  ctx.effect(() => {
    void (async () => {
      try {
        await backfillUsage()
      } catch {
        // 读不到就算了，界面上会退化成通用说明
      }
    })()
  }, 'plugin-console: 补使用说明')

  /* ------------------------------------------------------ 会话级放行（本对话启用/停用） */
  const gates = createSessionGates({
    ctx,
    consoleDir,
    profileDir: async () => {
      const dir = await resolveProfileDir()
      if (dir === null) throw new Error('找不到 profile 目录')
      return dir
    },
  })

  /** 读一次目录再套策略（gates 需要目录里的包名与标题）。 */
  const applySession = async sessionId => {
    try {
      const catalog = await readCatalog(ctx)
      return await gates.apply(sessionId, catalog)
    } catch (error) {
      return { applied: false, denied: [], error: error instanceof Error ? error.message : String(error) }
    }
  }

  ctx.effect(() => {
    // 重载/启动后先补一遍：已经有策略的会话在下次请求前就生效（不用重开对话）
    void (async () => {
      try {
        const catalog = await readCatalog(ctx)
        await gates.applyAll(catalog)
      } catch {
        // 目录还不可用时下次会话事件会补
      }
    })()

    const disposers = []
    const on = (event, handler) => {
      try {
        disposers.push(ctx.on(event, handler))
      } catch {
        // 该事件在当前版本不存在时忽略
      }
    }
    on('agent/created', payload => {
      const id = payload?.agent?.id
      if (typeof id === 'string') void applySession(id)
    })
    on('agent/disposed', payload => {
      const id = payload?.agent?.id
      if (typeof id === 'string') gates.revoke(id)
    })
    let toolsTimer = null
    on('tools/change', () => {
      gates.invalidateOwners()
      if (toolsTimer !== null) return
      toolsTimer = setTimeout(() => {
        toolsTimer = null
        void (async () => {
          try {
            const catalog = await readCatalog(ctx)
            await gates.applyAll(catalog)
          } catch {
            // 目录暂时不可读时跳过，下次事件再试
          }
        })()
      }, 1000)
      if (typeof toolsTimer.unref === 'function') toolsTimer.unref()
    })
    return () => {
      if (toolsTimer !== null) clearTimeout(toolsTimer)
      for (const disposer of disposers) {
        try {
          if (typeof disposer === 'function') disposer()
        } catch {
          // 忽略
        }
      }
      gates.revokeAll()
    }
  }, 'plugin-console: 会话级放行')

  // 单个插件的配置：GET 读表单描述 + 当前值，POST 保存
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE_BASE}/config`,
    handler: async (req, res) => {
      try {
        if (req.method === 'GET') {
          const url = new URL(req.url ?? '/', 'http://dsh.local')
          const id = url.searchParams.get('id')
          if (id === null || id.length === 0) {
            sendJson(res, 400, { status: 'error', message: '缺少 id' })
            return
          }
          const target = findConfigTarget(ctx, id)
          if (target.error !== undefined) {
            sendJson(res, 404, { status: 'error', message: target.error })
            return
          }
          sendJson(res, 200, {
            status: 'ok',
            id,
            name: target.name,
            patchId: target.patchId,
            hasConfig: target.fields.length > 0,
            fields: target.fields,
            explicit: target.explicit,
            inherited: target.inherited,
          })
          return
        }

        if (req.method === 'POST') {
          const body = await readJson(req)
          const id = typeof body?.id === 'string' ? body.id : null
          const config = body?.config !== null && typeof body?.config === 'object' ? body.config : null
          if (id === null || config === null) {
            sendJson(res, 400, { status: 'error', message: '需要 { id, config }' })
            return
          }
          const target = findConfigTarget(ctx, id)
          if (target.error !== undefined) {
            sendJson(res, 404, { status: 'error', message: target.error })
            return
          }
          await target.editor.edit(target.entry, () => config)
          sendJson(res, 200, { status: 'ok', id })
          return
        }

        sendJson(res, 405, { status: 'error', message: 'method not allowed' })
      } catch (error) {
        sendJson(res, 500, { status: 'error', message: error instanceof Error ? error.message : String(error) })
      }
    },
  }), 'plugin-console: 配置路由')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE_BASE}/describe`,
    handler: async (req, res) => {
      if (req.method !== 'GET') {
        sendJson(res, 405, { status: 'error', message: 'method not allowed' })
        return
      }
      try {
        const url = new URL(req.url ?? `${ROUTE_BASE}/describe`, 'http://dsh.local')
        const packageName = url.searchParams.get('id')
        if (packageName === null || packageName.length === 0) {
          sendJson(res, 400, { status: 'error', message: '缺少 id（包名）' })
          return
        }
        // 只允许描述"已安装的插件"，避免被当成任意目录读取
        const pm = ctx.get('pluginManager')
        const bundles = pm === undefined ? [] : await pm.listBundles()
        const known = (Array.isArray(bundles) ? bundles : []).find(bundle => bundle?.name === packageName)
        if (known === undefined) {
          sendJson(res, 404, { status: 'error', message: `没有这个插件：${packageName}` })
          return
        }
        const profileDir = await resolveProfileDir()
        if (profileDir === null) {
          sendJson(res, 500, { status: 'error', message: '找不到 profile 目录' })
          return
        }
        const fresh = url.searchParams.get('refresh') === '1'
        if (fresh) describeCache.delete(packageName)
        const info = await describePlugin({ profileDir, packageName, moduleName: known?.rows?.[0]?.moduleName })
        describeCache.set(packageName, { at: Date.now(), info })
        sendJson(res, 200, { status: 'ok', packageName, ...info })
      } catch (error) {
        sendJson(res, 500, { status: 'error', message: error instanceof Error ? error.message : String(error) })
      }
    },
  }), 'plugin-console: 描述生成路由')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE_BASE}/settings`,
    handler: async (req, res) => {
      try {
        const state = await readState()
        if (req.method === 'GET') {
          const profileDir = await resolveProfileDir()
          sendJson(res, 200, {
            status: 'ok',
            settings: state.settings,
            profileDir,
            stateFile: profileDir === null ? null : path.join(profileDir, '.plugin-console', 'state.json'),
            policiesDir: profileDir === null ? null : path.join(profileDir, '.plugin-console', 'sessions'),
            scanIntervalMs: SCAN_INTERVAL_MS,
            lastScanAt: state.lastScanAt ?? null,
            pendingNew: state.pendingBundles.length + state.pendingRows.length,
          })
          return
        }
        if (req.method === 'POST') {
          const body = await readJson(req)
          // 两个开关各自独立：请求里没带的那个保持原值，避免互相覆盖
          const autoAck = typeof body?.autoAck === 'boolean' ? body.autoAck : state.settings.autoAck === true
          const aiTags = typeof body?.aiTags === 'boolean' ? body.aiTags : state.settings.aiTags !== false
          await writeState({ ...state, settings: { ...state.settings, autoAck, aiTags } })
          lastScan = await scan(ctx)
          sendJson(res, 200, { status: 'ok', settings: { autoAck, aiTags }, discovery: lastScan })
          return
        }
        sendJson(res, 405, { status: 'error', message: 'method not allowed' })
      } catch (error) {
        sendJson(res, 500, { status: 'error', message: error instanceof Error ? error.message : String(error) })
      }
    },
  }), 'plugin-console: 设置路由')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE_BASE}/catalog`,
    handler: async (req, res) => {
      if (req.method !== 'GET') {
        sendJson(res, 405, { status: 'error', message: 'method not allowed' })
        return
      }
      try {
        const url = new URL(req.url ?? `${ROUTE_BASE}/catalog`, 'http://dsh.local')
        const ack = url.searchParams.get('ack') === '1'
        const catalog = await readCatalog(ctx)
        let discovery = lastScan
        if (ack) discovery = await runScan({ persist: true })
        if (discovery === null) discovery = await runScan()

        sendJson(res, 200, {
          status: 'ok',
          scannedAt: discovery?.scannedAt ?? null,
          discovery,
          aiTagsEnabled: (await readState()).settings.aiTags !== false,
          layout: {
            profileDir: await resolveProfileDir(),
            stateFile: await stateFile(),
          },
          bundles: catalog.bundles.map(b => ({
            ...b,
            inProfile: catalog.profileBundles === null ? null : catalog.profileBundles.includes(b.name),
            alwaysOn: (b.availability === 'installation' && catalog.profileBundles !== null
              && catalog.profileBundles.includes(b.name))
              || (b.installed === true && isAlwaysOn(b)),
            rowIds: b.rows.map(row => row.id).filter(rowId => typeof rowId === 'string' && rowId.length > 0),
            rows: undefined,
          })),
          kernel: catalog.kernel,
          installed: catalog.installedBundles.map(b => b.name),
          rows: catalog.rows,
          peers: catalog.peers,
        })
      } catch (error) {
        sendJson(res, 500, { status: 'error', message: error instanceof Error ? error.message : String(error) })
      }
    },
  }), 'plugin-console: 目录路由')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE_BASE}/status`,
    handler: async (req, res) => {
      if (req.method !== 'GET') {
        sendJson(res, 405, { status: 'error', message: 'method not allowed' })
        return
      }
      try {
        const discovery = lastScan ?? await runScan()
        sendJson(res, 200, {
          status: 'ok',
          pendingNew: (discovery?.newBundles?.length ?? 0) + (discovery?.newRows?.length ?? 0),
          scannedAt: discovery?.scannedAt ?? null,
          clientHalf: describeClientHalf(ctx),
        })
      } catch (error) {
        sendJson(res, 500, { status: 'error', message: error instanceof Error ? error.message : String(error) })
      }
    },
  }), 'plugin-console: 状态路由')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE_BASE}/toggle`,
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { status: 'error', message: 'method not allowed' })
        return
      }
      try {
        const body = await readJson(req)
        const kind = body?.kind === 'bundle' ? 'bundle' : 'row'
        const id = typeof body?.id === 'string' ? body.id : null
        const enabled = body?.enabled === true
        if (id === null) {
          sendJson(res, 400, { status: 'error', message: '缺少 id' })
          return
        }
        const pm = ctx.get('pluginManager')
        if (pm === undefined) {
          sendJson(res, 500, { status: 'error', message: 'pluginManager 服务不可用' })
          return
        }
        // 不允许从这里关掉自己：一旦关掉面板就没了，用户只能改 patch 文件救回来
        if (kind === 'row') {
          const rows = await pm.listPlugins()
          const self = (Array.isArray(rows) ? rows : []).find(row => row?.entryId === id)
          if (self?.moduleName === SELF_MODULE) {
            sendJson(res, 409, { status: 'error', message: '不能在这里关掉插件管家自己（会失去入口）' })
            return
          }
        }
        const result = kind === 'bundle'
          ? await pm.setBundleEnabled(id, enabled)
          : await pm.setPluginEnabled(id, enabled)
        sendJson(res, 200, { status: 'ok', kind, id, enabled, result })
      } catch (error) {
        sendJson(res, 500, { status: 'error', message: error instanceof Error ? error.message : String(error) })
      }
    },
  }), 'plugin-console: 启停路由')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE_BASE}/ack`,
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { status: 'error', message: 'method not allowed' })
        return
      }
      try {
        const state = await readState()
        await writeState({ ...state, pendingBundles: [], pendingRows: [] })
        lastScan = await runScan({ persist: true })
        sendJson(res, 200, { status: 'ok', discovery: lastScan })
      } catch (error) {
        sendJson(res, 500, { status: 'error', message: error instanceof Error ? error.message : String(error) })
      }
    },
  }), 'plugin-console: 认领路由')

  /* ------------------------------------------- 会话级放行（本对话启用/停用）路由 */

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE_BASE}/sessions`,
    handler: async (req, res) => {
      if (req.method !== 'GET') {
        sendJson(res, 405, { status: 'error', message: 'method not allowed' })
        return
      }
      try {
        const agents = ctx.get('agents')
        const running = new Set(
          typeof agents?.list === 'function' ? agents.list().map(agent => String(agent?.id)) : [],
        )
        const files = await gates.listPolicyFiles()
        const rows = []
        for (const file of files) {
          const sessionId = file.replace(/\.json$/, '')
          const policy = await gates.readPolicy(sessionId)
          rows.push({
            sessionId,
            running: running.has(sessionId),
            disabled: policy.disabled,
            disabledMcp: policy.disabledMcp,
            updatedAt: policy.updatedAt,
          })
        }
        sendJson(res, 200, { status: 'ok', running: [...running], policies: rows })
      } catch (error) {
        sendJson(res, 500, { status: 'error', message: error instanceof Error ? error.message : String(error) })
      }
    },
  }), 'plugin-console: 会话策略列表路由')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE_BASE}/session`,
    handler: async (req, res) => {
      try {
        const url = new URL(req.url ?? `${ROUTE_BASE}/session`, 'http://dsh.local')

        if (req.method === 'GET') {
          const sessionId = url.searchParams.get('id')
          if (sessionId === null || sessionId.length === 0) {
            sendJson(res, 400, { status: 'error', message: '缺少 id' })
            return
          }
          const catalog = await readCatalog(ctx)
          sendJson(res, 200, { status: 'ok', ...(await gates.describe(sessionId, catalog)) })
          return
        }

        if (req.method === 'POST') {
          const body = await readJson(req)
          const sessionId = typeof body?.id === 'string' ? body.id : null
          if (sessionId === null || sessionId.length === 0) {
            sendJson(res, 400, { status: 'error', message: '需要 { id, disabled: string[], disabledMcp: string[] }' })
            return
          }
          const catalog = await readCatalog(ctx)
          const saved = await gates.setPolicy(sessionId, {
            disabled: Array.isArray(body?.disabled) ? body.disabled : [],
            disabledMcp: Array.isArray(body?.disabledMcp) ? body.disabledMcp : [],
          }, catalog)
          sendJson(res, 200, {
            status: 'ok',
            sessionId,
            policy: saved.policy,
            applied: saved.applied,
            ...(await gates.describe(sessionId, catalog)),
          })
          return
        }

        if (req.method === 'DELETE') {
          const sessionId = url.searchParams.get('id')
          if (sessionId === null || sessionId.length === 0) {
            sendJson(res, 400, { status: 'error', message: '缺少 id' })
            return
          }
          await gates.forget(sessionId)
          sendJson(res, 200, { status: 'ok', sessionId, forgotten: true })
          return
        }

        sendJson(res, 405, { status: 'error', message: 'method not allowed' })
      } catch (error) {
        sendJson(res, 500, { status: 'error', message: error instanceof Error ? error.message : String(error) })
      }
    },
  }), 'plugin-console: 会话策略路由')

  /* ------------------------------------------------------ AI 中文标签路由 */
  // GET     → 已记住的全部标签
  // POST    → { packageName, refresh? } 生成/重算一个（结果写进 tags.json）
  // DELETE  → ?packageName= 忘掉一个
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE_BASE}/tags`,
    handler: async (req, res) => {
      try {
        const url = new URL(req.url ?? `${ROUTE_BASE}/tags`, 'http://dsh.local')

        if (req.method === 'GET') {
          const data = await readTags()
          sendJson(res, 200, {
            status: 'ok',
            count: Object.keys(data.entries).length,
            entries: data.entries,
            model: data.model,
            probing: tagsModelSeen,
          })
          return
        }

        if (req.method === 'POST') {
          const body = await readJson(req)
          const packageName = typeof body?.packageName === 'string' ? body.packageName : null
          if (packageName === null || packageName.length === 0) {
            sendJson(res, 400, { status: 'error', message: '需要 { packageName }' })
            return
          }
          const pm = ctx.get('pluginManager')
          const bundles = pm === undefined ? [] : await pm.listBundles()
          const known = (Array.isArray(bundles) ? bundles : []).some(bundle => bundle?.name === packageName)
          if (!known) {
            sendJson(res, 404, { status: 'error', message: `没有这个插件：${packageName}` })
            return
          }
          const entry = await generateTag(ctx, packageName, { allowFallback: body?.allowFallback !== false })
          sendJson(res, 200, { status: 'ok', packageName, ...entry })
          return
        }

        if (req.method === 'DELETE') {
          const packageName = url.searchParams.get('packageName')
          if (packageName === null || packageName.length === 0) {
            sendJson(res, 400, { status: 'error', message: '缺少 packageName' })
            return
          }
          const data = await readTags()
          const had = data.entries[packageName] !== undefined
          delete data.entries[packageName]
          await writeTags(data)
          sendJson(res, 200, { status: 'ok', packageName, removed: had })
          return
        }

        sendJson(res, 405, { status: 'error', message: 'method not allowed' })
      } catch (error) {
        const status = typeof error?.status === 'number' ? error.status : 500
        sendJson(res, status, { status: 'error', message: error instanceof Error ? error.message : String(error) })
      }
    },
  }), 'plugin-console: AI 中文标签路由')
}
