/**
 * 客户端半的离线冒烟测试。
 *
 * 不装 react、不开浏览器：用最小 React 桩 + 最小 slots/document/fetch 桩把
 * lib/client.js 跑一遍，验证
 *   1) 模块能被 __ModuleLoader__ 正常装载（语法 + 工厂返回值）
 *   2) apply() 里两个 slot 注册的 name/id/order 正确
 *   3) 注册进去的组件函数能被调用且不抛错（浅渲染，把函数组件层层展开成文本）
 *   4) 面板能打开、⚙ 能打开设置抽屉、抽屉里出现字段与保存按钮
 *
 * 用法：node dev/smoke-client.mjs        （SMOKE_DEBUG=1 打印渲染出的元素类名）
 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DEBUG = process.env.SMOKE_DEBUG === '1'
const here = path.dirname(fileURLToPath(import.meta.url))
const clientFile = path.join(here, '..', 'lib', 'client.js')

/* --------------------------------------------------------------- React 桩 */

const hooks = { cells: [], index: 0 }

function createElement(type, props, ...children) {
  return { type, props: { ...(props ?? {}), children: children.length === 0 ? undefined : children.length === 1 ? children[0] : children } }
}

const React = {
  createElement,
  Fragment: Symbol('Fragment'),
  useEffect(effect) { hooks.cells[hooks.index++] = { kind: 'effect', effect } },
  useReducer(reducer, initialArg, init) {
    const state = init !== undefined ? init(initialArg) : initialArg
    hooks.cells[hooks.index++] = { kind: 'reducer', state, reducer }
    return [state, () => {}]
  },
  useState(initial) {
    const slot = hooks.index
    const state = typeof initial === 'function' ? initial() : initial
    hooks.cells[slot] = { kind: 'state', state }
    hooks.index += 1
    const setState = (next) => {
      const cell = hooks.cells[slot]
      if (cell === undefined) return
      cell.state = typeof next === 'function' ? next(cell.state) : next
    }
    return [state, setState]
  },
}

/* -------------------------------------------------------------- 环境桩 */

const registrations = []
const injections = []
const headChildren = []

const slots = {
  inject(name, factory) {
    injections.push(name)
    const dispose = factory()
    return typeof dispose === 'function' ? dispose : undefined
  },
  register(registration, component) {
    registrations.push({ registration, component })
    return () => {}
  },
}

const services = { slots }

const ctx = {
  effect(fn) {
    const dispose = fn()
    return typeof dispose === 'function' ? dispose : () => {}
  },
  get(key) { return services[key] },
  service(key) { return services[key] },
}

const CONFIG_FIELDS = [
  { path: 'opacity', kind: 'number', options: null, typeText: 'number', description: '挂件透明度', required: false, volatile: false, default: 0.8, min: 0, max: 1 },
  { path: 'pinned', kind: 'boolean', options: null, typeText: 'boolean', description: null, required: false, volatile: true, default: false, min: null, max: null },
  { path: 'mode', kind: 'enum', options: ['light', 'dark'], typeText: '"light" | "dark"', description: null, required: false, volatile: false, default: null, min: null, max: null },
]

