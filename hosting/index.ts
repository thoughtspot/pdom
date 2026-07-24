import DOMPurify from 'dompurify';
import { onMessage, sendMessage, ON_MESSAGE_CALLBACK_SKIP_PROCESSING } from 'promise-postmessage';
import { inject } from "@vercel/analytics"
inject();

/**
 * URL schemes accepted when deriving the host origin and when dynamically
 * importing scripts. Everything the hosting iframe trusts must resolve to
 * http(s) (plus locally-produced blob URLs for scripts); restricting the set
 * here stops an attacker-influenced `scheme` query param or script url from
 * smuggling a `javascript:`/`data:` origin across the cross-frame boundary.
 */
const ALLOWED_ORIGIN_SCHEMES = new Set(['http', 'https']);

/**
 * Strict pattern for the `host` query param — a bare hostname with an optional
 * port, matching what `window.location.host` produces on the parent page. It
 * deliberately rejects paths, spaces, quotes, `@`, and any other character that
 * could be used to inject into the postMessage targetOrigin string.
 */
const HOST_PATTERN = /^[a-zA-Z0-9.-]+(:\d+)?$/;

/**
 * Derive and strictly validate the host page's origin from the iframe URL's
 * query params. `host`/`scheme` live in the iframe src and are therefore
 * attacker-influenceable, yet they are used as the postMessage targetOrigin for
 * every message this frame sends to its parent. We refuse anything that is not
 * a well-formed http(s) origin and never fall back to a wildcard ('*'), so the
 * parent-directed channel can never be widened to an unintended origin.
 *
 * @param params - The parsed iframe URL search params carrying `host`/`scheme`.
 * @returns The validated `scheme://host` origin string.
 * @throws If the scheme is not http/https or the host is missing/malformed.
 */
function resolveHostOrigin(params: URLSearchParams): string {
    const host = params.get('host');
    const scheme = params.get('scheme')?.toLowerCase();
    if (!host || !scheme || !ALLOWED_ORIGIN_SCHEMES.has(scheme) || !HOST_PATTERN.test(host)) {
        throw new Error('pdom: invalid or missing host/scheme parameters');
    }
    return `${scheme}://${host}`;
}

/**
 * Validate that a resolved script URL is safe to hand to a dynamic `import()`.
 * `import()` executes whatever it loads, so a script URL that arrives over the
 * cross-frame channel must be restricted to http(s) (and locally-produced blob
 * URLs) — never `javascript:`, `data:`, or any other scheme that could turn an
 * untrusted string into executable code.
 *
 * @param scriptUrl - A fully-qualified script URL about to be dynamically imported.
 * @returns True when the URL parses and uses an allowed, non-inline scheme.
 */
function isAllowedScriptUrl(scriptUrl: string): boolean {
    try {
        const { protocol } = new URL(scriptUrl);
        return protocol === 'https:' || protocol === 'http:' || protocol === 'blob:';
    } catch {
        return false;
    }
}

const defaultRunner = async (scriptUrls) => {
    for (const scriptUrl of scriptUrls) {
        await import(scriptUrl);
    }
}

const FrameworkRunners = {
    'react': async ([app], version) => {
        const { default: React } = await import(
            /* @vite-ignore */
            `https://esm.sh/stable/react@${version}/es2022/react.mjs`
        );
        const { default: ReactDOM } = await import(
            /* @vite-ignore */
            `https://esm.sh/stable/react-dom@${version}/es2022/client.js`
        );
        const { default: App } = await import(app);
        const callbacks = {};
        function getProps(props) {
            const newProps = {};
            for (const key in props) {
                const value = props[key];
                if (value === '__function__') {
                    newProps[key] = callbacks[key] || ((...args) => {
                        return sendMessage(window.parent, {
                            _type: 'pdom-callback',
                            callbackId: key,
                            args,
                        }, { origin: hostOrigin });
                    });
                    callbacks[key] = newProps[key];
                } else {
                    newProps[key] = value;
                }
            }
            return newProps;
        }


        const root = ReactDOM.createRoot(document.body.firstElementChild as HTMLElement);
        onMessage((message) => {
            if (message._type === 'pdom-props') {
                root.render(React.createElement(App, getProps(message.props)));
            } else {
                return ON_MESSAGE_CALLBACK_SKIP_PROCESSING;
            }
        }, window.parent, 'child')
    },
}

/**
 * Build the host container element from the parent-supplied outerHTML and
 * append it to the document body.
 *
 * `nodeOuterHTML` originates from an arbitrary element on the host page and
 * crosses the iframe trust boundary over postMessage, so it is treated as
 * untrusted and sanitized with DOMPurify before it ever touches `innerHTML`.
 * Sanitization strips `<script>`, inline event handlers, `javascript:` URLs and
 * other XSS vectors while preserving the plain container markup — the chart
 * itself is rendered later by the framework runner into this element, so
 * removing script vectors here does not affect legitimate chart rendering.
 *
 * @param nodeOuterHTML - Untrusted serialized HTML of the host container element.
 */
function createElement(nodeOuterHTML: string) {
    const template = document.createElement('template');
    // Sanitize the untrusted cross-frame HTML before assigning it to innerHTML.
    // This is the primary XSS neutralization: the raw outerHTML from the host
    // page can carry active content, and assigning it directly to innerHTML is
    // the DOM-based XSS sink reported for this frame.
    const sanitizedHTML = DOMPurify.sanitize(nodeOuterHTML);
    template.innerHTML = sanitizedHTML;
    const fragment = template.content;
    const targetEl = fragment.firstElementChild as HTMLElement | null;
    // If sanitization removed everything (e.g. a payload that was entirely
    // script/handler markup), there is no container to size or host the chart —
    // fail loudly instead of dereferencing null.
    if (!targetEl) {
        throw new Error('pdom: sanitized host element produced no renderable content');
    }
    targetEl.style.width = '100%';
    targetEl.style.height = '100%';
    document.body.appendChild(fragment);
}


window.addEventListener('error', (e) => {
    sendMessage(window.parent, {
        _type: 'pdom-error',
        error: {
            message: e.message,
            type: e.type,
        }
    });
});

const params = new URLSearchParams(window.location.search);
// Derive the parent origin up front and strictly; every message we post to the
// parent below is pinned to this validated targetOrigin so it can never be
// broadcast to an unintended origin.
const hostOrigin = resolveHostOrigin(params);

const reponse = await sendMessage(window.parent, { _type: 'pdom-init' }, {
    origin: hostOrigin,
    needsResponse: true,
    isValidResponse(data) {
        return !!data && !!data["nodeOuterHTML"];
    },
});
const {
    nodeOuterHTML,
    scriptUrls,
    framework,
    frameworkVersion
} = reponse;
createElement(nodeOuterHTML);
const fqnScriptUrls = scriptUrls
    .map(scriptUrl => (scriptUrl.startsWith('http'))
        ? scriptUrl
        : new URL(scriptUrl, hostOrigin).href)
    .filter((scriptUrl: string) => {
        // Only import scripts whose scheme is explicitly allowed. The script
        // list arrives over the same untrusted cross-frame channel as the HTML,
        // and import() executes whatever it loads, so anything else is dropped.
        if (!isAllowedScriptUrl(scriptUrl)) {
            console.warn(`pdom: refusing to import script with disallowed url: ${scriptUrl}`);
            return false;
        }
        return true;
    });

const runner = FrameworkRunners[framework] || defaultRunner;
await runner(fqnScriptUrls, frameworkVersion);

sendMessage(window.parent, { _type: 'pdom-loaded' }, {
    origin: hostOrigin,
});
