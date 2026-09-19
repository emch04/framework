/**
 * A chevron drawn with two borders — no SVG dependency for an arrow.
 *
 * The corner of a square (its left and bottom borders), turned 45°, points
 * left; turned 225°, right. The rounded ends of an SVG stroke are lost, which
 * at 10 points nobody sees.
 */
const { h, RN } = require('./runtime');

const ROTATION = { left: '45deg', right: '225deg', up: '135deg', down: '-45deg' };

function Chevron({ direction = 'left', color = '#0d1235', size = 9, strokeWidth = 2.4 }) {
  return h(RN.View, {
    pointerEvents: 'none',
    style: {
      width: size,
      height: size,
      borderLeftWidth: strokeWidth,
      borderBottomWidth: strokeWidth,
      borderColor: color,
      borderRadius: 1,
      /* The corner sits at the visual centre only once shifted toward the
         open side by a quarter of its diagonal. */
      marginLeft: direction === 'left' ? size / 4 : 0,
      marginRight: direction === 'right' ? size / 4 : 0,
      transform: [{ rotate: ROTATION[direction] || ROTATION.left }]
    }
  });
}

module.exports = { Chevron };