globalThis.window = globalThis
globalThis.window.__ModuleLoader__ = {
  load({ id, factory }) {
    globalThis.__loaded = { id, factory }
  },
}
globalThis.document = {
  createElement() { return { setAttribute() {}, textContent: '', remove() {} } },
  head: { appendChild(node) { headChildren.push(node) } },
}
globalThis.fetch = async (url, options) => ({
  ok: true,
  status: 200,
  async json() {
    if (String(url).includes('/config')) {
      if ((options?.method ?? 'GET') === 'POST') return { status: 'ok', id: 'include:dsh-whale-widget' }
      return {
        status: 'ok',
        id: 'include:dsh-whale-widget',
        name: 'dsh-whale-widget',
        patchId: 'dsh-whale-widget',
        hasConfig: true,
        fields: CONFIG_FIELDS,
        explicit: { opacity: 0.6 },
        inherited: {},
      }
    }
    if (String(url).includes('/session')) {
      if ((options?.method ?? 'GET') === 'POST') {
        const sent = JSON.parse(options?.body ?? '{}')
        return {
          status: 'ok', sessionId: sent.id,
          policy: { disabled: sent.disabled ?? [], disabledMcp: sent.disabledMcp ?? [], updatedAt: null },
          applied: { applied: true, denied: ['compress', 'decompress'], error: null },
          live: true,
          groups: [{ kind: 'plugin', id: 'pkg:billion-context', packageName: 'billion-context', label: 'billion-context', tools: ['compress', 'decompress', 'search_context'], disabled: (sent.disabled ?? []).includes('billion-context') }],
          mcp: [{ kind: 'mcp', id: 'mcp:misakanet', server: 'misakanet', label: 'MCP · misakanet', tools: ['mcp__misakanet__a', 'mcp__misakanet__b'], disabled: false }],
          stats: { visibleTools: 20, ownedTools: 4, denied: ['compress', 'decompress'], appliedAt: null, error: null },
          owners: { scannedAt: null, scannedPackages: 13, ambiguous: [] },
        }
      }
      return {
        status: 'ok', sessionId: 'smoke-session', live: true,
        policy: { disabled: [], disabledMcp: [], updatedAt: null },
        groups: [{ kind: 'plugin', id: 'pkg:billion-context', packageName: 'billion-context', label: 'billion-context', tools: ['compress', 'decompress', 'search_context'], disabled: false }],
        mcp: [{ kind: 'mcp', id: 'mcp:misakanet', server: 'misakanet', label: 'MCP · misakanet', tools: ['mcp__misakanet__a', 'mcp__misakanet__b'], disabled: false }],
        stats: { visibleTools: 20, ownedTools: 4, denied: [], appliedAt: null, error: null },
        owners: { scannedAt: null, scannedPackages: 13, ambiguous: [] },
      }
    }
    if (String(url).includes('/tags')) {
      const entry = {
        label: '余额挂件',
        summary: '右下角常驻小鲸鱼，显示余额与每轮消耗',
        tags: ['余额', '挂件'],
        source: 'ai',
        model: 'deepseek-official/deepseek-flash',
        at: 1700000000000,
      }
      if ((options?.method ?? 'GET') === 'POST') {
        const sent = JSON.parse(options?.body ?? '{}')
        return { status: 'ok', packageName: sent.packageName, ...entry }
      }
      return { status: 'ok', count: 1, entries: { 'dsh-whale-widget': entry }, model: entry.model, probing: null }
    }
    if (String(url).includes('/catalog')) {
      return {
        status: 'ok',
        aiTagsEnabled: true,
        layout: { profileDir: 'X', stateFile: 'X/state.json' },
        bundles: [
          { name: '@deepseek-ai/dsh-base', title: '基础', version: '0.2.1', enabled: true, official: true, installed: true, removable: false, alwaysOn: true, description: '内核', rowCount: 1 },
          { name: 'dsh-whale-widget', title: '小鲸鱼', version: '0.4.2', enabled: true, official: false, installed: true, removable: true, alwaysOn: false, description: '右下角余额挂件，可自定义泡泡内容', rowCount: 1, rowIds: ['include:dsh-whale-widget'], aiTag: { label: '余额挂件', summary: '右下角常驻小鲸鱼，显示余额与每轮消耗', tags: ['余额', '挂件'], source: 'ai', model: 'deepseek-official/deepseek-flash' } },
        ],
        installed: ['@deepseek-ai/dsh-base', 'dsh-whale-widget'],
        rows: [
          { id: 'include:plugin-console', moduleName: 'dsh-plugin-steward', title: '插件管家', enabled: true, phase: 'active', bundle: null, alwaysOn: false },
        ],
        peers: [],
        discovery: { firstRun: false, newBundles: [], newRows: [], pendingBundles: [{ name: 'dsh-new-thing' }], pendingRows: [], scannedAt: new Date().toISOString() },
      }
    }
    return { status: 'ok', pendingNew: 1, scannedAt: new Date().toISOString() }
  },
})

/* -------------------------------------------------------------- 装载 + 验证 */

