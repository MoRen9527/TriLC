// Bridge: CC's yoga-layout index.ts expects nested-enum API (Edge.All etc.).
// yoga-layout-prebuilt (npm) exports flat constants (EDGE_ALL etc.). Map them.
import _yoga from 'yoga-layout-prebuilt';
const Y = _yoga;
export default Y; // Yoga Node class (default export)
export const Edge = {
    Left: Y.EDGE_LEFT, // 0
    Top: Y.EDGE_TOP, // 1
    Right: Y.EDGE_RIGHT, // 2
    Bottom: Y.EDGE_BOTTOM, // 3
    Start: Y.EDGE_START, // 4
    End: Y.EDGE_END, // 5
    Horizontal: Y.EDGE_HORIZONTAL, // 6
    Vertical: Y.EDGE_VERTICAL, // 7
    All: Y.EDGE_ALL, // 8
};
export const Align = {
    Auto: Y.ALIGN_AUTO,
    FlexStart: Y.ALIGN_FLEX_START,
    Center: Y.ALIGN_CENTER,
    FlexEnd: Y.ALIGN_FLEX_END,
    Stretch: Y.ALIGN_STRETCH,
    Baseline: Y.ALIGN_BASELINE,
    SpaceBetween: Y.ALIGN_SPACE_BETWEEN,
    SpaceAround: Y.ALIGN_SPACE_AROUND,
};
export const Direction = {
    Inherit: Y.DIRECTION_INHERIT,
    LTR: Y.DIRECTION_LTR,
    RTL: Y.DIRECTION_RTL,
};
export const Display = {
    Flex: Y.DISPLAY_FLEX,
    None: Y.DISPLAY_NONE,
};
export const FlexDirection = {
    Column: Y.FLEX_DIRECTION_COLUMN,
    ColumnReverse: Y.FLEX_DIRECTION_COLUMN_REVERSE,
    Row: Y.FLEX_DIRECTION_ROW,
    RowReverse: Y.FLEX_DIRECTION_ROW_REVERSE,
};
export const Gutter = {
    Column: Y.EDGE_LEFT, // best-effort mapping — CC yoga supports gutter
    Row: Y.EDGE_TOP,
    All: Y.EDGE_ALL,
};
export const Justify = {
    FlexStart: Y.JUSTIFY_FLEX_START,
    Center: Y.JUSTIFY_CENTER,
    FlexEnd: Y.JUSTIFY_FLEX_END,
    SpaceBetween: Y.JUSTIFY_SPACE_BETWEEN,
    SpaceAround: Y.JUSTIFY_SPACE_AROUND,
    SpaceEvenly: Y.JUSTIFY_SPACE_EVENLY,
};
export const MeasureMode = {
    Undefined: Y.MEASURE_MODE_UNDEFINED,
    Exactly: Y.MEASURE_MODE_EXACTLY,
    AtMost: Y.MEASURE_MODE_AT_MOST,
};
export const Overflow = {
    Visible: Y.OVERFLOW_VISIBLE,
    Hidden: Y.OVERFLOW_HIDDEN,
    Scroll: Y.OVERFLOW_SCROLL,
};
export const PositionType = {
    Relative: Y.POSITION_TYPE_RELATIVE,
    Absolute: Y.POSITION_TYPE_ABSOLUTE,
};
export const Wrap = {
    NoWrap: Y.WRAP_NO_WRAP,
    Wrap: 1, // WRAP_WRAP (not exposed as named constant)
    WrapReverse: 2, // WRAP_WRAP_REVERSE (ditto)
};
// getYogaCounters stub (metrics only — no-op)
export const getYogaCounters = () => ({});
