// AskUserQuestion answers from office: validation against questions (by position) and summary.
import { describe, expect, it } from 'vitest';
import { answerSummary, checkAnswers } from './answers';
import type { AskQuestion } from './types';

// Positions from original: question 1 was invalid (skipped) and option 1 of the first as well.
const QS: AskQuestion[] = [
  { index: 0, header: 'Banco', question: 'Qual banco usar?', options: [{ index: 0, label: 'Postgres' }, { index: 2, label: 'SQLite' }] },
  { index: 2, question: 'Quais testes rodar antes do commit?', multiSelect: true, options: [{ index: 0, label: 'Unidade' }, { index: 1, label: 'E2E' }] },
];

describe('checkAnswers', () => {
  it('normalizes: question order, options in ascending order, trimmed text, no empty fields', () => {
    expect(checkAnswers(QS, [{ question: 2, options: [1, 0], other: '  lint  ' }, { question: 0, options: [2], other: '   ' }])).toEqual([
      { question: 0, options: [2] },
      { question: 2, options: [0, 1], other: 'lint' },
    ]);
    // Without multiSelect, free text takes place of an option; with multiSelect, valid alone as well.
    expect(checkAnswers(QS, [{ question: 0, other: 'MySQL' }, { question: 2, other: 'nenhum' }])).toEqual([
      { question: 0, other: 'MySQL' },
      { question: 2, other: 'nenhum' },
    ]);
  });

  it('each question exactly once', () => {
    expect(checkAnswers(QS, [{ question: 0, options: [0] }])).toBeUndefined();
    expect(checkAnswers(QS, [{ question: 0, options: [0] }, { question: 0, options: [2] }])).toBeUndefined();
    expect(checkAnswers(QS, [{ question: 0, options: [0] }, { question: 1, options: [0] }])).toBeUndefined();
    expect(checkAnswers(QS, [{ question: 0, options: [0] }, { question: 2, options: [0] }, { question: 2, options: [1] }])).toBeUndefined();
    expect(checkAnswers(QS, undefined)).toBeUndefined();
    expect(checkAnswers([], [])).toBeUndefined();
  });

  it('single choice: exactly one option OR free text', () => {
    const multi = { question: 2, options: [0] };
    expect(checkAnswers(QS, [{ question: 0, options: [0, 2] }, multi])).toBeUndefined();
    expect(checkAnswers(QS, [{ question: 0, options: [0], other: 'e mais' }, multi])).toBeUndefined();
    expect(checkAnswers(QS, [{ question: 0 }, multi])).toBeUndefined();
    expect(checkAnswers(QS, [{ question: 0, options: [] }, multi])).toBeUndefined();
  });

  it('multiple choice: at least one pick; options not shown by question or duplicates are invalid', () => {
    const single = { question: 0, options: [0] };
    expect(checkAnswers(QS, [single, { question: 2 }])).toBeUndefined();
    expect(checkAnswers(QS, [{ question: 0, options: [1] }, { question: 2, options: [0] }])).toBeUndefined();
    expect(checkAnswers(QS, [single, { question: 2, options: [0, 0] }])).toBeUndefined();
    expect(checkAnswers(QS, [single, { question: 2, options: [5] }])).toBeUndefined();
    expect(checkAnswers(QS, [single, { question: 2, other: 'x'.repeat(2_001) }])).toBeUndefined();
  });
});

describe('answerSummary', () => {
  it('header (or question) and chosen labels; free text in quotes and masked', () => {
    expect(answerSummary(QS, [{ question: 0, options: [2] }, { question: 2, options: [0, 1], other: 'pode rodar' }])).toBe(
      'Banco: SQLite · Quais testes rodar antes do commit?: Unidade, E2E, “pode rodar”',
    );
    const secret = answerSummary(QS, [{ question: 0, other: 'token ghp_abcdefghijklmnopqrstuvwxyz0123456789' }]);
    expect(secret).toMatch(/^Banco: “token .+”$/);
    expect(secret).not.toContain('abcdefghijklmnop');
  });
});
