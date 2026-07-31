// Readable environment helpers used by the ink terminal layer.
export const isEnvTruthy = (name) => {
    const val = process.env[name];
    return val === '1' || val === 'true' || val === 'TRUE';
};
