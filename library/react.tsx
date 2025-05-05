import React from 'react';
import PDomClass, { ON_MESSAGE_CALLBACK_SKIP_PROCESSING } from '.';

class PDomReact extends PDomClass {
    protected framework = 'react';
    protected frameworkVersion = React.version;

    public setProps(props) {
        this.sendMessage({
            _type: 'pdom-props',
            props,
        });
    }
}

function PDom<T extends React.ComponentType<any>>(importFn: () => Promise<{ default: T }>): T {
    const Component = React.lazy(importFn);
    return React.forwardRef<React.ComponentProps<typeof Component>>((props, ref) => {
        const containerRef = React.useRef(null);
        const _ref = React.useRef(null);
        const pDomRef = ref ?? _ref;

        React.useEffect(() => {
            const pDom = new PDomReact(containerRef.current, {
                scripts: [
                    importFn,
                ],
                domainUrl: 'https://react.pdom.dev'
            });
            pDom.render()
            pDomRef.current = pDom;
            pDom.onMessage((message) => {
                if (message._type === 'pdom-callback') {
                    const { callbackId, args } = message;
                    return props[callbackId](...args);
                } else {
                    return ON_MESSAGE_CALLBACK_SKIP_PROCESSING;
                }
            });
        }, []);

        React.useEffect(() => {
            const newProps = {};
            for (const key in props) {
                const value = props[key];
                if (typeof value === 'function') {
                    newProps[key] = '__function__';
                } else {
                    newProps[key] = value;
                }
            }
            pDomRef.current?.setProps?.(newProps);
        }, [props]);

        return <div ref={containerRef} className="pdom"></div>
    });
}

export default PDom;