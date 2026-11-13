/**
 * dsh-search-fetch-router —— 浏览器端设置卡片：填 Tavily / Firecrawl 的 API key。
 *
 * 为什么需要这个文件：本插件是纯 host bundle，配置里只有 key 的**引用名**
 * （`tavilyApiKeyRefs` / `firecrawlApiKeyRefs`），没有 `role("secret")` 字段。
 * 而 DSH 的通用设置表单**不渲染 secret/credential 字段**，bundle 插件详情页的
 * 配置区又只由插件自己的 client bundle 提供组件——没有 client bundle，插件页
 * 就只有 README，用户找不到地方填 key。因此这里补一个零构建的 client bundle。
 *
 * 挂载点：`plugins.detail.section`（list 座位）。它出现在插件详情页 README 下方，
 * 正是用户找 key 输入框的地方。座位是 list，页面给**任何**详情页都渲染它，所以
 * 组件必须自己按 `props.subject` 判掉别人的包，否则会串到别的插件页上。
 *
 * 读写路径：值经宿主 `remote.credentials` 落到 `~/.dsh/.credentials.yaml`（0600），
 * **永不进 `cordis.patch.yml`**。这与内置的「网络搜索」设置页同一套机制。
 *
 * 约束（改这个文件前先读）：
 * - 零构建：只 `require` 种子模块（`react` / `react-dom` /
 *   `@deepseek-ai/dsh-client-ui-primitives` 等），手写 `React.createElement`，无 JSX。
 * - 样式用宿主主题变量 `--dsw-alias-*` 并带中性回退值，明暗两套主题都可读。
 * - 组件是 `plugins.detail.section` 的 list 座位：自带 `id`，不声明 `inject`（owner
 *   props 由页面传入）。
 *
 * @module dsh-search-fetch-router/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-search-fetch-router',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const react = require('react');
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives');

    /** locale 命名空间，也是词表的键。 */
    const NS = 'dsh-search-fetch-router';
    /** 本插件在 profile 里的组合包名（`subject.pkg.name` 与它比对）。 */
    const PACKAGE_NAME = 'dsh-search-fetch-router';
    /** 配置命名空间 = 本插件入口 id（`cordis.patch.yml` 里 insert 的 id）。 */
    const SETTINGS_NS = 'search-fetch-router';
    /** 卡片座位。 */
    const SECTION_SLOT = 'plugins.detail.section';

    const h = react.createElement;

    // #region 词表（键集必须与 en 完全一致）
    const zh = {
      title: 'API 密钥',
      description:
        '在这里填入 Tavily、Exa 与 Firecrawl 的密钥。密钥保存到本机 DSH 凭据库（0600），'
        + '不会写进任何配置文件。',
      tavilyGroup: 'Tavily',
      exaGroup: 'Exa',
      firecrawlGroup: 'Firecrawl',
      configured: '已配置',
      notSet: '未配置',
      configuredHint: '已有密钥。输入新值可覆盖。',
      emptyHint: '还没有配置密钥，粘贴到上面的输入框后点保存。',
      show: '显示',
      hide: '隐藏',
      savedPlaceholder: '已保存，输入新值可覆盖',
      save: '保存',
      saving: '保存中…',
      note:
        '每把 key 一行。「添加账号」会自动追加一个引用名并生成新输入框，请求在这些账号'
        + '之间轮转；密钥仍然只存在本机凭据库，不进任何配置文件。',
      noProvider: '当前部署没有挂载凭据服务，无法保存密钥。',
      failed: '保存失败',
      addAccount: '添加账号',
      remove: '移除',
      removeHint: '至少保留一个账号',
      enabled: '已启用',
      disabled: '已停用',
      enable: '启用',
      disable: '停用',
      moveUp: '上移',
      moveDown: '下移',
      notePlaceholder: '备注（仅本机，方便分辨）',
      dragHandle: '拖动排序',
    };
    const en = {
      title: 'API keys',
      description:
        'Paste your Tavily, Exa and Firecrawl keys here. They are stored in the local DSH '
        + 'credential store (mode 0600) and never written into any config file.',
      tavilyGroup: 'Tavily',
      exaGroup: 'Exa',
      firecrawlGroup: 'Firecrawl',
      configured: 'Configured',
      notSet: 'Not set',
      configuredHint: 'A key is stored. Enter a new value to replace it.',
      emptyHint: 'No key yet. Paste one above and press Save.',
      show: 'Show',
      hide: 'Hide',
      savedPlaceholder: 'Saved — type a new value to replace',
      save: 'Save',
      saving: 'Saving…',
      note:
        'One row per key. "Add account" appends a reference name and a new field; requests rotate '
        + 'across them. Keys still live only in the local credential store, never in a config file.',
      noProvider: 'This deployment mounts no credential provider, so keys cannot be stored.',
      failed: 'Save failed',
      addAccount: 'Add account',
      remove: 'Remove',
      removeHint: 'Keep at least one account',
      enabled: 'Enabled',
      disabled: 'Disabled',
      enable: 'Enable',
      disable: 'Disable',
      moveUp: 'Move up',
      moveDown: 'Move down',
      notePlaceholder: 'Note (local only, to tell keys apart)',
      dragHandle: 'Drag to reorder',
    };
    const DICTIONARIES = Object.freeze({ zh, en });

    /**
     * 可排序 / 可停用的供应商（带 key），搜索与抓取共用同一张表。`id` 必须与
     * lib/search-backends.js / lib/fetch-backends.js 的注册 id 一致——它就是写进
     * providerOrder 的值。官方 deepseek-official 与本地 http 是无 key 的兜底，不在此列。
     */
    const SEARCH_PROVIDERS = Object.freeze([
      { id: 'tavily', titleKey: 'tavilyGroup', field: 'tavilyApiKeyRefs', base: 'TAVILY_API_KEY' },
      { id: 'exa', titleKey: 'exaGroup', field: 'exaApiKeyRefs', base: 'EXA_API_KEY' },
      { id: 'firecrawl', titleKey: 'firecrawlGroup', field: 'firecrawlApiKeyRefs', base: 'FIRECRAWL_API_KEY' },
    ]);

    /** 预留：目前没有「只抓取、不搜索」的供应商，抓取组为空。 */
    const FETCH_GROUPS = Object.freeze([]);

    /** 取 `props.t`（由 slot 宿主按 locale 接好），否则按浏览器语言选词表。 */
    function translate(props) {
      if (typeof props?.t === 'function') return props.t;
      const language =
        typeof navigator !== 'undefined' && typeof navigator.language === 'string'
          ? navigator.language.toLowerCase()
          : '';
      const dictionary = language.startsWith('zh') ? zh : en;
      return (key) => dictionary[key] ?? en[key] ?? key;
    }
    // #endregion

    // #region 样式（宿主主题变量 + 中性回退）
    const css = {
      card: {
        display: 'flex',
        flexDirection: 'column',
        gap: '14px',
        padding: '16px 18px',
        marginTop: '12px',
        border: '1px solid var(--dsw-alias-border-subtle, rgba(128,128,128,.28))',
        borderRadius: '10px',
        background: 'var(--dsw-alias-bg-subtle, rgba(128,128,128,.06))',
        color: 'var(--dsw-alias-text-primary, inherit)',
        font: 'inherit',
      },
      cardTitle: { fontSize: '15px', fontWeight: 600 },
      monoHint: {
        fontSize: '11px',
        color: 'var(--dsw-alias-text-tertiary, inherit)',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      },
      desc: {
        margin: 0,
        fontSize: '12px',
        lineHeight: 1.5,
        color: 'var(--dsw-alias-text-secondary, inherit)',
        opacity: 0.85,
      },
      group: { display: 'flex', flexDirection: 'column', gap: '10px' },
      groupTitle: {
        fontSize: '13px',
        fontWeight: 600,
        letterSpacing: '.02em',
        color: 'var(--dsw-alias-text-secondary, inherit)',
      },
      fieldWrap: { display: 'flex', flexDirection: 'column', gap: '8px' },
      head: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '10px',
      },
      label: { fontSize: '13px', fontWeight: 600 },
      badge: (configured) => ({
        fontSize: '11px',
        lineHeight: 1.4,
        padding: '1px 8px',
        borderRadius: '999px',
        whiteSpace: 'nowrap',
        border: '1px solid var(--dsw-alias-border-subtle, rgba(128,128,128,.35))',
        color: configured
          ? 'var(--dsw-alias-text-primary, inherit)'
          : 'var(--dsw-alias-text-secondary, inherit)',
        opacity: configured ? 1 : 0.7,
      }),
      inputRow: { display: 'flex', alignItems: 'center', gap: '8px' },
      input: {
        flex: 1,
        minWidth: 0,
        padding: '7px 10px',
        fontSize: '13px',
        fontFamily: 'inherit',
        borderRadius: '7px',
        border: '1px solid var(--dsw-alias-border-subtle, rgba(128,128,128,.35))',
        background: 'var(--dsw-alias-bg-elevated, rgba(128,128,128,.10))',
        color: 'var(--dsw-alias-text-primary, inherit)',
        outline: 'none',
      },
      eyeBtn: (active) => ({
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: '30px',
        height: '30px',
        padding: 0,
        borderRadius: '7px',
        cursor: 'pointer',
        border: '1px solid var(--dsw-alias-border-subtle, rgba(128,128,128,.35))',
        background: active
          ? 'var(--dsw-alias-bg-elevated, rgba(128,128,128,.16))'
          : 'transparent',
        color: 'inherit',
        opacity: active ? 1 : 0.65,
      }),
      hint: {
        margin: 0,
        fontSize: '12px',
        lineHeight: 1.5,
        color: 'var(--dsw-alias-text-secondary, inherit)',
        opacity: 0.75,
      },
      actionRow: { display: 'flex', alignItems: 'center', gap: '10px' },
      button: (enabled) => ({
        padding: '6px 14px',
        fontSize: '13px',
        borderRadius: '7px',
        cursor: enabled ? 'pointer' : 'default',
        border: '1px solid var(--dsw-alias-border-subtle, rgba(128,128,128,.35))',
        background: enabled
          ? 'var(--dsw-alias-bg-elevated, rgba(128,128,128,.16))'
          : 'transparent',
        color: 'inherit',
        opacity: enabled ? 1 : 0.5,
      }),
      smallBtn: (enabled = true) => ({
        alignSelf: 'flex-start',
        padding: '4px 10px',
        fontSize: '12px',
        borderRadius: '6px',
        cursor: enabled ? 'pointer' : 'default',
        border: '1px dashed var(--dsw-alias-border-subtle, rgba(128,128,128,.40))',
        background: 'transparent',
        color: 'inherit',
        opacity: enabled ? 0.85 : 0.45,
      }),
      error: { color: 'var(--dsw-alias-danger, #d14343)', fontSize: '12px' },
      note: {
        margin: 0,
        fontSize: '12px',
        lineHeight: 1.5,
        color: 'var(--dsw-alias-text-secondary, inherit)',
        opacity: 0.75,
      },
    };
    // #endregion

    /** 从配置快照里读某个 ref 名数组，读不到就用回退。 */
    function refsFor(form, field, fallback) {
      let value;
      try {
        value = form?.getSnapshot?.()?.value;
      } catch {
        value = undefined;
      }
      const array = value?.[field];
      return Array.isArray(array) && array.length > 0 ? array.slice() : fallback.slice();
    }

    /** 在已有 ref 名里挑下一个可用的名字：base、base_2、base_3…… */
    function nextRefName(list, base) {
      if (!list.includes(base)) return base;
      for (let n = 2; n < 10_000; n += 1) {
        const candidate = `${base}_${n}`;
        if (!list.includes(candidate)) return candidate;
      }
      return `${base}_${list.length + 1}`;
    }

    /** 订阅配置表单的变更，让 ref 名列表随配置刷新。 */
    function useFormTick(form) {
      const [, setTick] = react.useState(0);
      react.useEffect(() => {
        if (form === undefined || typeof form.subscribe !== 'function') return undefined;
        const off = form.subscribe(() => setTick((n) => (n + 1) % 1_000_000_007));
        return typeof off === 'function' ? off : undefined;
      }, [form]);
    }

    /** 眼睛图标：`off` 为真时画带斜线的闭合眼，表示「现在是隐藏态，点我看明文」。 */
    function EyeIcon(props) {
      const common = {
        width: 16,
        height: 16,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 2,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
        focusable: false,
      };
      if (props.off) {
        return h('svg', common, [
          h('path', {
            key: 'body',
            d: 'M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24',
          }),
          h('path', { key: 'slash', d: 'M1 1l22 22' }),
        ]);
      }
      return h('svg', common, [
        h('path', { key: 'body', d: 'M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z' }),
        h('circle', { key: 'pupil', cx: 12, cy: 12, r: 3 }),
      ]);
    }

    /**
     * 一行密钥：输入框（可切明文）+ 眼睛按钮 + 保存 + 状态。
     *
     * 为什么不用宿主的 `SettingsSecretField`：它内部把 input 固定成
     * `type="password"`，没有切换开关，用户看不到自己刚敲的草稿。这里自绘一个
     * 同构的输入行，眼睛按钮只对「正在输入、尚未保存」的草稿生效——已保存的值
     * 本来也取不回来，没有可显示的东西。
     */
    /** 读搜索链顺序；缺省用内置默认（tavily、exa 都启用，运行时按有没有 key 跳过）。 */
    function orderFor(form) {
      let value;
      try { value = form?.getSnapshot?.()?.value; } catch { value = undefined; }
      const raw = value?.providerOrder;
      return Array.isArray(raw) ? raw.filter((x) => typeof x === 'string' && x.length > 0) : ['tavily', 'exa', 'firecrawl'];
    }

    // 排序 / 启用相关的纯函数（不碰 mutate、不碰渲染），单测直接调用。
    function mergeKnown(known, unknown) {
      return [...known, ...unknown];
    }

    function applyProviderToggle(known, id, on) {
      if (on) return known.includes(id) ? known.slice() : known.concat(id);
      return known.filter((x) => x !== id);
    }

    function moveItemBefore(known, dragged, target) {
      if (dragged === target) return known.slice();
      const rest = known.filter((x) => x !== dragged);
      const at = rest.indexOf(target);
      if (at < 0) return known.slice();
      return [...rest.slice(0, at), dragged, ...rest.slice(at)];
    }

    function swapItem(known, id, delta) {
      const from = known.indexOf(id);
      const to = from + delta;
      if (from < 0 || to < 0 || to >= known.length) return known.slice();
      const next = known.slice();
      [next[from], next[to]] = [next[to], next[from]];
      return next;
    }

    function sameOrder(a, b) {
      return a.length === b.length && a.every((x, i) => x === b[i]);
    }

    /** 读每把 key 的本机备注（ref → 一句话）。 */
    function notesFor(form) {
      let value;
      try { value = form?.getSnapshot?.()?.value; } catch { value = undefined; }
      const raw = value?.keyNotes;
      return raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    }

    function KeyField(props) {
      const { t, reference, status, draft, onEdit, onSave, onRemove, note, onNoteCommit } = props;
      const configured = status?.configured === true;
      const busy = status?.busy === true;
      const disabled = busy || status?.writable === false;
      const text = String(draft ?? '');
      const hasDraft = text !== '';
      const enabled = busy !== true && hasDraft;
      const [revealed, setRevealed] = react.useState(false);

      return h('div', { style: css.fieldWrap }, [
        h('div', { key: 'head', style: css.head }, [
          h('label', { key: 'label', htmlFor: `sfr-key-${reference}`, style: css.label }, reference),
          h(
            'span',
            { key: 'badge', style: css.badge(configured) },
            configured
              ? (typeof status?.masked === 'string' && status.masked.length > 0
                  ? `${t('configured')} · ${status.masked}`
                  : t('configured'))
              : t('notSet'),
          ),
        ]),
        h('div', { key: 'row', style: css.inputRow }, [
          h('input', {
            key: 'input',
            id: `sfr-key-${reference}`,
            'data-sfr-key': reference,
            type: revealed ? 'text' : 'password',
            autoComplete: 'new-password',
            spellCheck: false,
            placeholder: configured ? t('savedPlaceholder') : '',
            value: text,
            disabled,
            style: css.input,
            onChange: (event) => onEdit(event.target.value),
          }),
          hasDraft
            ? h(
                'button',
                {
                  key: 'eye',
                  type: 'button',
                  style: css.eyeBtn(revealed),
                  title: revealed ? t('hide') : t('show'),
                  'aria-label': revealed ? t('hide') : t('show'),
                  'aria-pressed': revealed,
                  onClick: () => setRevealed((value) => !value),
                },
                h(EyeIcon, { off: revealed }),
              )
            : null,
          h(
            'button',
            {
              key: 'save',
              type: 'button',
              style: css.button(enabled),
              disabled: !enabled,
              onClick: onSave,
            },
            busy ? t('saving') : t('save'),
          ),
          typeof onRemove === 'function'
            ? h(
                'button',
                {
                  key: 'rm',
                  type: 'button',
                  style: css.smallBtn(true),
                  title: t('remove'),
                  'aria-label': t('remove'),
                  onClick: onRemove,
                },
                t('remove'),
              )
            : null,
        ]),
        h(
          'p',
          { key: 'hint', style: css.hint },
          configured ? t('configuredHint') : t('emptyHint'),
        ),
        h(
          'div',
          { key: 'note', style: css.inputRow },
          [
            h('input', {
              key: 'noteInput',
              'data-sfr-note': reference,
              type: 'text',
              placeholder: t('notePlaceholder'),
              defaultValue: String(note ?? ''),
              disabled,
              style: css.input,
              onBlur: (event) => {
                if (typeof onNoteCommit === 'function' && event.target.value !== String(note ?? '')) {
                  onNoteCommit(event.target.value);
                }
              },
            }),
          ],
        ),
        status?.error
          ? h('span', { key: 'err', style: css.error }, `${t('failed')}: ${status.error}`)
          : null,
      ]);
    }

    /** 卡片主体。 */
    function RouterSettingsCard(props) {
      const t = translate(props);
      const { ctx, form } = props;

      useFormTick(form);

      // 供应商列表（按 providerOrder 排序/停用）；每家可能同时提供搜索与抓取。每组的 ref 名列表随配置刷新。
      const searchGroups = SEARCH_PROVIDERS.map((entry) => ({
        ...entry,
        refs: refsFor(form, entry.field, [entry.base]),
      }));
      const fetchGroups = FETCH_GROUPS.map((entry) => ({
        ...entry,
        refs: refsFor(form, entry.field, [entry.base]),
      }));
      const groups = [...searchGroups, ...fetchGroups];
      const refs = groups.flatMap((entry) => entry.refs);
      const refsKey = refs.join('\u0000');

      // 搜索链顺序 = 启用顺序。只认内置搜索供应商；未知 id 原样保留在末尾，不丢用户手填的。
      const rawOrder = orderFor(form);
      const isKnownSearch = (id) => SEARCH_PROVIDERS.some((p) => p.id === id);
      const knownOrder = rawOrder.filter(isKnownSearch);
      const unknownOrder = rawOrder.filter((id) => !isKnownSearch(id));
      const notes = notesFor(form);
      // 视觉顺序必须跟 providerOrder 走，否则点排序只改配置、界面不动。
      const searchById = new Map(searchGroups.map((entry) => [entry.id, entry]));
      const orderedSearchGroups = [
        ...knownOrder.map((id) => searchById.get(id)).filter(Boolean),
        ...SEARCH_PROVIDERS.filter((p) => !knownOrder.includes(p.id)).map((p) => searchById.get(p.id)),
      ];

      const [drafts, setDrafts] = react.useState({});
      const [status, setStatus] = react.useState({});
      const [editError, setEditError] = react.useState(null);
      const [tick, setTick] = react.useState(0);
      const [dragId, setDragId] = react.useState(null);

      const credentials = ctx?.remote?.credentials;

      // 挂载时（以及 refs 变化、刷新时）读一次每把 key 的配置状态。
      react.useEffect(() => {
        let live = true;
        if (credentials === undefined || refs.length === 0) return undefined;
        (async () => {
          const next = {};
          try {
            const response = await credentials.describe(refs);
            for (const reference of refs) {
              const view = response?.ok ? response.value?.[reference] : undefined;
              next[reference] = {
                configured: view?.configured === true,
                masked: typeof view?.masked === 'string' ? view.masked : undefined,
                writable: view?.writable !== false,
                busy: false,
                error: null,
              };
            }
          } catch (error) {
            for (const reference of refs) {
              next[reference] = {
                configured: false,
                masked: undefined,
                writable: true,
                busy: false,
                error: null,
              };
            }
            if (live) setStatus((current) => ({ ...current, ...next }));
            return;
          }
          if (live) setStatus((current) => ({ ...current, ...next }));
        })();
        return () => {
          live = false;
        };
      }, [credentials, refsKey, tick]);

      // 宿主报告某个 ref 变了（别处写入）时刷新对应状态。
      react.useEffect(() => {
        if (credentials === undefined || typeof ctx?.remote?.$on !== 'function') return undefined;
        return ctx.remote.$on('credentials/reference-updated', (changed) => {
          if (refs.includes(changed)) setTick((n) => (n + 1) % 1_000_000_007);
        });
      }, [credentials, refsKey]);

      if (credentials === undefined) {
        return h('div', { style: css.card }, [
          h('div', { key: 't', style: css.cardTitle }, t('title')),
          h('p', { key: 'p', style: css.error }, t('noProvider')),
        ]);
      }

      async function save(reference) {
        const text = String(drafts[reference] ?? '').trim();
        if (text === '') return;
        setStatus((current) => ({
          ...current,
          [reference]: { ...(current[reference] ?? {}), busy: true, error: null },
        }));
        try {
          const response = await credentials.set(reference, text);
          if (response !== undefined && response?.ok === false) {
            throw new Error(response?.error?.message ?? t('failed'));
          }
          setDrafts((current) => ({ ...current, [reference]: '' }));
          let configured = true;
          let masked;
          try {
            const described = await credentials.describe([reference]);
            const view = described?.ok ? described.value?.[reference] : undefined;
            configured = view?.configured !== false;
            masked = typeof view?.masked === 'string' ? view.masked : undefined;
          } catch {
            configured = true;
          }
          setStatus((current) => ({
            ...current,
            [reference]: {
              configured,
              masked,
              writable: current[reference]?.writable !== false,
              busy: false,
              error: null,
            },
          }));
        } catch (error) {
          setStatus((current) => ({
            ...current,
            [reference]: {
              ...(current[reference] ?? {}),
              busy: false,
              error: String(error?.message ?? error),
            },
          }));
        }
      }

      const canEdit = form !== undefined && typeof form.mutate === 'function';


      const mutateRefs = async (ops) => {
        if (!canEdit) return;
        setEditError(null);
        try {
          const accepted = await form.mutate(ops);
          if (accepted === false) setEditError(t('failed'));
          // mutate 后强制重渲染一次，确保立刻读到新快照（否则排序点了界面不刷新）。
          setTick((n) => (n + 1) % 1_000_000_007);
        } catch (error) {
          setEditError(String(error?.message ?? error));
        }
      };

      const addRef = (field, base) => {
        const list = refsFor(form, field, [base]);
        const name = nextRefName(list, base);
        return mutateRefs([{ op: 'set', path: [field, list.length], value: name }]);
      };

      const removeRef = (field, index) => mutateRefs([{ op: 'unset', path: [field, index] }]);

      const setOrder = (known) =>
        mutateRefs([{ op: 'set', path: ['providerOrder'], value: mergeKnown(known, unknownOrder) }]);
      const toggleProvider = (id, on) =>
        setOrder(applyProviderToggle(knownOrder, id, on));
      const moveProvider = (id, delta) => {
        const next = swapItem(knownOrder, id, delta);
        return sameOrder(next, knownOrder) ? Promise.resolve() : setOrder(next);
      };

      // 一组 key 的输入行（含备注）。
      const keyFields = (list, field, base) =>
        list.map((reference, index) =>
          h(KeyField, {
            key: reference,
            ctx,
            t,
            reference,
            status: status[reference],
            draft: drafts[reference],
            note: notes[reference],
            onEdit: (text) => setDrafts((current) => ({ ...current, [reference]: text })),
            onSave: () => save(reference),
            onRemove: list.length > 1 ? () => removeRef(field, index) : undefined,
            onNoteCommit: (text) => mutateRefs([{ op: 'set', path: ['keyNotes', reference], value: text }]),
          }),
        );

      const addButton = (field, base) =>
        h('button', {
          key: 'add',
          type: 'button',
          style: css.smallBtn(canEdit),
          disabled: !canEdit,
          onClick: () => addRef(field, base),
        }, t('addAccount'));

      const moveBefore = (dragged, target) => {
        const next = moveItemBefore(knownOrder, dragged, target);
        return sameOrder(next, knownOrder) ? Promise.resolve() : setOrder(next);
      };

      const renderGroup = (entry) => {
        const { titleKey, refs: list, field, base } = entry;
        const id = entry.id;
        const isSearch = typeof id === 'string';
        const enabled = isSearch && knownOrder.includes(id);
        const position = isSearch ? knownOrder.indexOf(id) : -1;
        const masked = list.map((r) => status[r]).find((s) => typeof s?.masked === 'string' && s.masked.length > 0)?.masked;
        const grip = enabled
          ? h('span', {
              key: 'grip',
              draggable: true,
              title: t('dragHandle'),
              'aria-label': t('dragHandle'),
              style: { cursor: 'grab', userSelect: 'none', color: 'var(--dsw-alias-text-tertiary, inherit)', fontSize: '13px' },
              onDragStart: (event) => {
                try {
                  event.dataTransfer?.setData('text/plain', id);
                  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
                } catch {
                  // 有些环境没有 dataTransfer，忽略即可，仍靠 dragId 状态排序。
                }
                setDragId(id);
              },
              onDragEnd: () => setDragId(null),
            }, '⠿')
          : null;
        const header = isSearch
          ? h('div', { key: 'h', style: css.head }, [
              h('div', { key: 'l', style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } }, [
                grip,
                h('span', { key: 'title', style: css.groupTitle }, t(titleKey)),
                h('span', { key: 'state', style: css.badge(enabled) }, enabled ? t('enabled') : t('disabled')),
                masked ? h('span', { key: 'mask', style: css.monoHint }, masked) : null,
              ]),
              h('div', { key: 'c', style: { display: 'flex', gap: '6px' } }, [
                enabled
                  ? h('button', { key: 'up', type: 'button', style: css.smallBtn(position > 0), disabled: position <= 0, title: t('moveUp'), 'aria-label': t('moveUp'), onClick: () => moveProvider(id, -1) }, '↑')
                  : null,
                enabled
                  ? h('button', { key: 'dn', type: 'button', style: css.smallBtn(position < knownOrder.length - 1), disabled: position >= knownOrder.length - 1, title: t('moveDown'), 'aria-label': t('moveDown'), onClick: () => moveProvider(id, 1) }, '↓')
                  : null,
                h('button', { key: 'tg', type: 'button', style: css.smallBtn(canEdit), disabled: !canEdit, title: enabled ? t('disable') : t('enable'), 'aria-label': enabled ? t('disable') : t('enable'), onClick: () => toggleProvider(id, !enabled) }, enabled ? t('disable') : t('enable')),
              ]),
            ])
          : h('div', { key: 'h', style: css.groupTitle }, t(titleKey));
        const dropProps = isSearch && enabled
          ? {
              onDragOver: (event) => {
                if (dragId !== null && dragId !== id) event.preventDefault();
              },
              onDrop: (event) => {
                event.preventDefault();
                if (dragId !== null && dragId !== id) moveBefore(dragId, id);
                setDragId(null);
              },
            }
          : {};
        return h('div', { key: titleKey, style: css.group, ...dropProps }, [
          header,
          ...keyFields(list, field, base),
          addButton(field, base),
        ]);
      };

      return h('div', { style: css.card }, [
        h('div', { key: 't', style: css.cardTitle }, t('title')),
        h('p', { key: 'd', style: css.desc }, t('description')),
        ...orderedSearchGroups.map(renderGroup),
        ...fetchGroups.map(renderGroup),
        editError
          ? h('span', { key: 'ee', style: css.error }, `${t('failed')}: ${editError}`)
          : null,
        h('p', { key: 'n', style: css.note }, t('note')),
      ]);
    }

    /** `ctx.get` 在读未 inject 的服务时会抛，包一层。 */
    function safeGet(ctx, name) {
      try {
        return ctx.get(name);
      } catch {
        return undefined;
      }
    }

    /** 从宿主 context 拿到本插件的配置表单控制器（读 ref 名用）。 */
    function configFormFor(ctx) {
      // 优先用注入进来的 configForms；退化到 ctx.get（两者的 ctx 实现不同）。
      const configForms =
        ctx?.configForms ?? (typeof ctx?.get === 'function' ? safeGet(ctx, 'configForms') : undefined);
      if (configForms === undefined || typeof configForms.get !== 'function') return undefined;
      try {
        return configForms.get(SETTINGS_NS);
      } catch {
        return undefined;
      }
    }

    /**
     * 挂载设置卡片。
     * @param ctx - 浏览器插件上下文。
     */
    function apply(ctx) {
      const form = configFormFor(ctx);

      ctx.effect(
        () => ctx.locale.register(NS, DICTIONARIES),
        'dsh-search-fetch-router: card dictionaries',
      );

      ctx.slots.inject(SECTION_SLOT, () =>
        ctx.slots.register(
          { name: SECTION_SLOT, id: 'dsh-search-fetch-router', order: 60, locale: NS },
          (props) => {
            const subject = props?.subject;
            if (subject === undefined) return null;
            if (subject.kind !== 'bundle') return null;
            if (subject.pkg?.name !== PACKAGE_NAME) return null;
            return h(RouterSettingsCard, { ...props, ctx, form });
          },
        ),
      );
    }

    exports.NS = NS;
    exports.apply = apply;
    exports.inject = ['slots', 'locale', 'remote', 'remote.credentials', 'configForms'];
    // Test-only surface. Not part of the plugin contract; exists so node:test can
    // drive the key field (and its eye toggle) without a real React runtime.
    exports.__test = Object.freeze({ KeyField, EyeIcon, RouterSettingsCard, nextRefName, mergeKnown, applyProviderToggle, moveItemBefore, swapItem, sameOrder });
    return module.exports;
  },
});
