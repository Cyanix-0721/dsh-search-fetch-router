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
        '在这里填入 Tavily 与 Firecrawl 的密钥。密钥保存到本机 DSH 凭据库（0600），'
        + '不会写进任何配置文件。',
      tavilyGroup: 'Tavily',
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
        '这里的引用名来自插件配置（tavilyApiKeyRefs / firecrawlApiKeyRefs）。'
        + '要加多把 key 做轮转，先在上方配置里加引用名，再回到这里逐把填写。',
      noProvider: '当前部署没有挂载凭据服务，无法保存密钥。',
      failed: '保存失败',
    };
    const en = {
      title: 'API keys',
      description:
        'Paste your Tavily and Firecrawl keys here. They are stored in the local DSH '
        + 'credential store (mode 0600) and never written into any config file.',
      tavilyGroup: 'Tavily',
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
        'Reference names come from the plugin config (tavilyApiKeyRefs / firecrawlApiKeyRefs). '
        + 'To pool several keys, add reference names in the config above, then fill each one here.',
      noProvider: 'This deployment mounts no credential provider, so keys cannot be stored.',
      failed: 'Save failed',
    };
    const DICTIONARIES = Object.freeze({ zh, en });

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
    function KeyField(props) {
      const { t, reference, status, draft, onEdit, onSave } = props;
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
            configured ? t('configured') : t('notSet'),
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
        ]),
        h(
          'p',
          { key: 'hint', style: css.hint },
          configured ? t('configuredHint') : t('emptyHint'),
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

      const tavilyRefs = refsFor(form, 'tavilyApiKeyRefs', ['TAVILY_API_KEY']);
      const firecrawlRefs = refsFor(form, 'firecrawlApiKeyRefs', ['FIRECRAWL_API_KEY']);
      const refs = [...tavilyRefs, ...firecrawlRefs];
      const refsKey = refs.join('\u0000');

      const [drafts, setDrafts] = react.useState({});
      const [status, setStatus] = react.useState({});
      const [tick, setTick] = react.useState(0);

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
                writable: view?.writable !== false,
                busy: false,
                error: null,
              };
            }
          } catch (error) {
            for (const reference of refs) {
              next[reference] = {
                configured: false,
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
          try {
            const described = await credentials.describe([reference]);
            const view = described?.ok ? described.value?.[reference] : undefined;
            configured = view?.configured !== false;
          } catch {
            configured = true;
          }
          setStatus((current) => ({
            ...current,
            [reference]: {
              configured,
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

      const group = (titleKey, list) =>
        h('div', { key: titleKey, style: css.group }, [
          h('div', { key: 'h', style: css.groupTitle }, t(titleKey)),
          ...list.map((reference) =>
            h(KeyField, {
              key: reference,
              ctx,
              t,
              reference,
              status: status[reference],
              draft: drafts[reference],
              onEdit: (text) =>
                setDrafts((current) => ({ ...current, [reference]: text })),
              onSave: () => save(reference),
            }),
          ),
        ]);

      return h('div', { style: css.card }, [
        h('div', { key: 't', style: css.cardTitle }, t('title')),
        h('p', { key: 'd', style: css.desc }, t('description')),
        group('tavilyGroup', tavilyRefs),
        group('firecrawlGroup', firecrawlRefs),
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
    exports.__test = Object.freeze({ KeyField, EyeIcon });
    return module.exports;
  },
});
