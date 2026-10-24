// 探测：用「字符串字面量 ∩ 实时工具名」的方式给工具找归属插件。
// 用法: node dev/scan-tools.mjs [profileDir]
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

const profileDir = process.argv[2] ?? 'C:\\Users\\COLORFUL\\.dsh\\profiles\\desktop'
const root = join(profileDir, 'node_modules')

// 模拟「实时工具名集合」：真实实现里来自 ctx.tools.schemas()
const LIVE = new Set([
  'compress', 'decompress', 'search_context', 'acp_status', 'acp_cache',
  'web_search', 'web_fetch', 'read', 'edit', 'write', 'grep', 'glob', 'pwsh', 'bash',
  'hindsight', 'hindsight_status', 'hindsight_recall', 'hindsight_list', 'hindsight_remember',
  'hindsight_forget', 'hindsight_related', 'hindsight_operations', 'hindsight_condense',
  'list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource',
])

const MAX_BYTES_PER_PKG = 6 * 1024 * 1024
const MAX_FILE_BYTES = 2 * 1024 * 1024

async function collectJs(dir, out = [], depth = 0) {
  if (depth > 4) return out
  let entries
  try { entries = await readdir(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.git') continue
    const p = join(dir, e.name)
    if (e.isDirectory()) await collectJs(p, out, depth + 1)
    else if (/\.(js|mjs|cjs|ts|tsx|jsx)$/.test(e.name) && !e.name.endsWith('.map')) out.push(p)
  }
  return out
}

const STR_RE = /(['"`])([A-Za-z][A-Za-z0-9_.\-]{1,60})\1/g

async function stringsInPackage(dir, files) {
  const found = new Set()
  let budget = MAX_BYTES_PER_PKG
  for (const f of files) {
    if (budget <= 0) break
    let text
    try { text = await readFile(f, 'utf8') } catch { continue }
    if (text.length > MAX_FILE_BYTES) text = text.slice(0, MAX_FILE_BYTES)
    budget -= text.length
    for (const m of text.matchAll(STR_RE)) {
      const s = m[2]
      if (LIVE.has(s)) {
        found.add(s)
        if (found.size === LIVE.size) return found
      }
    }
  }
  return found
}

const pkgs = []
for (const entry of await readdir(root, { withFileTypes: true })) {
  if (!entry.isDirectory() || entry.name.startsWith('.')) continue
  if (entry.name.startsWith('@')) {
    for (const sub of await readdir(join(root, entry.name), { withFileTypes: true })) {
      if (sub.isDirectory()) pkgs.push(`${entry.name}/${sub.name}`)
    }
  } else pkgs.push(entry.name)
}

const claimed = new Map()
const rows = []
for (const name of pkgs.sort()) {
  const dir = join(root, name)
  let pkg
  try { pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) } catch { continue }
  // 只看 DSH 插件（有 dsh 字段）或名字里带 dsh 的包，减少无谓扫描
  const isDshPkg = Boolean(pkg.dsh) || /dsh|modlens|billion-context|misakanet/.test(name)
  if (!isDshPkg) continue
  const files = await collectJs(dir)
  const hits = await stringsInPackage(dir, files)
  for (const t of hits) {
    if (!claimed.has(t)) claimed.set(t, [])
    claimed.get(t).push(name)
  }
  rows.push({ name, version: pkg.version, client: Boolean(pkg.dsh?.client), files: files.length, tools: [...hits] })
}

for (const r of rows) {
  console.log(`${r.name}@${r.version}${r.client ? ' [client]' : ''} files=${r.files}\n    -> ${r.tools.length ? r.tools.join(', ') : '(未检出工具)'}`)
}
console.log('\n--- 反查（工具 -> 包）---')
for (const t of LIVE) {
  const owners = claimed.get(t) ?? []
  if (owners.length) console.log(`${t} <- ${owners.join(' | ')}`)
}
console.error(`\n检出 ${[...claimed.keys()].length}/${LIVE.size} 个工具名；无归属：${[...LIVE].filter((t) => !claimed.has(t)).join(', ') || '(无)'}`)
