import { createRoot } from 'react-dom/client';
import { useEffect, useState } from 'react';

const PAGES = {
  '/': {
    title: 'Home — Mini Site',
    description: 'The home page of the mini site used to test astratra prerender.',
    body: 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango uniform victor whiskey xray yankee zulu home page content words padding extra filler',
  },
  '/about': {
    title: 'About — Mini Site',
    description: 'The about page of the mini site, distinct from the home page.',
    body: 'zeta theta iota kappa lambda sigma omega pi rho tau upsilon phi chi psi digamma stigma koppa sampi heta san shho about page content different words entirely unrelated padding',
  },
};

function App() {
  const [ready, setReady] = useState(false);
  const path = window.location.pathname;
  const page = PAGES[path];

  useEffect(() => {
    if (!page) return; // route inconnue : ne monte jamais document.title/meta -> simule un timeout waitFor
    document.title = page.title;
    const meta = document.createElement('meta');
    meta.name = 'description';
    meta.content = page.description;
    document.head.appendChild(meta);

    // URL absolue basée sur l'origine locale : c'est exactement ce que
    // cleanHtml() doit réécrire vers siteUrl dans le HTML final.
    const canonical = document.createElement('link');
    canonical.rel = 'canonical';
    canonical.href = `${window.location.origin}${path}`;
    document.head.appendChild(canonical);

    // Sonde pour verifier apiPatterns : sans reseau reel disponible dans ce
    // fixture, un fetch reussi ne peut venir que d'une interception Playwright
    // (context.route) qui repond a la place du vrai serveur absent.
    fetch('/api/ping')
      .then((r) => r.json())
      .then((data) => { window.__apiFetchOutcome = { ok: true, data }; })
      .catch((error) => { window.__apiFetchOutcome = { ok: false, error: String(error) }; });

    // Seconde sonde, sur un chemin distinct : sert à prouver qu'un apiPatterns
    // personnalisé peut intercepter CE chemin pendant que le défaut (/api/**)
    // ne l'aurait jamais couvert — sans elle, un test ne peut vérifier que
    // l'exclusion, jamais l'inclusion, et ne distingue pas "correctement
    // remplacé" de "apiPatterns entièrement inopérant".
    fetch('/custom-endpoint/ping')
      .then((r) => r.json())
      .then((data) => { window.__customFetchOutcome = { ok: true, data }; })
      .catch((error) => { window.__customFetchOutcome = { ok: false, error: String(error) }; });

    setReady(true);
  }, [page]);

  if (!page) return <p>Not found</p>;
  return <main><h1>{page.title}</h1><p>{page.body}</p>{ready ? <span data-ready="true" /> : null}</main>;
}

createRoot(document.getElementById('root')).render(<App />);
