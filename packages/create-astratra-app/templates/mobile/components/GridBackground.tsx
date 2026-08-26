import { StyleSheet } from "react-native";
import Svg, { Defs, Pattern, Path, RadialGradient, Stop, Mask, Rect } from "react-native-svg";

const CELL = 40;
/* Faint on purpose: the grid gives the glass something to refract, it is not
   meant to be read as a grid. */
const LINE_COLOR = "rgba(61,90,254,0.08)";

/**
 * The paper behind the glass.
 *
 * A translucent card over a flat, near-white background is invisible — there is
 * nothing for it to sit on, so the panel reads as no panel at all. This is a
 * 40px rule, faded radially towards the edges: enough texture for the surface
 * to separate, not enough to notice.
 */
export default function GridBackground() {
  return (
    <Svg style={StyleSheet.absoluteFill} width="100%" height="100%">
      <Defs>
        <Pattern id="grid" width={CELL} height={CELL} patternUnits="userSpaceOnUse">
          <Path d={`M ${CELL} 0 L 0 0 0 ${CELL}`} fill="none" stroke={LINE_COLOR} strokeWidth={1} />
        </Pattern>
        <RadialGradient id="fade" cx="50%" cy="45%" rx="75%" ry="60%">
          <Stop offset="30%" stopColor="#fff" stopOpacity={1} />
          <Stop offset="100%" stopColor="#fff" stopOpacity={0} />
        </RadialGradient>
        <Mask id="fadeMask">
          <Rect width="100%" height="100%" fill="url(#fade)" />
        </Mask>
      </Defs>
      <Rect width="100%" height="100%" fill="url(#grid)" mask="url(#fadeMask)" />
    </Svg>
  );
}
