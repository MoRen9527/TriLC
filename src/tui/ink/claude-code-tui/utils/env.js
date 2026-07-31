// Minimal env config used by the ink terminal layer.
// The real CC env module is large; here we proxy process.env and supply safe
// defaults for the handful of keys the engine reads.
export const env = new Proxy(process.env, {
    get(_t, p) {
        if (typeof p === 'string')
            return process.env[p];
        return undefined;
    },
    has(_t, p) {
        if (typeof p === 'string')
            return p in process.env;
        return false;
    }
});
