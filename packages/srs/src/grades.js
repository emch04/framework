'use strict';

const { Rating, State } = require('ts-fsrs');

const GRADES = Object.freeze({ again: Rating.Again, hard: Rating.Hard, good: Rating.Good, easy: Rating.Easy });
const GRADE_NAMES = Object.freeze(['again', 'hard', 'good', 'easy']);
const STATE_NAMES = Object.freeze({ [State.New]: 'new', [State.Learning]: 'learning', [State.Review]: 'review', [State.Relearning]: 'relearning' });

/** Accepte 'again' | 'hard' | 'good' | 'easy' (casse libre) ou 1 à 4. */
function parseGrade(grade) {
  if (typeof grade === 'string' && GRADES[grade.toLowerCase()] !== undefined) return GRADES[grade.toLowerCase()];
  if (Number.isInteger(grade) && grade >= 1 && grade <= 4) return grade;
  throw new RangeError('INVALID_GRADE');
}

module.exports = { GRADES, GRADE_NAMES, STATE_NAMES, parseGrade };
