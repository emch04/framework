'use strict';

const { createUsageQuestionDetector } = require('../src');

describe('usage-question detector', () => {
  const isUsageQuestion = createUsageQuestionDetector({
    patterns: {
      fr: ['comment (?:faire|puis-je)', '[àa] quoi sert', 'o[uù] trouver'],
      en: ['how (?:do|can) i', 'where (?:is|can i)']
    },
    fallbackLanguage: 'en'
  });

  test.each([
    ['À quoi sert cette page ?', 'fr'],
    ['à quoi sert cette page ?', 'fr'],
    ['Comment faire cela ?', 'fr'],
    ['How do I open it?', 'en']
  ])('detects %s', (question, language) => {
    expect(isUsageQuestion(question, language)).toBe(true);
  });

  test('does not classify an unrelated data question', () => {
    expect(isUsageQuestion('How many orders arrived?', 'en')).toBe(false);
  });

  test('accepts caller-supplied regular expressions without state leaking between calls', () => {
    const detect = createUsageQuestionDetector({ patterns: { x: [/how do i/gi] } });
    expect(detect('how do i start', 'x')).toBe(true);
    expect(detect('how do i stop', 'x')).toBe(true);
  });
});
