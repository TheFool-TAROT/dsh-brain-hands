/**
 * Brain + Hands — Host half.
 *
 * One profile settings row owns the whole feature:
 *   - `primary` records the orchestrator (brain) model: it plans, decomposes,
 *     decides, and writes the final answer. Optionally it is pushed to the
 *     profile's default model so every new Session starts on it.
 *   - each entry of `hands` names one hand: a delegation role plus the exact
 *     provider/model route that role's child agent must run on.
 *
 * For every configured hand this plugin registers one model-facing delegation
 * tool (`delegate_<name>`) that starts a child agent through the registered
 * `spawn` subagent provider with the hand's route pinned in `agentOptions`.
 * The brain therefore spends its own context on planning while token-heavy
 * execution (bulk reading, long searches, mass writing) happens on the hand's
 * model.
 *
 * @module dsh-brain-hands
 */

import { execFile } from 'node:child_process'
import { existsSync, readdirSync, statSync, writeFileSync, unlinkSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * Import one package shipped with the dsh installation that is running this
 * plugin. A bundle installed into a profile lives outside that installation, so
 * first-party packages are not resolvable from this file's own directory; they
 * are resolved from the launcher instead, which keeps the plugin working across
 * reinstallations, cache moves, and profiles.
 *
 * @param specifier - package name shipped with dsh.
 * @returns the module namespace.
 */
async function importFromDsh(specifier) {
  const candidates = []
  if (typeof process !== 'undefined' && process !== null) {
    for (const candidate of [process.argv[1], process.argv[0]]) {
      if (typeof candidate === 'string' && candidate.length > 0) candidates.push(candidate)
    }
  }
  candidates.push(import.meta.url)
  for (const candidate of candidates) {
    try {
      const base = candidate.startsWith('file:') ? candidate : pathToFileURL(candidate).href
      const resolved = createRequire(base).resolve(specifier)
      return await import(pathToFileURL(resolved).href)
    } catch {
      continue
    }
  }
  return import(specifier)
}

const schemastery = await importFromDsh('@deepseek-ai/schemastery')
const z = schemastery.default ?? schemastery.Schema ?? schemastery
const { defineTool } = await importFromDsh('@deepseek-ai/dsh-tools')

/**
 * Brand an adapter-owned reasoning-effort identifier; the brand is compile-time
 * only, so the value passes through unchanged.
 *
 * @param id - opaque effort identifier from the model catalog.
 * @returns the same string.
 */
const ReasoningEffortId = id => id

export const name = 'brain-hands'
export const inject = ['tools', 'subagents', 'systemPrompt']

/** Local child-agent backend shipped with the Harness. */

/**
 * One exact provider/model/effort route. The object itself is the live unit:
 * schemastery refuses a volatile leaf inside a volatile field, and the settings
 * form writes one whole route at a time.
 */
const routeSchema = z.object({
  provider: z.string().default(''),
  model: z.string().default(''),
  reasoningEffort: z.string().default(''),
})

/** One named hand: the delegation role plus the model it must run on. */
const handSchema = z.object({
  name: z.string().default(''),
  provider: z.string().default(''),
  model: z.string().default(''),
  reasoningEffort: z.string().default(''),
  note: z.string().default(''),
})

export const Config = z.object({
  /** Master switch: off leaves every model exactly as the deployment configured it. */
  enabled: z.boolean().default(false).volatile(),
  /** Orchestrator (brain) model recorded for the main agent. Volatile: the whole route is one live edit. */
  primary: routeSchema.default({}).volatile(),
  /** Named hands; each entry contributes one delegation tool. Volatile: the settings form may only write live fields. */
  hands: z.array(handSchema).default([]).volatile(),
  /** Push `primary` to the profile's default model so new Sessions start on the brain. */
  applyPrimaryAsDefault: z.boolean().default(false).volatile(),
})

/**
 * Unwrap volatile configuration references.
 *
 * A volatile leaf reaches the plugin as a live reference rather than a plain
 * value (that is the mechanism the settings form writes through), so every
 * read of the configuration goes through this deep unwrap.
 *
 * @param value - one live or plain configuration value.
 * @returns the plain JavaScript value.
 */
function read(value) {
  if (value === null || typeof value !== 'object') return value
  if (typeof value.get === 'function') return read(value.get())
  if (Array.isArray(value)) return value.map(entry => read(entry))
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, read(entry)]))
}

