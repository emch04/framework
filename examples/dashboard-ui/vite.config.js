import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Injects a restrictive Content-Security-Policy only into the production
// build's index.html. A static meta tag would also apply in dev mode and
// break Vite's HMR websocket (which needs its own connect-src), so this
// only runs for `vite build` (apply: 'build').
function cspForProductionBuild() {
  return {
    name: 'astratra-csp',
    apply: 'build',
    transformIndexHtml(html) {
      const apiUrl = process.env.VITE_API_URL || 'http://localhost:4000';
      const csp = [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
        'font-src https://fonts.gstatic.com',
        "img-src 'self' data:",
        `connect-src 'self' ${apiUrl}`,
        "object-src 'none'",
        "base-uri 'self'",
        "frame-ancestors 'none'"
      ].join('; ');

      return html.replace(
        '</head>',
        `    <meta http-equiv="Content-Security-Policy" content="${csp}" />\n  </head>`
      );
    }
  };
}

export default defineConfig({
  plugins: [react(), cspForProductionBuild()]
});