const code = await readFile(clientFile, 'utf8')
// eslint-disable-next-line no-new-func
new Function(code)()

const loaded = globalThis.__loaded
if (loaded === undefined) throw new Error('__ModuleLoader__.load 没有被调用')
if (loaded.id !== 'dsh-plugin-steward') throw new Error(`模块 id 不对: ${loaded.id}`)

const moduleExports = loaded.factory((specifier) => {
  if (specifier === 'react') return React
  throw new Error(`未预料的 require: ${specifier}`)
})

if (typeof moduleExports.apply !== 'function') throw new Error('缺少 apply()')
if (!Array.isArray(moduleExports.inject) || !moduleExports.inject.includes('slots')) throw new Error('inject 里缺少 slots')

hooks.cells = []
hooks.index = 0
moduleExports.apply(ctx)

await new Promise((resolve) => setTimeout(resolve, 50))

const problems = []
const expected = [
  { name: 'conversation.input.left', id: 'plugin-console-trigger' },
  { name: 'shell.overlay', id: 'plugin-console-panel' },
  { name: 'settings.section', id: 'plugin-console' },
]
for (const want of expected) {
  const hit = registrations.find(r => r.registration?.name === want.name && r.registration?.id === want.id)
  if (hit === undefined) problems.push(`没有注册 ${want.name}#${want.id}`)
  else if (typeof hit.component !== 'function') problems.push(`${want.id} 的组件不是函数`)
}

/* 浅渲染：把函数组件展开，收集文本与宿主元素，看会不会抛错 */
function expand(node, depth = 0, out = [], elements = []) {
  if (node === null || node === undefined || node === false) return out
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  if (depth > 24) return out
  if (Array.isArray(node)) { for (const child of node) expand(child, depth + 1, out, elements); return out }
  if (typeof node.type === 'function') {
    hooks.cells = []
    hooks.index = 0
    return expand(node.type(node.props ?? {}), depth + 1, out, elements)
  }
  elements.push(node)
  if (node.type === React.Fragment) return expand(node.props?.children, depth + 1, out, elements)
  return expand(node.props?.children, depth + 1, out, elements)
}

function render(component, props) {
  hooks.cells = []
  hooks.index = 0
  const elements = []
  const text = expand(component(props), 0, [], elements)
  return { text, elements }
}

