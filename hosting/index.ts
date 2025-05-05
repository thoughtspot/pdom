import { onMessage, sendMessage, ON_MESSAGE_CALLBACK_SKIP_PROCESSING } from 'promise-postmessage';
import { inject } from "@vercel/analytics"
inject();

console.log(`It's using: "promise-postmessage": "^3.6.0-rc.1"`);


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

function createElement(nodeOuterHTML) {
    const template = document.createElement('template');
    template.innerHTML = nodeOuterHTML;
    const fragment = template.content;
    const targetEl = fragment.firstElementChild as HTMLElement;
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
const host = params.get('host') as string;
const scheme = params.get('scheme');
const hostOrigin = `${scheme}://${host}`;

const reponse = await sendMessage(window.parent, { _type: 'pdom-init' }, {
    origin: hostOrigin,
    needsResponse: true,
});
const {
    nodeOuterHTML,
    scriptUrls,
    framework,
    frameworkVersion
} = reponse;
createElement(nodeOuterHTML);
const fqnScriptUrls = scriptUrls.map(scriptUrl => (scriptUrl.startsWith('http'))
    ? scriptUrl
    : new URL(scriptUrl, hostOrigin).href);

const runner = FrameworkRunners[framework] || defaultRunner;
await runner(fqnScriptUrls, frameworkVersion);

sendMessage(window.parent, { _type: 'pdom-loaded' }, {
    origin: hostOrigin,
});

