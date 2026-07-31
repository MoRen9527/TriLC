// Bridge: use real yoga-layout-prebuilt (CJS → ESM interop).
// The deploy script copies this npm package to the installed app.
import * as _yogaNS from 'yoga-layout';
const Y = _yogaNS.default || _yogaNS;
export default Y;
export const Edge = { Left: Y.EDGE_LEFT, Top: Y.EDGE_TOP, Right: Y.EDGE_RIGHT, Bottom: Y.EDGE_BOTTOM, Start: Y.EDGE_START, End: Y.EDGE_END, Horizontal: Y.EDGE_HORIZONTAL, Vertical: Y.EDGE_VERTICAL, All: Y.EDGE_ALL };
export const Align = { Auto: Y.ALIGN_AUTO, FlexStart: Y.ALIGN_FLEX_START, Center: Y.ALIGN_CENTER, FlexEnd: Y.ALIGN_FLEX_END, Stretch: Y.ALIGN_STRETCH, Baseline: Y.ALIGN_BASELINE, SpaceBetween: Y.ALIGN_SPACE_BETWEEN, SpaceAround: Y.ALIGN_SPACE_AROUND };
export const Direction = { Inherit: Y.DIRECTION_INHERIT, LTR: Y.DIRECTION_LTR, RTL: Y.DIRECTION_RTL };
export const Display = { Flex: Y.DISPLAY_FLEX, None: Y.DISPLAY_NONE };
export const FlexDirection = { Column: Y.FLEX_DIRECTION_COLUMN, ColumnReverse: Y.FLEX_DIRECTION_COLUMN_REVERSE, Row: Y.FLEX_DIRECTION_ROW, RowReverse: Y.FLEX_DIRECTION_ROW_REVERSE };
export const Gutter = { Column: Y.EDGE_LEFT, Row: Y.EDGE_TOP, All: Y.EDGE_ALL };
export const Justify = { FlexStart: Y.JUSTIFY_FLEX_START, Center: Y.JUSTIFY_CENTER, FlexEnd: Y.JUSTIFY_FLEX_END, SpaceBetween: Y.JUSTIFY_SPACE_BETWEEN, SpaceAround: Y.JUSTIFY_SPACE_AROUND, SpaceEvenly: Y.JUSTIFY_SPACE_EVENLY };
export const MeasureMode = { Undefined: Y.MEASURE_MODE_UNDEFINED, Exactly: Y.MEASURE_MODE_EXACTLY, AtMost: Y.MEASURE_MODE_AT_MOST };
export const Overflow = { Visible: Y.OVERFLOW_VISIBLE, Hidden: Y.OVERFLOW_HIDDEN, Scroll: Y.OVERFLOW_SCROLL };
export const PositionType = { Relative: Y.POSITION_TYPE_RELATIVE, Absolute: Y.POSITION_TYPE_ABSOLUTE };
export const Wrap = { NoWrap: Y.WRAP_NO_WRAP, Wrap: 1, WrapReverse: 2 };
export const getYogaCounters = () => ({});
