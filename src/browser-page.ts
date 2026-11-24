import type { Upstream } from './upstreams';

/**
 * What a person sees who opens a gateway address in a browser (docs/DESIGN.md §3.2). The address
 * is for assistants; people paste it into a browser to check it, and used to get a JSON error.
 * This only replaces the body of the answer an assistant would get (status and headers stay),
 * so MCP clients and OAuth discovery see exactly what they saw before.
 */

/** A plain page load: GET, wants HTML, carries no token. MCP clients send none of these. */
export function isBrowserVisit(request: Request): boolean {
  if (request.method !== 'GET' || request.headers.has('Authorization')) return false;
  const accept = request.headers.get('Accept') ?? '';
  return accept.includes('text/html') && !accept.includes('text/event-stream');
}

/** No scripts, nothing loaded from elsewhere: the page is its own CSS and an inline mark. */
export const PAGE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const esc = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const MARK =
  '<svg viewBox="0 0 100 100" aria-hidden="true" focusable="false">' +
  '<path fill="#F15A24" d="M0 0 50 50V100L0 50Z"/><path fill="#F7931E" d="M100 0 50 50V100L100 50Z"/>' +
  '<path fill="#ED1C24" d="M0 50 50 100H15A15 15 0 0 1 0 85Z"/><path fill="#FBB03B" d="M100 50V85A15 15 0 0 1 85 100H50Z"/></svg>';

/**
 * Languages (docs/DESIGN.md §3.2): English and Turkish, chosen with `?lang=` or by the browser's
 * Accept-Language. Two small pages, so the words are here rather than in a catalog. Adding a
 * language: an entry in WORDS (TypeScript checks it has every sentence).
 */
export type Locale = 'en' | 'tr';
const LOCALES: readonly Locale[] = ['en', 'tr'];
const NAMES: Record<Locale, string> = { en: 'English', tr: 'Türkçe' };

/** The page's language: `?lang=`, then the first supported one the browser prefers. */
export function pageLocale(request: Request): Locale {
  const chosen = new URL(request.url).searchParams.get('lang');
  if (LOCALES.includes(chosen as Locale)) return chosen as Locale;
  const ranked = (request.headers.get('Accept-Language') ?? '')
    .split(',')
    .map((part, index) => {
      const [tag = '', ...params] = part.trim().split(';');
      const q = /q=([0-9.]+)/.exec(params.join(';'))?.[1];
      return { base: tag.toLowerCase().split('-')[0] ?? '', q: q ? Number(q) : 1, index };
    })
    .filter((p) => p.q > 0)
    .sort((a, b) => b.q - a.q || a.index - b.index);
  for (const { base } of ranked) if (LOCALES.includes(base as Locale)) return base as Locale;
  return 'en';
}

