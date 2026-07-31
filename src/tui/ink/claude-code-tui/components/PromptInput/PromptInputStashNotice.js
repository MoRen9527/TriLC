import { jsxs as _jsxs, jsx as _jsx } from "react/jsx-runtime";
const _c = (n) => Array(n); // patched: compiler-runtime not available
import figures from 'figures';
import { Box, Text } from 'src/ink.js';
export function PromptInputStashNotice(t0) {
    const $ = _c(1);
    const { hasStash } = t0;
    if (!hasStash) {
        return null;
    }
    let t1;
    if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
        t1 = _jsx(Box, { paddingLeft: 2, children: _jsxs(Text, { dimColor: true, children: [figures.pointerSmall, " Stashed (auto-restores after submit)"] }) });
        $[0] = t1;
    }
    else {
        t1 = $[0];
    }
    return t1;
}
