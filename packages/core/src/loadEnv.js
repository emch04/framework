const AppError = require('./AppError');

function hasValue(value) {
  return value !== undefined && value !== null && value !== '';
}

function resolveValue(name, definition) {
  const rawValue = process.env[name];

  if (hasValue(rawValue)) {
    return rawValue;
  }

  if (Object.prototype.hasOwnProperty.call(definition, 'default')) {
    return definition.default;
  }

  if (definition.required) {
    throw new AppError(`Missing required environment variable: ${name}`, 500);
  }

  return undefined;
}

function normalizeDefinition(definition) {
  if (definition && typeof definition === 'object' && !Array.isArray(definition)) {
    return definition;
  }

  return { default: definition };
}

function loadEnv(schema = {}) {
  return Object.entries(schema).reduce((config, [name, rawDefinition]) => {
    const definition = normalizeDefinition(rawDefinition);
    const value = resolveValue(name, definition);

    if (value === undefined) {
      config[name] = undefined;
      return config;
    }

    const transformed = typeof definition.transform === 'function'
      ? definition.transform(value)
      : value;

    if (typeof definition.validate === 'function' && !definition.validate(transformed)) {
      throw new AppError(`Invalid environment variable: ${name}`, 500);
    }

    config[name] = transformed;
    return config;
  }, {});
}

module.exports = loadEnv;
