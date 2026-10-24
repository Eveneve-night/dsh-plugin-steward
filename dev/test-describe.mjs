#!/usr/bin/env node
/**
 * describePlugin 真实验证脚本：对本机 profile 里已安装的 6 个插件跑一遍自省，
 * 打印每个包的 text / source / slots / tools / badges，并做契约与可读性断言。
 *
 * 运行：node dev/test-describe.mjs
 * 退出码：0 = 全部断言通过；1 = 有断言失败。
 */

import path from 'node:path'
import { readdir } from 'node:fs/promises'
import { describePlugin } from '../lib/describe.js'

const PROFILE_DIR = 'C:\\Users\\COLORFUL\\.dsh\\profiles\\desktop'
const PACKAGES = [
  '@dsh-use/wallpaper-engine',
  'dsh-conversation-navigator',
  'dsh-whale-widget',
  'dshmarket',
  'misakanet',
  'dock-git',
]
const SOURCES = new Set(['readme', 'client-slots', 'package', 'none'])
const RESULT_KEYS = ['text', 'source', 'tools', 'slots', 'badges']
const CJK = /[\u3400-\u9fff]/

const failures = []
const fail = (message) => failures.push(message)

const oneLine = (value) => String(value ?? '').replace(/\s+/g, ' ').trim()

function assertShape(packageName, result) {
  const missing = RESULT_KEYS.filter((key) => !(key in (result ?? {})))
  if (missing.length > 0) fail(`${packageName}: 返回对象缺字段 ${missing.join(', ')}`)
  if (result?.text !== null && typeof result?.text !== 'string') fail(`${packageName}: text 不是 string|null`)
  if (!SOURCES.has(result?.source)) fail(`${packageName}: source 非法 -> ${result?.source}`)
  if (!Array.isArray(result?.tools)) fail(`${packageName}: tools 不是数组`)
  if (!Array.isArray(result?.slots)) fail(`${packageName}: slots 不是数组`)
  if (!Array.isArray(result?.badges)) fail(`${packageName}: badges 不是数组`)
}

async function readmeFiles(packageName) {
  try {
    const files = await readdir(path.join(PROFILE_DIR, 'node_modules', ...packageName.split('/')))
    return files.filter((name) => /^readme/i.test(name)).sort()
  } catch {
    return []
  }
}

const results = []

console.log('describePlugin 真实验证')
console.log(`profileDir = ${PROFILE_DIR}`)
console.log('')

for (const packageName of PACKAGES) {
  const result = await describePlugin({ profileDir: PROFILE_DIR, packageName })
  assertShape(packageName, result)
  const files = await readmeFiles(packageName)
  results.push({ packageName, result, files })

  console.log(`================ ${packageName}`)
  console.log(`  text   : ${result.text === null ? '(null)' : result.text}`)
  console.log(`  source : ${result.source}`)
  console.log(`  slots  : ${result.slots.length === 0 ? '(0)' : `${result.slots.length} 个 -> ${result.slots.join('、')}`}`)
  console.log(`  tools  : ${result.tools.length === 0 ? '(0)' : `${result.tools.length} 个 -> ${result.tools.join('、')}`}`)
  console.log(`  badges : ${result.badges.length === 0 ? '(0)' : result.badges.join('、')}`)
  console.log(`  readme : ${files.length === 0 ? '(无)' : files.join(', ')}`)
  console.log('')
}

/* ------------------------------------------------------------------ 断言部分 */

const withText = results.filter(({ result }) => typeof result.text === 'string' && result.text.trim() !== '')
const withChinese = withText.filter(({ result }) => CJK.test(result.text))
const mojibake = withText.filter(({ result }) => result.text.includes('\uFFFD'))

if (withText.length < 4) {
  fail(`非空 text 只有 ${withText.length} 个（要求至少 4 个）`)
}
if (withChinese.length < 4) {
  fail(`含中文的 text 只有 ${withChinese.length} 个（要求至少 4 个）`)
}
for (const { packageName, result } of mojibake) {
  fail(`${packageName}: text 含替换字符 U+FFFD（乱码）-> ${oneLine(result.text)}`)
}
for (const { packageName, result } of withText) {
  if (result.text.length > 90) fail(`${packageName}: text 超过 90 字 -> ${result.text.length}`)
  if (oneLine(result.text) === '') fail(`${packageName}: text 只有空白字符`)
}
for (const { packageName, result } of results) {
  if (result.source === 'readme' && result.text === null) fail(`${packageName}: source=readme 但 text=null`)
  if (result.source === 'none' && result.text !== null) fail(`${packageName}: source=none 但 text 非空`)
}

/* 健壮性：非法输入、不存在的目录都不能抛错，统一返回空结果 */
const EMPTY = { text: null, source: 'none', tools: [], slots: [], badges: [] }
const robustness = [
  ['无参数', undefined],
  ['空对象', {}],
  ['不存在的 profile', { profileDir: 'C:\\no-such-profile-dir', packageName: '@dsh-use/wallpaper-engine' }],
  ['不存在的包', { profileDir: PROFILE_DIR, packageName: 'this-package-does-not-exist' }],
  ['目录穿越', { profileDir: PROFILE_DIR, packageName: '../package.json' }],
  ['空包名', { profileDir: PROFILE_DIR, packageName: '' }],
]
for (const [label, input] of robustness) {
  let result = null
  let thrown = null
  try {
    result = await describePlugin(input)
  } catch (error) {
    thrown = error
  }
  if (thrown !== null) {
    fail(`健壮性[${label}]: 抛错 -> ${thrown?.message ?? thrown}`)
    continue
  }
  assertShape(`健壮性[${label}]`, result)
  if (JSON.stringify(result) !== JSON.stringify(EMPTY)) {
    fail(`健壮性[${label}]: 期望空结果，实际 -> ${JSON.stringify(result)}`)
  }
}
console.log('健壮性检查（无参数/空对象/不存在目录/不存在包/目录穿越/空包名）：')
for (const [label] of robustness) console.log(`  ok  ${label}`)
console.log('')

/* ------------------------------------------------------------------ 汇总部分 */

console.log('----------------------------------------')
console.log(`非空 text：${withText.length}/${results.length}（含中文 ${withChinese.length} 个）`)
for (const { packageName, result } of results) {
  const badges = result.badges.length === 0 ? '' : `  badges: ${result.badges.join('、')}`
  console.log(`  ${packageName.padEnd(28)} source=${result.source.padEnd(13)} slots=${result.slots.length}${badges}`)
}
console.log('')
console.log('JSON 结果：')
console.log(JSON.stringify(results.map(({ packageName, result }) => ({ packageName, ...result })), null, 2))
console.log('')

if (failures.length > 0) {
  console.log(`FAIL（${failures.length} 项）`)
  for (const message of failures) console.log(`  - ${message}`)
  process.exitCode = 1
} else {
  console.log('PASS：契约、可读性（无乱码）、健壮性全部通过')
}