const seeAlso = []
for (const item of registrations) {
  const props = { sessionId: 'smoke-session', useSession: () => undefined, useInput: () => undefined, inputActions: {} }
  try {
    const { text } = render(item.component, props)
    if (text.join(' ').trim().length === 0) seeAlso.push(item)
    else console.log(`  ${item.registration.id} 渲染文本片段: ${text.join(' ').slice(0, 80).replace(/\s+/g, ' ')}…`)
  } catch (error) {
    problems.push(`${item.registration.id} 渲染抛错: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/* 把触发器里所有 onClick 点一遍（打开浮层），再渲染其余组件：应能渲染出内容 */
const trigger = registrations.find(r => r.registration?.id === 'plugin-console-trigger')
if (trigger !== undefined) {
  const { elements } = render(trigger.component, { sessionId: 'smoke-session' })
  const clickable = elements.filter(el => typeof el.props?.onClick === 'function')
  if (clickable.length === 0) problems.push('触发器上没有可点击元素（点不开面板）')
  for (const el of clickable) {
    try { el.props.onClick({ preventDefault() {}, stopPropagation() {} }) } catch (error) {
      problems.push(`点击触发器抛错: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

for (const item of seeAlso) {
  try {
    const { text } = render(item.component, { sessionId: 'smoke-session' })
    const joined = text.join(' ').replace(/\s+/g, ' ').trim()
    if (joined.length === 0) problems.push(`${item.registration.id} 点击后仍然渲染出空内容`)
    else console.log(`  ${item.registration.id} 打开后渲染文本片段: ${joined.slice(0, 120)}…`)
  } catch (error) {
    problems.push(`${item.registration.id} 打开后渲染抛错: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/* 打开设置抽屉：点插件行上的 ⚙ → 等 fetch → 再渲染面板，应出现全部字段 */
const panelReg = registrations.find(r => r.registration?.id === 'plugin-console-panel')
if (panelReg === undefined) problems.push('没有找到面板注册')
else {
  await new Promise((resolve) => setTimeout(resolve, 40))
  const first = render(panelReg.component, {})
  if (DEBUG) console.log('DEBUG list classes: ' + first.elements.map(el => String(el.props?.className)).join(' | '))
  // 面板现在默认落在「本对话」页，先切回「全局」再测全局列表的行行为
  const globalBtn = first.elements.find(el => el.props?.className === 'pc-scopebtn' && String(el.props?.children).includes('全局'))
  if (globalBtn === undefined) problems.push('面板头部没有「全局」切换按钮')
  else { globalBtn.props.onClick() }
  await new Promise((resolve) => setTimeout(resolve, 30))
  const globalView = render(panelReg.component, {})
  const gear = globalView.elements.find(el => el.props?.className === 'pc-gear' && el.props?.children === '⚙')
  if (gear === undefined) problems.push('插件行上没有 ⚙ 设置按钮')
  else {
    try { gear.props.onClick() } catch (error) {
      problems.push(`点击 ⚙ 抛错: ${error instanceof Error ? error.message : String(error)}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 80))
    const { text, elements } = render(panelReg.component, {})
    if (DEBUG) console.log('DEBUG drawer classes: ' + elements.map(el => String(el.props?.className)).join(' | '))
    const joined = text.join(' ').replace(/\s+/g, ' ')
    console.log(`  plugin-console-panel 设置抽屉文本片段: ${joined.slice(0, 200)}…`)
    for (const want of ['opacity', 'pinned', 'mode', '挂件透明度', '保存']) {
      if (!joined.includes(want)) problems.push(`设置抽屉里缺少「${want}」`)
    }
    const inputs = elements.filter(el => el.props?.className === 'pc-input')
    if (inputs.length < 2) problems.push(`设置抽屉里字段控件只有 ${inputs.length} 个（应为 2：数字框 + 下拉）`)
    const save = elements.find(el => el.props?.className === 'pc-btn' && el.props?.['data-primary'] === '1')
    if (save === undefined) problems.push('设置抽屉里没有保存按钮')
    else if (save.props.disabled !== true) problems.push('没改动时保存按钮应当禁用')
  }
}

/* 折叠 / 展开 + AI 中文标签：行默认只显示名字，点箭头才出描述；有标签时名字用标签 */
if (panelReg !== undefined) {
  const back = render(panelReg.component, {})
  const cancelBtn = back.elements.find(el => el.props?.className === 'pc-btn' && el.props?.['data-primary'] !== '1')
  if (cancelBtn !== undefined) cancelBtn.props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 30))

  const collapsed = render(panelReg.component, {})
  const collapsedText = collapsed.text.join(' ').replace(/\s+/g, ' ')
  if (!collapsedText.includes('余额挂件')) problems.push('列表里没有显示 AI 中文标签「余额挂件」')
  if (collapsedText.includes('可自定义泡泡内容')) problems.push('行默认折叠时不应显示描述')
  const aiBtn = collapsed.elements.find(el => el.props?.className === 'pc-gear' && el.props?.children === '中')
  if (aiBtn === undefined) problems.push('插件行上没有「中」AI 标签按钮')

  const expander = collapsed.elements.find(el => el.props?.className === 'pc-exp')
  if (expander === undefined) problems.push('插件行上没有展开箭头 .pc-exp')
  else {
    try { expander.props.onClick() } catch (error) {
      problems.push(`点击展开箭头抛错: ${error instanceof Error ? error.message : String(error)}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 30))
    const opened = render(panelReg.component, {})
    const openedText = opened.text.join(' ').replace(/\s+/g, ' ')
    console.log(`  plugin-console-panel 展开后文本片段: ${openedText.slice(0, 160)}…`)
    if (!openedText.includes('可自定义泡泡内容')) problems.push('展开后没有显示插件描述')
    if (opened.elements.filter(el => el.props?.className === 'pc-desc').length === 0) problems.push('展开后没有 .pc-desc 元素')
    if (opened.elements.filter(el => el.props?.className === 'pc-tag').length === 0) problems.push('展开后没有 .pc-tag 标签胶囊')
    if (opened.elements.filter(el => el.props?.className === 'pc-aisum').length === 0) problems.push('展开后没有 .pc-aisum AI 说明行')
  }
}

/* 本对话视图：从全局列表切到「本对话」→ 出现插件/MCP 分组与开关 → 点开关走 POST */
if (panelReg !== undefined) {
  // 先把会话 id 记进 store（触发器渲染时会同步写入）
  const t = registrations.find(r => r.registration?.id === 'plugin-console-trigger')
  if (t !== undefined) render(t.component, { sessionId: 'smoke-session' })
  await new Promise((resolve) => setTimeout(resolve, 30))
  // 关掉设置抽屉，回到列表
  const drawer = render(panelReg.component, {})
  const cancel = drawer.elements.find(el => el.props?.className === 'pc-btn' && el.props?.['data-primary'] !== '1')
  if (cancel !== undefined) cancel.props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 30))
  const listView = render(panelReg.component, {})
  const scopeBtn = listView.elements.find(el => el.props?.className === 'pc-scopebtn' && String(el.props?.children).includes('本对话'))
  if (scopeBtn === undefined) problems.push('面板头部没有「本对话」切换按钮')
  else {
    try { scopeBtn.props.onClick() } catch (error) {
      problems.push(`点击「本对话」抛错: ${error instanceof Error ? error.message : String(error)}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 80))
    const sessionView = render(panelReg.component, {})
    if (DEBUG) console.log('DEBUG session classes: ' + sessionView.elements.map(el => String(el.props?.className)).join(' | '))
    const joined = sessionView.text.join(' ').replace(/\s+/g, ' ')
    console.log(`  plugin-console-panel 本对话文本片段: ${joined.slice(0, 160)}…`)
    for (const want of ['只作用于本对话', 'billion-context', 'MCP · misakanet', '已拦截', '官方插件']) {
      if (!joined.includes(want)) problems.push(`本对话视图里缺少「${want}」`)
    }
    // 与全局页同一套行布局：每项一条 .pc-row，且官方插件合并成一条可展开项
    const sessionRows = sessionView.elements.filter(el => el.props?.className === 'pc-row')
    if (sessionRows.length < 3) problems.push(`本对话视图里只有 ${sessionRows.length} 条插件行（应 ≥3：插件 + MCP + 官方）`)
    if (!joined.includes('个工具')) problems.push('本对话视图的行里没有「N 个工具」说明')
    // 展开官方插件那一条
    const officialExp = sessionView.elements.filter(el => el.props?.className === 'pc-exp')[sessionRows.length - 1]
    if (officialExp !== undefined) {
      try { officialExp.props.onClick() } catch (error) {
        problems.push(`展开官方插件抛错: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    const switches = sessionView.elements.filter(el => el.props?.className === 'pc-sw')
    if (switches.length < 2) problems.push(`本对话视图里开关只有 ${switches.length} 个（应 ≥2：插件 + MCP）`)
    else {
      try { switches[0].props.onClick() } catch (error) {
        problems.push(`点击本对话开关抛错: ${error instanceof Error ? error.message : String(error)}`)
      }
      await new Promise((resolve) => setTimeout(resolve, 80))
      const after = render(panelReg.component, {})
      const afterText = after.text.join(' ').replace(/\s+/g, ' ')
      if (!afterText.includes('已拦截')) problems.push('切换后没有显示拦截数量')
      if (!afterText.includes('已拦截 2')) problems.push('切换后拦截数量没有更新（应显示「已拦截 2 个」）')
    }
  }
}

console.log(`\n注入点: ${injections.join(', ')}`)
console.log(`注册数: ${registrations.length}`)
console.log(`样式注入: ${headChildren.length} 个 <style>`)

if (problems.length > 0) {
  console.error('\n冒烟测试失败:')
  for (const problem of problems) console.error(' - ' + problem)
  process.exit(1)
}
console.log('\n冒烟测试通过 ✅')
