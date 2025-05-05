import { ON_MESSAGE_CALLBACK_SKIP_PROCESSING, onMessage, sendMessage } from 'promise-postmessage';
import { getScriptUrlFromFunction } from './util';

export interface PDomOptions {
    scripts: Array<(() => Promise<any>) | string>;
    domainUrl?: string;
    noIframe?: boolean;
    disableOriginAgentCluster?: boolean;
}

const DOMAIN_SUFFIX = 'pdom.dev';

function generateIframeSrc(origin?: string, disableOriginAgentCluster?: boolean) {
    const randomUUID = crypto.randomUUID().slice(0, 8);
    origin = origin || `https://${randomUUID}.${DOMAIN_SUFFIX}`;
    const url = new URL(origin);
    const params = url.searchParams;
    params.set('host', window.location.host);
    params.set('scheme', window.location.protocol.replace(':', ''));
    if (disableOriginAgentCluster) {
        params.set('disable-origin-agent-cluster', 'true');
    }
    return url.href;
}

export default class PDom {
    #iframeEl: HTMLIFrameElement;
    private callbacks: Record<string, Function[]> = {};
    private options: PDomOptions & { scriptUrls?: string[] };
    private el: HTMLElement;
    #iframeSrc: string;
    protected framework: string;
    protected frameworkVersion: string;
    private isLoaded: Promise<void>;

    public get iframeSrc() {
        return this.#iframeSrc;
    }

    public get containerEl() {
        return this.#iframeEl || this.el;
    }

    public get scriptUrls() {
        return this.options.scriptUrls;
    }

    constructor(_el: HTMLElement | string, options: PDomOptions | (() => Promise<any>)) {
        if (!_el) {
            throw new Error('Element is required');
        }

        if (typeof _el === 'string') {
            this.el = document.querySelector(_el) as HTMLElement;
            if (!this.el) {
                throw new Error('Element not found');
            }
        } else {
            this.el = _el;
        }

        if (typeof options === 'function') {
            options = { scripts: [options] };
        }
        this.options = options;
        this.options.scriptUrls = this.options.scripts
            .map(s => getScriptUrlFromFunction(s));

        if (this.options.noIframe) {
            return;
        }

        const { nodeOuterHTML, cssText } = getOuterHTMLAndStyleString(this.el);
        this.#iframeSrc = generateIframeSrc(
            options.domainUrl, options.disableOriginAgentCluster);
        this.#iframeEl = this.getIframeEl(this.#iframeSrc);
        this.on('pdom-init', async (data) => {
            const { scriptUrls } = this.options;
            return {
                nodeOuterHTML,
                cssText,
                scriptUrls,
                framework: this.framework,
                frameworkVersion: this.frameworkVersion,
            };
        });
    }

    /**
     * Method to render the iframe and load the script.
     * @returns Promise<void> which resolves when the iframe is loaded and rejects in case of an error.
     */
    public render() {
        if (this.options.noIframe) {
            return this.renderNoIframe();
        }
        this.isLoaded = new Promise<void>((resolve, reject) => {
            this.on('pdom-loaded', () => {
                resolve();
            });

            this.on('pdom-error', (err) => {
                reject(err);
            });

            this.#iframeEl.onerror = reject;

            this.el.replaceChildren(this.#iframeEl);
            this.subscribeToIframeMessages();
        });
        return this.isLoaded;
    }

    private renderNoIframe() {
        return new Promise<void>((resolve, reject) => {
            const { scriptUrls } = this.options;
            import(
                /* @vite-ignore */
                scriptUrls[0]
            ).then(() => {
                resolve();
            }).catch((err) => {
                reject(err);
            });
        });
    }

    private getIframeEl(iframeSrc: string) {
        const iframe = document.createElement('iframe');
        iframe.src = iframeSrc;
        iframe.style.width = '100%';
        iframe.style.height = '100%';
        iframe.style.border = 'none';
        iframe.style.overflow = 'hidden';
        return iframe;
    }

    private subscribeToIframeMessages() {
        onMessage((data) => {
            return this.executeCallbacks(data);
        }, this.#iframeEl);
    }

    private async executeCallbacks(data) {
        if (data._type && this.callbacks[data._type]) {
            // call each callback return the first resolved promise.
            return Promise.race(this.callbacks[data._type].map(async cb => await cb(data)));
        } else {
            return ON_MESSAGE_CALLBACK_SKIP_PROCESSING;
        }
    }

    private on(type: string, cb: Function) {
        if (!this.callbacks[type]) {
            this.callbacks[type] = [];
        }
        this.callbacks[type].push(cb);
    }

    public async sendMessage(data: any) {
        await this.isLoaded;
        return sendMessage(this.#iframeEl, data, {
            origin: this.#iframeSrc,
            endpoint: 'parent'
        });
    }

    public onMessage(cb: (data) => any) {
        return onMessage(cb, this.#iframeEl, 'parent');
    }
}

function getOuterHTMLAndStyleString(el: HTMLElement) {
    const nodeOuterHTML = el.outerHTML;
    const styles = getComputedStyle(el);
    let cssText = '';
    for (let i = 0; i < styles.length; i++) {
        const prop = styles[i];
        cssText += `${prop}: ${styles.getPropertyValue(prop)};`;
    }
    return { nodeOuterHTML, cssText };
}

export { ON_MESSAGE_CALLBACK_SKIP_PROCESSING }; 