const WORDS = {
  en: {
    addTitle: (name: string) => `${name}: add this address to your assistant`,
    forAssistant: (name: string) => `${name} for your AI assistant`,
    gateway: 'The 2earl MCP gateway',
    lede: (what: string) =>
      `This address is for AI assistants, not for browsers. Add it to Claude, ChatGPT, Cursor or another MCP client, and it can use ${what} for you, with the permissions you allow.`,
    services: '2earl services',
    addThis: 'Add this address to your assistant',
    how: 'How to add it',
    step1:
      'In Claude: <strong>Settings → Connectors → Add custom connector</strong>, and paste the address. Other assistants call it an MCP server or a connector.',
    step2: 'Sign in with your 2earl account and tick what the assistant may do.',
    step3: (account: string) =>
      `Ask for what you need. You can see and disconnect connected assistants in <a href="${account}">your 2earl account</a>.`,
    more: (name: string) => `More about ${name}, with examples`,
    gives: 'What it gives your assistant',
    whatItDoes: 'what it does',
    yourApps: 'Your apps and permissions',
    privacy: 'Privacy',
    imprint: 'Imprint',
    language: 'Language',
    nothingTitle: 'Nothing at this address',
    nothing: 'There’s nothing at this address',
    nothingLede:
      'The gateway’s address for assistants is <code>https://mcp.2earl.com/mcp</code>. For Prompt share alone, use <code>https://mcp.2earl.com/promptshare</code>.',
    goHome: 'Go to 2earl.com',
  },
  tr: {
    addTitle: (name: string) => `${name}: bu adresi asistanınıza ekleyin`,
    forAssistant: (name: string) => `Yapay zekâ asistanınız için ${name}`,
    gateway: '2earl MCP ağ geçidi',
    lede: (what: string) =>
      `Bu adres tarayıcılar için değil, yapay zekâ asistanları içindir. Claude, ChatGPT, Cursor ya da başka bir MCP istemcisine ekleyin; asistan, izin verdiğiniz yetkilerle ${what} sizin için kullanabilir.`,
    services: '2earl hizmetlerini',
    addThis: 'Bu adresi asistanınıza ekleyin',
    how: 'Nasıl eklenir',
    step1:
      'Claude’da: <strong>Settings → Connectors → Add custom connector</strong> yolunu izleyip adresi yapıştırın. Diğer asistanlar buna MCP sunucusu ya da bağlayıcı der.',
    step2: '2earl hesabınızla giriş yapın ve asistanın neler yapabileceğini işaretleyin.',
    step3: (account: string) =>
      `İhtiyacınız olanı isteyin. Bağlı asistanları <a href="${account}">2earl hesabınızda</a> görebilir ve bağlantılarını kesebilirsiniz.`,
    more: (name: string) => `${name} hakkında daha fazlası, örneklerle`,
    gives: 'Asistanınıza neler sağlar',
    whatItDoes: 'ne yapar',
    yourApps: 'Uygulamalarınız ve izinleriniz',
    privacy: 'Gizlilik',
    imprint: 'Künye',
    language: 'Dil',
    nothingTitle: 'Bu adreste bir şey yok',
    nothing: 'Bu adreste bir şey yok',
    nothingLede:
      'Ağ geçidinin asistanlar için adresi <code>https://mcp.2earl.com/mcp</code>. Yalnızca Prompt share için <code>https://mcp.2earl.com/promptshare</code> adresini kullanın.',
    goHome: '2earl.com’a gidin',
  },
} satisfies Record<Locale, unknown>;

/** 2earl.com's page in the language. */
const site = (locale: Locale, path = '') =>
  `https://2earl.com${locale === 'en' ? '' : `/${locale}`}${path}`;

/** Where a person learns more about a service: its own site's connect page, if it has one. */
const SERVICE_LINKS: Record<string, string> = {
  promptshare: 'https://promptshare.cc/connect',
};

const STYLE = `
:root{color-scheme:light dark;--bg:#f7f7f8;--fg:#1c1b1f;--muted:#5c5a60;--rule:#e2e1e5;--surface:#fff;--link:#b23a0c}
@media (prefers-color-scheme:dark){:root{--bg:#141315;--fg:#f2f1f3;--muted:#a19fa6;--rule:#2c2a2f;--surface:#1c1b1f;--link:#fbb03b}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:1rem/1.6 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif}
body::before{content:'';display:block;height:.375rem;background:linear-gradient(90deg,#ed1c24 0 25%,#f15a24 25% 50%,#f7931e 50% 75%,#fbb03b 75%)}
.page{max-width:40rem;margin:0 auto;padding:1.5rem clamp(1.25rem,5vw,2rem) 3rem}
.brand{display:inline-flex;align-items:center;gap:.6rem;color:var(--fg);text-decoration:none;font-weight:600;font-size:1.2rem}
.brand svg{width:2rem;height:2rem}
h1{font-size:clamp(1.75rem,4vw,2.4rem);line-height:1.15;letter-spacing:-.02em;margin:2.5rem 0 .75rem}
.lede{color:var(--muted);font-size:1.1rem;margin:0 0 1.5rem}
.address{background:var(--surface);border:1px solid var(--rule);border-left:4px solid #f15a24;border-radius:.5rem;padding:1rem 1.25rem;margin:0 0 2rem}
.address span{display:block;color:var(--muted);font-size:.875rem}
.address code{font:1.1rem/1.4 ui-monospace,'SF Mono',Menlo,Consolas,monospace;overflow-wrap:anywhere;user-select:all}
ol{padding-left:1.25rem}li+li{margin-top:.5rem}
h2{font-size:1.1rem;margin:2rem 0 .5rem}
a{color:var(--link)}
.services{list-style:none;padding:0}
.foot{margin-top:3rem;padding-top:1rem;border-top:1px solid var(--rule);color:var(--muted);font-size:.875rem;display:flex;flex-wrap:wrap;gap:.5rem 1.25rem}
.foot a{color:var(--muted)}
.languages{display:flex;gap:.75rem;margin-left:auto}.languages a{text-decoration:none}.languages a[aria-current]{color:var(--fg);font-weight:600}
`;

