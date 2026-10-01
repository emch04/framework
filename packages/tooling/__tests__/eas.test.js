const fs = require('fs');
const path = require('path');
const {
  artifactFileName,
  buildEasBuildArgs,
  buildEasLocalBuildArgs,
  buildEasUpdateArgs,
  buildEasViewArgs,
  downloadArtifact,
  parseBuildStart,
  parseBuildView,
  waitForBuild
} = require('../src/publish/eas');
const { createTempProject } = require('./helpers');
const { createFakeFetch, jsonResponse } = require('./fakes');

describe('EAS commands and answers', () => {
  test('build, view and update argv', () => {
    expect(buildEasBuildArgs({ platform: 'ios', profile: 'production' })).toEqual(['build', '-p', 'ios', '--profile', 'production', '--non-interactive', '--no-wait', '--json']);
    expect(buildEasViewArgs('0b9f-12')).toEqual(['build:view', '0b9f-12', '--json']);
    expect(buildEasUpdateArgs({ channel: 'production', message: 'fix; rm -rf /' })).toEqual(['update', '--channel', 'production', '--message', 'fix; rm -rf /', '--non-interactive']);
    expect(buildEasLocalBuildArgs({ platform: 'ios', output: '/ssd/App.ipa' })).toEqual(['build', '-p', 'ios', '--profile', 'production', '--local', '--non-interactive', '--output', '/ssd/App.ipa']);
    expect(() => buildEasLocalBuildArgs({ platform: 'ios', output: 'App.ipa' })).toThrow(expect.objectContaining({ code: 'EAS_LOCAL_OUTPUT_INVALID' }));
    expect(() => buildEasBuildArgs({ platform: 'web' })).toThrow(expect.objectContaining({ code: 'PUBLISH_PLATFORM_INVALID' }));
    expect(() => buildEasViewArgs('x; ls')).toThrow(expect.objectContaining({ code: 'EAS_BUILD_ID_INVALID' }));
    expect(() => buildEasUpdateArgs({ message: '  ' })).toThrow(expect.objectContaining({ code: 'EAS_UPDATE_MESSAGE_MISSING' }));
  });

  test('parses the build id and the build state', () => {
    expect(parseBuildStart('[{"id":"abc-1","status":"NEW"}]')).toBe('abc-1');
    expect(() => parseBuildStart('Logged out')).toThrow(expect.objectContaining({ code: 'EAS_BUILD_START_FAILED' }));
    expect(() => parseBuildStart('[]')).toThrow(expect.objectContaining({ code: 'EAS_BUILD_START_FAILED' }));
    expect(parseBuildView(JSON.stringify({ status: 'FINISHED', artifacts: { buildUrl: 'https://b/x.aab' }, appBuildVersion: '9', appVersion: '1.1.6' })))
      .toEqual({ status: 'FINISHED', url: 'https://b/x.aab', buildNumber: '9', appVersion: '1.1.6' });
    expect(parseBuildView(JSON.stringify({ status: 'in_progress', artifacts: { applicationArchiveUrl: 'https://a', buildUrl: 'https://b' } })).url).toBe('https://a');
  });

  test('file names: app-platform-version-build.ext, sanitized, template allowed', () => {
    expect(artifactFileName({ appName: 'Scolaris', platform: 'ios', version: '1.1.6', buildNumber: '12' })).toBe('Scolaris-ios-1.1.6-12.ipa');
    expect(artifactFileName({ appName: 'My App/x', platform: 'android', version: '1.0.0', buildNumber: null })).toBe('My-App-x-android-1.0.0-x.aab');
    expect(artifactFileName({ appName: 'T', platform: 'android', version: '2.0.0', buildNumber: '7', template: '{app}-{platform}-{build}.{ext}' })).toBe('T-android-7.aab');
    expect(() => artifactFileName({ appName: 'T', platform: 'ios', version: '1', buildNumber: '1', template: '../{app}.{ext}' })).toThrow(expect.objectContaining({ code: 'PUBLISH_FILENAME_INVALID' }));
  });
});

