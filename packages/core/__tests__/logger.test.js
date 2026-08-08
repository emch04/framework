describe('createLogger', () => {
  const originalEnv = process.env.NODE_ENV;
  let createLogger;

  beforeEach(() => {
    jest.resetModules();
    createLogger = require('../src').createLogger;
  });

  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
    jest.restoreAllMocks();
  });

  test('does not write logs when NODE_ENV is test', () => {
    process.env.NODE_ENV = 'test';
    const info = jest.spyOn(console, 'info').mockImplementation(() => {});

    createLogger('core').info('hidden');

    expect(info).not.toHaveBeenCalled();
  });

  test('prefixes messages with the service name outside test mode', () => {
    process.env.NODE_ENV = 'development';
    const info = jest.spyOn(console, 'info').mockImplementation(() => {});

    createLogger('core').info('ready', { port: 3000 });

    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0][0]).toContain('[core]');
    expect(info.mock.calls[0][0]).toContain('ready');
    expect(info.mock.calls[0][1]).toEqual({ port: 3000 });
  });
});
