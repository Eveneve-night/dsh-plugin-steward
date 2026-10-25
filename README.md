# dsh-plugin-steward · 插件管家

English · [中文](#中文)

`dsh-plugin-steward` adds one button to the composer (🧩 插件) and one settings page. Its host half registers a few
same-origin HTTP routes inside the running harness process; its client half is a single unbundled module loaded by
the web UI. It starts no extra process and stores no credentials.

![icon](https://raw.githubusercontent.com/Eveneve-night/dsh-plugin-steward/main/assets/icon-180.png)

---

## English

### What it does

| Feature | Behaviour |
|---|---|
| Catalog | Lists every installed bundle (third-party and built-in) and every loader row with title, version, description, package name and current state. |
| Global on/off | Bundles go through `pluginManager.setBundleEnabled`, rows through `setPluginEnabled`. The result is reported as applied / restart-required / overridden / failed. The plugin refuses to disable itself (HTTP 409) so the entry point cannot disappear. |
| Per-plugin settings | The ⚙ next to each row opens a settings drawer. The host reads that row's schemastery `Config` and derives the form: string, number (with min/max), boolean, enum and JSON controls, each with default and a `reload` marker when the field is volatile. Saving sends only changed fields through `configEditor.edit()`. |
| Per-conversation gating | The **This conversation** tab hides a plugin's tools or a whole MCP server from the model for one conversation. It calls `agent.ctx.tools.restrict()` on that agent, so it applies to an already-running conversation from the next request. Policies are saved per session and re-applied after a reload or restart. |
| Automatic descriptions | When a plugin ships no `meta.description`, the host derives one sentence (≤ 90 chars) from the plugin's own README, client slot ids or `package.json`. Author-written descriptions always win; ✨ regenerates on demand and the source is labelled. |
| AI Chinese labels | The 中 button asks the current default model to read the plugin's own README, `package.json` and client slot ids, and write a short Chinese label + one-line summary + 2–4 keywords as JSON. Results are stored in `tags.json`, so they survive reloads and restarts, and the label replaces the English package name in the list. If the model answers with prose, the host re-asks once, then falls back to a rule-based label. Can be turned off in Settings. |
| Compact rows, expandable | Rows show only the name (and badges) by default; ▸ expands to the small-print description, AI summary and keywords. |
| Movable panel | Drag the panel by its title bar; the position is remembered in `localStorage` and clamped to the viewport. Double-click the title bar to snap back to the top-right corner. |
| New-plugin discovery | A silent scan every 5 minutes records newly appeared bundles and rows as pending. The button shows an orange dot; the panel offers one click to acknowledge them. |
| Kernel section | Bundles that ship with DSH itself and are actually assembled in the current profile are listed on a separate read-only **内核** tab with 🔒. Their enable logic stays isolated in the backend from third-party plugins. |
| Coexistence | If a capability-panel style plugin is installed (`dsh-capability-panel`, `dsh-capability-composer`, `@super_camel/dsh-plugin-panel`), the panel shows a note pointing at it and does not reimplement its live context state. |

Entry points:

- **🧩 插件** at the left of the composer tool row (`conversation.input.left`) → floating panel with **全局** and **本对话** tabs.
- **Settings → 插件管家** (`settings.section`) → discovery settings, profile paths, per-conversation policy list.

### Install

```sh
# from GitHub
dsh plugin add github:Eveneve-night/dsh-plugin-steward

# from npm (if published)
dsh plugin add dsh-plugin-steward
```

Or install the directory itself as a bundle with the plugin manager:

```
plugin_manager action: install_bundle
target: <path to this checkout>
```

The bundle adds one row to the composition:

```yaml
- insert:
    - id: plugin-console
      name: 'dsh-plugin-steward'
```

Reload the Web UI once (the client half is injected at page load). After editing the source,
`set_plugin` on `include:plugin-console` with `enabled: false` then `true`.

### HTTP routes

All routes are same-origin under `/plugin-console/api` and are called by the client half.

| Method | Path | Purpose |
|---|---|---|
| GET | `/catalog` | Full catalog, discovery state, `kernel` section, `profileBundles`; `?ack=1` also acknowledges |
| GET | `/status` | Pending count (orange dot) and client-half load state |
| POST | `/toggle` | `{kind:'bundle'\|'row', id, enabled}` |
| POST | `/ack` | Record the current plugin set as known |
| GET | `/config?id=<entryId>` | Derived form description and explicit values for one loader row |
| POST | `/config` | `{id, config}` → validated, persisted and reloaded by the Loader |
| GET | `/sessions` | Running sessions plus every saved per-conversation policy |
| GET | `/session?id=<sessionId>` | Gate view for one session: visible tools, tools grouped by plugin, MCP servers, denied list |
| POST | `/session` | `{id, disabled: string[], disabledMcp: string[]}` → saved and applied immediately |
| DELETE | `/session?id=<sessionId>` | Clear one conversation's policy and revoke its restriction |
| GET/POST | `/settings` | Discovery settings (auto-acknowledge) and the AI-label switch |
| GET | `/describe?id=<package>&refresh=1` | Derive a description from the plugin's own files |
| GET | `/tags` | Remembered AI labels for every plugin |
| POST | `/tags` | `{packageName}` → ask the default model, store and return the label |
| DELETE | `/tags?packageName=<package>` | Forget one plugin's label |

### Files written

- `<profile>/.plugin-console/state.json` — known bundles/rows, pending discoveries, settings.
- `<profile>/.plugin-console/sessions/<sessionId>.json` — per-conversation policy (`disabled`, `disabledMcp`).
- `<profile>/.plugin-console/tags.json` — AI labels remembered per package name.

Nothing else is modified; global switching goes through the platform's own plugin manager.

### Limits

- **Pure UI plugins (wallpaper, widgets, sidebars) cannot be toggled per conversation.** Client plugins load at
  profile level and their slot registrations are global. For those the steward offers global on/off and a way to
  open their settings.
- **Per-conversation gating covers globally registered tools.** Tools registered inside an agent scope (by a preset
  or composition) stay visible — `tools.restrict()` does not reach them. Globally registered plugins and MCP
  servers are covered.
- **The settings form is per loader row.** A bundle with several rows lets you switch rows; a row without `Config`
  shows "nothing to configure".
- **Nested object/array fields** fall back to a JSON text area.
- **Automatic descriptions are heuristic.** README first, then client slot ids, then `package.json`; the source is
  labelled and can be regenerated.
- **AI labels need a default model.** Without one (or when the provider errors) the host falls back to a rule-based
  label and marks its source as `rule`. One plugin costs one short model call; generated labels are cached until you
  clear them in Settings.

### Test

```sh
node dev/smoke-client.mjs      # client half: load, 3 slot registrations, panel / this-conversation / settings render
node dev/test-describe.mjs     # description derivation against 6 installed plugins
node --check lib/index.js      # host half syntax
```

---

## 中文

### 它做什么

| 功能 | 行为 |
|---|---|
| 统一目录 | 列出全部已安装 bundle（第三方与内建）和全部 loader 行，带标题、版本、描述、包名与当前状态。 |
| 全局启停 | bundle 走 `setBundleEnabled`，行走 `setPluginEnabled`，结果区分「已生效 / 需重启 / 被覆盖 / 失败」。插件管家不允许关掉自己（HTTP 409），免得入口消失。 |
| 单插件设置 | 每行右侧 ⚙ 打开设置抽屉：宿主自省该行的 schemastery `Config` 生成表单（字符串、数字带范围、布尔、枚举、JSON 五类控件，带默认值与「需重载」标记）。保存只提交改动过的字段，经 `configEditor.edit()` 校验并写回。 |
| 按对话放行 | 面板「本对话」页把某个插件的工具、或某个 MCP 服务器，在这一轮对话里对模型隐藏。它在该 Agent 上调 `agent.ctx.tools.restrict()`，所以**对已开始的对话也生效**，下一个请求即可见。策略按会话保存，重载或重启后自动补应用。 |
| 自动描述 | 插件没写 `meta.description` 时，按它自己的 README、客户端 slot id、`package.json` 生成一句话（≤90 字）；作者写的描述永远优先，✨ 可手动重新生成，并标注来源。 |
| AI 中文标签 | 行上的「中」按钮让当前默认模型读这个插件自己的 README、`package.json`、客户端注入点，输出「中文名 + 一句话 + 2–4 个关键词」的 JSON。结果存在 `tags.json`，刷新/重启后仍在，并且中文名直接替换列表里的英文包名。模型答成散文时会带上次输出再问一次，还不行就用规则从插件信息里提炼。设置页可关闭此功能。 |
| 紧凑行、按需展开 | 行默认只显示名称（与徽章），点 ▸ 才展开小字描述、AI 一句话与关键词。 |
| 面板可拖动 | 按住标题栏拖动，位置记在 `localStorage` 并限制在视口内；双击标题栏回到右上角。 |
| 自动发现 | 每 5 分钟静默扫描一次，把新出现的 bundle / 行记成「待纳入管理」，按钮上出现橙点，面板里一键认领。 |
| 内核分区 | DSH 本体自带、且当前 profile 真正组装的包单独列成只读「内核」页（🔒）；它们的启用逻辑在后端与第三方插件完全隔离。 |
| 与能力面板共存 | 检测到 `dsh-capability-panel` / `dsh-capability-composer` / `@super_camel/dsh-plugin-panel` 时只显示一条指向提示，不重复实现它的实时上下文状态，也不做双向同步。 |

入口：

- 输入框工具行左侧的 **🧩 插件**（`conversation.input.left`）→ 浮层面板，含「全局 / 本对话」两档。
- **设置 → 插件管家**（`settings.section`）→ 发现设置、目录路径、按对话策略清单。

### 安装

```sh
dsh plugin add github:Eveneve-night/dsh-plugin-steward
```

或者用插件管理器把本目录当作 bundle 安装：

```
plugin_manager action: install_bundle
target: <本仓库的路径>
```

组合里会插入一行 `plugin-console`（见上文 YAML）。刷新一次 Web UI 使客户端半生效；改源码后用
`set_plugin` 把 `include:plugin-console` 先设 false 再设 true 即可重载。

### 接口与写入的文件

接口表同上，全部挂在 `/plugin-console/api` 下。持久化只有三处：
`<profile>/.plugin-console/state.json`（已知集合、待认领项、设置）、
`<profile>/.plugin-console/sessions/<sessionId>.json`（按对话策略）、
`<profile>/.plugin-console/tags.json`（记住的 AI 中文标签）。其余不做改动——全局开关走平台自己的插件管理器。

### 已知边界

- **纯 UI 插件（壁纸 / 挂件 / 侧栏）无法按对话开关**：客户端插件在 profile 级加载，slot 注册是全局的。这类插件只提供全局启停与「打开它的设置」。
- **按对话放行只覆盖全局注册的工具**：preset / composition 在 agent scope 里注册的工具，`tools.restrict()` 本身也限制不到。
- **设置表单是按 loader 行**的：多行 bundle 可在头部切换行；没有 `Config` 的行显示「没有可配置项」。
- **嵌套对象 / 数组字段**退化为 JSON 文本域。
- **自动描述是启发式的**：可能不准，所以标注来源并可手动重生成。
- **AI 中文标签需要默认模型**：没有默认模型或 provider 报错时，退回规则提炼并把来源标成 `rule`。一个插件一次短调用；生成过的不再重复请求，可在设置页清空。

### 自测

```sh
node dev/smoke-client.mjs
node dev/test-describe.mjs
node --check lib/index.js
```

## License

MIT
