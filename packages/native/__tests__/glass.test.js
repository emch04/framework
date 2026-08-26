const { blurPropsFor, resolveGlassMode } = require('../src');

describe('resolveGlassMode', () => {
  test('the platform material wins when the OS can render it', () => {
    expect(resolveGlassMode({ platform: 'ios', apiAvailable: true, effectAvailable: true })).toBe('native');
  });

  test('ANDROID IS NOT A SECOND-CLASS CITIZEN: a real blur is a real blur', () => {
    expect(resolveGlassMode({ platform: 'android', blurAvailable: true })).toBe('blur');
  });

  test('an iOS too old for the glass API still blurs', () => {
    expect(resolveGlassMode({ platform: 'ios', apiAvailable: true, effectAvailable: false, blurAvailable: true }))
      .toBe('blur');
  });

  test('only a device with no blur at all falls back', () => {
    expect(resolveGlassMode({ platform: 'android', blurAvailable: false })).toBe('fallback');
    expect(resolveGlassMode({ platform: 'web' })).toBe('fallback');
    expect(resolveGlassMode({})).toBe('fallback');
  });
});

describe('blurPropsFor', () => {
  test('Android must be asked for the native method, or the blur is fake', () => {
    expect(blurPropsFor('android')).toMatchObject({ experimentalBlurMethod: 'dimezisBlurView' });
  });

  test('iOS needs no such flag', () => {
    expect(blurPropsFor('ios').experimentalBlurMethod).toBeUndefined();
  });

  test('the intensity is tunable and defaulted', () => {
    expect(blurPropsFor('ios').intensity).toBe(40);
    expect(blurPropsFor('ios', 12).intensity).toBe(12);
  });
});