/** Trimmed non-empty string, or undefined. */
function text(value) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

/**
 * Model-facing tool name for one hand.
 * @param handName - the user's display name for the hand.
 * @returns a stable `delegate_*` tool name.
 */
export function toolNameFor(handName) {
  const normalized = String(handName).toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '')
  return `delegate_${normalized.length === 0 ? 'hand' : normalized.slice(0, 40)}`
}

/**
 * Detached snapshot of the live configuration.
 * @param config - the row's Config.
 * @returns enabled state, brain route, and the resolvable hands.
 */
export function snapshot(config) {
  const primary = read(config.primary) ?? {}
  const hands = read(config.hands) ?? []
  return {
    enabled: read(config.enabled) === true,
    applyPrimaryAsDefault: read(config.applyPrimaryAsDefault) === true,
    primary: {
      provider: text(primary.provider),
      model: text(primary.model),
      reasoningEffort: text(primary.reasoningEffort),
    },
    hands: hands.flatMap((entry) => {
      const handName = text(entry?.name)
      const model = text(entry?.model)
      if (handName === undefined || model === undefined) return []
      return [{
        name: handName,
        tool: toolNameFor(handName),
        provider: text(entry?.provider),
        model,
        reasoningEffort: text(entry?.reasoningEffort),
        note: text(entry?.note),
      }]
    }),
  }
}

/** The delegation provider one hand may use: the shipped spawn provider, else any route-pinning provider. */
function pickProvider(subagents) {
  const names = subagents.list()
  if (names.length === 0) throw new Error('brain-hands: no subagent provider is registered')
  const candidates = ['spawn', ...names.filter(candidate => candidate !== 'spawn')]
  const pinned = candidates
    .map(candidate => subagents.getProvider(candidate))
    .find(provider => provider !== undefined && provider.capabilities?.agentOptions === true)
  if (pinned === undefined) {
    throw new Error('brain-hands: no subagent provider can pin a model for the hand')
  }
  return pinned.name
}

/** Delegation depth policy from the current user setting; omitted when the setting leaves it open. */
function resolveMaxDepth(subagents) {
  try {
    const resolved = subagents.resolveMaxDepth()
    return typeof resolved === 'number' ? resolved : undefined
  } catch {
    return undefined
  }
}


const STATE_FILE = 'PROJECT_STATE.md'
const STATE_SKIP = new Set([
  'node_modules', '.git', '__pycache__', '.venv', 'venv', '.pytest_cache',
  'sessions', '.npm', '.cache', 'pkg', 'mod',
  'templates', 'template', 'examples', 'docs', 'test', 'tests',
])
/** 缓存查找结果，避免每次派单都扫盘。key = cwd，value = {file, ts} */
const stateFileCache = new Map()

const BUILTIN_NAMES = new Set([
  'print','len','str','int','float','bool','list','dict','set','tuple','open','range',
  'enumerate','zip','map','filter','sum','min','max','sorted','any','all','isinstance',
  'getattr','setattr','hasattr','super','self','cls','type','repr','format','round',
  'read','write','open','close','main','test','__init__','__main__',
])

/** 从 brief 里提取「应该实现」的函数/类名。
 *  只认明确写法：def/class、实现 xxx(、xxx() ->、`xxx(...)`，避免误抓。*/
