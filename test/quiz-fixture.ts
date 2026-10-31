export const quizRoadmap = JSON.stringify({ goal: "Judgment", style: "quiz", concepts: [{ id: "a", title: "A" }] });
export const quizQuestions = (prefix = "First") => Array.from({ length: 5 }, (_, i) => ({
  text: `${prefix} situation ${i + 1}?`,
  choices: [{ text: "Bound the work", correct: true }, { text: "Retry forever", why: "No stopping rule" }, { text: "Ignore the failure", why: "Loses feedback" }],
}));
export const quizFiles = (slug = "first", questions = quizQuestions(slug)) => ({
  "exercise.yaml": JSON.stringify({ slug, style: "quiz", concepts: ["a"], difficulty: 1 }),
  "README.md": "# A decision\n\nChoose what to do.",
  "quiz.yaml": JSON.stringify({ questions }),
});
