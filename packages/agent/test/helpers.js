'use strict';
const tool = (name = 'lookup', run = async () => ({ data: 'found' })) => ({ name, kind: 'read', description: 'Look up a value.', parameters: { type: 'object' }, run });
const call = (name = 'lookup', id = 'call', args = {}) => ({ name, id, args });
module.exports = { tool, call };
