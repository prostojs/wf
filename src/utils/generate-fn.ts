
const GLOBALS = {
    // Node.js Globals
    global: null,
    process: null,
    Buffer: null,
    require: null,
    __filename: null,
    __dirname: null,
    exports: null,
    module: null,
    setImmediate: null,
    clearImmediate: null,
    setTimeout: null,
    clearTimeout: null,
    setInterval: null,
    clearInterval: null,
    queueMicrotask: null,
    queueGlobalMicrotask: null,
    globalThis: null, // GlobalThis (Introduced in ECMAScript 2020)
    // Browser Globals
    window: null,
    self: null,
    document: null,
    localStorage: null,
    sessionStorage: null,
    console: null,
    performance: null,
    fetch: null,
    URL: null,
    URLSearchParams: null,
    XMLHttpRequest: null,
    FormData: null,
    Image: null,
    Audio: null,
    navigator: null,
    location: null,
    history: null,
    screen: null,
    requestAnimationFrame: null,
    cancelAnimationFrame: null,
}

export function generateFn<R>(code: string) {
    const fnCode = `
with (__ctx__) {
    return ${code}
}`
    // console.log(fnCode)
    const fn = new Function('__ctx__', fnCode) as ((ctx?: Record<string, unknown>) => R)
    return (ctx?: Record<string, unknown>) => {
        const newCtx = {
            ...GLOBALS,
            ...ctx,
        }
        return fn(newCtx)
    }
}
