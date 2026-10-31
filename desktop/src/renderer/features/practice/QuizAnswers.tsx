import { parse, stringify } from 'yaml';
import type { QuizQuestion } from '../../../shared/api';

/** Whether every question has a choice: Check waits for it, since checking one answer at a time would reveal the key. */
export function answeredAll(questions: QuizQuestion[], text: string): boolean {
  try {
    const answers = parse(text) as Record<string, unknown> | null;
    return questions.every((_, i) => typeof answers?.[i + 1] === 'number');
  } catch {
    return false;
  }
}

/** The same numbered YAML file the terminal edits; no answer key reaches this component. */
export function QuizAnswers({ questions, text, disabled, onChange }: {
  questions: QuizQuestion[]; text: string; disabled: boolean; onChange: (text: string) => void;
}) {
  let answers: Record<string, number | null>;
  try {
    answers = parse(text);
    if (!answers || typeof answers !== 'object' || Array.isArray(answers) || Object.entries(answers).some(([n, choice]) =>
      !/^[1-9][0-9]*$/.test(n) || !questions[Number(n) - 1] || (choice !== null && (!Number.isInteger(choice) || choice < 1 || choice > questions[Number(n) - 1].choices.length)))) throw new Error();
  } catch {
    return <p role="alert">Fix answers.yaml to use question and choice numbers, then reopen this activity.</p>;
  }
  return <div className="quiz-questions stack loose">
    {questions.map((q, i) => <fieldset className="stack" key={i} disabled={disabled}>
      <legend className="h3">{q.text}</legend>
      {q.choices.map((c, j) => <label className={`opt${answers[i + 1] === j + 1 ? ' on' : ''}`} key={j}>
        <input type="radio" name={`question-${i + 1}`} checked={answers[i + 1] === j + 1}
          onChange={() => onChange(stringify({ ...answers, [i + 1]: j + 1 }))} />
        {c.text}
      </label>)}
    </fieldset>)}
  </div>;
}