function layout(locale: Locale, path: string, title: string, body: string): string {
  const w = WORDS[locale];
  const account = `https://login.2earl.com/account${locale === 'en' ? '' : `?lang=${locale}`}`;
  const languages = LOCALES.map((l) =>
    l === locale
      ? `<a href="${path}?lang=${l}" lang="${l}" aria-current="true">${NAMES[l]}</a>`
      : `<a href="${path}?lang=${l}" lang="${l}" hreflang="${l}">${NAMES[l]}</a>`,
  ).join('');
  return `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title><style>${STYLE}</style></head><body><div class="page"><a class="brand" href="${site(locale)}">${MARK}<span>2earl</span></a>${body}<p class="foot"><a href="${site(locale)}">2earl.com</a><a href="${account}">${w.yourApps}</a><a href="${site(locale, '/privacy')}">${w.privacy}</a><a href="${site(locale, '/imprint')}">${w.imprint}</a><span class="languages" aria-label="${w.language}">${languages}</span></p></div></body></html>`;
}

/** The page for one of the gateway's addresses. */
export function endpointPage(
  address: string,
  endpoint: { name: string; mode: 'all' | 'single'; upstreams: readonly Upstream[] },
  locale: Locale = 'en',
): string {
  const w = WORDS[locale];
  const single = endpoint.mode === 'single' ? endpoint.upstreams[0] : undefined;
  const more = single ? SERVICE_LINKS[single.id] : undefined;
  const services =
    endpoint.mode === 'all'
      ? `<h2>${w.gives}</h2><ul class="services">${endpoint.upstreams
          .map(
            (u) =>
              `<li><strong>${esc(u.name)}</strong>${SERVICE_LINKS[u.id] ? ` · <a href="${esc(SERVICE_LINKS[u.id] ?? '')}">${w.whatItDoes}</a>` : ''}</li>`,
          )
          .join('')}</ul>`
      : '';
  return layout(
    locale,
    new URL(address).pathname,
    w.addTitle(single ? single.name : '2earl'),
    `<h1>${single ? esc(w.forAssistant(single.name)) : w.gateway}</h1>
<p class="lede">${w.lede(single ? esc(single.name) : w.services)}</p>
<p class="address"><span>${w.addThis}</span><code>${esc(address)}</code></p>
<h2>${w.how}</h2>
<ol>
<li>${w.step1}</li>
<li>${w.step2}</li>
<li>${w.step3(`https://login.2earl.com/account${locale === 'en' ? '' : `?lang=${locale}`}`)}</li>
</ol>
${more ? `<p><a href="${esc(more)}${locale === 'en' ? '' : `?lang=${locale}`}">${esc(w.more(single?.name ?? ''))}</a></p>` : ''}
${services}`,
  );
}

export function notFoundPage(locale: Locale = 'en', path = '/'): string {
  const w = WORDS[locale];
  return layout(
    locale,
    path,
    `${w.nothingTitle} · 2earl`,
    `<h1>${w.nothing}</h1>
<p class="lede">${w.nothingLede}</p>
<p><a href="${site(locale)}">${w.goHome}</a></p>`,
  );
}
