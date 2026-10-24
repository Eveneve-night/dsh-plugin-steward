/**
 * 插件描述自省（describePlugin）
 *
 * 当插件自己没有 meta.description 时，从它的安装目录里自己读取信息，
 * 拼出一句可读的中文功能描述：
 *   1. package.json（bundle / 客户端平台 / main 等）
 *   2. README（中文优先，剥掉 markdown 标记后取第一段）
 *   3. 客户端半的 slots.register / slots.inject 插槽名
 *   4. 宿主半的 webServer 路由、inject 服务、工具注册
 *
 * 约束：纯 ESM、零依赖、不联网、不 import @deepseek-ai/*。
 * 约定返回 { text, source, tools, slots, badges }，任何异常都在内部消化，永不抛错。
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'

const MAX_TEXT = 90
const MAX_README_BYTES = 1024 * 1024
const MAX_CLIENT_BYTES = 3 * 1024 * 1024
const MAX_HOST_BYTES = 512 * 1024
const MAX_HOST_FILES = 9
const MAX_SLOTS = 6
const MAX_TOOLS = 8

/** README 候选的优先顺序（任务契约里点名的四种）。 */
const README_PRIORITY = ['README.md', 'readme.md', 'README.zh-CN.md', 'README.zh_CN.md']

/** 客户端半文件的常见位置（README 契约之外兜底用）。 */
const CLIENT_CANDIDATES = [
  'lib/client.js',
  'client/client.js',
  'dist/client.js',
  'lib/client.mjs',
  'client.js',
]

/** 宿主半入口的常见位置（package.json 的 main/exports 之外兜底用）。 */
const HOST_CANDIDATES = [
  'lib/index.js',
  'index.js',
  'lib/host/index.js',
  'dist/index.js',
  'lib/index.mjs',
  'index.mjs',
  'index.cjs',
]

const LANGUAGE_WORDS = new Set([
  'english',
  'chinese',
  'japanese',
  '中文',
  '简体中文',
  '繁体中文',
  '繁體中文',
  '日本語',
  '英文',
])

const EMPTY_RESULT = () => ({ text: null, source: 'none', tools: [], slots: [], badges: [] })

/**
 * 自省一个插件，返回它自己的中文描述。
 *
 * @param {{ profileDir?: string, packageName?: string, moduleName?: string|null }} [options]
 * @returns {Promise<{ text: string|null, source: string, tools: string[], slots: string[], badges: string[] }>}
 */
export async function describePlugin(options) {
  try {
    const profileDir = typeof options?.profileDir === 'string' ? options.profileDir.trim() : ''
    const rawName = firstNonEmpty(
      typeof options?.packageName === 'string' ? options.packageName : '',
      typeof options?.moduleName === 'string' ? options.moduleName : '',
    )
    const packageName = normalizePackageName(rawName)
    if (profileDir === '' || packageName === null) return EMPTY_RESULT()

    const modulesDir = path.resolve(profileDir, 'node_modules')
    const packageDir = path.resolve(modulesDir, ...packageName.split('/'))
    if (!isInside(modulesDir, packageDir)) return EMPTY_RESULT()

    const pkg = await readJson(path.join(packageDir, 'package.json'))
    if (pkg === null) return EMPTY_RESULT()

    const readme = await firstReadmeParagraph(packageDir)
    const slots = await readClientSlots(packageDir, pkg)
    const host = await readHostFacts(packageDir, pkg)

    const badges = []
    if (host.hasWebServer && host.paths.length > 0) badges.push('提供 HTTP 接口')
    if (host.hasToolish) badges.push('提供工具')

    let text = null
    let source = 'none'

    if (readme !== null) {
      text = truncateText(readme)
      source = 'readme'
    } else if (slots.length > 0) {
      text = truncateText(slotSentence(slots))
      source = 'client-slots'
    } else if (typeof pkg.description === 'string' && pkg.description.trim() !== '') {
      text = truncateText(stripMarkdown(pkg.description))
      source = text === null ? 'none' : 'package'
    } else if (isBundle(pkg)) {
      const platform = typeof pkg?.dsh?.client?.platform === 'string' ? pkg.dsh.client.platform : ''
      text = platform === '' ? 'DSH 插件包' : `DSH 插件包（客户端平台 ${platform}）`
      source = 'package'
    }

    if (typeof text === 'string' && text.length === 0) {
      text = null
      source = 'none'
    }

    return {
      text,
      source,
      tools: host.tools.slice(0, MAX_TOOLS),
      slots,
      badges,
    }
  } catch {
    return EMPTY_RESULT()
  }
}

