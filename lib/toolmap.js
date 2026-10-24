// 工具归属探测：回答「某个工具是哪个插件注册的」。
//
// 平台没有提供注册者信息（ctx.tools.schemas() 只给 name/description/parameters），
// 所以这里用「插件包内的字符串字面量 ∩ 当前实时工具名」来推断：
//   - 只有出现在插件源码里的工具名才可能属于它；
//   - 再用官方行名（patchId 以 tool- 开头）排除内建工具，避免 billion-context
//     这类会提到 read/write/edit 的插件把内建工具认领走；
//   - 名字含包名关键词的优先（dsh-hindsight 拥有 hindsight_*）。
//
// 结果是启发式的：误判/漏判都可能有，UI 上标成「推断」并保留人工纠正入口。
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

const MAX_BYTES_PER_PACKAGE = 6 * 1024 * 1024
const MAX_BYTES_PER_FILE = 2 * 1024 * 1024
const MAX_DEPTH = 4
const STRING_RE = /(['"`])([A-Za-z][A-Za-z0-9_.\-]{1,60})\1/g

async function collectSourceFiles(dir, out = [], depth = 0) {
  if (depth > MAX_DEPTH) return out
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      await collectSourceFiles(full, out, depth + 1)
    } else if (/\.(js|mjs|cjs|ts|tsx|jsx)$/.test(entry.name) && !entry.name.endsWith('.map')) {
      out.push(full)
    }
  }
  return out
}

/** 抓一个包里所有「可能是工具名」的字符串字面量（只保留 liveNames 里的，省内存） */
async function collectToolLiterals(packageDir, liveNames) {
  const files = await collectSourceFiles(packageDir)
  const found = new Set()
  let budget = MAX_BYTES_PER_PACKAGE
  for (const file of files) {
    if (budget <= 0 || found.size === liveNames.size) break
    let text
    try {
      text = await readFile(file, 'utf8')
    } catch {
      continue
    }
    if (text.length > MAX_BYTES_PER_FILE) text = text.slice(0, MAX_BYTES_PER_FILE)
    budget -= text.length
    for (const match of text.matchAll(STRING_RE)) {
      const literal = match[2]
      if (liveNames.has(literal)) found.add(literal)
    }
  }
  return found
}

/** 包名 → 关键词集合，用于「名字相近优先」 */
function packageKeywords(name) {
  return name
    .replace(/^@[^/]+\//, '')
    .split(/[^a-z0-9]+/i)
    .map(part => part.toLowerCase())
    .filter(part => part.length >= 3 && part !== 'dsh' && part !== 'plugin' && part !== 'bundles' && part !== 'bundle')
}

/**
 * @param {object} options
 * @param {string} options.profileDir   profile 目录（含 node_modules）
 * @param {string[]} options.packageNames 参与探测的第三方包名
 * @param {string[]} options.liveNames  当前全局可见的工具名
 * @param {string[]} [options.officialNames] 内建/官方工具名，不参与第三方归属
 * @returns {Promise<{ toolToPackage: Record<string,string>, packageToTools: Record<string,string[]>, ambiguous: Record<string,string[]>, scannedPackages: number, scannedAt: string }>}
 */
export async function detectToolOwners(options) {
  const { profileDir, packageNames, liveNames, officialNames = [] } = options
  const official = new Set(officialNames)
  const candidates = new Set(liveNames.filter(name => !official.has(name) && !name.startsWith('mcp__')))
  const nodeModules = join(profileDir, 'node_modules')

  const claims = new Map() // tool -> [{ pkg, keywords }]
  for (const pkgName of packageNames) {
    if (candidates.size === 0) break
    const dir = join(nodeModules, ...pkgName.split('/'))
    const literals = await collectToolLiterals(dir, candidates)
    const keywords = packageKeywords(pkgName)
    for (const tool of literals) {
      if (!claims.has(tool)) claims.set(tool, [])
      claims.get(tool).push({ pkg: pkgName, keywords })
    }
  }

  const toolToPackage = {}
  const packageToTools = {}
  const ambiguous = {}

  for (const [tool, owners] of claims) {
    let winner = owners[0]
    if (owners.length > 1) {
      const scored = owners
        .map(owner => ({
          owner,
          score: owner.keywords.filter(word => tool.toLowerCase().includes(word)).length,
        }))
        .sort((a, b) => b.score - a.score)
      winner = scored[0].owner
      ambiguous[tool] = owners.map(owner => owner.pkg)
    }
    toolToPackage[tool] = winner.pkg
    if (!packageToTools[winner.pkg]) packageToTools[winner.pkg] = []
    packageToTools[winner.pkg].push(tool)
  }

  for (const tools of Object.values(packageToTools)) tools.sort()

  return {
    toolToPackage,
    packageToTools,
    ambiguous,
    scannedPackages: packageNames.length,
    scannedAt: new Date().toISOString(),
  }
}
