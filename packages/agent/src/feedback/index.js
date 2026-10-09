'use strict';
const model = require('./model');
module.exports = {
  RATINGS: model.RATINGS, FEEDBACK_REASONS: model.FEEDBACK_REASONS, FeedbackError: model.FeedbackError, scrubPersonalData: model.scrubPersonalData,
  createMemoryFeedbackStore: require('./stores').createMemoryFeedbackStore,
  ...require('./postgres'), ...require('./service'), ...require('./router')
};
