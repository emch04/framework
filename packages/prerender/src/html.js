function cleanHtml(html, { origin, siteUrl }) {
  let output = String(html).replaceAll(origin, siteUrl);
  if (!output.includes('data-astratra-prerendered=')) {
    output = output.replace(/<html(\s|>)/i, '<html data-astratra-prerendered="true"$1');
  }
  return output;
}

function assertFreshShell(html) {
  if (String(html).includes('data-astratra-prerendered="true"')) {
    throw new Error('dist/index.html is already prerendered. Run a fresh Vite build first.');
  }
}

module.exports = { cleanHtml, assertFreshShell };
