const {
  createLiveShield
} = require('../src');
test('masking and unmasking stay on their own paths', () => {
  const shield = createLiveShield({
    maskText: text => text.replace('private', '[MASK]'),
    unmaskText: text => text.replace('[MASK]', 'private')
  });
  expect(shield.input('private')).toBe('[MASK]');
  expect(shield.output('[MASK]')).toBe('private');
  expect(shield.args({
    value: '[MASK]'
  })).toEqual({
    value: 'private'
  });
  expect(shield.result({
    value: 'private'
  })).toEqual({
    value: '[MASK]'
  });
});
test('third party arguments omit injected sensitive keys and redact text', () => {
  const shield = createLiveShield({
    omitKey: key => key === 'secret',
    redactText: text => text.replace('private', '[REDACTED]')
  });
  expect(shield.external({
    nested: {
      secret: 'value',
      query: 'private'
    }
  })).toEqual({
    nested: {
      query: '[REDACTED]'
    }
  });
});
test('cyclic input and excessive depth are bounded', () => {
  const shield = createLiveShield({
    maxDepth: 2
  });
  const value = {
    nested: {
      deep: {
        further: true
      }
    }
  };
  value.self = value;
  expect(shield.external(value)).toEqual({
    nested: {
      deep: null
    },
    self: null
  });
});
