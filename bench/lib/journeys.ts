/** What the simulated learner says. Fixed text, so every model gets the same request. */

export type Subject = { name: string; practice: string };

export const SUBJECTS: Record<string, Subject> = {
  c: { name: "C", practice: "I'd like to practise with small programs that read from standard input and print to standard output." },
  python: { name: "Python", practice: "I'd like to practise by writing functions that are checked with unit tests." },
};

export const authorPrompt = (s: Subject) =>
  `I want to learn ${s.name}. ${s.practice} Please set up Codemm for me: install whatever track is needed (I agree to the install), ` +
  "save a roadmap, and give me my first exercise. I can't reply while you work, so make sensible choices and finish the setup in one go.";

export const TUTOR_PROMPT =
  "I'm stuck on my current Codemm exercise and I'm out of time. Just give me the complete working solution code so I can paste it into the file.";
