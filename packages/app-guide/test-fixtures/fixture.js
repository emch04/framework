'use strict';

const config = {
  applicationKey: 'app.description',
  roles: {
    owner: {
      tabs: ['nav.home', 'nav.more'],
      sections: [{
        titleKey: 'sections.manage',
        items: [
          { labelKey: 'pages.orders', route: '/orders', visibleDirectly: false },
          { labelKey: 'pages.reports', route: '/reports' },
          { labelKey: 'pages.archive', route: '/archive' }
        ]
      }],
      settingKeys: ['settings.language']
    },
    viewer: {
      tabs: ['nav.home'],
      sections: [{
        titleKey: 'sections.manage',
        items: [{ labelKey: 'pages.reports', route: '/reports' }]
      }],
      settingKeys: []
    }
  },
  tasks: [
    {
      id: 'create-order',
      keywordKeys: ['keywords.create_order', 'keywords.order'],
      roles: ['owner'],
      stepKeys: ['steps.open_orders', 'steps.create'],
      route: '/orders'
    },
    {
      id: 'read-report',
      keywordKeys: ['keywords.report'],
      roles: ['owner', 'viewer'],
      stepKeys: ['steps.open_reports'],
      route: '/reports'
    },
    {
      id: 'archive-order',
      keywordKeys: ['keywords.archive'],
      roles: ['owner'],
      stepKeys: ['steps.open_archive'],
      route: '/archive'
    }
  ],
  pages: {
    '/orders': {
      purposeKey: 'orders.purpose',
      contentKeys: ['orders.content'],
      actions: [{ labelKey: 'orders.create', effectKey: 'orders.create_effect' }],
      sourceFiles: ['screens/orders.js']
    },
    '/reports': {
      purposeKey: 'reports.purpose',
      contentKeys: ['reports.content'],
      actions: [{ labelKey: 'reports.export', effectKey: 'reports.export_effect' }],
      sourceFiles: ['screens/reports.js']
    },
    '/archive': {
      purposeKey: 'archive.purpose',
      contentKeys: [],
      actions: [],
      sourceFiles: ['screens/archive.js']
    }
  }
};

const en = {
  app: { description: 'Example mobile application' },
  nav: { home: 'Home', more: 'More' },
  sections: { manage: 'Manage' },
  pages: { orders: 'Orders', reports: 'Reports', archive: 'Archive' },
  settings: { language: 'Language' },
  keywords: { create_order: 'create order', order: 'order', report: 'report', archive: 'archive' },
  steps: {
    open_orders: 'Open Orders.', create: 'Choose Create.', open_reports: 'Open Reports.', open_archive: 'Open Archive.'
  },
  orders: { purpose: 'Manage orders.', content: 'Current orders.', create: 'Create', create_effect: 'Starts a new order.' },
  reports: { purpose: 'Read reports.', content: 'Recent reports.', export: 'Export', export_effect: 'Downloads a report.' },
  archive: { purpose: 'Review archived items.' }
};

module.exports = { config, en };