function extractExpectedSymbols(text) {
  if (!text) return []
  const names = new Set()
  const add = n => { if (n && !BUILTIN_NAMES.has(n) && /^[A-Za-z_]\w*$/.test(n)) names.add(n) }

  // def xxx / class xxx
  for (const m of text.matchAll(/\b(?:def|class)\s+([A-Za-z_]\w*)/g)) add(m[1])
  // 实现 xxx( / 编写 xxx( / 写一个 xxx( / 写 xxx(
  for (const m of text.matchAll(/(?:实现|编写|写出|写一个|写个|写)\s*`?([A-Za-z_][\w]*)`?\s*\(/g)) add(m[1])
  // xxx() ->  （函数签名形式）
  for (const m of text.matchAll(/`?([A-Za-z_]\w*)`?\s*\([^)]*\)\s*->/g)) add(m[1])
  // 反引号里的 xxx(...)
  for (const m of text.matchAll(/`([A-Za-z_]\w*)\s*\([^`]*\)`/g)) add(m[1])

  return [...names]
}

/** 派单前扫描 .py 文件，写入临时快照，用于事后区分新增/修改。
 *  Linux 上 st_birthtime 不可用、ctime 修改后也会变，只能靠快照对比。*/
function snapshotPyFiles(cwd, maxDepth = 8) {
  const out = []
  const walk = (dir, depth) => {
    if (depth > maxDepth) return
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const ent of entries) {
      if (ent.isFile() && ent.name.endsWith('.py')) {
        try { out.push(path.relative(cwd, path.join(dir, ent.name))) } catch {}
      }
    }
    if (depth === maxDepth) return
    for (const ent of entries) {
      if (!ent.isDirectory()) continue
      if (STATE_SKIP.has(ent.name) || ent.name.startsWith('.')) continue
      walk(path.join(dir, ent.name), depth + 1)
    }
  }
  walk(cwd, 0)
  const file = `/tmp/hand_snap_${Date.now()}_${Math.floor(Math.random()*1e6)}.txt`
  try {
    writeFileSync(file, out.join('\n'), 'utf-8')
    return file
  } catch { return null }
}

/** 从 brief 里提取期望的文件路径（只认含 / 且以 .py 结尾的）。
 *  排除 /tmp 和 /path/to 这类示例路径，避免误报。*/
function extractExpectedPaths(text) {
  if (!text) return []
  const out = new Set()
  for (const m of text.matchAll(/\/?[\w\-.]+(?:\/[\w\-.]+)+\.py\b/g)) {
    const p = m[0]
    if (p.startsWith('/tmp/') || p.startsWith('tmp/')) continue
    if (p.includes('/path/to') || p.includes('path/to/')) continue
    out.add(p)
  }
  return [...out]
}

/** 在 cwd 及其浅层子目录里找 PROJECT_STATE.md，取 mtime 最新的一个。
 *  只向下找 maxDepth 层，跳过 node_modules/.git 等目录，避免扫描过大。*/
function findStateFile(cwd, maxDepth = 2) {
  const now = Date.now()
  const cached = stateFileCache.get(cwd)
  if (cached && now - cached.ts < 10000) return cached.file

  let best = null
  let bestMtime = 0
  const walk = (dir, depth) => {
    if (depth > maxDepth) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const ent of entries) {
      if (ent.isFile() && ent.name === STATE_FILE) {
        const full = path.join(dir, ent.name)
        try {
          const m = statSync(full).mtimeMs
          if (m > bestMtime) { bestMtime = m; best = full }
        } catch {}
      }
    }
    if (depth === maxDepth) return
    for (const ent of entries) {
      if (!ent.isDirectory()) continue
      if (STATE_SKIP.has(ent.name)) continue
      if (ent.name.startsWith('.')) continue
      walk(path.join(dir, ent.name), depth + 1)
    }
  }
  walk(cwd, 0)

  stateFileCache.set(cwd, { file: best, ts: now })
  return best
}

/** hand 没有用户可问，ask_user_question 会让它卡住。
 *  实测 hand 连续调用两次 ask_user_question 后停摆，什么都没产出。*/
function autonomyHint() {
  return '【执行要求】不要调用 ask_user_question —— 你没有用户可问。'
    + '遇到不确定的决策，按最合理的假设继续做，并在最终报告里说明你的假设。'
    + '必须实际写入文件，只描述代码不算完成。\n\n'
}

/** 若工作目录（或其浅层子目录）里有 PROJECT_STATE.md，生成一段"先读它"的提示。
 *  这样 brain 不必在每个 brief 里重复描述项目背景——
 *  实测 36 次派单重复描述花掉约 5.3 万 token（¥0.21），改读文件后接近 0。*/
function stateFileHint(cwd) {
  try {
    const file = findStateFile(cwd)
    if (file !== null) {
      return `【项目状态】先读 ${file}，了解项目结构、接口约定、当前进度和你要做的部分。`
        + '严格按其中的约定交付。\n\n'
    }
  } catch {}
  return ''
}

/** 调用 verify.py 验收 hand 产出。失败或无脚本时返回 null（不阻断流程）。*/
function verifyHandOutput(cwd, since, expect = [], snapshot = null, expectPaths = [], timeoutMs = 120000) {
  const script = path.join(path.dirname(new URL(import.meta.url).pathname), 'verify.py')
  if (!existsSync(script)) return Promise.resolve(null)
  return new Promise(resolve => {
    const argv = [script, cwd, '--since', String(since), '--json']
    if (expect.length > 0) argv.push('--expect', expect.join(','))
    if (snapshot !== null) argv.push('--snapshot', snapshot)
    if (expectPaths.length > 0) argv.push('--expect-path', expectPaths.join(','))
    execFile('python3', argv,
      { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
        const raw = (stdout || '').trim()
        if (!raw) return resolve(null)
        try {
          const parsed = JSON.parse(raw)
          resolve(parsed)
        } catch {
          resolve(null)
        }
      })
  })
}

/** 把验收结果渲染成一段追加到 hand 回复末尾的文字。*/
function renderVerifyReport(report) {
  if (report === null || report === undefined) return ''
  if (report.checked === 0) {
    return '\n\n【产出验收】✗ 没有检测到任何 .py 文件变更。'
      + 'hand 可能只描述了代码而没有实际写入文件。'
      + '请检查：① hand 报告的目标路径是否正确 ② 是否真的需要重派该任务'
  }
  const nAdd = (report.added || []).length
  const nMod = (report.modified || []).length
  const scope = report.added === undefined
    ? `${report.checked} 个文件`
    : `新增 ${nAdd} / 修改 ${nMod}`
  const defs = Object.values(report.symbols || {})
    .flat()
    .filter(x => x !== '(无顶层定义)').length
  if (report.ok) {
    return `\n\n【产出验收】✓ ${scope}，共 ${report.checked} 个文件、${defs} 个定义全部通过`
      + '（语法/导入/无污染）'
  }
  const lines = [`\n\n【产出验收】✗ ${scope}，共 ${report.checked} 个文件，发现问题需修正：`]
  for (const [file, probs] of Object.entries(report.problems || {})) {
    lines.push(`- ${file}`)
    for (const p of probs) lines.push(`    · ${p}`)
  }
  for (const p of report.import_problems || []) lines.push(`- ${p}`)
  if (report.missing && report.missing.length > 0) {
    lines.push(`- 缺少期望的定义: ${report.missing.join(', ')}`)
  }
  if (report.missing_paths && report.missing_paths.length > 0) {
    lines.push(`- 期望的文件未创建: ${report.missing_paths.join(', ')}`)
  }
  return lines.join('\n')
}

/** Await one non-background run, release it, and keep its answer and failure detail. */
async function collectForeground(run) {
  let result
  let failure
  try {
    result = await run.result
  } catch (error) {
    failure = error
  }
  try {
    await run.dispose()
  } catch (error) {
    failure ??= error
  }
  if (failure !== undefined) throw failure
  if (result.stopReason !== 'completed') {
    const diagnostic = result.diagnostic === undefined ? '' : ` — ${result.diagnostic}`
    throw new Error(`brain-hands: the hand stopped before finishing (${String(result.stopReason)})${diagnostic}`)
  }
  return {
    runId: run.id,
    text: result.output.filter(block => block.type === 'text').map(block => block.text).join(''),
  }
}

/** Display form of one hand's route. */
function routeLabel(hand) {
  return hand.provider === undefined ? hand.model : `${hand.provider}/${hand.model}`
}

/**
 * Install the Brain + Hands composition.
 * @param ctx - Host context owning every registration.
 * @param config - the row's validated Config.
 */
export function apply(ctx, config) {
  /** Tool name -> currently mounted hand tool. */
  const mounted = new Map()

  const syncDefaultModel = (settings) => {
    if (!settings.enabled || !settings.applyPrimaryAsDefault) return
    const { provider, model } = settings.primary
    if (provider === undefined || model === undefined) return
    const defaults = ctx.get('agentDefaultModel')
    if (defaults === undefined) return
    try {
      const current = defaults.currentSelection()
      const matches = current.provider === provider && current.model === model
        && String(current.reasoningEffort ?? '') === String(settings.primary.reasoningEffort ?? '')
      if (matches) return
      void defaults.saveSelection({
        provider,
        model,
        ...settings.primary.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: ReasoningEffortId(settings.primary.reasoningEffort) },
      }).then(
        () => { ctx.logger.info(`brain-hands: brain model set to ${provider}/${model}`) },
        (error) => { ctx.logger.warn(`brain-hands: could not set the default model: ${String(error)}`) },
      )
    } catch (error) {
      ctx.logger.warn(`brain-hands: could not set the default model: ${String(error)}`)
    }
  }

  const descriptionFor = (hand) => {
    return `Delegate a self-contained task to the "${hand.name}" hand: a separate agent pinned to `
      + `${routeLabel(hand)} that returns only its result.`
      + (hand.note === undefined ? '' : ` Use it for ${hand.note}.`)
      + ' Write the brief so the hand needs nothing else from this conversation: the goal, the exact inputs and '
      + 'paths, the output shape, and any constraint. Do not name a provider or model: this hand\'s route is fixed.'
  }

  const buildTool = (settings, hand) => defineTool({
    name: hand.tool,
    description: descriptionFor(hand),
    parameters: {
      description: {
        type: 'string',
        required: true,
        description: 'A short (3-5 word) description of the delegated task, for display.',
      },
      prompt: {
        type: 'string',
        required: true,
        description: 'The complete, self-contained task for the hand. It does not share this conversation, '
          + 'so include every path, constraint, and the expected output.',
      },
      run_in_background: {
        type: 'boolean',
        description: 'Defaults to true: the hand is dispatched and its result arrives as a message. '
          + 'Set false to block until it finishes and receive its answer directly in this result.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', required: true, enum: ['continuable', 'foreground'] },
          subagentId: { type: 'string', required: true },
          hand: { type: 'string', required: true },
          model: { type: 'string', required: true },
          text: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.text === undefined
          ? `dispatched the ${value.hand} hand (${value.model}) as subagent ${value.subagentId}; `
            + 'its result arrives as a message when it finishes'
          : `${value.hand} hand (${value.model}) finished:\n\n${value.text}`,
      }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const live = snapshot(config)
      if (!live.enabled) throw new Error('brain-hands: delegation is disabled in this profile')
      const current = live.hands.find(candidate => candidate.name === hand.name)
      if (current === undefined) {
        throw new Error(`brain-hands: hand "${hand.name}" is no longer configured; re-add it in the plugin settings`)
      }
      const parent = exec.agent
      if (parent === undefined) throw new Error(`brain-hands: ${hand.tool} needs a calling agent`)
      const subagents = ctx.get('subagents')
      if (subagents === undefined) throw new Error('brain-hands: the subagents service is unavailable')
      const provider = current.provider ?? live.primary.provider
      if (provider === undefined) {
        throw new Error(`brain-hands: hand "${hand.name}" has no provider; set one in the plugin settings`)
      }
      const childProvider = pickProvider(subagents)
      const signal = exec.signal
      signal.throwIfAborted()
      const maxDepth = resolveMaxDepth(subagents)
      const handCwd = (() => { try { return process.cwd() } catch { return '/root' } })()
      const brief = `You are running as the "${current.name}" hand of the brain model, pinned to `
        + `${routeLabel({ provider, model: current.model })}. Carry this delegated task through to a complete, `
        + 'self-contained result yourself; do not delegate further.\n\n'
        + autonomyHint()
        + stateFileHint(handCwd)
      const request = {
        prompt: [{ type: 'text', text: brief + args.prompt }],
        parent,
        agentOptions: {
          provider,
          model: current.model,
          ...current.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: ReasoningEffortId(current.reasoningEffort) },
        },
        ...maxDepth === undefined ? {} : { maxDepth },
      }
      const label = args.description ?? `${current.name} hand`
      if (args.run_in_background !== false) {
        const started = await subagents.startContinuable({
          provider: childProvider,
          label,
          request,
          signal,
        })
        return {
          kind: 'continuable',
          subagentId: String(started.childId),
          hand: current.name,
          model: routeLabel({ provider, model: current.model }),
        }
      }
      const handSnap = snapshotPyFiles(handCwd)
      const handStartTs = Date.now() / 1000
      const result = await collectForeground(
        await subagents.start(childProvider, { label, ...request, signal }),
      )
      // 自动验收 hand 产出：语法 / 导入 / Markdown 围栏污染
      let verifyText = ''
      try {
        const expected = extractExpectedSymbols(args.prompt)
        const expectedPaths = extractExpectedPaths(args.prompt)
        const report = await verifyHandOutput(handCwd, handStartTs, expected, handSnap, expectedPaths)
        if (handSnap !== null) { try { unlinkSync(handSnap) } catch {} }
        verifyText = renderVerifyReport(report)
      } catch {}
      return {
        kind: 'foreground',
        subagentId: String(result.runId),
        hand: current.name,
        model: routeLabel({ provider, model: current.model }),
        text: result.text + verifyText,
      }
    },
  })

  const reconcileOnce = () => {
    const settings = snapshot(config)
    const wanted = settings.enabled ? settings.hands : []
    const before = [...mounted.keys()].sort()
    // Two hands may sanitize to the same tool name; the first one owns it.
    const owners = new Map()
    for (const hand of wanted) if (!owners.has(hand.tool)) owners.set(hand.tool, hand)
    const unique = [...owners.values()]
    const wantedTools = new Set(unique.map(hand => hand.tool))
    for (const toolName of [...mounted.keys()]) {
      if (wantedTools.has(toolName)) continue
      const entry = mounted.get(toolName)
      mounted.delete(toolName)
      entry.dispose()
    }
    for (const hand of unique) {
      const signature = `${hand.provider ?? ''}|${hand.model ?? ''}|${hand.reasoningEffort ?? ''}|${hand.note ?? ''}`
      const existing = mounted.get(hand.tool)
      if (existing !== undefined) {
        if (existing.signature === signature) continue
        mounted.delete(hand.tool)
        existing.dispose()
      }
      try {
        const definition = buildTool(settings, hand)
        const dispose = ctx.effect(() => {
          const unregister = ctx.tools.register(definition)
          return () => { unregister() }
        })
        mounted.set(hand.tool, { signature, dispose })
      } catch (error) {
        ctx.logger.warn(`brain-hands: could not mount ${hand.tool}: ${String(error)}`)
      }
    }
    syncDefaultModel(settings)
    const after = [...mounted.keys()].sort()
    if (before.join() !== after.join()) {
      ctx.logger.info(after.length === 0
        ? 'brain-hands: no hand tool mounted'
        : `brain-hands: mounted ${after.join(', ')}`)
    }
  }

  // Registering a tool emits `tools/change`, so a listener may re-enter this
  // while a mount is still in flight; the guard reruns once instead.
  let reconciling = false
  let again = false
  const reconcile = () => {
    if (reconciling) {
      again = true
      return
    }
    reconciling = true
    try {
      do {
        again = false
        reconcileOnce()
      } while (again)
    } finally {
      reconciling = false
    }
  }

  ctx.effect(() => ctx.systemPrompt.section({
    name: 'brain-hands',
    order: ctx.systemPrompt.getSectionOrder('TOOL_SUBAGENT') + 5,
    text: () => {
      const settings = snapshot(config)
      if (!settings.enabled || mounted.size === 0) return ''
      const brain = settings.primary.provider === undefined || settings.primary.model === undefined
        ? 'the model selected for this session'
        : `${settings.primary.provider}/${settings.primary.model}`
      const lines = [...mounted.keys()].sort().map((toolName) => {
        const hand = settings.hands.find(candidate => candidate.tool === toolName)
        if (hand === undefined) return `- \`${toolName}\``
        const note = hand.note === undefined ? '' : ` — for ${hand.note}`
        return `- \`${toolName}\` — ${hand.name} on ${routeLabel(hand)}${note}`
      })
      return '## Brain and hands\n\n'
        + `You are the brain: ${brain}. You own planning, decomposition, key decisions, and the final answer. `
        + 'Hands run on their own models in their own contexts and return only their result, so heavy work goes '
        + 'to a hand and your context stays for judgement.\n\n'
        + 'Dispatch a hand instead of doing the step yourself whenever that step is any of:\n'
        + '- reading, searching, or summarising several files, a whole tree, or a long document;\n'
        + '- producing a long output: a report, a document, a long code block, or an image;\n'
        + '- otherwise reachable only through many repeated tool calls.\n\n'
        + 'Keep a step in your own context only when it is one small action whose result you must judge '
        + 'directly. When steps are independent, call their hands in the same message and keep working while '
        + 'they run. `subagent`, `subagent_fork`, and `workflow` run on your own model; a hand is how heavy '
        + 'work leaves it. Doing that work yourself is the failure this arrangement exists to prevent.\n\n'
        + `Available hands:\n${lines.join('\n')}`
    },
  }))

  ctx.on('tools/change', () => { reconcile() })
  // The settings form writes live fields into the running references; the loader
  // reports those in place, so the mounted tools follow the edited hand list.
  ctx.on('loader/volatile-update', () => { reconcile() })
  reconcile()
}