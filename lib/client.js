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
    /** 输入框左侧那排紧凑控件里的一个格子（一键启停路由）。 */
    const TOGGLE_SLOT = 'conversation.input.left';

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
      keyLabel: 'API 密钥',
      emptyName: '名称不能为空',
      renameWarn: '改名后这把 key 会显示未配置，需在新名字下重新填写',
      note:
        '同一供应商可加多把 key，请求会在它们之间轮流使用；密钥只存在本机，'
        + '不进任何配置文件。',
      noProvider: '当前部署没有挂载凭据服务，无法保存密钥。',
      failed: '保存失败',
      addKey: '＋ 添加一行 key',
      addKeyHint: '再加一把 key：同一供应商可有多把，请求轮流使用',
      capSearch: '搜索',
      capFetch: '抓取',
      capHint: '停用的供应商会同时从搜索与抓取两条链移除',
      remove: '移除',
      removeHint: '至少保留一个账号',
      enabled: '已启用',
      disabled: '已停用',
      enable: '启用',
      disable: '停用',
      moveUp: '上移',
      moveDown: '下移',
      namePlaceholder: 'key 名称（如 TAVILY_API_KEY_2）',
      renameHint: '改这里给 key 起个区分用的名字；改名不搬移已存密钥，需重新填一次',
      invalidName: '名称只能用字母、数字、下划线，且不能以数字开头',
      duplicateName: '这个名称已经存在',
      dragHandle: '拖动排序',
      routerOn: '搜索增强已开启 —— 点击改用原生搜索 / 本地抓取',
      routerOff: '搜索增强已关闭 —— 当前用原生搜索 / 本地抓取，点击启用第三方',
      routerBusy: '切换中…',
      routerLoading: '搜索增强…',
      routerOnLabel: '搜索增强·开',
      routerOffLabel: '搜索增强·关',
      maxResultsLabel: '最大搜索结果条数',
      maxResultsHint: '单次搜索向每家请求的条数上限（默认 20）',
      maxResultsInvalid: '请输入不小于 1 的整数',
      saveMax: '保存条数',
      modeCap: '统一上限',
      modeProviderMax: '各家最大',
      modeProviderDefault: '各家默认',
      maxModeHint: '统一上限=按上面数字封顶；各家最大=Tavily 20 / Exa 100 / Firecrawl 100；各家默认=不传条数，用各家默认值',
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
      keyLabel: 'API key',
      emptyName: 'Name cannot be empty',
      renameWarn: 'After renaming, this key shows as not set — re-enter it under the new name',
      note:
        'A provider can hold several keys; requests rotate across them. Keys stay on '
        + 'this machine and never go into a config file.',
      noProvider: 'This deployment mounts no credential provider, so keys cannot be stored.',
      failed: 'Save failed',
      addKey: '+ Add a key row',
      addKeyHint: 'Add another key: a provider can hold several, used in rotation',
      capSearch: 'Search',
      capFetch: 'Fetch',
      capHint: 'A disabled provider leaves both the search and fetch chains',
      remove: 'Remove',
      removeHint: 'Keep at least one account',
      enabled: 'Enabled',
      disabled: 'Disabled',
      enable: 'Enable',
      disable: 'Disable',
      moveUp: 'Move up',
      moveDown: 'Move down',
      namePlaceholder: 'Key name (e.g. TAVILY_API_KEY_2)',
      renameHint: 'Rename here to tell keys apart; renaming does not move the stored key — re-enter it',
      invalidName: 'Use letters, digits and underscores only; cannot start with a digit',
      duplicateName: 'That name is already used',
      dragHandle: 'Drag to reorder',
      routerOn: 'Search boost on — click to use native search / local fetch',
      routerOff: 'Search boost off — using native search / local fetch; click to use third-party providers',
      routerBusy: 'Switching…',
      routerLoading: 'Search boost…',
      routerOnLabel: 'Search boost: on',
      routerOffLabel: 'Search boost: off',
      maxResultsLabel: 'Max search results',
      maxResultsHint: 'Per-provider cap for one search (default 20)',
      maxResultsInvalid: 'Enter an integer of at least 1',
      saveMax: 'Save count',
      modeCap: 'Unified cap',
      modeProviderMax: 'Each max',
      modeProviderDefault: 'Each default',
      maxModeHint: 'Unified cap = the number above; Each max = Tavily 20 / Exa 100 / Firecrawl 100; Each default = omit the count, let each provider default',
    };
    const DICTIONARIES = Object.freeze({ zh, en });

    /**
     * 可排序 / 可停用的供应商（带 key），搜索与抓取共用同一张表。`id` 必须与
     * lib/search-backends.js / lib/fetch-backends.js 的注册 id 一致——它就是写进
     * providerOrder 的值。官方 deepseek-official 与本地 http 是无 key 的兜底，不在此列。
     */
    const SEARCH_PROVIDERS = Object.freeze([
      // `caps` 与注册表里该供应商实现了 search / fetch 哪几条链对应（内置三家都齐全）。
      // 停用一家会同时从这两条链移除——卡片上把它标出来，用户才知道停用的影响面。
      { id: 'tavily', titleKey: 'tavilyGroup', field: 'tavilyApiKeyRefs', base: 'TAVILY_API_KEY', caps: { search: true, fetch: true } },
      { id: 'exa', titleKey: 'exaGroup', field: 'exaApiKeyRefs', base: 'EXA_API_KEY', caps: { search: true, fetch: true } },
      { id: 'firecrawl', titleKey: 'firecrawlGroup', field: 'firecrawlApiKeyRefs', base: 'FIRECRAWL_API_KEY', caps: { search: true, fetch: true } },
    ]);

    /**
     * 没有配置时的兜底顺序。**从上面那张表派生**，不再手写第二份——
     * 曾经这里是 `['tavily','exa','firecrawl']` 的字面量，加供应商时漏改就会出现
     * 「卡片认这家、兜底顺序不认」的错位。
     */
    const DEFAULT_ORDER = Object.freeze(SEARCH_PROVIDERS.map((provider) => provider.id));

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
      capBadge: {
        fontSize: '11px',
        lineHeight: 1.4,
        padding: '1px 8px',
        borderRadius: '999px',
        whiteSpace: 'nowrap',
        border: '1px solid var(--dsw-alias-border-subtle, rgba(128,128,128,.28))',
        color: 'var(--dsw-alias-text-tertiary, inherit)',
        opacity: 0.9,
      },
      inputRow: { display: 'flex', alignItems: 'center', gap: '8px' },
      keyInput: {
        flex: '1 1 40%',
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
      nameInput: {
        flex: '0 1 auto',
        maxWidth: '62%',
        minWidth: 0,
        padding: '2px 6px',
        fontSize: '13px',
        fontWeight: 600,
        fontFamily: 'inherit',
        borderRadius: '6px',
        border: '1px dashed var(--dsw-alias-border-subtle, rgba(128,128,128,.45))',
        background: 'transparent',
        color: 'inherit',
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
      warn: {
        margin: 0,
        fontSize: '12px',
        lineHeight: 1.5,
        color: 'var(--dsw-alias-warning, #b45309)',
      },
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
    /**
     * 读供应商顺序（搜索与抓取共用同一张表）；缺省用 {@link DEFAULT_ORDER}。
     * 运行时还会按「这家有没有配 key」再跳过一次，所以默认全列出来是安全的。
     */
    function orderFor(form) {
      let value;
      try { value = form?.getSnapshot?.()?.value; } catch { value = undefined; }
      const raw = value?.providerOrder;
      // 空数组是**有意义的**：用户把所有供应商都停用了。只有「没配过」才回退默认，
      // 不能把 [] 也当没配——那样全停用会显示成全启用。
      return Array.isArray(raw)
        ? raw.filter((x) => typeof x === 'string' && x.length > 0)
        : DEFAULT_ORDER.slice();
    }

    /** 从配置快照里读某个标量字段（读不到返回 undefined）。 */
    function configValue(form, key) {
      let value;
      try { value = form?.getSnapshot?.()?.value; } catch { value = undefined; }
      return value?.[key];
    }

    /** 规整 maxResultsMode：只认三个白名单值，其余按 cap（与 lib/execute.js 同口径）。 */
    function normalizeMaxResultsMode(value) {
      const mode = typeof value === 'string' ? value.trim().toLowerCase() : '';
      return mode === 'provider-max' || mode === 'provider-default' ? mode : 'cap';
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

    /** 保存按钮是否该禁用：忙碌、或者既没输 key 也没改名称时禁用。 */
    function saveDisabled(busy, hasDraft, nameDirty) {
      return busy === true || (!hasDraft && !nameDirty);
    }

    /** key 引用名必须是合法标识符（它同时是环境变量名，坏名字读不到 env）。 */
    const REF_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

    /** 改名合法性校验：返回错误词键（invalidName/duplicateName）或 null（含"没改"）。 */
    function validateRefName(name, existing, oldName) {
      const value = String(name ?? '').trim();
      if (value === oldName) return null;
      if (value === '') return 'emptyName';
      if (!REF_NAME_RE.test(value)) return 'invalidName';
      if (Array.isArray(existing) && existing.includes(value)) return 'duplicateName';
      return null;
    }

    /**
     * 点「保存」时到底该做什么——纯决策，不做任何 I/O，方便零成本单测。
     *
     * 这里承载的是最容易弄错、又最难在浏览器里手测的判断：改名要落到**哪个字段数组、
     * 哪个下标**，撞名 / 空名要拒绝，以及「只有改名没有新 key」也要放行。返回：
     * - `error`：错误词键，非空表示直接报错、不落库；
     * - `noop`：既没改名也没新 key，什么都不做；
     * - `rename`：要执行的改名（`{field,index,to}`）或 null；
     * - `key`：要写入的新密钥（已 trim）或 null。
     * @param args - `{reference, newNameRaw, text, fieldInfo, refs}`。
     */
    function planSave({ reference, newNameRaw, text, fieldInfo, refs }) {
      const value = String(text ?? '').trim();
      const newName = String(newNameRaw ?? reference).trim();
      const renaming = newName !== reference;
      if (renaming) {
        if (fieldInfo === undefined) return { error: 'failed', noop: false, rename: null, key: null };
        const problem = validateRefName(newName, refs, reference);
        if (problem !== null) return { error: problem, noop: false, rename: null, key: null };
      }
      if (value === '' && !renaming) return { error: null, noop: true, rename: null, key: null };
      const rename = renaming
        ? { field: fieldInfo.field, index: fieldInfo.list.indexOf(reference), to: newName }
        : null;
      return { error: null, noop: false, rename, key: value === '' ? null : value };
    }

    function KeyField(props) {
      const { t, reference, status, draft, onEdit, onSave, onRemove } = props;
      const configured = status?.configured === true;
      const busy = status?.busy === true;
      const disabled = busy || status?.writable === false;
      const text = String(draft ?? '');
      const hasDraft = text !== '';
      // 名称与 key 都只在点「保存」时落库：输入过程只改本地草稿。
      const [nameDraft, setNameDraft] = react.useState(reference);
      const nameDirty = String(nameDraft).trim() !== reference;
      const enabled = !saveDisabled(busy, hasDraft, nameDirty);
      const [revealed, setRevealed] = react.useState(false);
      // 外部改了名称（保存成功、别处写入）时同步草稿；用户正在输入时 reference 没变，不会被打断。
      react.useEffect(() => {
        setNameDraft(reference);
      }, [reference]);

      return h('div', { style: css.fieldWrap }, [
        h('div', { key: 'head', style: css.head }, [
          h('input', {
            key: 'name',
            'data-sfr-name': reference,
            type: 'text',
            value: nameDraft,
            disabled,
            spellCheck: false,
            placeholder: t('namePlaceholder'),
            title: t('renameHint'),
            style: css.nameInput,
            onChange: (event) => setNameDraft(event.target.value),
          }),
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
            'aria-label': `${t('keyLabel')}: ${reference}`,
            type: revealed ? 'text' : 'password',
            autoComplete: 'new-password',
            spellCheck: false,
            placeholder: configured ? t('savedPlaceholder') : '',
            value: text,
            disabled,
            style: css.keyInput,
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
              onClick: () => {
                if (typeof onSave === 'function') onSave(nameDraft);
              },
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
        nameDirty && configured && !hasDraft
          ? h('p', { key: 'renameWarn', style: css.warn }, t('renameWarn'))
          : null,
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

      // 供应商列表（按 providerOrder 排序/停用）；每家同时提供搜索与抓取。每组的 ref 名列表随配置刷新。
      const providerGroups = SEARCH_PROVIDERS.map((entry) => ({
        ...entry,
        refs: refsFor(form, entry.field, [entry.base]),
      }));
      const refs = providerGroups.flatMap((entry) => entry.refs);
      const refsKey = refs.join('\u0000');

      // 搜索链顺序 = 启用顺序。只认内置搜索供应商；未知 id 原样保留在末尾，不丢用户手填的。
      const rawOrder = orderFor(form);
      const isKnownSearch = (id) => SEARCH_PROVIDERS.some((p) => p.id === id);
      const knownOrder = rawOrder.filter(isKnownSearch);
      const unknownOrder = rawOrder.filter((id) => !isKnownSearch(id));
      // 视觉顺序必须跟 providerOrder 走，否则点排序只改配置、界面不动。
      const providerById = new Map(providerGroups.map((entry) => [entry.id, entry]));
      const orderedGroups = [
        ...knownOrder.map((id) => providerById.get(id)).filter(Boolean),
        ...SEARCH_PROVIDERS.filter((p) => !knownOrder.includes(p.id)).map((p) => providerById.get(p.id)),
      ];

      const [drafts, setDrafts] = react.useState({});
      const [status, setStatus] = react.useState({});
      const [editError, setEditError] = react.useState(null);
      const [tick, setTick] = react.useState(0);
      const [dragId, setDragId] = react.useState(null);
      // 「最大搜索条数」输入框的本地草稿（点保存才落库）。
      const maxResultsValue = (() => {
        const v = configValue(form, 'maxSearchResults');
        return Number.isInteger(v) && v > 0 ? v : 20;
      })();
      const [maxDraft, setMaxDraft] = react.useState(String(maxResultsValue));
      react.useEffect(() => { setMaxDraft(String(maxResultsValue)); }, [maxResultsValue]);

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

      // 一个 ref 属于哪个配置字段、当前该字段的 ref 列表（改名要按 index 落到正确的数组里）。
      function fieldInfoFor(ref) {
        const group = providerGroups.find((entry) => entry.refs.includes(ref));
        return group === undefined ? undefined : { field: group.field, list: group.refs };
      }

      // 点「保存」时落库：先按需改名，再把新输入的 key 存到（可能已改名的）ref 下。
      // 该做什么由纯函数 planSave 决定，这里只负责按计划执行 I/O。
      async function save(reference, newNameRaw) {
        const plan = planSave({
          reference,
          newNameRaw,
          text: drafts[reference],
          fieldInfo: fieldInfoFor(reference),
          refs,
        });
        if (plan.error != null) {
          // 改名/名称类错误挂在**这一行**上，而不是卡片最底部，用户能就近看到是哪把 key 出错。
          setStatus((current) => ({
            ...current,
            [reference]: { ...(current[reference] ?? {}), error: t(plan.error) },
          }));
          return;
        }
        if (plan.noop) return;
        const target = plan.rename === null ? reference : plan.rename.to;
        // busy 打在当前行（这一帧界面还显示旧名字）上，否则改名那一下按钮不变灰、能被双击重复提交。
        setStatus((current) => ({
          ...current,
          [reference]: { ...(current[reference] ?? {}), busy: true, error: null },
        }));
        try {
          if (plan.rename !== null) {
            const ok = await mutateRefs([
              { op: 'set', path: [plan.rename.field, plan.rename.index], value: plan.rename.to },
            ]);
            if (ok === false) {
              setStatus((current) => ({ ...current, [reference]: { ...(current[reference] ?? {}), busy: false } }));
              return;
            }
          }
          if (plan.key !== null) {
            const response = await credentials.set(target, plan.key);
            if (response !== undefined && response?.ok === false) {
              throw new Error(response?.error?.message ?? t('failed'));
            }
          }
          setDrafts((current) => {
            const next = { ...current };
            delete next[reference];
            delete next[target];
            return next;
          });
          let configured = false;
          let masked;
          try {
            const described = await credentials.describe([target]);
            const view = described?.ok ? described.value?.[target] : undefined;
            configured = view?.configured === true;
            masked = typeof view?.masked === 'string' ? view.masked : undefined;
          } catch {
            configured = plan.key !== null;
          }
          setStatus((current) => {
            const next = { ...current };
            next[target] = {
              configured,
              masked,
              writable: current[target]?.writable !== false && current[reference]?.writable !== false,
              busy: false,
              error: null,
            };
            // 改名成功后旧名字的状态项已无意义，清掉，免得留下一条永不使用的脏数据。
            if (plan.rename !== null) delete next[reference];
            return next;
          });
          if (plan.rename !== null) setTick((n) => (n + 1) % 1_000_000_007);
        } catch (error) {
          setStatus((current) => ({
            ...current,
            [reference]: { ...(current[reference] ?? {}), busy: false, error: String(error?.message ?? error) },
          }));
        }
      }

      const canEdit = form !== undefined && typeof form.mutate === 'function';


      const mutateRefs = async (ops) => {
        if (!canEdit) return false;
        setEditError(null);
        try {
          const accepted = await form.mutate(ops);
          if (accepted === false) {
            setEditError(t('failed'));
            return false;
          }
          // mutate 后强制重渲染一次，确保立刻读到新快照（否则排序点了界面不刷新）。
          setTick((n) => (n + 1) % 1_000_000_007);
          return true;
        } catch (error) {
          setEditError(String(error?.message ?? error));
          return false;
        }
      };

      // 保存「统一上限」条数：非法值就近报错，合法值才 mutate。
      const saveMaxResults = async () => {
        const n = Number(maxDraft);
        if (!Number.isInteger(n) || n < 1) {
          setEditError(t('maxResultsInvalid'));
          return;
        }
        await mutateRefs([{ op: 'set', path: ['maxSearchResults'], value: n }]);
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

      // 一组 key 的输入行（名称可编辑）。
      const keyFields = (list, field, base) =>
        list.map((reference, index) =>
          h(KeyField, {
            key: reference,
            ctx,
            t,
            reference,
            status: status[reference],
            draft: drafts[reference],
            onEdit: (text) => setDrafts((current) => ({ ...current, [reference]: text })),
            onSave: (nameText) => save(reference, nameText),
            onRemove: list.length > 1 ? () => removeRef(field, index) : undefined,
          }),
        );

      const addButton = (field, base) =>
        h('div', { key: 'addRow', style: { display: 'flex', flexDirection: 'column', gap: '4px' } }, [
          h('button', {
            key: 'add',
            type: 'button',
            'data-sfr-add': field,
            style: { ...css.smallBtn(canEdit), alignSelf: 'stretch', textAlign: 'left', padding: '7px 10px' },
            disabled: !canEdit,
            title: t('addKeyHint'),
            onClick: () => addRef(field, base),
          }, t('addKey')),
          h('span', { key: 'addHint', style: css.hint }, t('addKeyHint')),
        ]);

      const moveBefore = (dragged, target) => {
        const next = moveItemBefore(knownOrder, dragged, target);
        return sameOrder(next, knownOrder) ? Promise.resolve() : setOrder(next);
      };

      const renderGroup = (entry) => {
        const { titleKey, refs: list, field, base, caps } = entry;
        const id = entry.id;
        const capLabel = [caps?.search ? t('capSearch') : null, caps?.fetch ? t('capFetch') : null]
          .filter(Boolean)
          .join(' · ');
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
                capLabel.length > 0
                  ? h('span', { key: 'caps', style: css.capBadge, title: t('capHint') }, capLabel)
                  : null,
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

      // 结果条数：一个数字框（统一上限）+ 三个模式按钮（统一上限 / 各家最大 / 各家默认）。
      const maxMode = normalizeMaxResultsMode(configValue(form, 'maxResultsMode'));
      const modeButton = (mode, label) => h('button', {
        key: `mode-${mode}`, type: 'button', 'data-sfr-mode': mode,
        style: {
          ...css.smallBtn(canEdit),
          fontWeight: maxMode === mode ? '700' : '400',
          textDecoration: maxMode === mode ? 'underline' : 'none',
        },
        disabled: !canEdit,
        'aria-pressed': maxMode === mode,
        onClick: () => mutateRefs([{ op: 'set', path: ['maxResultsMode'], value: mode }]),
      }, label);
      const maxResultsBlock = h('div', { key: 'maxblock', style: css.group }, [
        h('div', { key: 'h', style: css.head }, [
          h('span', { key: 't', style: css.groupTitle }, t('maxResultsLabel')),
        ]),
        h('div', { key: 'row', style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } }, [
          h('input', {
            key: 'num', type: 'number', min: 1, step: 1, value: maxDraft,
            'data-sfr-maxresults': 'input', 'aria-label': t('maxResultsLabel'),
            disabled: !canEdit || maxMode !== 'cap',
            style: { width: '88px', padding: '5px 8px', fontSize: '13px' },
            onChange: (event) => setMaxDraft(event.target.value),
          }),
          h('button', {
            key: 'save', type: 'button', 'data-sfr-maxsave': 'button',
            style: css.smallBtn(canEdit && maxMode === 'cap'),
            disabled: !canEdit || maxMode !== 'cap',
            onClick: saveMaxResults,
          }, t('saveMax')),
          modeButton('cap', t('modeCap')),
          modeButton('provider-max', t('modeProviderMax')),
          modeButton('provider-default', t('modeProviderDefault')),
        ]),
        h('span', { key: 'hint', style: css.hint }, t('maxModeHint')),
      ]);

      return h('div', { style: css.card }, [
        h('div', { key: 't', style: css.cardTitle }, t('title')),
        h('p', { key: 'd', style: css.desc }, t('description')),
        ...orderedGroups.map(renderGroup),
        maxResultsBlock,
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

    /** 从 settings.describe() 的返回里按 ns 取本插件那一份视图。 */
    function findNamespaceView(describeValue, ns) {
      const list = describeValue?.namespaces;
      if (!Array.isArray(list)) return undefined;
      return list.find((view) => view && view.ns === ns);
    }

    /**
     * 解掉 remote 调用的结果信封：远端方法一般回 `{ ok, value }`（失败时 `{ ok:false, error }`），
     * 本地直连时可能直接把值给你。统一在这里剥一层，别让上层既猜信封又猜结构。
     */
    function unwrapRemote(response) {
      if (response !== null && typeof response === 'object' && 'ok' in response) {
        return response.ok === false ? undefined : response.value;
      }
      return response;
    }

    /** 由一份命名空间视图算出「当前是否开启」——缺字段视为开启。 */
    function viewEnabled(view) {
      return view?.value?.enabled !== false;
    }

    /**
     * 一键启停按钮（`conversation.input.left` 的一个格子）。
     * 读/写本插件配置的 `enabled`（volatile，即时生效）：关闭 = 旁路到官方搜索 / 本地抓取，
     * 第三方 key 不调用，但 key、顺序等配置原样保留，点回来即恢复。
     */
    function RouterToggle(props) {
      const t = translate(props);
      const settings = props?.ctx?.remote?.settings;
      const canRead = settings !== undefined && typeof settings.describe === 'function';
      const [enabled, setEnabled] = react.useState(undefined);
      // 首帧若读不到 settings 服务（无凭据环境）直接当「已就绪 = 开」；否则等 describe 回来再定状态，
      // 期间显示中性文案——不要在真值未知时先渲染成 disabled/关，否则刷新时会「由暗变亮」闪一下。
      const [loaded, setLoaded] = react.useState(!canRead);
      const [busy, setBusy] = react.useState(false);
      const [failed, setFailed] = react.useState(false);

      react.useEffect(() => {
        let live = true;
        if (!canRead) {
          setEnabled(true);
          setLoaded(true);
          return undefined;
        }
        Promise.resolve(settings.describe())
          .then((response) => {
            if (!live) return;
            setEnabled(viewEnabled(findNamespaceView(unwrapRemote(response), SETTINGS_NS)));
            setLoaded(true);
          })
          .catch(() => { if (live) { setEnabled(true); setLoaded(true); } });
        return () => { live = false; };
      }, [settings, canRead]);

      const flip = () => {
        if (!canRead || typeof settings.mutate !== 'function' || busy || !loaded) return;
        setBusy(true);
        setFailed(false);
        Promise.resolve(settings.describe())
          .then((response) => {
            const view = findNamespaceView(unwrapRemote(response), SETTINGS_NS);
            if (view === undefined) throw new Error('settings namespace not found');
            const next = !viewEnabled(view);
            return Promise.resolve(settings.mutate(SETTINGS_NS, [{ op: 'set', path: ['enabled'], value: next }], view?.revision))
              .then((written) => {
                if (written !== null && typeof written === 'object' && written.ok === false) {
                  throw new Error(written?.error?.message ?? 'settings mutate failed');
                }
                return next;
              });
          })
          .then((next) => { setEnabled(next); })
          .catch(() => { setFailed(true); })
          .finally(() => { setBusy(false); });
      };

      const on = enabled !== false;
      const frozen = busy || !loaded;
      const label = failed ? t('failed') : busy ? t('routerBusy') : !loaded ? t('routerLoading') : on ? t('routerOn') : t('routerOff');
      const text = !loaded ? t('routerLoading') : failed ? t('routerLoading') : on ? t('routerOnLabel') : t('routerOffLabel');
      const style = {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '4px',
        padding: '4px 8px',
        borderRadius: '6px',
        fontSize: '12px',
        lineHeight: '16px',
        cursor: frozen ? 'default' : 'pointer',
        opacity: busy ? 0.6 : 1,
        border: '1px solid ' + (on
          ? 'var(--dsw-alias-border-secondary, rgba(128,128,128,.35))'
          : 'var(--dsw-alias-state-warning-primary, #b8860b)'),
        background: on ? 'transparent' : 'var(--dsw-alias-bg-secondary, rgba(128,128,128,.15))',
        color: 'var(--dsw-alias-label-secondary, inherit)',
      };
      return h('button', {
        type: 'button',
        'data-sfr-router-toggle': '1',
        role: 'switch',
        'aria-checked': on ? 'true' : 'false',
        'aria-label': label,
        title: label,
        style,
        disabled: frozen,
        onClick: flip,
      }, text);
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

      // 输入框左侧的一键启停格子。
      ctx.slots.inject(TOGGLE_SLOT, () =>
        ctx.slots.register(
          { name: TOGGLE_SLOT, id: 'dsh-search-fetch-router-toggle', order: 8, locale: NS },
          (props) => h(RouterToggle, { ...props, ctx }),
        ),
      );
    }

    exports.NS = NS;
    exports.apply = apply;
    exports.inject = ['slots', 'locale', 'remote', 'remote.credentials', 'remote.settings', 'configForms'];
    // Test-only surface. Not part of the plugin contract; exists so node:test can
    // drive the key field (and its eye toggle) without a real React runtime.
    exports.__test = Object.freeze({ KeyField, EyeIcon, RouterSettingsCard, RouterToggle, findNamespaceView, viewEnabled, unwrapRemote, nextRefName, mergeKnown, applyProviderToggle, moveItemBefore, swapItem, sameOrder, orderFor, DEFAULT_ORDER, saveDisabled, validateRefName, planSave, normalizeMaxResultsMode });
    return module.exports;
  },
});
