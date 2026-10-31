/**
 * 插件管家 · 客户端半
 *
 * 单文件、无需构建：宿主通过 window.__ModuleLoader__ 直接加载。
 * 只 require("react")，其余全部用宿主注入的 slots 服务 + 同源 fetch。
 *
 * 入口：对话输入框左侧（conversation.input.left）一个小药丸按钮；点开后在
 * shell.overlay 里渲染浮层，列出本机全部插件、可全局启停、并显示"新发现的插件"。
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-steward',
  factory: (require) => {
    // 宿主加载器约定：factory 自己建 module/exports，返回 module.exports
    var module = { exports: {} }
    var exports = module.exports
    const React = require('react')
    const h = React.createElement
    const API = '/plugin-console/api'

    /* ------------------------------------------------------------ 迷你 store */

    const store = {
      open: false,
      loading: false,
      loaded: false,
      error: null,
      data: null,
      filter: '',
      tab: 'plugins',
      busy: null,
      toast: null,
      pendingNew: 0,
      view: 'list',
      config: null,
      scope: 'global',
      sessionId: null,
      gate: null,
      gateBusy: null,
      described: {},
      expanded: {},
    }
    const listeners = new Set()
    const emit = () => { for (const fn of Array.from(listeners)) fn() }
    const patch = (next) => { Object.assign(store, next); emit() }

    function useStore() {
      const [, force] = React.useReducer((n) => n + 1, 0)
      React.useEffect(() => {
        listeners.add(force)
        return () => { listeners.delete(force) }
      }, [])
      return store
    }

    let toastTimer = null
    function toast(message) {
      patch({ toast: message })
      if (toastTimer !== null) clearTimeout(toastTimer)
      toastTimer = setTimeout(() => patch({ toast: null }), 4200)
    }

    async function load(options = {}) {
      patch({ loading: true, error: null })
      try {
        const response = await fetch(`${API}/catalog${options.ack ? '?ack=1' : ''}`, { headers: { accept: 'application/json' } })
        const body = await response.json()
        if (body.status !== 'ok') throw new Error(body.message ?? `HTTP ${response.status}`)
        const pendingNew = (body.discovery?.newBundles?.length ?? 0) + (body.discovery?.newRows?.length ?? 0)
        patch({ data: body, loading: false, loaded: true, pendingNew })
        return body
      } catch (error) {
        patch({ loading: false, error: error instanceof Error ? error.message : String(error) })
        return null
      }
    }

    async function refreshStatus() {
      try {
        const response = await fetch(`${API}/status`, { headers: { accept: 'application/json' } })
        const body = await response.json()
        if (body.status === 'ok') patch({ pendingNew: body.pendingNew ?? 0 })
      } catch {
        /* 状态徽章失败不打扰用户 */
      }
    }

    async function togglePlugin(kind, id, enabled) {
      patch({ busy: `${kind}:${id}` })
      try {
        const response = await fetch(`${API}/toggle`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ kind, id, enabled }),
        })
        const body = await response.json()
        if (body.status !== 'ok') throw new Error(body.message ?? `HTTP ${response.status}`)
        const application = body.result?.application
        if (application === 'restart-required') toast('已保存，需重启 DSH 才能生效')
        else if (application === 'overridden') toast('已保存，但被 profile 的覆盖行挡住了')
        else if (application === 'failed') toast(`失败：${body.result?.error ?? '未知原因'}`)
        else if (application === 'cancelled') toast('已取消')
        else toast(enabled ? '已启用' : '已停用')
        await load()
      } catch (error) {
        toast(`操作失败：${error instanceof Error ? error.message : String(error)}`)
      } finally {
        patch({ busy: null })
      }
    }

    async function acknowledge() {
      try {
        await fetch(`${API}/ack`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
        await load()
        toast('已纳入管理')
      } catch (error) {
        toast(`操作失败：${error instanceof Error ? error.message : String(error)}`)
      }
    }

    /* ------------------------------------------------------ 自动描述 */

    /** 让宿主读插件自己的 README/源码，生成一句 ≤90 字的功能描述。 */
    async function describeOne(packageName) {
      patch({ busy: `describe:${packageName}` })
      try {
        const response = await fetch(`${API}/describe?id=${encodeURIComponent(packageName)}&refresh=1`, { headers: { accept: 'application/json' } })
        const body = await response.json()
        if (body.status !== 'ok') throw new Error(body.message ?? `HTTP ${response.status}`)
        if (typeof body.text !== 'string' || body.text.length === 0) {
          toast('没找到可读的插件信息（README / package.json / 界面注入点都没有）')
        } else {
          patch({ described: { ...store.described, [packageName]: body } })
          toast(`已按插件信息生成描述（来源：${body.source}）`)
        }
      } catch (error) {
        toast(`生成失败：${error instanceof Error ? error.message : String(error)}`)
      } finally {
        patch({ busy: null })
      }
    }

    /* ------------------------------------------------------ AI 中文标签 */

    /**
     * 让宿主把插件自己的信息喂给当前默认模型，生成「中文标签 + 一句话 + 关键词」。
     * 结果由宿主记在 <profile>/.plugin-console/tags.json，所以它是记忆的：
     * 刷新页面、重启 DSH 都还在；再点一次就是重算。
     */
    async function generateTag(packageName) {
      patch({ busy: `tag:${packageName}` })
      try {
        const response = await fetch(`${API}/tags`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ packageName }),
        })
        const body = await response.json()
        if (body.status !== 'ok') throw new Error(body.message ?? `HTTP ${response.status}`)
        const how = body.source === 'ai' ? `${body.model ?? '模型'} 生成` : '按插件信息提炼（没调用模型）'
        toast(`中文标签：${body.label}（${how}）`)
        await load()
      } catch (error) {
        toast(`生成失败：${error instanceof Error ? error.message : String(error)}`)
      } finally {
        patch({ busy: null })
      }
    }

    /* ------------------------------------------------------ 面板拖动与位置 */

    const POS_KEY = 'plugin-console:panel-pos:v1'

    function readSavedPos() {
      try {
        const raw = window.localStorage.getItem(POS_KEY)
        if (raw === null) return null
        const parsed = JSON.parse(raw)
        if (parsed !== null && typeof parsed === 'object' && Number.isFinite(parsed.x) && Number.isFinite(parsed.y)) {
          return { x: parsed.x, y: parsed.y }
        }
      } catch {
        /* localStorage 不可用 / 内容坏了：当没存过 */
      }
      return null
    }

    function savePos(x, y) {
      try {
        window.localStorage.setItem(POS_KEY, JSON.stringify({ x: Math.round(x), y: Math.round(y) }))
      } catch {
        /* 存不下就只影响"记住位置"，不影响使用 */
      }
    }

    function clearSavedPos() {
      try {
        window.localStorage.removeItem(POS_KEY)
      } catch {
        /* 忽略 */
      }
    }

    /** 面板至少留 96px 在视口里、标题栏至少露 72px，避免拖出去之后找不回来。 */
    function clampPos(el, x, y) {
      const rect = el.getBoundingClientRect()
      const width = rect.width > 0 ? rect.width : 480
      const margin = 8
      const minX = margin - width + 96
      const maxX = Math.max(minX, window.innerWidth - 96)
      const minY = margin
      const maxY = Math.max(minY, window.innerHeight - 72)
      return {
        x: Math.min(Math.max(minX, x), maxX),
        y: Math.min(Math.max(minY, y), maxY),
      }
    }

    function applyPos(el) {
      const saved = readSavedPos()
      if (saved === null) return
      const next = clampPos(el, saved.x, saved.y)
      el.style.right = 'auto'
      el.style.left = `${next.x}px`
      el.style.top = `${next.y}px`
    }

    function resetPos(el) {
      clearSavedPos()
      el.style.left = ''
      el.style.top = ''
      el.style.right = ''
    }

    /** 顶部拖动：拖动时直接改 DOM（不触发 React 重渲染，跟手），松手后记住位置。 */
    function beginDrag(event, el) {
      if (event.button !== 0) return
      const target = event.target
      if (target !== null && typeof target.closest === 'function' && target.closest('button,input,select,textarea,a')) return
      const rect = el.getBoundingClientRect()
      const startX = event.clientX
      const startY = event.clientY
      const originLeft = rect.left
      const originTop = rect.top
      let moved = false
      const onMove = (moveEvent) => {
        const next = clampPos(el, originLeft + (moveEvent.clientX - startX), originTop + (moveEvent.clientY - startY))
        el.style.right = 'auto'
        el.style.left = `${next.x}px`
        el.style.top = `${next.y}px`
        moved = true
      }
      const onUp = () => {
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', onUp)
        el.removeAttribute('data-dragging')
        if (moved) savePos(Number.parseFloat(el.style.left) || 0, Number.parseFloat(el.style.top) || 0)
      }
      el.setAttribute('data-dragging', '1')
      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp)
      event.preventDefault()
    }

    /** 每个面板的标题栏都挂同一套拖动手势；双击复位到默认角落。 */
    function headProps() {
      return {
        className: 'pc-head',
        title: '按住这里可以拖动面板；双击回到右上角',
        onMouseDown: (event) => {
          const el = typeof event.currentTarget.closest === 'function' ? event.currentTarget.closest('.pc-panel') : null
          if (el !== null) beginDrag(event, el)
        },
        onDoubleClick: (event) => {
          const el = typeof event.currentTarget.closest === 'function' ? event.currentTarget.closest('.pc-panel') : null
          if (el !== null) resetPos(el)
        },
      }
    }

    /* ------------------------------------------------------ 本对话放行 */

    /** 拉「本对话」视图：哪些插件/MCP 的工具可以在这个对话里用。 */
    async function loadGate(sessionId) {
      if (typeof sessionId !== 'string' || sessionId.length === 0) {
        patch({ gate: { error: '还没有会话 id（新对话首个请求后才有）' } })
        return null
      }
      patch({ gate: { loading: true } })
      try {
        const response = await fetch(`${API}/session?id=${encodeURIComponent(sessionId)}`, { headers: { accept: 'application/json' } })
        const body = await response.json()
        if (body.status !== 'ok') throw new Error(body.message ?? `HTTP ${response.status}`)
        patch({ gate: body })
        return body
      } catch (error) {
        patch({ gate: { error: error instanceof Error ? error.message : String(error) } })
        return null
      }
    }

    /** 改本对话的放行策略：disabled / disabledMcp 是要拦下的插件包名与 MCP server 名。 */
    async function saveGate(sessionId, disabled, disabledMcp) {
      if (store.gateBusy === 'save') return null
      patch({ gateBusy: 'save' })
      try {
        const response = await fetch(`${API}/session`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: sessionId, disabled, disabledMcp }),
        })
        const body = await response.json()
        if (body.status !== 'ok') throw new Error(body.message ?? `HTTP ${response.status}`)
        patch({ gate: body })
        const applied = body.applied
        if (applied?.error != null) toast(`已保存，但当前未生效：${applied.error}`)
        else if ((applied?.denied ?? []).length === 0) toast('已保存（本对话当前没有需要拦截的工具）')
        else toast(`已保存，本对话下一轮请求起隐藏 ${applied.denied.length} 个工具`)
        return body
      } catch (error) {
        toast(`操作失败：${error instanceof Error ? error.message : String(error)}`)
        return null
      } finally {
        patch({ gateBusy: null })
      }
    }

    /* ---------------------------------------------------------- 设置抽屉 */

    /** 把宿主给的 explicit/default 拍平成可编辑草稿（值一律先当字符串处理）。 */
    function draftFrom(body) {
      const explicit = body.explicit ?? {}
      const draft = {}
      for (const field of body.fields ?? []) {
        const has = Object.prototype.hasOwnProperty.call(explicit, field.path)
        const raw = has ? explicit[field.path] : (field.default ?? null)
        if (field.kind === 'boolean') draft[field.path] = has ? explicit[field.path] === true : (raw === true ? true : null)
        else if (field.kind === 'json') draft[field.path] = raw === null || raw === undefined ? '' : JSON.stringify(raw, null, 2)
        else draft[field.path] = raw === null || raw === undefined ? '' : String(raw)
      }
      return draft
    }

    async function openConfig(id, rowIds = []) {
      patch({ view: 'config', config: { id, rowIds, loading: true, error: null, hasConfig: false, fields: [], explicit: {}, initial: {}, saving: false } })
      try {
        const response = await fetch(`${API}/config?id=${encodeURIComponent(id)}`, { headers: { accept: 'application/json' } })
        const body = await response.json()
        if (body.status !== 'ok') throw new Error(body.message ?? `HTTP ${response.status}`)
        const initial = draftFrom(body)
        patch({
          config: {
            id, rowIds, loading: false, error: null, saving: false,
            name: body.name ?? null, patchId: body.patchId ?? null,
            hasConfig: body.hasConfig === true,
            fields: body.fields ?? [], explicit: body.explicit ?? {}, initial,
          },
        })
      } catch (error) {
        patch({ config: { id, rowIds, loading: false, saving: false, error: error instanceof Error ? error.message : String(error), hasConfig: false, fields: [], explicit: {}, initial: {} } })
      }
    }

    /** 只提交用户真正改过的字段，未动的保留原 explicit，避免把默认值固化进 patch。 */
    function buildConfig(cfg, draft) {
      const config = Object.assign({}, cfg.explicit ?? {})
      const touched = []
      for (const field of cfg.fields ?? []) {
        const raw = draft[field.path]
        if (raw === cfg.initial[field.path]) continue
        touched.push(field.path)
        if (raw === '' || raw === null) { delete config[field.path]; continue }
        if (field.kind === 'boolean') config[field.path] = raw === true
        else if (field.kind === 'number') {
          const value = Number(raw)
          if (Number.isNaN(value)) throw new Error(`${field.path} 不是合法数字`)
          config[field.path] = value
        } else if (field.kind === 'json') {
          try { config[field.path] = JSON.parse(raw) } catch { throw new Error(`${field.path} 不是合法 JSON`) }
        } else config[field.path] = raw
      }
      return { config, touched }
    }

    async function saveConfig(cfg, draft) {
      let payload
      try {
        payload = buildConfig(cfg, draft)
      } catch (error) {
        toast(error instanceof Error ? error.message : String(error))
        return
      }
      if (payload.touched.length === 0) {
        patch({ view: 'list', config: null })
        toast('没有改动')
        return
      }
      patch({ config: Object.assign({}, store.config, { saving: true }) })
      try {
        const response = await fetch(`${API}/config`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: cfg.id, config: payload.config }),
        })
        const body = await response.json()
        if (body.status !== 'ok') throw new Error(body.message ?? `HTTP ${response.status}`)
        patch({ view: 'list', config: null })
        toast(`已保存 ${payload.touched.length} 项，插件将按新配置重载`)
        await load()
      } catch (error) {
        if (store.config !== null) patch({ config: Object.assign({}, store.config, { saving: false }) })
        toast(`保存失败：${error instanceof Error ? error.message : String(error)}`)
      }
    }



    /* ---------------------------------------------------------------- 样式 */

    const CSS = `
.pc-pill{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 10px;border-radius:999px;cursor:pointer;
  border:1px solid color-mix(in srgb,currentColor 18%,transparent);background:color-mix(in srgb,currentColor 6%,transparent);
  color:inherit;font-size:12px;line-height:1;font-family:inherit;transition:background .15s,border-color .15s}
.pc-pill:hover{background:color-mix(in srgb,currentColor 12%,transparent);border-color:color-mix(in srgb,currentColor 28%,transparent)}
.pc-pill[data-open="1"]{background:color-mix(in srgb,currentColor 16%,transparent);border-color:color-mix(in srgb,currentColor 36%,transparent)}
.pc-dot{position:relative;display:inline-block;width:6px;height:6px;border-radius:50%;background:#f5a524}
.pc-dot[data-count]:after{content:attr(data-count);position:absolute;left:8px;top:-6px;font-size:9px;color:#f5a524}
.pc-backdrop{position:fixed;inset:0;z-index:2147483000;background:transparent}
.pc-panel{position:fixed;top:56px;right:20px;z-index:2147483001;width:min(480px,calc(100vw - 40px));max-height:min(74vh,720px);
  display:flex;flex-direction:column;border-radius:14px;overflow:hidden;color:inherit;
  background:color-mix(in srgb,Canvas 88%,transparent);backdrop-filter:blur(18px) saturate(1.2);
  border:1px solid color-mix(in srgb,currentColor 16%,transparent);
  box-shadow:0 18px 48px rgba(0,0,0,.28), 0 2px 8px rgba(0,0,0,.16);font-size:13px}
@media (prefers-color-scheme:dark){.pc-panel{background:color-mix(in srgb,#14141a 88%,transparent)}}
.pc-head{display:flex;align-items:center;gap:8px;padding:12px 14px;border-bottom:1px solid color-mix(in srgb,currentColor 10%,transparent);
  cursor:grab;user-select:none;touch-action:none}
.pc-panel[data-dragging="1"] .pc-head{cursor:grabbing}
.pc-panel[data-dragging="1"]{transition:none;box-shadow:0 24px 64px rgba(0,0,0,.34), 0 2px 10px rgba(0,0,0,.2)}
.pc-head button{cursor:pointer}
.pc-title{font-weight:600;font-size:14px;margin-right:auto}
.pc-x{border:0;background:transparent;color:inherit;cursor:pointer;font-size:16px;opacity:.6;padding:2px 6px;border-radius:6px}
.pc-x:hover{opacity:1;background:color-mix(in srgb,currentColor 10%,transparent)}
.pc-tabs{display:flex;gap:4px;padding:8px 12px 0}
.pc-tab{border:0;background:transparent;color:inherit;opacity:.62;cursor:pointer;font:inherit;font-size:12px;
  padding:5px 9px;border-radius:8px}
.pc-tab:hover{background:color-mix(in srgb,currentColor 8%,transparent);opacity:.9}
.pc-tab[data-active="1"]{background:color-mix(in srgb,currentColor 13%,transparent);opacity:1;font-weight:600}
.pc-search{margin:8px 12px;padding:7px 10px;border-radius:8px;border:1px solid color-mix(in srgb,currentColor 16%,transparent);
  background:color-mix(in srgb,currentColor 4%,transparent);color:inherit;font:inherit;font-size:12px;outline:none}
.pc-search:focus{border-color:color-mix(in srgb,currentColor 38%,transparent)}
.pc-body{overflow:auto;padding:4px 8px 12px}
.pc-note{margin:8px 12px;padding:8px 10px;border-radius:8px;font-size:11.5px;line-height:1.5;
  background:color-mix(in srgb,#f5a524 14%,transparent);border:1px solid color-mix(in srgb,#f5a524 30%,transparent)}
.pc-note b{font-weight:600}
.pc-sec{padding:8px 6px 4px;font-size:11px;opacity:.55;letter-spacing:.04em}
.pc-row{display:flex;gap:10px;align-items:flex-start;padding:9px 8px;border-radius:9px}
.pc-row:hover{background:color-mix(in srgb,currentColor 7%,transparent)}
.pc-ico{width:26px;height:26px;flex:0 0 26px;border-radius:7px;display:flex;align-items:center;justify-content:center;
  background:color-mix(in srgb,currentColor 9%,transparent);font-size:13px;overflow:hidden}
.pc-ico img{width:100%;height:100%;object-fit:cover}
.pc-main{flex:1;min-width:0}
.pc-name{display:flex;align-items:center;gap:6px;font-weight:600;font-size:12.5px;line-height:1.35}
.pc-ver{font-weight:400;opacity:.45;font-size:10.5px}
.pc-new{font-size:9.5px;padding:1px 5px;border-radius:999px;background:#f5a524;color:#231a05;font-weight:700}
.pc-desc{margin-top:2px;font-size:11.5px;line-height:1.5;opacity:.66;
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.pc-meta{margin-top:3px;font-size:10.5px;opacity:.42;font-family:ui-monospace,Menlo,Consolas,monospace;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pc-sw{flex:0 0 38px;width:38px;height:21px;border-radius:999px;border:0;padding:0;cursor:pointer;position:relative;
  background:color-mix(in srgb,currentColor 20%,transparent);transition:background .16s}
.pc-sw[data-on="1"]{background:#3b82f6}
.pc-sw:disabled{opacity:.45;cursor:not-allowed}
.pc-knob{position:absolute;top:2.5px;left:2.5px;width:16px;height:16px;border-radius:50%;background:#fff;
  transition:transform .16s;box-shadow:0 1px 3px rgba(0,0,0,.3)}
.pc-sw[data-on="1"] .pc-knob{transform:translateX(17px)}
.pc-lock{flex:0 0 auto;font-size:12px;opacity:.5}
.pc-empty{padding:26px 12px;text-align:center;font-size:12px;opacity:.55;line-height:1.7}
.pc-toast{position:fixed;bottom:28px;left:50%;transform:translateX(-50%);z-index:2147483002;
  padding:9px 16px;border-radius:999px;font-size:12px;background:#242430;color:#f5f5f7;
  box-shadow:0 8px 24px rgba(0,0,0,.3)}
.pc-foot{display:flex;align-items:center;gap:8px;padding:8px 14px;border-top:1px solid color-mix(in srgb,currentColor 10%,transparent);font-size:11px;opacity:.6}
.pc-link{border:0;background:transparent;color:#3b82f6;cursor:pointer;font:inherit;font-size:11px;padding:0}
.pc-gear{flex:0 0 auto;width:22px;height:22px;border:0;border-radius:6px;background:transparent;color:inherit;opacity:.45;cursor:pointer;font-size:12px;line-height:1;padding:0;margin-top:1px}
.pc-gear:hover{opacity:1;background:color-mix(in srgb,currentColor 12%,transparent)}
.pc-back{border:0;background:transparent;color:inherit;cursor:pointer;font-size:15px;opacity:.7;padding:0 6px;border-radius:6px;line-height:1.4}
.pc-back:hover{opacity:1;background:color-mix(in srgb,currentColor 10%,transparent)}
.pc-field{display:flex;gap:10px;align-items:flex-start;padding:8px 10px;border-radius:8px}
.pc-field:hover{background:color-mix(in srgb,currentColor 5%,transparent)}
.pc-fmain{flex:1;min-width:0}
.pc-flabel{font-size:12px;font-weight:600;font-family:ui-monospace,Menlo,Consolas,monospace;display:flex;gap:6px;align-items:center;word-break:break-all}
.pc-fhint{margin-top:2px;font-size:10.5px;opacity:.5;line-height:1.45}
.pc-vol{font-size:9px;padding:1px 4px;border-radius:4px;background:color-mix(in srgb,#f5a524 22%,transparent);font-weight:600;white-space:nowrap}
.pc-input{min-width:0;width:100%;box-sizing:border-box;padding:5px 8px;border-radius:7px;
  border:1px solid color-mix(in srgb,currentColor 18%,transparent);background:color-mix(in srgb,currentColor 4%,transparent);
  color:inherit;font:inherit;font-size:12px;outline:none}
.pc-input:focus{border-color:color-mix(in srgb,currentColor 40%,transparent)}
.pc-json{font-family:ui-monospace,Menlo,Consolas,monospace;resize:vertical}
.pc-ctrls{flex:0 0 auto;width:190px}
.pc-actions{display:flex;gap:8px;align-items:center;padding:10px 14px;border-top:1px solid color-mix(in srgb,currentColor 10%,transparent)}
.pc-btn{border:1px solid color-mix(in srgb,currentColor 20%,transparent);background:color-mix(in srgb,currentColor 7%,transparent);
  color:inherit;font:inherit;font-size:12px;padding:6px 12px;border-radius:8px;cursor:pointer}
.pc-btn:hover{background:color-mix(in srgb,currentColor 13%,transparent)}
.pc-btn[data-primary="1"]{background:#3b82f6;border-color:#3b82f6;color:#fff}
.pc-btn:disabled{opacity:.5;cursor:not-allowed}
.pc-rowids{display:flex;flex-wrap:wrap;gap:4px;margin:6px 12px 0}
.pc-rowid{border:1px solid color-mix(in srgb,currentColor 18%,transparent);background:transparent;color:inherit;
  font:inherit;font-size:10.5px;padding:2px 7px;border-radius:999px;cursor:pointer;opacity:.72}
.pc-rowid[data-active="1"]{background:color-mix(in srgb,currentColor 14%,transparent);opacity:1;font-weight:600}
.pc-scope{display:inline-flex;gap:2px;padding:2px;border-radius:999px;background:color-mix(in srgb,currentColor 8%,transparent);margin-left:2px}
.pc-scopebtn{font:inherit;font-size:11px;padding:2px 8px;border:0;border-radius:999px;background:transparent;color:inherit;cursor:pointer;opacity:.6}
.pc-scopebtn[data-active="1"]{background:color-mix(in srgb,currentColor 16%,transparent);opacity:1;font-weight:600}
.pc-srow{display:flex;align-items:flex-start;gap:8px;padding:8px 4px;border-top:1px solid color-mix(in srgb,currentColor 8%,transparent)}
.pc-stools{font-size:10.5px;opacity:.55;margin-top:3px;word-break:break-all}
.pc-stools[data-dark="1"]{opacity:.35;text-decoration:line-through}
.pc-auto{font-size:10px;padding:1px 5px;border-radius:999px;border:1px solid color-mix(in srgb,currentColor 22%,transparent);opacity:.6}
.pc-settings{display:flex;flex-direction:column;gap:14px;padding:4px 2px;font-size:13px}
.pc-setting-head{display:flex;align-items:flex-start;gap:10px}
.pc-setting-title{font-size:15px;font-weight:600}
.pc-setting-sub{font-size:12px;opacity:.62;margin-top:3px;line-height:1.5}
.pc-setting-group{border:1px solid color-mix(in srgb,currentColor 12%,transparent);border-radius:10px;padding:10px 12px;display:flex;flex-direction:column;gap:6px}
.pc-setting-group-title{font-size:12px;font-weight:600;opacity:.8}
.pc-setting-row{display:flex;align-items:baseline;gap:10px;font-size:12px;opacity:.8;flex-wrap:wrap}
.pc-setting-path{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;opacity:.65;word-break:break-all}
.pc-exp{flex:0 0 auto;width:16px;border:0;background:transparent;color:inherit;opacity:.42;cursor:pointer;
  font-size:10px;line-height:1;padding:3px 0;margin-top:1px;border-radius:4px}
.pc-exp:hover{opacity:.9;background:color-mix(in srgb,currentColor 12%,transparent)}
.pc-aisum{margin-top:3px;font-size:10.5px;line-height:1.45;opacity:.55}
.pc-tags{display:flex;flex-wrap:wrap;gap:4px;margin-top:5px}
.pc-tag{font-size:9.5px;padding:1px 6px;border-radius:999px;background:color-mix(in srgb,currentColor 8%,transparent);opacity:.7}
.pc-setting-hint{font-size:11.5px;opacity:.6;line-height:1.5}
.pc-label{display:inline-block;margin-top:6px;margin-right:6px;font-size:9.5px;letter-spacing:.04em;opacity:.45;
  padding:0 4px;border-radius:4px;background:color-mix(in srgb,currentColor 8%,transparent)}
.pc-usage{margin-top:2px;font-size:10.5px;line-height:1.55;opacity:.62}
.pc-usage b{font-weight:600;opacity:.85}
.pc-help{padding:6px 14px 14px;overflow:auto;font-size:12px;line-height:1.6}
.pc-help h4{margin:14px 0 4px;font-size:12px;font-weight:600;opacity:.85}
.pc-help p{margin:4px 0;opacity:.72}
.pc-help ol,.pc-help ul{margin:4px 0 0;padding-left:18px;opacity:.75}
.pc-help li{margin:3px 0}
.pc-help code{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:10.5px;padding:0 3px;border-radius:3px;
  background:color-mix(in srgb,currentColor 10%,transparent)}
.pc-hb{border:1px solid color-mix(in srgb,currentColor 18%,transparent);background:transparent;color:inherit;
  font:inherit;font-size:11px;padding:3px 9px;border-radius:999px;cursor:pointer;margin-top:12px;opacity:.8}
.pc-hb:hover{background:color-mix(in srgb,currentColor 10%,transparent)}
`

    /* -------------------------------------------------------------- 小组件 */

    function Switch({ on, disabled, title, onToggle }) {
      return h('button', {
        type: 'button', className: 'pc-sw', 'data-on': on ? '1' : '0', disabled: disabled === true,
        title: title ?? (on ? '点击停用' : '点击启用'),
        onClick: () => { if (disabled !== true) onToggle() },
      }, h('span', { className: 'pc-knob' }))
    }

    function Icon({ src }) {
      if (typeof src === 'string' && /^(data:|https?:|\/)/.test(src)) return h('img', { src, alt: '' })
      return h('span', { 'aria-hidden': 'true' }, '🧩')
    }

    /** 这一行「怎么用」：优先用记住的 usage（模型或 README 提炼），再退回按能力写的通用说明。 */
    function usageFor(item, kind) {
      const tag = item.aiTag ?? null
      if (tag !== null && typeof tag.usage === 'string' && tag.usage.trim().length > 0) return tag.usage.trim()
      if (item.alwaysOn === true || item.toggleable === false) return 'DSH 本体的一部分：始终启用，不需要操作；真要停用只能改 profile 的 patch 文件。'
      if (kind === 'session') {
        return item.enabled === true
          ? '它在这个对话里可用。关掉开关，它的工具/MCP 就不会出现在这个对话的模型上下文里，下一条消息起生效。'
          : '这个对话里已停用。重新打开开关，它的工具/MCP 会从下一条消息起恢复。'
      }
      if (item.configurable === true) return '点行尾的 ⚙ 打开它的设置项；右侧开关控制这个包是否加载（全局生效）。'
      return '右侧开关控制这个包是否加载（全局生效，影响所有对话）。具体用法见它的 README。'
    }

    function Row({ item, kind, busy, toggleBusy, expanded, onExpand, onToggle, onConfig, onDescribe, onGenerateTag, aiEnabled }) {
      const key = item.id ?? item.name
      const isBusy = busy === `${kind}:${key}`
      const locked = item.toggleable === false || item.alwaysOn === true || item.readOnlyReason != null
      const described = item.described ?? null
      const tag = item.aiTag ?? null
      const description = described?.text ?? item.description
      const descriptionSource = described !== null ? (described.source ?? 'auto') : item.descriptionSource
      const isDescribing = busy === `describe:${item.name ?? key}`
      const isTagging = busy === `tag:${item.name ?? key}`
      // 有 AI 中文标签时用它当名字，原名退到副标题里（不丢信息）
      const name = tag !== null && typeof tag.label === 'string' && tag.label.length > 0
        ? tag.label
        : (item.title ?? item.name ?? key)
      const aiSummary = tag !== null && typeof tag.summary === 'string' ? tag.summary : null
      const tags = tag !== null && Array.isArray(tag.tags) ? tag.tags : []
      const canTag = aiEnabled === true && item.canDescribe === true

      return h('div', { className: 'pc-row' },
        h('button', {
          type: 'button', className: 'pc-exp',
          title: expanded === true ? '收起说明' : '展开说明',
          onClick: () => onExpand(item),
        }, expanded === true ? '▾' : '▸'),
        h('div', { className: 'pc-ico' }, h(Icon, { src: item.icon })),
        h('div', { className: 'pc-main' },
          h('div', {
            className: 'pc-name',
            title: expanded === true ? '点击收起说明' : '点击展开说明',
            style: { cursor: 'pointer' },
            onClick: () => onExpand(item),
          },
            h('span', null, name),
            item.isNew === true ? h('span', { className: 'pc-new' }, '新') : null,
            item.version != null ? h('span', { className: 'pc-ver' }, typeof item.version === 'number' ? `v${item.version}` : String(item.version)) : null,
            tag !== null
              ? h('span', { className: 'pc-auto', title: tag.source === 'ai' ? `模型（${tag.model ?? '?'}）读插件信息生成的中文标签，已记在本机` : '没调用模型，按插件信息提炼' }, tag.source === 'ai' ? 'AI' : '自动')
              : descriptionSource != null
                ? h('span', {
                  className: 'pc-auto',
                  title: `插件没写描述或你点了生成：这句是读它自己的 ${descriptionSource === 'readme' ? 'README' : descriptionSource === 'client-slots' ? '界面注入点' : '包内信息'} 生成的`,
                }, '自动')
                : null,
          ),
          expanded === true
            ? h(React.Fragment, null,
              (aiSummary !== null && aiSummary.length > 0) || (description != null && description.length > 0)
                ? h('div', null,
                  h('span', { className: 'pc-label' }, '作用'),
                  aiSummary !== null && aiSummary.length > 0
                    ? h('div', { className: 'pc-aisum', style: { marginTop: 0 } }, aiSummary)
                    : null,
                  description != null && description.length > 0
                    ? h('div', { className: 'pc-desc', style: { display: 'block', WebkitLineClamp: 'unset', overflow: 'visible', fontSize: '10.5px' } }, description)
                    : null,
                )
                : null,
              h('div', { className: 'pc-usage' },
                h('span', { className: 'pc-label' }, '使用说明'),
                usageFor(item, kind)),
              tags.length > 0
                ? h('div', { className: 'pc-tags' }, tags.map((keyword) => h('span', { className: 'pc-tag', key: keyword }, keyword)))
                : null,
              h('div', { className: 'pc-meta' }, item.subtitle ?? item.name ?? key),
            )
            : null,
        ),
        canTag
          ? h('button', {
            type: 'button', className: 'pc-gear',
            title: isTagging ? '正在让模型读插件信息…' : (tag === null ? 'AI 读插件信息，生成中文标签（会记住）' : '重新生成中文标签'),
            disabled: isTagging === true,
            onClick: () => onGenerateTag(item),
          }, '中')
          : null,
        item.canDescribe === true
          ? h('button', {
            type: 'button', className: 'pc-gear',
            title: isDescribing ? '正在读取插件信息…' : '读插件自己的信息，生成/刷新功能描述',
            disabled: isDescribing,
            onClick: () => onDescribe(item),
          }, '✨')
          : null,
        item.configurable === true
          ? h('button', {
            type: 'button', className: 'pc-gear',
            title: '设置这个插件',
            onClick: () => onConfig(item),
          }, '⚙')
          : null,
        locked
          ? h('span', { className: 'pc-lock', title: item.readOnlyReason ?? '内核常开，不可在此关闭' }, '🔒')
          : h(Switch, {
            on: item.enabled === true,
            disabled: isBusy === true || toggleBusy === true,
            onToggle: () => onToggle(kind, item.id ?? item.name, item.enabled !== true),
          }),
      )
    }

    /* -------------------------------------------------------------- 设置表单 */

    function FieldRow({ field, value, onChange }) {
      let control = null
      if (field.kind === 'boolean') {
        control = h(Switch, {
          on: value === true,
          title: value === true ? '点击改为关闭' : '点击改为开启',
          onToggle: () => onChange(value === true ? false : true),
        })
      } else if (field.kind === 'enum') {
        const options = Array.isArray(field.options) ? field.options : []
        control = h('select', {
          className: 'pc-input', value: typeof value === 'string' ? value : '',
          onChange: (event) => onChange(event.target.value),
        },
          h('option', { value: '' }, '（默认）'),
          options.map((option) => h('option', { key: option, value: option }, option)),
        )
      } else if (field.kind === 'json') {
        control = h('textarea', {
          className: 'pc-input pc-json', rows: 3, spellCheck: false,
          value: typeof value === 'string' ? value : '',
          placeholder: field.typeText ?? 'JSON',
          onChange: (event) => onChange(event.target.value),
        })
      } else {
        control = h('input', {
          className: 'pc-input',
          type: field.kind === 'number' ? 'number' : 'text',
          step: 'any',
          min: field.min === null || field.min === undefined ? undefined : field.min,
          max: field.max === null || field.max === undefined ? undefined : field.max,
          value: value === null || value === undefined ? '' : String(value),
          placeholder: field.default === null || field.default === undefined ? '（默认）' : `默认 ${JSON.stringify(field.default)}`,
          onChange: (event) => onChange(event.target.value),
        })
      }

      let hint = null
      if (typeof field.description === 'string' && field.description.length > 0) hint = field.description
      else if (field.kind === 'json' && typeof field.typeText === 'string' && field.typeText.length > 0) hint = `类型：${field.typeText}`

      return h('div', { className: 'pc-field' },
        h('div', { className: 'pc-fmain' },
          h('div', { className: 'pc-flabel' },
            h('span', null, field.path),
            field.required === true ? h('span', { style: { color: '#f5a524' }, title: '必填' }, '*') : null,
            field.volatile === true ? h('span', { className: 'pc-vol', title: '改动后要重新加载插件才生效' }, '需重载') : null,
          ),
          hint !== null ? h('div', { className: 'pc-fhint' }, hint) : null,
        ),
        h('div', { className: field.kind === 'json' ? 'pc-main' : 'pc-ctrls' }, control),
      )
    }

    function ConfigView({ cfg, onClose }) {
      const [draft, setDraft] = React.useState(() => Object.assign({}, cfg.initial))
      const setValue = (path, value) => setDraft((prev) => Object.assign({}, prev, { [path]: value }))
      const fields = Array.isArray(cfg.fields) ? cfg.fields : []
      const dirty = fields.filter((field) => draft[field.path] !== cfg.initial[field.path]).length

      return h(React.Fragment, null,
        h('div', headProps(),
          h('button', { type: 'button', className: 'pc-back', title: '返回列表', onClick: onClose }, '‹'),
          h('span', { className: 'pc-title', style: { fontSize: 13 } }, cfg.name ?? cfg.id),
          h('button', {
            type: 'button', className: 'pc-x', title: '关闭',
            onClick: () => patch({ open: false, view: 'list', config: null }),
          }, '✕'),
        ),
        h('div', { className: 'pc-meta', style: { padding: '6px 14px 0' } }, cfg.patchId ?? cfg.id),
        Array.isArray(cfg.rowIds) && cfg.rowIds.length > 1
          ? h('div', { className: 'pc-rowids' }, cfg.rowIds.map((rowId) => h('button', {
            key: rowId, type: 'button', className: 'pc-rowid',
            'data-active': rowId === cfg.id ? '1' : '0',
            onClick: () => { if (rowId !== cfg.id) void openConfig(rowId, cfg.rowIds) },
          }, rowId.replace(/^include:/, ''))))
          : null,
        cfg.error !== null && cfg.error !== undefined
          ? h('div', { className: 'pc-note' }, `读取失败：${cfg.error}`)
          : null,
        cfg.hasConfig !== true
          ? h('div', { className: 'pc-empty' }, '这个插件没有可配置项（作者没有声明 Config）。')
          : h('div', { className: 'pc-body' }, fields.length === 0
            ? h('div', { className: 'pc-empty' }, '配置是空对象。')
            : fields.map((field) => h(FieldRow, {
              key: field.path, field, value: draft[field.path],
              onChange: (value) => setValue(field.path, value),
            }))),
        h('div', { className: 'pc-actions' },
          h('button', {
            type: 'button', className: 'pc-btn', 'data-primary': '1',
            disabled: cfg.saving === true || cfg.hasConfig !== true || dirty === 0,
            onClick: () => { void saveConfig(cfg, draft) },
          }, cfg.saving === true ? '保存中…' : `保存${dirty > 0 ? ` (${dirty})` : ''}`),
          h('button', { type: 'button', className: 'pc-btn', onClick: onClose }, '取消'),
          dirty > 0 ? h('span', { style: { marginLeft: 'auto', fontSize: 11, opacity: 0.5 } }, `${dirty} 项未保存`) : null,
        ),
      )
    }

    /* ------------------------------------------------------- 本对话放行视图 */

    function ScopeTabs() {
      const s = useStore()
      if (s.sessionId == null) return null
      return h('div', { className: 'pc-scope' },
        h('button', {
          type: 'button', className: 'pc-scopebtn', 'data-active': s.scope === 'global' ? '1' : '0',
          title: '所有对话共用的插件开关（写进 profile）',
          onClick: () => patch({ scope: 'global' }),
        }, '全局'),
        h('button', {
          type: 'button', className: 'pc-scopebtn', 'data-active': s.scope === 'session' ? '1' : '0',
          title: '只影响当前这个对话',
          onClick: () => {
            patch({ scope: 'session' })
            if (s.gate == null) void loadGate(s.sessionId)
          },
        }, '本对话'),
      )
    }

    /*
     * 官方插件（内核 + 内建）在「本对话」页合并成一条可展开的条目：
     * 它们的工具由平台固定提供，没有按对话的开关，只做说明。
     */
    function OfficialRow({ bundles, expanded, onExpand }) {
      const toggle = () => onExpand({ id: 'official' })
      return h('div', { className: 'pc-row' },
        h('button', {
          type: 'button', className: 'pc-exp',
          title: expanded === true ? '收起官方插件' : '展开官方插件',
          onClick: toggle,
        }, expanded === true ? '▾' : '▸'),
        h('div', { className: 'pc-ico' }, h(Icon, { src: null })),
        h('div', { className: 'pc-main' },
          h('div', {
            className: 'pc-name', style: { cursor: 'pointer' },
            title: expanded === true ? '点击收起官方插件' : '点击展开官方插件',
            onClick: toggle,
          },
            h('span', null, '官方插件'),
            h('span', { className: 'pc-ver' }, `${bundles.length} 个`),
          ),
          expanded === true
            ? h(React.Fragment, null,
              h('div', { className: 'pc-aisum' }, 'DSH 本体自带的官方插件（当前 profile 真正组装的那几个）。它们始终启用，没有「本对话」开关：工具由平台固定提供，列在这里只是让你知道这个对话里还有哪些官方能力。'),
              h('div', { className: 'pc-tags' }, bundles.map((bundle) => h('span', {
                className: 'pc-tag', key: bundle.name, title: bundle.name,
              }, bundle.title))),
            )
            : null,
        ),
        h('span', { className: 'pc-lock', title: '官方插件始终启用，不能按对话关掉' }, '🔒'),
      )
    }

    function SessionView() {
      const s = useStore()
      const gate = s.gate
      const sessionId = s.sessionId

      React.useEffect(() => {
        if (gate == null) void loadGate(sessionId)
      }, [])

      if (gate == null || gate.loading === true) {
        return h('div', { className: 'pc-body' }, h('div', { className: 'pc-empty' }, '正在读取本对话的工具情况…'))
      }
      if (gate.error != null) {
        return h('div', { className: 'pc-body' }, h('div', { className: 'pc-note' }, `读取失败：${gate.error}`))
      }

      const disabled = Array.isArray(gate.policy?.disabled) ? gate.policy.disabled : []
      const disabledMcp = Array.isArray(gate.policy?.disabledMcp) ? gate.policy.disabledMcp : []
      const groups = Array.isArray(gate.groups) ? gate.groups : []
      const mcps = Array.isArray(gate.mcp) ? gate.mcp : []
      const denied = Array.isArray(gate.stats?.denied) ? gate.stats.denied : []
      const data = s.data
      const bundles = Array.isArray(data?.bundles) ? data.bundles : []
      const byName = new Map(bundles.map((bundle) => [bundle.name, bundle]))
      const aiEnabled = data?.aiTagsEnabled !== false

      const setPkg = (pkg, enabled) => {
        const next = enabled === true
          ? disabled.filter((value) => value !== pkg)
          : (disabled.includes(pkg) ? disabled : [...disabled, pkg])
        void saveGate(sessionId, next, disabledMcp)
      }
      const setMcp = (server, enabled) => {
        const next = enabled === true
          ? disabledMcp.filter((value) => value !== server)
          : (disabledMcp.includes(server) ? disabledMcp : [...disabledMcp, server])
        void saveGate(sessionId, disabled, next)
      }

      // 与「全局」页完全一致的行布局：每一项单列，展开才看说明
      const toggleExpanded = (item) => {
        const key = `session:${item.id ?? item.name}`
        patch({ expanded: { ...s.expanded, [key]: s.expanded[key] !== true } })
      }

      const pluginItems = groups.map((group) => {
        const bundle = byName.get(group.packageName) ?? null
        const configIds = Array.isArray(bundle?.rowIds) ? bundle.rowIds : []
        const tools = Array.isArray(group.tools) ? group.tools : []
        return {
          id: `pkg:${group.packageName}`,
          name: group.packageName,
          title: bundle?.aiTag?.label ?? bundle?.title ?? group.label ?? group.packageName,
          subtitle: group.packageName,
          version: `${tools.length} 个工具`,
          description: tools.length > 0
            ? `本对话可见的工具：${tools.join(' · ')}`
            : '这个插件在本对话里没有可开关的工具。',
          enabled: !disabled.includes(group.packageName),
          toggleable: true,
          alwaysOn: false,
          icon: bundle?.icon ?? null,
          aiTag: bundle?.aiTag ?? null,
          canDescribe: true,
          described: s.described[group.packageName] ?? null,
          configurable: configIds.length > 0,
          configIds,
        }
      })

      const mcpItems = mcps.map((server) => {
        const tools = Array.isArray(server.tools) ? server.tools : []
        return {
          id: `mcp:${server.server}`,
          name: server.server,
          title: server.label != null && String(server.label).length > 0 ? String(server.label) : `MCP · ${server.server}`,
          subtitle: `MCP 服务器 · ${server.server}`,
          version: `${tools.length} 个工具`,
          description: tools.length > 0 ? `本对话可见的工具：${tools.join(' · ')}` : null,
          enabled: !disabledMcp.includes(server.server),
          toggleable: true,
          alwaysOn: false,
          icon: null,
          canDescribe: false,
          configurable: false,
          configIds: [],
        }
      })

      // 官方插件只列当前 profile 真正组装的那些（inProfile），避免把没装的实验包也列进来
      const officialBundles = bundles
        .filter((bundle) => bundle.official === true && (bundle.inProfile === true || bundle.installed === true))
        .map((bundle) => ({ name: bundle.name, title: bundle.aiTag?.label ?? bundle.title ?? bundle.name }))

      const onToggle = (_kind, id, enabled) => {
        if (store.gateBusy === 'save') return
        const text = String(id ?? '')
        if (text.startsWith('pkg:')) setPkg(text.slice(4), enabled)
        else if (text.startsWith('mcp:')) setMcp(text.slice(4), enabled)
      }

      const renderRow = (item) => h(Row, {
        key: item.id,
        item,
        kind: 'session',
        busy: null,
        toggleBusy: s.gateBusy === 'save',
        aiEnabled,
        expanded: s.expanded[`session:${item.id}`] === true,
        onExpand: toggleExpanded,
        onToggle,
        onConfig: (target) => {
          const ids = Array.isArray(target.configIds) ? target.configIds : []
          if (ids.length === 0) return
          void openConfig(ids[0], ids)
        },
        onDescribe: (target) => { void describeOne(target.name) },
        onGenerateTag: (target) => { void generateTag(target.name) },
      })

      const empty = pluginItems.length === 0 && mcpItems.length === 0 && officialBundles.length === 0

      return h(React.Fragment, null,
        h('div', { className: 'pc-note', style: { background: 'color-mix(in srgb,#10b981 12%,transparent)', borderColor: 'color-mix(in srgb,#10b981 28%,transparent)' } },
          h('div', null,
            h('b', null, '只作用于本对话'), '：关掉的插件其工具/MCP 在这一轮对话里对模型不可见，',
            '下一个请求立即生效（对已开始的对话也有效）。',
          ),
          h('div', { style: { marginTop: 4, opacity: 0.7 } },
            `可见工具 ${gate.stats?.visibleTools ?? 0} 个 · 已拦截 ${denied.length} 个`),
        ),
        gate.stats?.error != null
          ? h('div', { className: 'pc-note' }, `当前未生效：${gate.stats.error}`)
          : null,
        gate.live !== true
          ? h('div', { className: 'pc-note' }, '这个对话现在不在运行中，策略会在下次进入对话时生效。')
          : null,
        h('div', { className: 'pc-body' },
          empty
            ? h('div', { className: 'pc-empty' }, '没有找到可以按对话开关的工具（插件可能只提供界面或提示词）')
            : h('div', null,
              pluginItems.map(renderRow),
              mcpItems.map(renderRow),
              officialBundles.length > 0
                ? h(OfficialRow, {
                  bundles: officialBundles,
                  expanded: s.expanded['session:official'] === true,
                  key: 'session:official',
                  onExpand: toggleExpanded,
                })
                : null,
            ),
        ),
        h('div', { className: 'pc-foot' },
          h('span', null, '工具归属按插件源码推断'),
          h('span', { style: { marginLeft: 'auto' } },
            `扫描 ${gate.owners?.scannedPackages ?? 0} 个插件`),
        ),
      )
    }

    /* ---------------------------------------------------------------- 面板 */

    /* ------------------------------------------------------------ 使用说明 */

    /**
     * 插件管家自己的「作用 + 使用说明」。
     * 单独一页，从面板标题栏的「?」进入；和每个插件行里的「作用 / 使用说明」是一套说法。
     */
    function HelpView({ onClose }) {
      return h('div', { className: 'pc-help' },
        h('h4', null, '作用'),
        h('p', null, '在对话输入框左边加一个「插件」入口，用来管这台机器上已装的 DSH 插件：全局启停、逐个改配置、在一条对话里单独隐藏某个插件的工具/MCP，以及让模型给每个插件写一句中文的「做什么 / 怎么用」。'),
        h('h4', null, '使用说明'),
        h('ol', null,
          h('li', null, '顶部「全局 / 本对话」：全局改的是 profile，所有对话都受影响；本对话只在这一条对话里隐藏工具与 MCP，下一条消息起生效，对已开始的对话也有效。'),
          h('li', null, '每行：点名字或行首 ▸ 展开「作用 / 使用说明」；右侧开关启停；⚙ 打开它的设置项；✨ 重读插件信息生成描述；「中」让模型读插件信息写中文标签（会记住，下次不用再问）。'),
          h('li', null, '四个页：插件＝第三方插件；内核＝DSH 本体组成（🔒 不可关，只做展示）；内建＝官方自带插件；其它行＝没打包成 bundle 的独立 loader 行。'),
          h('li', null, '设置 → 插件管家：自动纳入新插件、AI 中文标签开关、按对话策略清单、数据文件路径。'),
          h('li', null, '面板：按住标题栏可以拖动，位置会记住；双击标题栏回到右上角。'),
          h('li', null, '边界：纯界面类插件不能按对话开关，只能在全局启停；本对话的开关只对全局注册的工具/MCP 有效。'),
        ),
        h('button', { type: 'button', className: 'pc-hb', onClick: onClose }, '知道了'),
      )
    }

    function Panel() {
      const s = useStore()
      // 每次面板换个形态（列表 / 本对话 / 设置抽屉）都重新贴一次记住的位置
      React.useEffect(() => {
        if (typeof document === 'undefined') return
        const el = document.querySelector('.pc-panel')
        if (el !== null && el !== undefined) applyPos(el)
      }, [s.open, s.view, s.scope, s.tab])
      if (s.open !== true) return null

      if (s.view === 'help') {
        return h(React.Fragment, null,
          h('div', { className: 'pc-backdrop', onClick: () => patch({ view: 'list' }) }),
          h('div', { className: 'pc-panel', role: 'dialog', 'aria-label': '插件管家 · 说明' },
            h('div', headProps(),
              h('span', { className: 'pc-title' }, '插件管家 · 说明'),
              h('button', { type: 'button', className: 'pc-x', title: '返回列表', onClick: () => patch({ view: 'list' }) }, '✕'),
            ),
            h(HelpView, { onClose: () => patch({ view: 'list' }) }),
          ),
          s.toast !== null ? h('div', { className: 'pc-toast' }, s.toast) : null,
        )
      }

      if (s.view === 'config' && s.config !== null) {
        const cfg = s.config
        return h(React.Fragment, null,
          h('div', { className: 'pc-backdrop', onClick: () => patch({ open: false, view: 'list', config: null }) }),
          h('div', { className: 'pc-panel', role: 'dialog', 'aria-label': '插件设置' },
            cfg.loading === true
              ? h('div', headProps(),
                h('span', { className: 'pc-title' }, '读取配置…'),
                h('button', { type: 'button', className: 'pc-x', title: '取消', onClick: () => patch({ view: 'list', config: null }) }, '✕'),
              )
              : h(ConfigView, { cfg, onClose: () => patch({ view: 'list', config: null }) }),
          ),
          s.toast !== null ? h('div', { className: 'pc-toast' }, s.toast) : null,
        )
      }

      if (s.scope === 'session') {
        const gateSessionId = s.sessionId
        return h(React.Fragment, null,
          h('div', { className: 'pc-backdrop', onClick: () => patch({ open: false }) }),
          h('div', { className: 'pc-panel', role: 'dialog', 'aria-label': '插件管家 · 本对话' },
            h('div', headProps(),
              h('span', { className: 'pc-title' }, '插件管家'),
              h(ScopeTabs, null),
              h('button', { type: 'button', className: 'pc-x', title: '作用与使用说明', onClick: () => patch({ view: 'help' }) }, '?'),
              h('button', { type: 'button', className: 'pc-x', title: '刷新', onClick: () => { void load(); void loadGate(gateSessionId) } }, '↻'),
              h('button', { type: 'button', className: 'pc-x', title: '关闭', onClick: () => patch({ open: false }) }, '✕'),
            ),
            h(SessionView, null),
            s.toast != null ? h('div', { className: 'pc-toast' }, s.toast) : null,
          ),
        )
      }

      const data = s.data
      const filter = s.filter.trim().toLowerCase()
      const matches = (item) => {
        if (filter.length === 0) return true
        const haystack = `${item.title ?? ''} ${item.name ?? ''} ${item.id ?? ''} ${item.moduleName ?? ''} ${item.description ?? ''} ${item.aiTag?.label ?? ''} ${(item.aiTag?.tags ?? []).join(' ')}`.toLowerCase()
        return haystack.includes(filter)
      }

      const bundles = Array.isArray(data?.bundles) ? data.bundles : []
      const rows = Array.isArray(data?.rows) ? data.rows : []
      const newNames = new Set((data?.discovery?.newBundles ?? []).map((entry) => entry.name))
      const newRowIds = new Set((data?.discovery?.newRows ?? []).map((entry) => entry.id))
      const aiEnabled = data?.aiTagsEnabled !== false
      const toggleExpanded = (item) => {
        const key = `${s.tab}:${item.id ?? item.name}`
        patch({ expanded: { ...s.expanded, [key]: s.expanded[key] !== true } })
      }

      const thirdParty = bundles
        .filter((b) => b.installed === true && b.official !== true)
        .map((b) => {
          const configIds = Array.isArray(b.rowIds) ? b.rowIds : []
          return {
            ...b, id: b.name, subtitle: b.name, isNew: newNames.has(b.name),
            configurable: configIds.length > 0, configIds,
            canDescribe: true, described: s.described[b.name] ?? null,
            aiTag: b.aiTag ?? null,
          }
        })
      const builtin = bundles
        .filter((b) => b.installed === true && b.official === true && b.alwaysOn !== true)
        .map((b) => {
          const configIds = Array.isArray(b.rowIds) ? b.rowIds : []
          return { ...b, id: b.name, subtitle: b.name, isNew: newNames.has(b.name), alwaysOn: false, configurable: configIds.length > 0, configIds, aiTag: b.aiTag ?? null }
        })
      const kernelItems = (Array.isArray(data?.kernel) ? data.kernel : []).map((k) => ({
        ...k, id: k.name, subtitle: k.name, alwaysOn: true, toggleable: false,
        configurable: false, configIds: [], isNew: newNames.has(k.name),
        described: s.described[k.name] ?? null, aiTag: k.aiTag ?? null,
      }))
      const otherRows = rows
        .filter((r) => r.bundle == null)
        .map((r) => ({ ...r, subtitle: r.moduleName, isNew: newRowIds.has(r.id), alwaysOn: r.alwaysOn === true, configurable: true, configIds: [r.id] }))

      const tabs = [
        { key: 'plugins', label: `插件 ${thirdParty.length}` },
        { key: 'kernel', label: `内核 ${kernelItems.length}` },
        { key: 'builtin', label: `内建 ${builtin.length}` },
        { key: 'rows', label: `其它行 ${otherRows.length}` },
      ]

      let list = []
      if (s.tab === 'plugins') list = thirdParty
      else if (s.tab === 'kernel') list = kernelItems
      else if (s.tab === 'builtin') list = builtin
      else list = otherRows
      list = list.filter(matches)

      const kernelNote = s.tab === 'kernel'
        ? h('div', { className: 'pc-note', style: { background: 'color-mix(in srgb,#8b5cf6 12%,transparent)', borderColor: 'color-mix(in srgb,#8b5cf6 28%,transparent)' } },
          h('div', null,
            h('b', null, `内核组成（${kernelItems.length} 个）`),
            '：这些是 DSH 本体的一部分（官方包且不可移除，没有独立的开关入口）。',
            '它们始终启用——列在这里只是让你知道有哪些、各自负责什么；真要停用只能改 profile 的 patch 文件。',
          ))
        : null

      const peerNote = Array.isArray(data?.peers) && data.peers.length > 0 ? data.peers[0] : null

      return h(React.Fragment, null,
        h('div', { className: 'pc-backdrop', onClick: () => patch({ open: false }) }),
        h('div', { className: 'pc-panel', role: 'dialog', 'aria-label': '插件管家' },
          h('div', headProps(),
            h('span', { className: 'pc-title' }, '插件管家'),
            h(ScopeTabs, null),
            s.loading === true ? h('span', { style: { fontSize: 11, opacity: 0.5 } }, '载入中…') : null,
            h('button', { type: 'button', className: 'pc-x', title: '作用与使用说明', onClick: () => patch({ view: 'help' }) }, '?'),
            h('button', {
              type: 'button', className: 'pc-x', title: '刷新',
              onClick: () => { void load() },
            }, '↻'),
            h('button', { type: 'button', className: 'pc-x', title: '关闭', onClick: () => patch({ open: false }) }, '✕'),
          ),
          h('div', { className: 'pc-tabs' }, tabs.map((tab) => h('button', {
            key: tab.key, type: 'button', className: 'pc-tab', 'data-active': s.tab === tab.key ? '1' : '0',
            onClick: () => patch({ tab: tab.key }),
          }, tab.label))),
          h('input', {
            className: 'pc-search', placeholder: '搜索插件名称 / 包名 / 描述…',
            value: s.filter, onChange: (event) => patch({ filter: event.target.value }),
          }),
          s.pendingNew > 0
            ? h('div', { className: 'pc-note' },
              h('div', null, `发现 ${s.pendingNew} 项新变化（新装的插件 / 新出现的插件行）`),
              h('button', { type: 'button', className: 'pc-link', onClick: () => { void acknowledge() } }, '标记为已纳入管理'))
            : null,
          peerNote !== null
            ? h('div', { className: 'pc-note', style: { background: 'color-mix(in srgb,#3b82f6 12%,transparent)', borderColor: 'color-mix(in srgb,#3b82f6 28%,transparent)' } },
              h('div', null, h('b', null, `已检测到「${peerNote.title}」`), '：', peerNote.note, '。此处只做插件启停，不重复它的界面。'))
            : null,
          kernelNote,
          s.error != null
            ? h('div', { className: 'pc-note' }, `读取失败：${s.error}`)
            : null,
          h('div', { className: 'pc-body' },
            list.length === 0
              ? h('div', { className: 'pc-empty' }, s.loading === true ? '正在读取本机插件目录…' : '没有匹配的插件')
              : list.map((item) => h(Row, {
                key: `${s.tab}:${item.id ?? item.name}`,
                item,
                kind: s.tab === 'rows' ? 'row' : 'bundle',
                busy: s.busy,
                aiEnabled,
                expanded: s.expanded[`${s.tab}:${item.id ?? item.name}`] === true,
                onExpand: toggleExpanded,
                onToggle: (kind, id, enabled) => { void togglePlugin(kind, id, enabled) },
                onConfig: (target) => {
                  const ids = Array.isArray(target.configIds) ? target.configIds : []
                  if (ids.length === 0) return
                  void openConfig(ids[0], ids)
                },
                onDescribe: (target) => { void describeOne(target.name) },
                onGenerateTag: (target) => { void generateTag(target.name) },
              })),
          ),
          h('div', { className: 'pc-foot' },
            h('span', null, data?.scannedAt != null ? `上次扫描 ${new Date(data.scannedAt).toLocaleTimeString()}` : '尚未扫描'),
            h('span', { style: { marginLeft: 'auto' } }, `目录 ${bundles.length} 个 bundle / ${rows.length} 行`),
          ),
        ),
        s.toast != null ? h('div', { className: 'pc-toast' }, s.toast) : null,
      )
    }

    /* ------------------------------------------------------------ 设置页 */
    /*
     * 挂在「设置 → 插件管家」的一页：全局策略（自动纳入管理）、本机统计、
     * 已有的「本对话」策略清单（可清除），以及检测到的同类插件。
     * 只用 settings.section 这个公开插槽，不碰设置页内部实现。
     */

    async function loadSettingsView(setState) {
      setState((prev) => ({ ...prev, loading: true, error: null }))
      try {
        const [settingsRes, catalogRes, sessionsRes] = await Promise.all([
          fetch(`${API}/settings`, { headers: { accept: 'application/json' } }).then((r) => r.json()),
          fetch(`${API}/catalog`, { headers: { accept: 'application/json' } }).then((r) => r.json()),
          fetch(`${API}/sessions`, { headers: { accept: 'application/json' } }).then((r) => r.json()),
        ])
        setState((prev) => ({
          ...prev,
          loading: false,
          settings: settingsRes.status === 'ok' ? settingsRes : null,
          catalog: catalogRes.status === 'ok' ? catalogRes : null,
          sessions: sessionsRes.status === 'ok' ? sessionsRes : null,
          error: [settingsRes, catalogRes, sessionsRes].find((body) => body.status !== 'ok')?.message ?? null,
        }))
      } catch (error) {
        setState((prev) => ({ ...prev, loading: false, error: error instanceof Error ? error.message : String(error) }))
      }
    }

    async function saveAutoAck(autoAck) {
      await fetch(`${API}/settings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ autoAck }),
      })
      await load()
    }

    async function saveAiTags(aiTags) {
      await fetch(`${API}/settings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ aiTags }),
      })
      await load()
    }

    async function clearTags() {
      const response = await fetch(`${API}/tags`, { headers: { accept: 'application/json' } })
      const body = await response.json()
      const names = body.status === 'ok' ? Object.keys(body.entries ?? {}) : []
      for (const packageName of names) {
        await fetch(`${API}/tags?packageName=${encodeURIComponent(packageName)}`, { method: 'DELETE' })
      }
      await load()
      return names.length
    }

    async function forgetSession(sessionId) {
      await fetch(`${API}/session?id=${encodeURIComponent(sessionId)}`, { method: 'DELETE' })
    }

    function SettingsSection() {
      const [view, setView] = React.useState({ loading: true, error: null, settings: null, catalog: null, sessions: null })
      React.useEffect(() => { void loadSettingsView(setView) }, [])

      const reload = () => { void loadSettingsView(setView) }
      const settings = view.settings
      const catalog = view.catalog
      const sessions = view.sessions
      const installed = (catalog?.bundles ?? []).filter((b) => b.installed === true)
      const kernel = Array.isArray(catalog?.kernel) ? catalog.kernel : []
      const third = installed.filter((b) => b.official !== true)
      const peers = Array.isArray(catalog?.peers) ? catalog.peers : []
      const policies = Array.isArray(sessions?.policies) ? sessions.policies : []

      return h('div', { className: 'pc-settings' },
        h('div', { className: 'pc-setting-head' },
          h('div', null,
            h('div', { className: 'pc-setting-title' }, '插件管家'),
            h('div', { className: 'pc-setting-sub' }, '图形化管理本机插件：全局开关在对话输入框的「🧩 插件」里，按对话的开关在同一面板的「本对话」页。'),
          ),
          h('button', { type: 'button', className: 'pc-btn', onClick: reload }, '刷新'),
        ),
        view.error != null ? h('div', { className: 'pc-note' }, `读取失败：${view.error}`) : null,
        h('div', { className: 'pc-setting-group' },
          h('div', { className: 'pc-setting-group-title' }, '作用与使用说明'),
          h('div', { className: 'pc-setting-hint' },
            '作用：在对话输入框左边加一个「插件」入口，用来看清并管理这台机器上已装的 DSH 插件——',
            '全局启停、逐个改配置、在一条对话里单独隐藏某个插件的工具/MCP，并让模型给每个插件写一句中文的「做什么 / 怎么用」。'),
          h('div', { className: 'pc-setting-hint' },
            '用法：① 在输入框左边点「🧩 插件」打开面板；② 顶部切「全局 / 本对话」；',
            '③ 点行名展开「作用 / 使用说明」，右侧开关启停；④ ⚙ 改配置、✨ 重读插件信息、中 生成中文标签；',
            '⑤ 面板标题栏可拖动、双击回位，「?」随时看这份说明。'),
        ),
        h('div', { className: 'pc-setting-group' },
          h('div', { className: 'pc-setting-group-title' }, '自动发现'),
          h('div', { className: 'pc-srow' },
            h('div', { className: 'pc-main' },
              h('div', { className: 'pc-name' }, h('span', null, '自动纳入新装的插件')),
              h('div', { className: 'pc-meta' },
                '开启后，新装的插件直接进入管理清单，不再在面板顶部提示「发现 N 项新变化」。',
                `扫描间隔 ${Math.round((settings?.scanIntervalMs ?? 300000) / 1000)} 秒，上次扫描 `,
                settings?.lastScanAt != null ? new Date(settings.lastScanAt).toLocaleTimeString() : '尚未扫描'),
            ),
            h(Switch, {
              on: settings?.settings?.autoAck === true,
              disabled: settings == null,
              onToggle: () => { void saveAutoAck(settings?.settings?.autoAck !== true) },
            }),
          ),
        ),
        h('div', { className: 'pc-setting-group' },
          h('div', { className: 'pc-setting-group-title' }, 'AI 中文标签'),
          h('div', { className: 'pc-srow' },
            h('div', { className: 'pc-main' },
              h('div', { className: 'pc-name' }, h('span', null, '在插件行上显示「中」按钮')),
              h('div', { className: 'pc-meta' },
                '点一下就让当前默认模型读这个插件自己的 README / package.json / 界面注入点，写出中文标签和一句话说明；',
                '结果记在本机 tags.json，刷新页面或重启后仍然在。关掉只是隐藏按钮，已生成的标签照常显示。'),
            ),
            h(Switch, {
              on: settings?.settings?.aiTags !== false,
              disabled: settings == null,
              onToggle: () => { void saveAiTags(settings?.settings?.aiTags === false) },
            }),
          ),
          h('div', { className: 'pc-setting-row' },
            h('span', null, `已记住 ${(catalog?.bundles ?? []).filter((b) => b.aiTag != null).length} 个插件的中文标签`),
            h('button', {
              type: 'button', className: 'pc-link',
              onClick: () => { void (async () => {
                const count = await clearTags()
                reload()
                patch({ toast: count === 0 ? '还没有生成过中文标签' : `已清空 ${count} 个中文标签` })
              })() },
            }, '清空已生成的标签'),
          ),
        ),
        h('div', { className: 'pc-setting-group' },
          h('div', { className: 'pc-setting-group-title' }, `本机统计（内核 ${kernel.length} · 第三方 ${third.length} · 内建 ${installed.length - third.length - kernel.length}）`),
          h('div', { className: 'pc-setting-row' },
            h('span', null, `目录：${(catalog?.bundles ?? []).length} 个 bundle / ${(catalog?.rows ?? []).length} 个 loader 行`),
            h('span', { className: 'pc-setting-path' }, settings?.stateFile ?? '—'),
          ),
          h('div', { className: 'pc-setting-row' },
            h('span', null, '按对话的策略文件'),
            h('span', { className: 'pc-setting-path' }, settings?.policiesDir ?? '—'),
          ),
        ),
        peers.length > 0
          ? h('div', { className: 'pc-setting-group' },
            h('div', { className: 'pc-setting-group-title' }, '同类插件（共存，不互相接管）'),
            peers.map((peer) => h('div', { className: 'pc-setting-row', key: peer.packageName },
              h('span', null, `${peer.title}（${peer.packageName}）`),
              h('span', { className: 'pc-setting-hint' }, peer.note),
            )),
          )
          : null,
        h('div', { className: 'pc-setting-group' },
          h('div', { className: 'pc-setting-group-title' }, `按对话的策略（${policies.length}）`),
          policies.length === 0
            ? h('div', { className: 'pc-setting-hint' }, '还没有任何对话单独设置过。在对话里打开「🧩 插件 → 本对话」即可。')
            : policies.map((policy) => h('div', { className: 'pc-srow', key: policy.sessionId },
              h('div', { className: 'pc-main' },
                h('div', { className: 'pc-name' },
                  h('span', null, policy.sessionId.length > 18 ? `${policy.sessionId.slice(0, 18)}…` : policy.sessionId),
                  h('span', { className: 'pc-ver' }, policy.running === true ? '运行中' : '未运行'),
                ),
                h('div', { className: 'pc-meta' },
                  `停用插件：${(policy.disabled ?? []).length} 个，停用 MCP：${(policy.disabledMcp ?? []).length} 个`,
                  policy.updatedAt != null ? ` · ${new Date(policy.updatedAt).toLocaleString()}` : ''),
                (policy.disabled ?? []).length > 0
                  ? h('div', { className: 'pc-stools' }, (policy.disabled ?? []).join(' · '))
                  : null,
              ),
              h('button', {
                type: 'button', className: 'pc-btn',
                onClick: () => { void forgetSession(policy.sessionId).then(() => { reload() }) },
              }, '清除'),
            )),
        ),
      )
    }

    /* ------------------------------------------------------------ 入口按钮 */

    function Trigger(props) {
      const s = useStore()
      const sessionId = typeof props?.sessionId === 'string' ? props.sessionId : null
      React.useEffect(() => {
        void refreshStatus()
        const timer = setInterval(() => { void refreshStatus() }, 60_000)
        return () => clearInterval(timer)
      }, [])
      React.useEffect(() => {
        // 输入框的 slot 是会话级的：把当前对话 id 记下来，供「本对话」视图使用
        patch({ sessionId })
      }, [sessionId])
      // 渲染期同步记一份：面板可能在 effect 之前就被打开，直接改字段不 emit（避免渲染期通知）
      if (store.sessionId !== sessionId) store.sessionId = sessionId
      const open = s.open === true
      return h('button', {
        type: 'button', className: 'pc-pill', 'data-open': open ? '1' : '0',
        title: '插件管家：查看与启停本机插件',
        onClick: () => {
          const next = !open
          if (!next) {
            patch({ open: false })
            return
          }
          // 默认落在「本对话」页：这个是大多数时候要改的东西；没有会话上下文时退回「全局」
          const initialScope = typeof sessionId === 'string' && sessionId.length > 0 ? 'session' : 'global'
          patch({ open: true, view: 'list', config: null, scope: initialScope })
          void load({ ack: true })
          if (initialScope === 'session') void loadGate(store.sessionId)
        },
      },
        h('span', { 'aria-hidden': 'true' }, '🧩'),
        h('span', null, '插件'),
        s.pendingNew > 0 ? h('span', { className: 'pc-dot', 'data-count': String(s.pendingNew) }) : null,
      )
    }

    /* ---------------------------------------------------------------- apply */

    function apply(ctx) {
      const slots = ctx.get('slots')
      if (slots === undefined) return

      const styleEl = document.createElement('style')
      styleEl.setAttribute('data-dsh-plugin-steward', '')
      styleEl.textContent = CSS
      document.head.appendChild(styleEl)
      ctx.effect(() => () => { styleEl.remove() })

      slots.inject('conversation.input.left', () => slots.register(
        { name: 'conversation.input.left', id: 'plugin-console-trigger', order: 40, label: () => '插件管家' },
        (props) => h(Trigger, props),
      ))

      slots.inject('shell.overlay', () => slots.register(
        { name: 'shell.overlay', id: 'plugin-console-panel', order: 55, label: () => '插件管家' },
        () => h(Panel),
      ))

      slots.inject('settings.section', () => slots.register(
        { name: 'settings.section', id: 'plugin-console', order: 30, label: () => '插件管家' },
        () => h(SettingsSection),
      ))
    }

    const inject = ['slots']
    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