/* ------------------------------------------------------------------ 基础工具 */

function firstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return ''
}

/** 只接受合法的 npm 包名（防目录穿越）；含 `..`、绝对路径、反斜杠一律拒绝。 */
function normalizePackageName(name) {
  if (typeof name !== 'string') return null
  const value = name.trim()
  if (value === '') return null
  if (value.includes('..') || path.isAbsolute(value) || value.includes('\\')) return null
  if (/^@[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(value)) return value
  if (/^[A-Za-z0-9._-]+$/.test(value)) return value
  return null
}

function isInside(parent, child) {
  const rel = path.relative(parent, child)
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

function stripBom(value) {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value
}

async function readJson(file) {
  const raw = await readIfFile(file, MAX_README_BYTES)
  if (raw === null) return null
  try {
    const parsed = JSON.parse(stripBom(raw))
    return parsed !== null && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

async function readIfFile(file, maxBytes) {
  try {
    const info = await stat(file)
    if (info.isFile() !== true || info.size > maxBytes) return null
    return await readFile(file, 'utf8')
  } catch {
    return null
  }
}

async function readDirNames(dir) {
  try {
    const names = await readdir(dir)
    return Array.isArray(names) ? names : []
  } catch {
    return []
  }
}

async function resolveExistingFile(baseDir, relative) {
  if (typeof relative !== 'string' || relative.trim() === '') return null
  const file = path.resolve(baseDir, relative)
  if (!isInside(baseDir, file)) return null
  try {
    const info = await stat(file)
    return info.isFile() === true ? file : null
  } catch {
    return null
  }
}

/* ------------------------------------------------------------- package.json */

function exportTarget(exportsField, key) {
  if (typeof exportsField === 'string') {
    return key === '.' ? exportsField : null
  }
  if (exportsField === null || typeof exportsField !== 'object') return null
  const value = exportsField[key]
  if (typeof value === 'string') return value
  if (value !== null && typeof value === 'object') {
    for (const field of ['default', 'import', 'require', 'module']) {
      if (typeof value[field] === 'string') return value[field]
    }
    for (const nested of Object.values(value)) {
      if (typeof nested === 'string') return nested
    }
  }
  return null
}

function platformOf(pkg) {
  const platform = pkg?.dsh?.client?.platform
  return typeof platform === 'string' ? platform : ''
}

function isBundle(pkg) {
  return pkg?.dsh !== null && typeof pkg?.dsh === 'object' && pkg.dsh.bundle !== null && typeof pkg.dsh.bundle === 'object'
}

/* ------------------------------------------------------------------- README */

function hasCJK(value) {
  return /[\u3400-\u9fff]/.test(value)
}

function stripMarkdown(value) {
  let text = String(value ?? '')
  text = text.replace(/<!--[\s\S]*?-->/g, ' ')
  text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ') // 图片整体丢掉
  for (let i = 0; i < 2; i += 1) text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // [文字](链接) -> 文字
  text = text.replace(/<[^>]*>/g, ' ')
  text = text.replace(/&nbsp;/gi, ' ')
  text = text.replace(/&amp;/gi, '&')
  text = text.replace(/&lt;/gi, '<')
  text = text.replace(/&gt;/gi, '>')
  text = text.replace(/`+/g, '')
  text = text.replace(/\*\*|__/g, '')
  text = text.replace(/\*/g, '')
  text = text.replace(/(^|[\s(（])_+|_+([\s)）]|$)/g, '$1$2')
  text = text.replace(/^\s*(?:[-+>]|\d+[.)])\s+/, '')
  text = text.replace(/\s+/g, ' ').trim()
  return text
}

function isLanguageSwitcher(value) {
  const cleaned = value.replace(/[|/·,，、;；:：\-–—\s]+/g, ' ').trim()
  if (cleaned === '') return true
  const parts = cleaned.split(' ')
  return parts.every((part) => LANGUAGE_WORDS.has(part.toLowerCase()))
}

/** 取 README 第一段可读正文（跳过标题 / 徽章 / 图片 / 表格 / HTML / 语言切换行）。 */
function firstParagraph(markdown) {
  const text = stripBom(String(markdown ?? ''))
    .replace(/\r\n?/g, '\n')
    .replace(/<!--[\s\S]*?-->/g, '\n')
  const lines = text.split('\n')
  const blocks = []
  let current = []
  let fence = null

  const flush = () => {
    if (current.length > 0) {
      blocks.push(current.join(' '))
      current = []
    }
  }

  for (const raw of lines) {
    const line = raw.trim()
    if (line.startsWith('```') || line.startsWith('~~~')) {
      flush()
      fence = fence === null ? line.slice(0, 3) : null
      continue
    }
    if (fence !== null) continue
    if (line === '') {
      flush()
      continue
    }
    if (/^-{3,}$/.test(line) || /^\*{3,}$/.test(line) || /^_{3,}$/.test(line)) {
      flush()
      continue
    }
    if (/^#{1,6}\s/.test(line)) {
      flush()
      continue
    }
    if (/^\[!\[/.test(line) || /^!\[/.test(line)) {
      flush()
      continue
    }
    if (line.startsWith('|')) {
      flush()
      continue
    }
    if (/^<\/?[a-zA-Z]/.test(line)) {
      flush()
      continue
    }
    const cleaned = line.replace(/^>+\s?/, '').trim()
    if (cleaned === '') {
      flush()
      continue
    }
    current.push(cleaned)
  }
  flush()

  for (const block of blocks) {
    if (block.includes('\uFFFD')) continue // 明显乱码的段落直接不要
    const plain = stripMarkdown(block)
    if (plain === '' || plain.length < 6) continue
    if (isLanguageSwitcher(plain)) continue
    if (/^(install|installation|quick ?start|usage|features?|contents|table of contents)$/i.test(plain)) continue
    return plain
  }
  return null
}

async function readmeNames(packageDir) {
  const names = await readDirNames(packageDir)
  const byLower = new Map()
  for (const name of names) byLower.set(name.toLowerCase(), name)

  const ordered = []
  for (const wanted of README_PRIORITY) {
    const actual = byLower.get(wanted.toLowerCase())
    if (actual !== undefined && !ordered.includes(actual)) ordered.push(actual)
  }

  const extras = names
    .filter((name) => /^readme.*\.(md|markdown)$/i.test(name) && !ordered.includes(name))
    .sort((a, b) => chineseNameScore(b) - chineseNameScore(a) || a.localeCompare(b))

  return ordered.concat(extras)
}

function chineseNameScore(name) {
  return /(zh|cn|hans|chs)/i.test(name) ? 1 : 0
}

async function firstReadmeParagraph(packageDir) {
  const names = await readmeNames(packageDir)
  let fallback = null
  for (const name of names) {
    const markdown = await readIfFile(path.join(packageDir, name), MAX_README_BYTES)
    if (markdown === null) continue
    const paragraph = firstParagraph(markdown)
    if (paragraph === null) continue
    if (hasCJK(paragraph)) return paragraph // 中文优先
    if (fallback === null) fallback = paragraph
  }
  return fallback
}

/* -------------------------------------------------------------- 文本截断 */

function truncateText(value, max = MAX_TEXT) {
  const text = stripMarkdown(value)
  if (text.length <= max) return text
  let cut = text.slice(0, max - 1) // 留一个字符给省略号
  let lastEnd = -1
  const enders = /[。！？!?]/g
  let match
  while ((match = enders.exec(cut)) !== null) lastEnd = match.index
  if (lastEnd >= Math.floor(max * 0.5)) {
    cut = cut.slice(0, lastEnd + 1)
  } else {
    cut = cut.replace(/[\s，,、；;：:—–\-·]+$/, '')
    if (!/[。！？!?…]$/.test(cut)) cut += '…'
  }
  return cut.trim()
}

/* -------------------------------------------------------------- 客户端插槽 */

async function resolveClientFile(packageDir, pkg) {
  const client = pkg?.dsh?.client
  if (client === null || typeof client !== 'object') return null

  const candidates = []
  const fromExports = exportTarget(pkg?.exports, './client')
  if (fromExports !== null) candidates.push(fromExports)
  candidates.push(...CLIENT_CANDIDATES)

  for (const candidate of candidates) {
    const file = await resolveExistingFile(packageDir, candidate)
    if (file !== null) return file
  }
  return null
}

function addUnique(list, value, limit) {
  const item = String(value ?? '').trim()
  if (item === '' || item.length > 80) return
  if (list.includes(item)) return
  if (list.length >= limit) return
  list.push(item)
}

function collectQuoted(source, list, limit) {
  const pattern = /['"`]([^'"`]{1,80})['"`]/g
  let match
  while ((match = pattern.exec(source)) !== null) {
    const value = match[1].trim()
    if (value === '' || /[\s<>{}]/.test(value)) continue
    addUnique(list, value, limit)
  }
}

function extractSlots(source) {
  const slots = []

  // slots.inject('name', cb) / ctx.slots.inject("name", cb)
  const injectPattern = /(?:[\w$.]+\s*\.\s*)?slots\s*\.\s*inject\s*\(\s*(['"`])([^'"`\n]{1,80})\1/g
  let match
  while ((match = injectPattern.exec(source)) !== null) addUnique(slots, match[2], MAX_SLOTS)

  // slots.register({ name: '...' , ... }) / { id: '...' } 兜底
  const registerPattern = /slots\s*\.\s*register\s*\(\s*\{/g
  while ((match = registerPattern.exec(source)) !== null) {
    const start = match.index + match[0].length - 1
    const chunk = source.slice(start, start + 500)
    const byName = chunk.match(/name\s*:\s*(['"`])([^'"`\n]{1,80})\1/)
    const byId = chunk.match(/\bid\s*:\s*(['"`])([^'"`\n]{1,80})\1/)
    const candidate = byName !== null ? byName[2] : byId !== null ? byId[2] : ''
    addUnique(slots, candidate, MAX_SLOTS)
  }

  return slots
}

async function readClientSlots(packageDir, pkg) {
  const file = await resolveClientFile(packageDir, pkg)
  if (file === null) return []
  const source = await readIfFile(file, MAX_CLIENT_BYTES)
  if (source === null) return []
  return extractSlots(source)
}

function inferSlotLocation(slots) {
  const joined = slots.join(' ').toLowerCase()
  if (/input|composer|chat/.test(joined)) return '输入框'
  if (/sidebar|side|dock/.test(joined)) return '侧栏'
  if (/settings|preferences/.test(joined)) return '设置页'
  return '界面'
}

function slotSentence(slots) {
  const names = slots.slice(0, 3).join('、')
  const more = slots.length > 3 ? ' 等' : ''
  return `在${inferSlotLocation(slots)}的 ${names}${more} 插槽挂载界面组件`
}

/* ---------------------------------------------------------------- 宿主信息 */

async function resolveHostFile(packageDir, pkg) {
  const candidates = []
  if (typeof pkg?.main === 'string') candidates.push(pkg.main)
  const fromExports = exportTarget(pkg?.exports, '.')
  if (fromExports !== null) candidates.push(fromExports)
  candidates.push(...HOST_CANDIDATES)

  for (const candidate of candidates) {
    const file = await resolveExistingFile(packageDir, candidate)
    if (file !== null) return file
  }
  return null
}

function hostFileScore(name) {
  if (/route|router/i.test(name)) return 4
  if (/server|http|api/i.test(name)) return 3
  if (/web|static|mount|host/i.test(name)) return 2
  return 0
}

function addPath(paths, value) {
  const item = String(value ?? '').trim()
  if (item === '' || !item.startsWith('/') || item.length > 200) return
  addUnique(paths, item, 12)
}

function collectHostSource(source, facts) {
  if (/webServer|web-server|web_server/i.test(source)) facts.hasWebServer = true
  // 工具特征：注册工具、工具数组、或文档/报错里明确提到 MCP tools（misakanet 这类纯 MCP 插件）
  if (/registerTool\s*\(|\bTool\b|\btools\s*:|MCP\s+tools?\b/.test(source)) facts.hasToolish = true

  // register({ kind: 'exact'|'prefix'|'regex', path: '/x' })
  const kindFirst = /kind\s*:\s*['"](?:exact|prefix|regex)['"][\s\S]{0,240}?path\s*:\s*['"]([^'"\n]+)['"]/g
  let match
  while ((match = kindFirst.exec(source)) !== null) addPath(facts.paths, match[1])

  const pathFirst = /path\s*:\s*['"]([^'"\n]+)['"][\s\S]{0,160}?kind\s*:\s*['"](?:exact|prefix|regex)['"]/g
  while ((match = pathFirst.exec(source)) !== null) addPath(facts.paths, match[1])

  // export const inject = ['a', 'b'] / ctx.inject(['a', 'b'], cb)
  const injectList = /(?:export\s+)?(?:const|let|var)\s+inject\s*=\s*\[([\s\S]{0,600}?)\]/g
  while ((match = injectList.exec(source)) !== null) collectQuoted(match[1], facts.services, 12)

  const injectCall = /\.inject\s*\(\s*\[([\s\S]{0,400}?)\]/g
  while ((match = injectCall.exec(source)) !== null) collectQuoted(match[1], facts.services, 12)

  // 工具名
  const registerTool = /registerTool\s*\(\s*(['"`])([^'"`]{1,80})\1/g
  while ((match = registerTool.exec(source)) !== null) addUnique(facts.tools, match[2], MAX_TOOLS)

  const toolList = /\btools\s*:\s*\[([\s\S]{0,600}?)\]/g
  while ((match = toolList.exec(source)) !== null) collectQuoted(match[1], facts.tools, MAX_TOOLS)
}

async function readHostFacts(packageDir, pkg) {
  const facts = { paths: [], services: [], tools: [], hasWebServer: false, hasToolish: false }

  const entry = await resolveHostFile(packageDir, pkg)
  const dirs = new Set()
  if (entry !== null) dirs.add(path.dirname(entry))
  dirs.add(path.join(packageDir, 'lib'))
  dirs.add(packageDir)

  const seen = new Set()
  const sources = []
  if (entry !== null) {
    const source = await readIfFile(entry, MAX_HOST_BYTES)
    if (source !== null) {
      sources.push(source)
      seen.add(path.resolve(entry))
    }
  }

  for (const dir of dirs) {
    if (!isInside(packageDir, dir)) continue
    if (sources.length >= MAX_HOST_FILES) break
    const names = await readDirNames(dir)
    const ranked = names
      .filter((name) => /\.(?:js|mjs|cjs)$/i.test(name))
      .sort((a, b) => hostFileScore(b) - hostFileScore(a) || a.localeCompare(b))
    for (const name of ranked) {
      if (sources.length >= MAX_HOST_FILES) break
      if (name === 'package.json') continue
      const file = path.resolve(dir, name)
      if (seen.has(file)) continue
      if (!isInside(packageDir, file)) continue
      const source = await readIfFile(file, MAX_HOST_BYTES)
      if (source === null) continue
      seen.add(file)
      sources.push(source)
    }
  }

  for (const source of sources) collectHostSource(source, facts)
  return facts
}
