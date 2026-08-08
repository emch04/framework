const fs = require('fs');
const os = require('os');
const path = require('path');

function createTempProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'astratra-tooling-'));
}

function writeFile(rootDir, relativePath, content) {
  const filePath = path.join(rootDir, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  return filePath;
}

function writeJson(rootDir, relativePath, value) {
  writeFile(rootDir, relativePath, `${JSON.stringify(value, null, 2)}\n`);
}

function createOutput() {
  return {
    lines: [],
    log(message = '') {
      this.lines.push(message);
    }
  };
}

module.exports = {
  createOutput,
  createTempProject,
  writeFile,
  writeJson
};
