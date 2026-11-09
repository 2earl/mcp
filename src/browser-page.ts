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
`;

function layout(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title><style>${STYLE}</style></head><body><div class="page"><a class="brand" href="https://2earl.com">${MARK}<span>2earl</span></a>${body}<p class="foot"><a href="https://2earl.com">2earl.com</a><a href="https://login.2earl.com/account">Your apps and permissions</a><a href="https://2earl.com/privacy">Privacy</a><a href="https://2earl.com/imprint">Imprint</a></p></div></body></html>`;
}

/** The page for one of the gateway's addresses. */
export function endpointPage(
  address: string,
  endpoint: { name: string; mode: 'all' | 'single'; upstreams: readonly Upstream[] },
): string {
  const single = endpoint.mode === 'single' ? endpoint.upstreams[0] : undefined;
  const more = single ? SERVICE_LINKS[single.id] : undefined;
  const services =
    endpoint.mode === 'all'
      ? `<h2>What it gives your assistant</h2><ul class="services">${endpoint.upstreams
          .map(
            (u) =>
              `<li><strong>${esc(u.name)}</strong>${SERVICE_LINKS[u.id] ? ` · <a href="${esc(SERVICE_LINKS[u.id] ?? '')}">what it does</a>` : ''}</li>`,
          )
          .join('')}</ul>`
      : '';
  return layout(
    `${single ? single.name : '2earl'}: add this address to your assistant`,
    `<h1>${single ? `${esc(single.name)} for your AI assistant` : 'The 2earl MCP gateway'}</h1>
<p class="lede">This address is for AI assistants, not for browsers. Add it to Claude, ChatGPT, Cursor or another MCP client, and it can use ${single ? esc(single.name) : '2earl services'} for you, with the permissions you allow.</p>
<p class="address"><span>Add this address to your assistant</span><code>${esc(address)}</code></p>
<h2>How to add it</h2>
<ol>
<li>In Claude: <strong>Settings → Connectors → Add custom connector</strong>, and paste the address. Other assistants call it an MCP server or a connector.</li>
<li>Sign in with your 2earl account and tick what the assistant may do.</li>
<li>Ask for what you need. You can see and disconnect connected assistants in <a href="https://login.2earl.com/account">your 2earl account</a>.</li>
</ol>
${more ? `<p><a href="${esc(more)}">More about ${esc(single?.name ?? '')}, with examples</a></p>` : ''}
${services}`,
  );
}

export function notFoundPage(): string {
  return layout(
    'Nothing at this address · 2earl',
    `<h1>There’s nothing at this address</h1>
<p class="lede">The gateway’s address for assistants is <code>https://mcp.2earl.com/mcp</code>. For Prompt share alone, use <code>https://mcp.2earl.com/promptshare</code>.</p>
<p><a href="https://2earl.com">Go to 2earl.com</a></p>`,
  );
}