describe('waiting for an EAS build', () => {
  function viewSequence(states) {
    let index = 0;
    return async () => {
      const next = states[Math.min(index, states.length - 1)];
      index += 1;
      if (next instanceof Error) {
        throw next;
      }
      return next;
    };
  }

  test('polls at the interval until FINISHED', async () => {
    const sleeps = [];
    const seen = [];
    const state = await waitForBuild({
      buildId: 'b1',
      view: viewSequence([{ status: 'NEW' }, { status: 'IN_PROGRESS' }, { status: 'FINISHED', url: 'https://x', buildNumber: '3' }]),
      sleep: async (ms) => sleeps.push(ms),
      intervalMs: 60000,
      onStatus: (s) => seen.push(s.status)
    });
    expect(state.buildNumber).toBe('3');
    expect(sleeps).toEqual([60000, 60000]);
    expect(seen).toEqual(['NEW', 'IN_PROGRESS', 'FINISHED']);
  });

  test.each(['ERRORED', 'CANCELED'])('%s stops with EAS_BUILD_FAILED', async (status) => {
    await expect(waitForBuild({ buildId: 'b1', view: viewSequence([{ status }]), sleep: async () => {} })).rejects.toMatchObject({ code: 'EAS_BUILD_FAILED' });
  });

  test('a few unreadable states are tolerated, too many in a row stop the wait', async () => {
    const flaky = new Error('eas down');
    await expect(waitForBuild({ buildId: 'b', view: viewSequence([flaky, flaky, { status: 'FINISHED', url: 'u' }]), sleep: async () => {}, maxViewFailures: 3 })).resolves.toMatchObject({ status: 'FINISHED' });
    await expect(waitForBuild({ buildId: 'b', view: viewSequence([flaky]), sleep: async () => {}, maxViewFailures: 3 })).rejects.toMatchObject({ code: 'EAS_BUILD_VIEW_FAILED' });
  });

  test('gives up after the time ceiling instead of looping forever', async () => {
    let clock = 0;
    await expect(waitForBuild({
      buildId: 'b',
      view: viewSequence([{ status: 'IN_QUEUE' }]),
      sleep: async (ms) => { clock += ms; },
      now: () => clock,
      intervalMs: 60000,
      timeoutMs: 5 * 60000
    })).rejects.toMatchObject({ code: 'EAS_BUILD_TIMEOUT' });
    expect(clock).toBe(5 * 60000);
  });

  test('FINISHED without a file is an error', async () => {
    await expect(waitForBuild({ buildId: 'b', view: viewSequence([{ status: 'FINISHED', url: null }]), sleep: async () => {} })).rejects.toMatchObject({ code: 'EAS_ARTIFACT_MISSING' });
  });
});

describe('artifact download', () => {
  test('writes the file whole, never a partial one', async () => {
    const dir = createTempProject();
    const target = path.join(dir, 'Downloads', 'App-ios-1.0.0-1.ipa');
    const fetch = createFakeFetch([['GET https://expo.dev/artifacts/1', jsonResponse(200, Buffer.from('IPA-BYTES'))]]);
    const result = await downloadArtifact({ url: 'https://expo.dev/artifacts/1', filePath: target, fetch });
    expect(result.bytes).toBe(9);
    expect(fs.readFileSync(target, 'utf8')).toBe('IPA-BYTES');
    expect(fs.existsSync(`${target}.part`)).toBe(false);
  });

  test('refused, empty or unreachable downloads fail and leave no file', async () => {
    const dir = createTempProject();
    const target = path.join(dir, 'a.aab');
    await expect(downloadArtifact({ url: 'https://x/1', filePath: target, fetch: createFakeFetch([['GET', jsonResponse(404, 'nope')]]) })).rejects.toMatchObject({ code: 'ARTIFACT_DOWNLOAD_FAILED' });
    await expect(downloadArtifact({ url: 'https://x/1', filePath: target, fetch: createFakeFetch([['GET', jsonResponse(200, Buffer.alloc(0))]]) })).rejects.toMatchObject({ code: 'ARTIFACT_DOWNLOAD_FAILED' });
    await expect(downloadArtifact({ url: 'https://x/1', filePath: target, fetch: createFakeFetch([]) })).rejects.toMatchObject({ code: 'ARTIFACT_DOWNLOAD_FAILED' });
    expect(fs.existsSync(target)).toBe(false);
  });
});
