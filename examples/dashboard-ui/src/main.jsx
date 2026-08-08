import React from 'react';
import { createRoot } from 'react-dom/client';
import { AstratraDashboardApp } from '@astratra/saas-kit-ui';

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <AstratraDashboardApp />
  </React.StrictMode>
);
