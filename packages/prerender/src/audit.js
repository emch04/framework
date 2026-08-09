function field(html, pattern) {
  const match = String(html).match(pattern);
  return match ? match[1].trim() : '';
}

/** Texte réellement lisible par un robot : sans head, script, style ni balises. */
function extractVisibleText(html) {
  return String(html)
    .replace(/<head[\s\S]*?<\/head>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Indice de Jaccard sur les mots significatifs : communs / union. Rapporter
 * au plus COURT des deux textes produit des faux positifs — le vocabulaire
 * d'une petite page (navbar, pied de page, mots courants) est presque
 * entièrement inclus dans celui d'une page plus longue. L'union pénalise cet
 * écart de taille : seules deux pages réellement jumelles approchent 1.
 */
function similarity(a, b) {
  const words = (text) => new Set(text.toLowerCase().split(' ').filter((w) => w.length > 3));
  const wa = words(a);
  const wb = words(b);
  if (!wa.size || !wb.size) return 0;

  let common = 0;
  for (const word of wa) if (wb.has(word)) common++;
  return common / (wa.size + wb.size - common);
}

/**
 * Contrôle que le HTML écrit est réellement exploitable par un robot — pas
 * seulement que la génération n'a pas planté. Motivé par un bug réel trouvé
 * sur un site consommateur : une route derrière une redirection d'auth
 * capturait la page de connexion et la publiait sous sa propre URL, titre et
 * description compris. Compter les pages écrites ne suffit pas à le détecter ;
 * il faut relire ce qu'elles contiennent.
 *
 * @param {{route: string, html: string}[]} pages
 * @param {{minWords?: number, similarityThreshold?: number}} [options]
 */
function auditPages(pages, { minWords = 20, similarityThreshold = 0.9 } = {}) {
  const errors = [];
  const warnings = [];

  const analyzed = pages.map(({ route, html }) => {
    const text = extractVisibleText(html);
    return {
      route,
      text,
      words: text ? text.split(' ').length : 0,
      title: field(html, /<title[^>]*>([\s\S]*?)<\/title>/i),
      description: field(html, /<meta\s+name=["']description["'][^>]*content=["']([^"']*)/i),
    };
  });

  for (const page of analyzed) {
    if (!page.title) errors.push(`${page.route}: missing title`);
    if (!page.description) errors.push(`${page.route}: missing meta description`);
    if (page.words < minWords) {
      warnings.push(`${page.route}: only ${page.words} words of visible content`);
    }
  }

  const byTitle = new Map();
  for (const page of analyzed) {
    if (!page.title) continue;
    if (!byTitle.has(page.title)) byTitle.set(page.title, []);
    byTitle.get(page.title).push(page.route);
  }
  for (const [title, routes] of byTitle) {
    if (routes.length > 1) errors.push(`duplicate title "${title}" on ${routes.join(', ')}`);
  }

  for (let i = 0; i < analyzed.length; i++) {
    for (let j = i + 1; j < analyzed.length; j++) {
      const a = analyzed[i];
      const b = analyzed[j];
      if (a.words < minWords || b.words < minWords) continue;
      if (similarity(a.text, b.text) >= similarityThreshold) {
        errors.push(`${a.route} and ${b.route} render the same content`);
      }
    }
  }

  return { errors, warnings };
}

module.exports = { auditPages, extractVisibleText };
