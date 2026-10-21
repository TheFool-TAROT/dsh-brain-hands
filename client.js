/**
 * Brain + Hands — browser half.
 *
 * One configuration card, rendered in the Plugins page's per-row configuration
 * slot, so it opens from this bundle's row in Settings → Plugins. It reads the
 * live model catalog from the Host (`remote.session.modelCatalog`) and writes
 * the whole section — brain route, hand list, switches — as one revision-fenced
 * mutation over the `brain-hands` settings namespace.
 *
 * Plain JavaScript against the browser module table: only `react` is required,
 * styles are one inline `<style>` element, and all copy goes through the locale
 * service so `t` follows the active language.
 */
window.__ModuleLoader__.load({
  id: 'dsh-brain-hands',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Dictionary namespace owned by this plugin. */
    const NS = 'brainHands'
    /** The per-row configuration slot declared by the plugin manager page. */
    const SLOT = 'plugins.row.config'
    /** `<bundle package name>#<row id>` of this bundle's row. */
    const SLOT_KEY = 'dsh-brain-hands#brain-hands'

    const TEXT = {
      zh: {
        summary: '主脑模型负责计划与决策，每个副手各自绑定模型执行高消耗任务。',
        enabled: '启用主脑 / 副手分工',
        enabledHint: '关闭时不向模型暴露任何副手工具，所有模型保持部署原样。',
        brain: '主脑模型',
        brainHint: '制定任务计划、拆解工作、做关键决定并写最终答复的模型。',
        provider: '服务商',
        model: '模型',
        effort: '推理强度',
        unset: '（未设置）',
        defaultEffort: '（跟随模型默认）',
        pushDefault: '把主脑模型设为新会话默认模型',
        pushDefaultHint: '写入 profile 的 agent-default-model，之后新建会话直接用它当大脑。',
        hands: '副手模型',
        handsHint: '每个副手是「名字 + 一个模型」；添加后会自动生成同名委派工具，主脑可把高 token 任务交给它。',
        handName: '名字',
        handNote: '用途说明',
        handNotePlaceholder: '例如：批量读代码、长文写作',
        add: '添加副手',
        remove: '删除',
        noHands: '还没有副手；添加一个，主脑才有可委派的工具。',
        save: '保存',
        saving: '保存中…',
        discard: '放弃修改',
        saved: '已保存',
        saveFailed: '写入被拒绝（可能别处已改动），请重试。',
        loading: '正在读取模型目录…',
        loadFailed: '模型目录读取失败。',
        retry: '重试',
        unavailable: '该命名空间未注册为可配置项，当前部署未提供这个页面。',
        readOnly: '当前会话的设置存储是只读的。',
        dirty: '有未保存的修改',
        comesFrom: '来自',
      },
      en: {
        summary: 'One brain model plans and decides; each hand runs token-heavy work on its own model.',
        enabled: 'Enable the brain / hand split',
        enabledHint: 'Off hides every hand tool from the model and leaves all models as the deployment set them.',
        brain: 'Brain model',
        brainHint: 'The model that plans, decomposes, makes the key decisions, and writes the final answer.',
        provider: 'Provider',
        model: 'Model',
        effort: 'Reasoning effort',
        unset: '(not set)',
        defaultEffort: '(model default)',
        pushDefault: 'Make the brain model the default for new Sessions',
        pushDefaultHint: 'Writes agent-default-model in the profile, so new Sessions start on the brain.',
        hands: 'Hands',
        handsHint: 'Each hand is a name plus one model. Adding one creates a delegation tool for token-heavy work.',
        handName: 'Name',
        handNote: 'What it is for',
        handNotePlaceholder: 'e.g. bulk code reading, long-form writing',
        add: 'Add hand',
        remove: 'Remove',
        noHands: 'No hand yet. Add one and the brain gets something to delegate to.',
        save: 'Save',
        saving: 'Saving…',
        discard: 'Discard',
        saved: 'Saved',
        saveFailed: 'The Host refused the write (something changed elsewhere). Try again.',
        loading: 'Loading the model catalog…',
        loadFailed: 'The model catalog could not be loaded.',
        retry: 'Retry',
        unavailable: 'This namespace is not registered as configurable, so this page is not available here.',
        readOnly: 'This Session stores settings read-only.',
        dirty: 'Unsaved changes',
        comesFrom: 'from',
      },
    }

    /** Tool name one hand maps to; mirrors the Host rule exactly. */
    function toolNameFor(handName) {
      const normalized = String(handName).toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '')
      return `delegate_${normalized.length === 0 ? 'hand' : normalized.slice(0, 40)}`
    }

    /** Trimmed string, or '' for anything else. */
    function str(value) {
      return typeof value === 'string' ? value : ''
    }

    /** Detached editable state from one form snapshot. */
    function readDraft(state) {
      const value = state.value ?? state.base ?? {}
      const primary = value.primary ?? {}
      const hands = Array.isArray(value.hands) ? value.hands : []
      return {
        enabled: value.enabled === true,
        applyPrimaryAsDefault: value.applyPrimaryAsDefault === true,
        primary: {
          provider: str(primary.provider),
          model: str(primary.model),
          reasoningEffort: str(primary.reasoningEffort),
        },
        hands: hands.map(hand => ({
          name: str(hand && hand.name),
          provider: str(hand && hand.provider),
          model: str(hand && hand.model),
          reasoningEffort: str(hand && hand.reasoningEffort),
          note: str(hand && hand.note),
        })),
      }
    }

    /** Model choices the catalog advertises for one provider. */
    function modelsOf(catalog, provider) {
      const group = catalog.groups.find(candidate => candidate.id === provider)
      if (group === undefined) return []
      return group.models.map(candidate => ({ id: candidate.id, name: candidate.name ?? candidate.id }))
    }

    /** Reasoning-effort choices advertised for one exact route. */
    function effortOptions(catalog, provider, model) {
      if (provider === '' || model === '') return []
      const group = catalog.groups.find(candidate => candidate.id === provider)
      if (group === undefined) return []
      const found = group.models.find(candidate => candidate.id === model)
      if (found === undefined || found.reasoning === undefined) return []
      return found.reasoning.efforts.map(effort => ({ id: effort.id, name: effort.name ?? effort.id }))
    }

    const STYLE_TAG = 'dsh-brain-hands'
    const CSS = `
.bh-card{display:flex;flex-direction:column;gap:18px;font-size:13px}
.bh-summary{margin:0;color:var(--dsw-alias-label-secondary)}
.bh-section{display:flex;flex-direction:column;gap:10px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg);padding:14px}
.bh-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
.bh-title{font-weight:600;font-size:14px}
.bh-hint{margin:2px 0 0;color:var(--dsw-alias-label-secondary)}
.bh-row{display:flex;flex-wrap:wrap;gap:10px;align-items:flex-end}
.bh-field{display:flex;flex-direction:column;gap:4px;min-width:148px;flex:1 1 148px}
.bh-field>label{color:var(--dsw-alias-label-secondary);font-size:12px}
.bh-field input,.bh-field select{width:100%;box-sizing:border-box;padding:6px 8px;border-radius:var(--dsw-radius-sm);border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-interactive-bg-primary);color:var(--dsw-alias-label-primary);font:inherit}
.bh-field input:disabled,.bh-field select:disabled{opacity:.55}
.bh-switch{display:inline-flex;align-items:center;gap:8px;cursor:pointer;color:var(--dsw-alias-label-primary)}
.bh-switch input{width:16px;height:16px;accent-color:var(--dsw-alias-interactive-primary)}
.bh-list{display:flex;flex-direction:column;gap:8px;margin:0;padding:0;list-style:none}
.bh-item{display:flex;align-items:center;justify-content:space-between;gap:12px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm);padding:8px 10px}
.bh-item-main{display:flex;flex-direction:column;gap:2px;min-width:0}
.bh-mono{font-family:var(--dsw-font-mono,monospace);font-size:12px}
.bh-route{font-family:var(--dsw-font-mono,monospace);font-size:12px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.bh-actions{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.bh-btn{padding:6px 12px;border-radius:var(--dsw-radius-sm);border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-interactive-bg-primary);color:var(--dsw-alias-label-primary);font:inherit;cursor:pointer}
.bh-btn:disabled{opacity:.5;cursor:default}
.bh-btn-primary{border-color:transparent;background:var(--dsw-alias-interactive-primary);color:var(--dsw-alias-label-inverse)}
.bh-dirty{color:var(--dsw-alias-state-warning-primary,var(--dsw-alias-label-secondary));font-size:12px}
.bh-error{color:var(--dsw-alias-state-error-primary,var(--dsw-alias-label-secondary));font-size:12px}
.bh-muted{color:var(--dsw-alias-label-secondary);font-size:12px}
`

    /** Install the card stylesheet once, and remove it with the plugin. */
    function installStyles() {
      if (typeof document === 'undefined') return () => {}
      if (document.querySelector(`style[data-plugin-css=${JSON.stringify(STYLE_TAG)}]`) !== null) return () => {}
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-brain-hands'
      tag.dataset.pluginCss = STYLE_TAG
      tag.textContent = CSS
      document.head.appendChild(tag)
      return () => { tag.remove() }
    }

    /** One `<select>` over `{id, name}` choices, with an unset/placeholder entry. */
    function Picker(props) {
      const { t, label, value, options, placeholder, disabled, onChange } = props
      return h('div', { className: 'bh-field' },
        h('label', null, label),
        h('select', {
          value,
          disabled,
          onChange: event => { onChange(event.target.value) },
        },
          h('option', { value: '' }, placeholder ?? t('unset')),
          options.map(option => h('option', { key: option.id, value: option.id }, option.name)),
        ),
      )
    }

    /** Provider / model / effort editor shared by the brain and every hand. */
    function RouteFields(props) {
      const { t, catalog, route, disabled, onChange } = props
      const providers = catalog.groups.map(group => ({ id: group.id, name: group.name ?? group.id }))
      const models = modelsOf(catalog, route.provider)
      if (route.model !== '' && !models.some(candidate => candidate.id === route.model)) {
        models.push({ id: route.model, name: route.model })
      }
      const efforts = effortOptions(catalog, route.provider, route.model)
      if (route.reasoningEffort !== '' && !efforts.some(candidate => candidate.id === route.reasoningEffort)) {
        efforts.push({ id: route.reasoningEffort, name: route.reasoningEffort })
      }
      return h(React.Fragment, null,
        h(Picker, {
          t,
          label: t('provider'),
          value: route.provider,
          options: providers,
          disabled,
          onChange: provider => { onChange({ provider, model: '', reasoningEffort: '' }) },
        }),
        h(Picker, {
          t,
          label: t('model'),
          value: route.model,
          options: models,
          disabled: disabled || route.provider === '',
          onChange: model => { onChange({ ...route, model, reasoningEffort: '' }) },
        }),
        h(Picker, {
          t,
          label: t('effort'),
          value: route.reasoningEffort,
          options: efforts,
          placeholder: t('defaultEffort'),
          disabled: disabled || route.model === '' || efforts.length === 0,
          onChange: reasoningEffort => { onChange({ ...route, reasoningEffort }) },
        }),
      )
    }

    /** The configuration card. */
    function Card(props) {
      const { t, form, catalog, catalogStatus, retryCatalog } = props
      const state = form === undefined ? undefined : form.state
      const [draft, setDraft] = React.useState(() => readDraft(state ?? {}))
      const [dirty, setDirty] = React.useState(false)
      const [status, setStatus] = React.useState('idle')
      const revision = state === undefined ? undefined : state.revision

      React.useEffect(() => {
        if (dirty) return
        setDraft(readDraft(state ?? {}))
      }, [revision, dirty])

      if (props.view === 'summary') return h('p', { className: 'bh-summary' }, t('summary'))
      if (form === undefined || state === undefined || state.status === 'unavailable') {
        return h('p', { className: 'bh-muted' }, t('unavailable'))
      }

      const edit = (patch) => {
        setDraft(current => ({ ...current, ...patch }))
        setDirty(true)
        setStatus('idle')
      }
      const editHand = (index, patch) => {
        edit({ hands: draft.hands.map((hand, position) => position === index ? { ...hand, ...patch } : hand) })
      }
      const save = async () => {
        setStatus('saving')
        const value = {
          enabled: draft.enabled,
          applyPrimaryAsDefault: draft.applyPrimaryAsDefault,
          primary: {
            provider: draft.primary.provider,
            model: draft.primary.model,
            reasoningEffort: draft.primary.reasoningEffort,
          },
          hands: draft.hands.map(hand => ({
            name: hand.name,
            provider: hand.provider,
            model: hand.model,
            reasoningEffort: hand.reasoningEffort,
            note: hand.note,
          })),
        }
        const ok = await form.mutate([
          { op: 'set', path: ['enabled'], value: value.enabled },
          { op: 'set', path: ['applyPrimaryAsDefault'], value: value.applyPrimaryAsDefault },
          { op: 'set', path: ['primary'], value: value.primary },
          { op: 'set', path: ['hands'], value: value.hands },
        ], revision)
        if (ok !== true) { setStatus('failed'); return }
        setDirty(false)
        setStatus('saved')
      }

      const busy = status === 'saving'
      const disabled = state.writable === false || busy
      const catalogNote = catalogStatus === 'error'
        ? h('p', { className: 'bh-error' }, `${t('loadFailed')} `,
          h('button', { className: 'bh-btn', onClick: retryCatalog }, t('retry')))
        : catalogStatus === 'loading'
          ? h('p', { className: 'bh-muted' }, t('loading'))
          : null

      return h('div', { className: 'bh-card' },
        h('div', { className: 'bh-head' },
          h('div', null,
            h('div', { className: 'bh-title' }, t('enabled')),
            h('p', { className: 'bh-hint' }, t('enabledHint')),
          ),
          h('label', { className: 'bh-switch' },
            h('input', {
              type: 'checkbox',
              checked: draft.enabled,
              disabled,
              onChange: event => { edit({ enabled: event.target.checked }) },
            }),
          ),
        ),
        h('div', { className: 'bh-section' },
          h('div', null,
            h('div', { className: 'bh-title' }, t('brain')),
            h('p', { className: 'bh-hint' }, t('brainHint')),
          ),
          h('div', { className: 'bh-row' },
            h(RouteFields, {
              t,
              catalog,
              route: draft.primary,
              disabled,
              onChange: route => { edit({ primary: { ...draft.primary, ...route } }) },
            }),
          ),
          h('label', { className: 'bh-switch' },
            h('input', {
              type: 'checkbox',
              checked: draft.applyPrimaryAsDefault,
              disabled,
              onChange: event => { edit({ applyPrimaryAsDefault: event.target.checked }) },
            }),
            h('span', null, t('pushDefault')),
          ),
          h('p', { className: 'bh-hint' }, t('pushDefaultHint')),
          catalogNote,
        ),
        h('div', { className: 'bh-section' },
          h('div', null,
            h('div', { className: 'bh-title' }, t('hands')),
            h('p', { className: 'bh-hint' }, t('handsHint')),
          ),
          draft.hands.length === 0
            ? h('p', { className: 'bh-muted' }, t('noHands'))
            : h('ul', { className: 'bh-list' }, draft.hands.map((hand, index) => h('li', {
              key: `view-${index}`,
              className: 'bh-item',
            },
              h('div', { className: 'bh-item-main' },
                h('span', { className: 'bh-mono' }, `${hand.name === '' ? '?' : hand.name} → ${toolNameFor(hand.name)}`),
                h('span', { className: 'bh-route' },
                  [hand.provider, hand.model].filter(part => part !== '').join('/')
                  + (hand.reasoningEffort === '' ? '' : ` · ${hand.reasoningEffort}`)),
                hand.note === '' ? null : h('span', { className: 'bh-muted' }, hand.note),
              ),
              h('button', {
                className: 'bh-btn',
                disabled,
                onClick: () => { edit({ hands: draft.hands.filter((_hand, position) => position !== index) }) },
              }, t('remove')),
            ))),
          draft.hands.map((hand, index) => h('div', { key: `edit-${index}`, className: 'bh-section' },
            h('div', { className: 'bh-row' },
              h('div', { className: 'bh-field' },
                h('label', null, t('handName')),
                h('input', {
                  type: 'text',
                  value: hand.name,
                  disabled,
                  onChange: event => { editHand(index, { name: event.target.value }) },
                }),
              ),
              h('div', { className: 'bh-field' },
                h('label', null, t('handNote')),
                h('input', {
                  type: 'text',
                  value: hand.note,
                  placeholder: t('handNotePlaceholder'),
                  disabled,
                  onChange: event => { editHand(index, { note: event.target.value }) },
                }),
              ),
            ),
            h('div', { className: 'bh-row' },
              h(RouteFields, {
                t,
                catalog,
                route: hand,
                disabled,
                onChange: route => { editHand(index, route) },
              }),
            ),
          )),
          h('div', { className: 'bh-actions' },
            h('button', {
              className: 'bh-btn',
              disabled,
              onClick: () => {
                edit({ hands: [...draft.hands, { name: '', provider: '', model: '', reasoningEffort: '', note: '' }] })
              },
            }, t('add')),
          ),
        ),
        h('div', { className: 'bh-actions' },
          h('button', {
            className: 'bh-btn bh-btn-primary',
            disabled: !dirty || disabled,
            onClick: () => { void save() },
          }, busy ? t('saving') : t('save')),
          h('button', {
            className: 'bh-btn',
            disabled: !dirty || disabled,
            onClick: () => { setDirty(false); setDraft(readDraft(state)); setStatus('idle') },
          }, t('discard')),
          dirty ? h('span', { className: 'bh-dirty' }, t('dirty')) : null,
          status === 'saved' ? h('span', { className: 'bh-muted' }, t('saved')) : null,
          status === 'failed' ? h('span', { className: 'bh-error' }, t('saveFailed')) : null,
          state.writable === false ? h('span', { className: 'bh-muted' }, t('readOnly')) : null,
        ),
      )
    }

    return {
      inject: ['slots', 'locale', 'remote', 'remote.session'],
      apply(ctx) {
        const t = ctx.locale.bind(NS)
        ctx.effect(() => ctx.locale.register(NS, TEXT), 'brain-hands: dictionaries')
        ctx.effect(installStyles, 'brain-hands: styles')

        /** Catalog snapshot shared by every mounted card. */
        let catalog = { status: 'idle', groups: [], failures: [] }
        let inflight
        const listeners = new Set()
        const publish = (next) => {
          catalog = next
          for (const listener of listeners) listener(next)
        }
        const loadCatalog = () => {
          if (inflight !== undefined) return inflight
          publish({ ...catalog, status: 'loading' })
          inflight = ctx.remote.session.modelCatalog().then(
            (response) => {
              if (response.ok !== true) {
                publish({ status: 'error', groups: [], failures: [] })
                return
              }
              publish({
                status: 'ready',
                groups: response.value.groups ?? [],
                failures: response.value.failures ?? [],
              })
            },
            () => { publish({ status: 'error', groups: [], failures: [] }) },
          ).finally(() => { inflight = undefined })
          return inflight
        }
        ctx.effect(() => ctx.remote.$on('llm/adapters-updated', () => { void loadCatalog() }),
          'brain-hands: catalog invalidation')

        /** Join the shared catalog to the card. */
        const Entry = (props) => {
          const [snapshot, setSnapshot] = React.useState(catalog)
          React.useEffect(() => {
            listeners.add(setSnapshot)
            setSnapshot(catalog)
            if (catalog.status === 'idle') void loadCatalog()
            return () => { listeners.delete(setSnapshot) }
          }, [])
          return h(Card, {
            t: props.t,
            view: props.view,
            form: props.form,
            catalog: snapshot,
            catalogStatus: snapshot.status,
            retryCatalog: () => { void loadCatalog() },
          })
        }

        ctx.slots.inject(SLOT, () => ctx.slots.register({
          name: SLOT,
          key: SLOT_KEY,
          inject: () => ({ t }),
        }, Entry))
      },
    }
  },
})