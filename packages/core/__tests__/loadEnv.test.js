const { loadEnv } = require('../src');

describe('loadEnv', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  test('returns configured environment values with defaults and transforms', () => {
    process.env.PORT = '3000';

    const config = loadEnv({
      PORT: {
        required: true,
        transform: Number,
        validate: (value) => Number.isInteger(value) && value > 0
      },
      LOG_LEVEL: {
        default: 'info'
      }
    });

    expect(config).toEqual({
      PORT: 3000,
      LOG_LEVEL: 'info'
    });
  });

  test('throws an AppError when a required value is missing', () => {
    expect(() =>
      loadEnv({
        API_KEY: { required: true }
      })
    ).toThrow('Missing required environment variable: API_KEY');
  });

  test('throws an AppError when validation fails', () => {
    process.env.PORT = 'zero';

    expect(() =>
      loadEnv({
        PORT: {
          transform: Number,
          validate: Number.isInteger
        }
      })
    ).toThrow('Invalid environment variable: PORT');
  });
});
