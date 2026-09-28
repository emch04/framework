/**
 * Quoting for POSIX shells. Every value that ends up inside a generated script
 * or an ssh command line goes through `shellQuote`: a single-quoted word can
 * hold anything except a single quote, which is closed, escaped and reopened.
 */
function shellQuote(value) {
  const text = String(value);

  if (text === '') {
    return "''";
  }

  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(text)) {
    return text;
  }

  return `'${text.replace(/'/g, `'\\''`)}'`;
}

function shellJoin(args) {
  return args.map(shellQuote).join(' ');
}

module.exports = {
  shellJoin,
  shellQuote
};
