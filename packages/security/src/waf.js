const WAF_PATTERNS = [
  /(\b(union|select|insert|update|delete|drop|alter|create)\b.*\b(from|into|table|database)\b)/gi,
  /(\b(or|and)\b\s+\d+\s*=\s*\d+)/gi,
  /(--|#|\/\*|\*\/|;--)/g,
  /(\.\.\/(\.\.\/){2,})/g,
  /(\/etc\/passwd|\/proc\/self|\/dev\/null)/gi,
  /(<script[\s>]|javascript:|on(error|load|click|mouseover)\s*=)/gi,
  /(\$\{.*\}|\$\(.*\))/g,
  /(\bexec\b|\beval\b|\bFunction\b)\s*\(/gi
];

const DEFAULT_MESSAGE = {
  success: false,
  message: 'Request blocked by security policy.'
};

const safeStringify = (value) => {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value || {});
  } catch (_error) {
    return '';
  }
};

const createWafMiddleware = (options = {}) => {
  const message = options.message || DEFAULT_MESSAGE;
  const patterns = options.patterns || WAF_PATTERNS;

  return (req, res, next) => {
    const targets = [
      req.path,
      safeStringify(req.query),
      safeStringify(req.body)
    ].join(' ');

    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      if (pattern.test(targets)) {
        return res.status(403).json(message);
      }
    }

    return next();
  };
};

module.exports = {
  createWafMiddleware,
  WAF_PATTERNS
};
