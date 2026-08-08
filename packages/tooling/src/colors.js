const colors = {
  blue: (value) => `\x1b[34m${value}\x1b[0m`,
  green: (value) => `\x1b[32m${value}\x1b[0m`,
  yellow: (value) => `\x1b[33m${value}\x1b[0m`,
  red: (value) => `\x1b[31m${value}\x1b[0m`,
  bold: (value) => `\x1b[1m${value}\x1b[0m`,
  dim: (value) => `\x1b[2m${value}\x1b[0m`
};

module.exports = colors;
