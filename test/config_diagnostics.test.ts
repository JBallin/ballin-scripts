const path = require('path');
const { configurationPath, filesystemCause } = require('../config/diagnostics.ts');

describe('safe configuration diagnostics', () => {
  it('shows the absolute configured path and escapes terminal controls', () => {
    assert.equal(configurationPath('custom preferences.json'), JSON.stringify(path.resolve('custom preferences.json')));
    const unsafe = 'custom\n\x1b[31m\u007f\u0085\u202e\u2028\u2029\ud800.json';
    const result = configurationPath(unsafe);
    assert.notMatch(result, /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u);
    assert.include(result, '\\n'); assert.include(result, '\\u001b'); assert.include(result, '\\u007f');
    assert.include(result, '\\u0085'); assert.include(result, '\\u202e'); assert.include(result, '\\u2028'); assert.include(result, '\\u2029');
    assert.include(result, '\\ud800');
  });
  for (const [code, cause] of Object.entries({
    EACCES: 'permission denied', EPERM: 'operation not permitted', EROFS: 'read-only filesystem',
    ENOSPC: 'no space left on the filesystem', EDQUOT: 'storage quota exceeded',
    ENOENT: 'a required file or folder is missing', ENOTDIR: 'a path component is not a folder',
    EISDIR: 'the destination is a folder', EEXIST: 'the private staging path already exists',
    EIO: 'filesystem input/output error', ELOOP: 'too many symbolic links',
  })) it(`reports only the whitelisted ${code} cause`, () => {
    assert.equal(filesystemCause({ code, message: 'PRIVATE_MESSAGE', path: 'PRIVATE_PATH', syscall: 'PRIVATE_SYSCALL' }), `${code}: ${cause}.`);
  });
  for (const error of [undefined, null, new Error('PRIVATE_ERROR'), { code: 'PRIVATE_CODE' }, { code: 1 }, { code: 'toString' }]) {
    it(`omits unknown or non-filesystem cause ${JSON.stringify(error)}`, () => assert.isUndefined(filesystemCause(error)));
  }
});
